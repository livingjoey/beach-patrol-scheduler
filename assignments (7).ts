// Assignment directory (stands, squads, skis, boats, extras), staffing slots and saved criteria presets.

import { all, audit, bool, get, run, tx, type DB } from '../db/index.ts';
import { describe, evaluate, parseRule, type Rule } from '../domain/criteria.ts';
import { todayIso } from '../domain/dates.ts';
import { ADMIN, created, HttpError, type Router } from '../http/app.ts';
import { bad, has, idParam, int, notFound, obj, oneOf, optBool, optInt, optOneOf, optStr, str, TIME, type Body } from '../http/validate.ts';
import { knownCertCodes, loadAssignments, loadPersonnel, loadPresets } from '../services/context.ts';

export const KINDS = ['stand', 'medical', 'pwc', 'boat', 'extra'] as const;

// ---------- helpers ----------

function ruleFrom(db: DB, raw: unknown, field = 'rule'): Rule {
  try {
    return parseRule(raw, knownCertCodes(db), field);
  } catch (e) {
    throw new HttpError(400, 'invalid_rule', (e as Error).message, { field });
  }
}

type Criteria = { mode: 'default' } | { mode: 'preset'; presetId: number } | { mode: 'custom'; rule: Rule };

function parseCriteria(db: DB, raw: unknown): Criteria {
  const c = obj(raw, 'criteria');
  const mode = oneOf(c, 'mode', ['default', 'preset', 'custom'] as const);
  if (mode === 'preset') {
    const presetId = int(c, 'presetId', { min: 1 });
    if (!get(db, 'SELECT id FROM criteria_presets WHERE id = ?', presetId)) throw notFound('Criteria preset');
    return { mode, presetId };
  }
  if (mode === 'custom') return { mode, rule: ruleFrom(db, c.rule, 'criteria.rule') };
  return { mode };
}

function writeCriteria(db: DB, slotId: number, c: Criteria): void {
  run(
    db,
    'UPDATE slots SET criteria_mode = ?, preset_id = ?, custom_rule_json = ? WHERE id = ?',
    c.mode,
    c.mode === 'preset' ? c.presetId : null,
    c.mode === 'custom' ? JSON.stringify(c.rule) : null,
    slotId,
  );
}

function assignmentJson(db: DB, id: number) {
  const { assignments } = loadAssignments(db);
  const a = assignments.get(id);
  if (!a) return null;
  const row = get<{ default_preset_id: number | null }>(db, 'SELECT default_preset_id FROM assignments WHERE id = ?', id)!;
  const presets = loadPresets(db);
  const dp = row.default_preset_id != null ? presets.get(row.default_preset_id) : undefined;
  const custom = new Map(
    all<{ id: number; custom_rule_json: string | null }>(db, 'SELECT id, custom_rule_json FROM slots WHERE assignment_id = ?', id).map((s) => [s.id, s.custom_rule_json]),
  );
  return {
    id: a.id,
    code: a.code,
    kind: a.kind,
    displayName: a.displayName,
    active: a.active,
    sortOrder: a.sortOrder,
    openByDefault: a.openByDefault,
    startTime: a.startTime,
    endTime: a.endTime,
    defaultPreset: dp ? { id: dp.id, name: dp.name, criteria: describe(dp.rule) } : null,
    slotCount: a.slots.length,
    slots: a.slots.map((s) => ({
      id: s.id,
      position: s.position,
      name: s.name,
      criteria: {
        mode: s.mode,
        presetId: s.mode === 'preset' ? s.presetId : null,
        rule: s.mode === 'custom' ? (JSON.parse(custom.get(s.id) ?? 'null') as Rule) : null,
      },
      // What actually applies, after defaults:
      effective: { presetName: s.presetName, text: s.ruleText, rule: s.rule },
      // 'default' = uses the assignment default; 'override' = a different saved preset; 'custom' = a one-off rule.
      tag: s.mode === 'default' ? 'default' : s.mode === 'preset' ? 'override' : 'custom',
    })),
  };
}

function renumber(db: DB, assignmentId: number): void {
  const ids = all<{ id: number }>(db, 'SELECT id FROM slots WHERE assignment_id = ? ORDER BY position, id', assignmentId);
  ids.forEach((s, i) => run(db, 'UPDATE slots SET position = ? WHERE id = ?', i + 1, s.id));
}

