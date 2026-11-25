// Loads the data the scheduling rules need into memory.
// A patrol has tens of lifeguards and slots, so loading a week at a time is cheap.

import { all, type DB } from '../db/index.ts';
import { describe, effectiveCerts, type Equivalency, type Rule } from '../domain/criteria.ts';
import type {
  AssignmentCtx,
  AssignmentKind,
  EntryCtx,
  LabelColor,
  PersonCtx,
  ScheduleContext,
  SlotCtx,
  TimeOffCtx,
  TimeOffType,
} from '../domain/scheduling.ts';

export function loadEquivalencies(db: DB): Equivalency[] {
  return all<{ holder_code: string; satisfies_code: string }>(
    db,
    'SELECT holder_code, satisfies_code FROM cert_equivalencies WHERE enabled = 1',
  ).map((r) => ({ holder: r.holder_code, satisfies: r.satisfies_code }));
}

export function knownCertCodes(db: DB): Set<string> {
  return new Set(all<{ code: string }>(db, 'SELECT code FROM certifications').map((r) => r.code));
}

export function loadPersonnel(db: DB, range?: { from: string; to: string }): Map<number, PersonCtx> {
  const eqs = loadEquivalencies(db);
  const rows = all<{ id: number; lg_number: string; name: string; active: number; label_color: LabelColor }>(
    db,
    'SELECT id, lg_number, name, active, label_color FROM personnel',
  );
  const certs = all<{ personnel_id: number; cert_code: string }>(
    db,
    `SELECT pc.personnel_id, pc.cert_code FROM personnel_certs pc
     JOIN certifications c ON c.code = pc.cert_code ORDER BY c.sort_order, c.code`,
  );
  const daysOff = all<{ personnel_id: number; weekday: number }>(db, 'SELECT personnel_id, weekday FROM personnel_days_off');
  const timeOff = range
    ? all<{ id: number; personnel_id: number; start_date: string; end_date: string; type: TimeOffType; note: string }>(
        db,
        'SELECT id, personnel_id, start_date, end_date, type, note FROM time_off WHERE end_date >= ? AND start_date <= ?',
        range.from,
        range.to,
      )
    : [];

  const map = new Map<number, PersonCtx>();
  for (const r of rows) {
    map.set(r.id, {
      id: r.id,
      lgNumber: r.lg_number,
      name: r.name,
      active: r.active === 1,
      labelColor: r.label_color,
      heldCerts: [],
      certs: new Set(),
      daysOff: new Set(),
      timeOff: [],
    });
  }
  for (const c of certs) map.get(c.personnel_id)?.heldCerts.push(c.cert_code);
  for (const d of daysOff) map.get(d.personnel_id)?.daysOff.add(d.weekday);
  for (const t of timeOff) {
    const item: TimeOffCtx = { id: t.id, personnelId: t.personnel_id, startDate: t.start_date, endDate: t.end_date, type: t.type, note: t.note };
    map.get(t.personnel_id)?.timeOff.push(item);
  }
  for (const p of map.values()) p.certs = effectiveCerts(p.heldCerts, eqs);
  return map;
}

export interface PresetRow {
  id: number;
  name: string;
  rule: Rule;
  description: string;
}

export function loadPresets(db: DB): Map<number, PresetRow> {
  const rows = all<{ id: number; name: string; rule_json: string; description: string }>(
    db,
    'SELECT id, name, rule_json, description FROM criteria_presets ORDER BY name',
  );
  return new Map(rows.map((r) => [r.id, { id: r.id, name: r.name, rule: JSON.parse(r.rule_json) as Rule, description: r.description }]));
}

export function loadAssignments(db: DB): { assignments: Map<number, AssignmentCtx>; slots: Map<number, SlotCtx> } {
  const presets = loadPresets(db);
  const aRows = all<{
    id: number;
    code: string;
    kind: AssignmentKind;
    display_name: string;
    active: number;
    sort_order: number;
    default_preset_id: number | null;
    open_by_default: number;
    start_time: string | null;
    end_time: string | null;
  }>(db, 'SELECT * FROM assignments ORDER BY sort_order, id');
  const sRows = all<{
    id: number;
    assignment_id: number;
    position: number;
    name: string;
    criteria_mode: 'default' | 'preset' | 'custom';
    preset_id: number | null;
    custom_rule_json: string | null;
  }>(db, 'SELECT * FROM slots ORDER BY assignment_id, position, id');

  const assignments = new Map<number, AssignmentCtx>();
  const defaults = new Map<number, number | null>();
  for (const a of aRows) {
    defaults.set(a.id, a.default_preset_id);
    assignments.set(a.id, {
      id: a.id,
      code: a.code,
      kind: a.kind,
      displayName: a.display_name,
      active: a.active === 1,
      sortOrder: a.sort_order,
      openByDefault: a.open_by_default === 1,
      startTime: a.start_time,
      endTime: a.end_time,
      slots: [],
    });
  }
  const slots = new Map<number, SlotCtx>();
  for (const s of sRows) {
    let rule: Rule | null = null;
    let presetName: string | null = null;
    if (s.criteria_mode === 'custom' && s.custom_rule_json) {
      rule = JSON.parse(s.custom_rule_json) as Rule;
    } else {
      const pid = s.criteria_mode === 'preset' ? s.preset_id : defaults.get(s.assignment_id) ?? null;
      const preset = pid != null ? presets.get(pid) : undefined;
      if (preset) {
        rule = preset.rule;
        presetName = preset.name;
      }
    }
    const slot: SlotCtx = {
      id: s.id,
      assignmentId: s.assignment_id,
      position: s.position,
      name: s.name,
      mode: s.criteria_mode,
      presetId: s.preset_id,
      presetName,
      rule,
      ruleText: describe(rule),
    };
    slots.set(s.id, slot);
    assignments.get(s.assignment_id)?.slots.push(slot);
  }
  return { assignments, slots };
}

export function loadEntries(db: DB, from: string, to: string): EntryCtx[] {
  return all<{
    id: number;
    date: string;
    slot_id: number;
    personnel_id: number;
    locked: number;
    source: EntryCtx['source'];
    override_reason: string | null;
  }>(db, 'SELECT id, date, slot_id, personnel_id, locked, source, override_reason FROM schedule_entries WHERE date BETWEEN ? AND ?', from, to).map(
    (r) => ({
      id: r.id,
      date: r.date,
      slotId: r.slot_id,
      personnelId: r.personnel_id,
      locked: r.locked === 1,
      source: r.source,
      overrideReason: r.override_reason,
    }),
  );
}

export function loadContext(db: DB, from: string, to: string): ScheduleContext {
  const { assignments, slots } = loadAssignments(db);
  const dayStatus = new Map<string, boolean>();
  for (const r of all<{ assignment_id: number; date: string; open: number }>(
    db,
    'SELECT assignment_id, date, open FROM assignment_day_status WHERE date BETWEEN ? AND ?',
    from,
    to,
  )) {
    dayStatus.set(`${r.assignment_id}|${r.date}`, r.open === 1);
  }
  return {
    personnel: loadPersonnel(db, { from, to }),
    assignments,
    slots,
    dayStatus,
    entries: loadEntries(db, from, to),
  };
}