function futureEntries(db: DB, slotIds: number[]): number {
  if (!slotIds.length) return 0;
  return get<{ n: number }>(
    db,
    `SELECT COUNT(*) AS n FROM schedule_entries WHERE date >= ? AND slot_id IN (${slotIds.map(() => '?').join(',')})`,
    todayIso(),
    ...slotIds,
  )!.n;
}

function readTimes(b: Body): { start?: string | null; end?: string | null } {
  const out: { start?: string | null; end?: string | null } = {};
  if (has(b, 'startTime')) out.start = b.startTime === null ? null : str(b, 'startTime', { pattern: TIME });
  if (has(b, 'endTime')) out.end = b.endTime === null ? null : str(b, 'endTime', { pattern: TIME });
  return out;
}

// ---------- routes ----------

export function registerAssignments(r: Router, db: DB): void {
  // ----- presets -----

  const usage = (presetId: number) => {
    const rows = all<{ id: number; display_name: string; default_preset_id: number | null }>(db, 'SELECT id, display_name, default_preset_id FROM assignments');
    const defaults = new Map(rows.map((a) => [a.id, a.default_preset_id]));
    const names = new Map(rows.map((a) => [a.id, a.display_name]));
    return {
      assignmentDefaults: rows.filter((a) => a.default_preset_id === presetId).map((a) => ({ assignmentId: a.id, assignment: a.display_name })),
      slots: [...loadAssignments(db).slots.values()]
        .filter((s) => (s.mode === 'preset' ? s.presetId === presetId : s.mode === 'default' && defaults.get(s.assignmentId) === presetId))
        .map((s) => ({
          slotId: s.id,
          assignmentId: s.assignmentId,
          label: `${names.get(s.assignmentId)} · ${s.name}`,
          how: s.mode === 'preset' ? 'override' : 'assignment default',
        })),
    };
  };

  r.get('/api/presets', ADMIN, () =>
    [...loadPresets(db).values()].map((p) => {
      const u = usage(p.id);
      return { id: p.id, name: p.name, description: p.description, rule: p.rule, text: describe(p.rule), usedBySlots: u.slots.length };
    }),
  );

  r.get('/api/presets/:id', ADMIN, (req) => {
    const p = loadPresets(db).get(idParam(req.params.id));
    if (!p) throw notFound('Criteria preset');
    const people = [...loadPersonnel(db).values()].filter((x) => x.active);
    const qualifying = people.filter((x) => evaluate(p.rule, x.certs)).map((x) => ({ personnelId: x.id, lgNumber: x.lgNumber, name: x.name }));
    return { id: p.id, name: p.name, description: p.description, rule: p.rule, text: describe(p.rule), usage: usage(p.id), qualifying, activeTotal: people.length };
  });

  // Live preview while editing a rule.
  r.post('/api/presets/preview', ADMIN, (req) => {
    const b = obj(req.body);
    const rule = ruleFrom(db, b.rule);
    const people = [...loadPersonnel(db).values()].filter((x) => x.active);
    const qualifying = people.filter((x) => evaluate(rule, x.certs)).map((x) => ({ personnelId: x.id, lgNumber: x.lgNumber, name: x.name }));
    return { rule, text: describe(rule), qualifying, count: qualifying.length, activeTotal: people.length };
  });

  r.post('/api/presets', ADMIN, (req) => {
    const b = obj(req.body);
    const name = str(b, 'name', { max: 80 });
    const rule = ruleFrom(db, b.rule);
    const description = optStr(b, 'description', { min: 0, max: 300 }) ?? '';
    const { lastId } = run(db, 'INSERT INTO criteria_presets (name, rule_json, description) VALUES (?, ?, ?)', name, JSON.stringify(rule), description);
    audit(db, req.user.id, 'preset.create', { id: lastId, name });
    return created({ id: lastId, name, description, rule, text: describe(rule) });
  });

  r.patch('/api/presets/:id', ADMIN, (req) => {
    const id = idParam(req.params.id);
    const p = loadPresets(db).get(id);
    if (!p) throw notFound('Criteria preset');
    const b = obj(req.body);
    const name = optStr(b, 'name', { max: 80 }) ?? p.name;
    const rule = has(b, 'rule') ? ruleFrom(db, b.rule) : p.rule;
    const description = optStr(b, 'description', { min: 0, max: 300 }) ?? p.description;
    run(db, 'UPDATE criteria_presets SET name = ?, rule_json = ?, description = ? WHERE id = ?', name, JSON.stringify(rule), description, id);
    audit(db, req.user.id, 'preset.update', { id });
    return { id, name, description, rule, text: describe(rule), usage: usage(id) };
  });

  r.delete('/api/presets/:id', ADMIN, (req) => {
    const id = idParam(req.params.id);
    if (!loadPresets(db).has(id)) throw notFound('Criteria preset');
    const u = usage(id);
    if ((u.slots.length || u.assignmentDefaults.length) && req.query.get('force') !== 'true') {
      throw new HttpError(409, 'preset_in_use', 'This preset is in use. Pass ?force=true to delete it; those slots will fall back to their assignment default (or no requirement).', u);
    }
    tx(db, () => {
      run(db, "UPDATE slots SET criteria_mode = 'default', preset_id = NULL WHERE criteria_mode = 'preset' AND preset_id = ?", id);
      run(db, 'DELETE FROM criteria_presets WHERE id = ?', id);
      audit(db, req.user.id, 'preset.delete', { id });
    });
    return { ok: true };
  });

  // ----- assignments -----

  r.get('/api/assignments', ADMIN, (req) => {
    const kind = req.query.get('kind');
    const ids = all<{ id: number }>(db, 'SELECT id FROM assignments ORDER BY sort_order, id');
    return ids.map((a) => assignmentJson(db, a.id)!).filter((a) => !kind || a.kind === kind);
  });

  r.get('/api/assignments/:id', ADMIN, (req) => assignmentJson(db, idParam(req.params.id)) ?? (() => { throw notFound('Assignment'); })());

  r.post('/api/assignments', ADMIN, (req) => {
    const b = obj(req.body);
    const code = str(b, 'code', { max: 30, pattern: /^[A-Za-z0-9_-]+$/ });
    const kind = oneOf(b, 'kind', KINDS);
    const displayName = str(b, 'displayName', { max: 60 });
    const slotCount = optInt(b, 'slotCount', { min: 0, max: 30 }) ?? 1;
    const defaultPresetId = has(b, 'defaultPresetId') && b.defaultPresetId !== null ? int(b, 'defaultPresetId', { min: 1 }) : null;
    const t = readTimes(b);
    const id = tx(db, () => {
      const sort = optInt(b, 'sortOrder') ?? get<{ m: number }>(db, 'SELECT COALESCE(MAX(sort_order), 0) + 10 AS m FROM assignments')!.m;
      const { lastId } = run(
        db,
        'INSERT INTO assignments (code, kind, display_name, active, sort_order, default_preset_id, open_by_default, start_time, end_time) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        code,
        kind,
        displayName,
        bool(optBool(b, 'active') ?? true),
        sort,
        defaultPresetId,
        bool(optBool(b, 'openByDefault') ?? true),
        t.start ?? null,
        t.end ?? null,
      );
      for (let i = 1; i <= slotCount; i++) run(db, 'INSERT INTO slots (assignment_id, position, name) VALUES (?, ?, ?)', lastId, i, `Slot ${i}`);
      audit(db, req.user.id, 'assignment.create', { id: lastId, code });
      return lastId;
    });
    return created(assignmentJson(db, id));
  });

  r.patch('/api/assignments/:id', ADMIN, (req) => {
    const id = idParam(req.params.id);
    if (!get(db, 'SELECT id FROM assignments WHERE id = ?', id)) throw notFound('Assignment');
    const b = obj(req.body);
    tx(db, () => {
      const name = optStr(b, 'displayName', { max: 60 });
      if (name) run(db, 'UPDATE assignments SET display_name = ? WHERE id = ?', name, id);
      const active = optBool(b, 'active');
      if (active !== undefined) run(db, 'UPDATE assignments SET active = ? WHERE id = ?', bool(active), id);
      const open = optBool(b, 'openByDefault');
      if (open !== undefined) run(db, 'UPDATE assignments SET open_by_default = ? WHERE id = ?', bool(open), id);
      const sort = optInt(b, 'sortOrder');
      if (sort !== undefined) run(db, 'UPDATE assignments SET sort_order = ? WHERE id = ?', sort, id);
      if (has(b, 'defaultPresetId')) {
        const pid = b.defaultPresetId === null ? null : int(b, 'defaultPresetId', { min: 1 });
        if (pid !== null && !get(db, 'SELECT id FROM criteria_presets WHERE id = ?', pid)) throw notFound('Criteria preset');
        run(db, 'UPDATE assignments SET default_preset_id = ? WHERE id = ?', pid, id);
      }
      const t = readTimes(b);
      if (t.start !== undefined) run(db, 'UPDATE assignments SET start_time = ? WHERE id = ?', t.start, id);
      if (t.end !== undefined) run(db, 'UPDATE assignments SET end_time = ? WHERE id = ?', t.end, id);
      audit(db, req.user.id, 'assignment.update', { id, fields: Object.keys(b) });
    });
    return assignmentJson(db, id);
  });

  r.delete('/api/assignments/:id', ADMIN, (req) => {
    const id = idParam(req.params.id);
    const slotIds = all<{ id: number }>(db, 'SELECT id FROM slots WHERE assignment_id = ?', id).map((s) => s.id);
    const n = futureEntries(db, slotIds);
    if (n && req.query.get('force') !== 'true') {
      throw new HttpError(409, 'has_entries', `${n} upcoming assignments use this. Deactivate it instead, or pass ?force=true to delete them too.`);
    }
    const { changes } = run(db, 'DELETE FROM assignments WHERE id = ?', id);
    if (!changes) throw notFound('Assignment');
    audit(db, req.user.id, 'assignment.delete', { id });
    return { ok: true };
  });

  // ----- slots -----

  r.post('/api/assignments/:id/slots', ADMIN, (req) => {
    const id = idParam(req.params.id);
    if (!get(db, 'SELECT id FROM assignments WHERE id = ?', id)) throw notFound('Assignment');
    const b = obj(req.body);
    const criteria = has(b, 'criteria') ? parseCriteria(db, b.criteria) : null;
    const slotId = tx(db, () => {
      const pos = get<{ m: number }>(db, 'SELECT COALESCE(MAX(position), 0) + 1 AS m FROM slots WHERE assignment_id = ?', id)!.m;
      const name = optStr(b, 'name', { max: 40 }) ?? `Slot ${pos}`;
      const { lastId } = run(db, 'INSERT INTO slots (assignment_id, position, name) VALUES (?, ?, ?)', id, pos, name);
      if (criteria) writeCriteria(db, lastId, criteria);
      audit(db, req.user.id, 'slot.create', { assignmentId: id, slotId: lastId });
      return lastId;
    });
    return created({ slotId, assignment: assignmentJson(db, id) });
  });

  // Set the number of slots: adds "Slot N" at the end or removes from the end.
  r.put('/api/assignments/:id/slot-count', ADMIN, (req) => {
    const id = idParam(req.params.id);
    if (!get(db, 'SELECT id FROM assignments WHERE id = ?', id)) throw notFound('Assignment');
    const count = int(obj(req.body), 'count', { min: 0, max: 30 });
    tx(db, () => {
      const slots = all<{ id: number }>(db, 'SELECT id FROM slots WHERE assignment_id = ? ORDER BY position, id', id);
      if (count < slots.length) {
        const removing = slots.slice(count).map((s) => s.id);
        const n = futureEntries(db, removing);
        if (n && req.query.get('force') !== 'true') {
          throw new HttpError(409, 'has_entries', `The slots being removed have ${n} upcoming assignments. Pass ?force=true to remove them too.`);
        }
        for (const sid of removing) run(db, 'DELETE FROM slots WHERE id = ?', sid);
      } else {
        for (let i = slots.length + 1; i <= count; i++) run(db, 'INSERT INTO slots (assignment_id, position, name) VALUES (?, ?, ?)', id, i, `Slot ${i}`);
      }
      renumber(db, id);
      audit(db, req.user.id, 'assignment.slot_count', { id, count });
    });
    return assignmentJson(db, id);
  });

  r.put('/api/assignments/:id/slots/order', ADMIN, (req) => {
    const id = idParam(req.params.id);
    const b = obj(req.body);
    if (!Array.isArray(b.slotIds)) throw bad('slotIds', 'must be an array of slot ids in the new order');
    const current = all<{ id: number }>(db, 'SELECT id FROM slots WHERE assignment_id = ?', id).map((s) => s.id);
    const given = b.slotIds.map(Number);
    if (given.length !== current.length || !current.every((sid) => given.includes(sid))) {
      throw bad('slotIds', 'must list every slot of this assignment exactly once');
    }
    tx(db, () => given.forEach((sid, i) => run(db, 'UPDATE slots SET position = ? WHERE id = ?', i + 1, sid)));
    audit(db, req.user.id, 'assignment.slot_order', { id, order: given });
    return assignmentJson(db, id);
  });

  // Apply one preset to every slot (or reset all to the assignment default with presetId: null).
  r.post('/api/assignments/:id/apply-preset', ADMIN, (req) => {
    const id = idParam(req.params.id);
    if (!get(db, 'SELECT id FROM assignments WHERE id = ?', id)) throw notFound('Assignment');
    const b = obj(req.body);
    const pid = b.presetId === null || b.presetId === undefined ? null : int(b, 'presetId', { min: 1 });
    if (pid !== null && !get(db, 'SELECT id FROM criteria_presets WHERE id = ?', pid)) throw notFound('Criteria preset');
    if (pid === null) run(db, "UPDATE slots SET criteria_mode = 'default', preset_id = NULL, custom_rule_json = NULL WHERE assignment_id = ?", id);
    else run(db, "UPDATE slots SET criteria_mode = 'preset', preset_id = ?, custom_rule_json = NULL WHERE assignment_id = ?", pid, id);
    audit(db, req.user.id, 'assignment.apply_preset', { id, presetId: pid });
    return assignmentJson(db, id);
  });

  r.patch('/api/slots/:id', ADMIN, (req) => {
    const sid = idParam(req.params.id);
    const slot = get<{ assignment_id: number }>(db, 'SELECT assignment_id FROM slots WHERE id = ?', sid);
    if (!slot) throw notFound('Slot');
    const b = obj(req.body);
    tx(db, () => {
      const name = optStr(b, 'name', { max: 40 });
      if (name) run(db, 'UPDATE slots SET name = ? WHERE id = ?', name, sid);
      if (has(b, 'criteria')) writeCriteria(db, sid, parseCriteria(db, b.criteria));
      audit(db, req.user.id, 'slot.update', { slotId: sid, fields: Object.keys(b) });
    });
    return assignmentJson(db, slot.assignment_id);
  });

  r.delete('/api/slots/:id', ADMIN, (req) => {
    const sid = idParam(req.params.id);
    const slot = get<{ assignment_id: number }>(db, 'SELECT assignment_id FROM slots WHERE id = ?', sid);
    if (!slot) throw notFound('Slot');
    const n = futureEntries(db, [sid]);
    if (n && req.query.get('force') !== 'true') throw new HttpError(409, 'has_entries', `This slot has ${n} upcoming assignments. Pass ?force=true to remove them too.`);
    tx(db, () => {
      run(db, 'DELETE FROM slots WHERE id = ?', sid);
      renumber(db, slot.assignment_id);
      audit(db, req.user.id, 'slot.delete', { slotId: sid });
    });
    return assignmentJson(db, slot.assignment_id);
  });

  // Save the slot's current rule as a reusable preset and point the slot at it.
  r.post('/api/slots/:id/save-as-preset', ADMIN, (req) => {
    const sid = idParam(req.params.id);
    const s = loadAssignments(db).slots.get(sid);
    if (!s) throw notFound('Slot');
    if (!s.rule) throw new HttpError(409, 'no_rule', 'This slot has no requirement to save.');
    const name = str(obj(req.body), 'name', { max: 80 });
    const presetId = tx(db, () => {
      const { lastId } = run(db, 'INSERT INTO criteria_presets (name, rule_json) VALUES (?, ?)', name, JSON.stringify(s.rule));
      writeCriteria(db, sid, { mode: 'preset', presetId: lastId });
      audit(db, req.user.id, 'slot.save_as_preset', { slotId: sid, presetId: lastId });
      return lastId;
    });
    return created({ presetId, name, text: describe(s.rule), assignment: assignmentJson(db, s.assignmentId) });
  });
}

export { optOneOf };
