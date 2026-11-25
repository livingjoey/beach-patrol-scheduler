// Weekly Schedule Builder: week view, candidates, assigning (drag-and-drop), open/close, Auto-Fill, copy and publish.

import { all, audit, bool, get, getSetting, run, tx, type DB } from '../db/index.ts';
import { addDays, isIsoDate, weekDates, weekStartOf, todayIso } from '../domain/dates.ts';
import { candidatesFor, checkAssignment, planAutoFill, type Issue } from '../domain/scheduling.ts';
import { ADMIN, created, HttpError, type AuthUser, type Router } from '../http/app.ts';
import { bad, boolean, date, has, idParam, int, notFound, obj, oneOf, optBool, optInt, queryDate, str, type Body } from '../http/validate.ts';
import { loadContext } from '../services/context.ts';
import { buildWeek } from '../services/week.ts';

function weekParam(raw: string | null): string {
  if (raw !== null && !isIsoDate(raw)) throw bad('week', 'must be a date like 2027-06-05');
  return weekStartOf(raw ?? todayIso());
}

function contextForDate(db: DB, d: string) {
  const start = weekStartOf(d);
  return { start, ctx: loadContext(db, start, addDays(start, 6)) };
}

interface EntryRow {
  id: number;
  date: string;
  slot_id: number;
  personnel_id: number;
  locked: number;
  source: string;
  override_by: number | null;
  override_reason: string | null;
}

function entryJson(db: DB, id: number) {
  const e = get<EntryRow & { lg_number: string; name: string; label_color: string }>(
    db,
    `SELECT e.*, p.lg_number, p.name, p.label_color FROM schedule_entries e JOIN personnel p ON p.id = e.personnel_id WHERE e.id = ?`,
    id,
  );
  if (!e) return null;
  return {
    id: e.id,
    date: e.date,
    slotId: e.slot_id,
    personnelId: e.personnel_id,
    lgNumber: e.lg_number,
    name: e.name,
    labelColor: e.label_color,
    locked: e.locked === 1,
    source: e.source,
    overrideBy: e.override_by,
    overrideReason: e.override_reason,
  };
}

/** Decides whether an assignment may go ahead; throws a descriptive 409/403 otherwise. */
function gate(db: DB, user: AuthUser, issues: Issue[], b: Body): { reason: string | null } {
  const blocking = issues.filter((i) => !i.overridable);
  if (blocking.length) throw new HttpError(409, 'blocked', blocking.map((i) => i.message).join(' '), { issues });
  if (!issues.length) return { reason: null };
  const overridesEnabled = getSetting(db, 'overrides_enabled', 'true') === 'true';
  if (!has(b, 'override')) {
    throw new HttpError(409, 'needs_override', 'This assignment breaks a scheduling rule and needs a supervisor override.', {
      issues,
      overridesEnabled,
      youCanOverride: overridesEnabled && user.canOverride,
    });
  }
  if (!overridesEnabled) throw new HttpError(403, 'overrides_disabled', 'Supervisor overrides are turned off in settings.', { issues });
  if (!user.canOverride) throw new HttpError(403, 'override_not_permitted', 'Your account cannot approve overrides. Ask an admin who can.', { issues });
  const reason = str(obj(b.override, 'override'), 'reason', { min: 3, max: 300 });
  return { reason };
}

export function registerSchedule(r: Router, db: DB): void {
  r.get('/api/schedule/week', ADMIN, (req) => buildWeek(db, weekParam(req.query.get('start') ?? req.query.get('week'))));

  // Selecting a slot: qualified + available first, then the rest with reasons.
  r.get('/api/schedule/candidates', ADMIN, (req) => {
    const d = queryDate(req.query, 'date');
    const slotId = idParam(req.query.get('slotId') ?? undefined, 'slotId');
    const { start, ctx } = contextForDate(db, d);
    if (!ctx.slots.has(slotId)) throw notFound('Slot');
    return { date: d, ...candidatesFor(ctx, d, slotId, weekDates(start)) };
  });

  // Dry run used while dragging over a slot.
  r.post('/api/schedule/check', ADMIN, (req) => {
    const b = obj(req.body);
    const d = date(b, 'date');
    const slotId = int(b, 'slotId', { min: 1 });
    const personnelId = int(b, 'personnelId', { min: 1 });
    const moveFrom = optInt(b, 'moveFromEntryId', { min: 1 });
    const { ctx } = contextForDate(db, d);
    const existing = ctx.entries.find((e) => e.date === d && e.slotId === slotId);
    const issues = checkAssignment(ctx, { date: d, slotId, personnelId, ignoreEntryIds: [existing?.id ?? 0, moveFrom ?? 0] });
    const overridesEnabled = getSetting(db, 'overrides_enabled', 'true') === 'true';
    return {
      issues,
      slotFilled: existing ? { entryId: existing.id, personnelId: existing.personnelId, locked: existing.locked } : null,
      canAssign: issues.length === 0 && !existing?.locked,
      needsOverride: issues.length > 0 && issues.every((i) => i.overridable),
      blocked: issues.some((i) => !i.overridable) || !!existing?.locked,
      youCanOverride: overridesEnabled && req.user.canOverride,
    };
  });

  // Assign (drop) a lifeguard into a slot. Use moveFromEntryId when dragging from another slot,
  // replace: true to swap out whoever is there, and override: { reason } to accept rule exceptions.
  r.put('/api/schedule/entries', ADMIN, (req) => {
    const b = obj(req.body);
    const d = date(b, 'date');
    const slotId = int(b, 'slotId', { min: 1 });
    const personnelId = int(b, 'personnelId', { min: 1 });
    const locked = optBool(b, 'locked') ?? false;
    const replace = optBool(b, 'replace') ?? false;
    const moveFrom = optInt(b, 'moveFromEntryId', { min: 1 });

    const id = tx(db, () => {
      const { ctx } = contextForDate(db, d);
      const existing = ctx.entries.find((e) => e.date === d && e.slotId === slotId);
      if (existing && existing.personnelId === personnelId && !moveFrom) {
        run(db, 'UPDATE schedule_entries SET locked = ? WHERE id = ?', bool(locked || existing.locked), existing.id);
        return existing.id;
      }
      if (existing?.locked) throw new HttpError(409, 'slot_locked', 'This slot is locked. Unlock it first.', { entryId: existing.id });
      if (existing && !replace) {
        const p = ctx.personnel.get(existing.personnelId);
        throw new HttpError(409, 'slot_filled', `${p?.lgNumber ?? 'Someone'} is already in this slot. Send replace: true to swap.`, { entryId: existing.id });
      }
      let moving = null;
      if (moveFrom) {
        moving = get<EntryRow>(db, 'SELECT * FROM schedule_entries WHERE id = ?', moveFrom);
        if (!moving) throw notFound('Entry to move');
        if (moving.locked) throw new HttpError(409, 'entry_locked', 'The entry you are moving is locked.');
        if (moving.personnel_id !== personnelId) throw bad('moveFromEntryId', 'belongs to a different lifeguard');
      }
      const issues = checkAssignment(ctx, { date: d, slotId, personnelId, ignoreEntryIds: [existing?.id ?? 0, moveFrom ?? 0] });
      const { reason } = gate(db, req.user, issues, b);
      if (existing) run(db, 'DELETE FROM schedule_entries WHERE id = ?', existing.id);
      if (moving) run(db, 'DELETE FROM schedule_entries WHERE id = ?', moving.id);
      const { lastId } = run(
        db,
        `INSERT INTO schedule_entries (date, slot_id, personnel_id, locked, source, override_by, override_reason, override_issues, created_by)
         VALUES (?, ?, ?, ?, 'manual', ?, ?, ?, ?)`,
        d,
        slotId,
        personnelId,
        bool(locked),
        reason ? req.user.id : null,
        reason,
        reason ? JSON.stringify(issues) : null,
        req.user.id,
      );
      audit(db, req.user.id, reason ? 'schedule.assign_override' : 'schedule.assign', { date: d, slotId, personnelId, replaced: existing?.id, moved: moveFrom, reason, issues });
      return lastId;
    });
    return entryJson(db, id);
  });

  r.patch('/api/schedule/entries/:id', ADMIN, (req) => {
    const id = idParam(req.params.id);
    const locked = boolean(obj(req.body), 'locked');
    const { changes } = run(db, 'UPDATE schedule_entries SET locked = ? WHERE id = ?', bool(locked), id);
    if (!changes) throw notFound('Entry');
    audit(db, req.user.id, locked ? 'schedule.lock' : 'schedule.unlock', { id });
    return entryJson(db, id);
  });

  r.delete('/api/schedule/entries/:id', ADMIN, (req) => {
    const id = idParam(req.params.id);
    const e = get<EntryRow>(db, 'SELECT * FROM schedule_entries WHERE id = ?', id);
    if (!e) throw notFound('Entry');
    if (e.locked && req.query.get('force') !== 'true') throw new HttpError(409, 'entry_locked', 'This assignment is locked. Unlock it or pass ?force=true.');
    run(db, 'DELETE FROM schedule_entries WHERE id = ?', id);
    audit(db, req.user.id, 'schedule.unassign', { id, date: e.date, slotId: e.slot_id, personnelId: e.personnel_id });
    return { ok: true };
  });

  // Open or close an assignment on one day.
  r.put('/api/schedule/day-status', ADMIN, (req) => {
    const b = obj(req.body);
    const assignmentId = int(b, 'assignmentId', { min: 1 });
    const d = date(b, 'date');
    const open = boolean(b, 'open');
    const clear = optBool(b, 'clearEntries') ?? false;
    const a = get<{ open_by_default: number; display_name: string }>(db, 'SELECT open_by_default, display_name FROM assignments WHERE id = ?', assignmentId);
    if (!a) throw notFound('Assignment');
    return tx(db, () => {
      if (!open) {
        const entries = all<{ id: number; locked: number; lg_number: string }>(
          db,
          `SELECT e.id, e.locked, p.lg_number FROM schedule_entries e JOIN slots s ON s.id = e.slot_id JOIN personnel p ON p.id = e.personnel_id
           WHERE s.assignment_id = ? AND e.date = ?`,
          assignmentId,
          d,
        );
        if (entries.length && !clear) {
          throw new HttpError(409, 'has_entries', `${a.display_name} has ${entries.length} people assigned on ${d}. Send clearEntries: true to close it and remove them.`, {
            entries: entries.map((e) => ({ entryId: e.id, lgNumber: e.lg_number, locked: e.locked === 1 })),
          });
        }
        for (const e of entries) run(db, 'DELETE FROM schedule_entries WHERE id = ?', e.id);
      }
      if (open === (a.open_by_default === 1)) run(db, 'DELETE FROM assignment_day_status WHERE assignment_id = ? AND date = ?', assignmentId, d);
      else run(db, 'INSERT INTO assignment_day_status (assignment_id, date, open) VALUES (?, ?, ?) ON CONFLICT(assignment_id, date) DO UPDATE SET open = excluded.open', assignmentId, d, bool(open));
      audit(db, req.user.id, open ? 'schedule.open' : 'schedule.close', { assignmentId, date: d });
      return { assignmentId, date: d, open };
    });
  });

  // Auto-Fill: the whole week or one day, optionally only empty slots. dryRun previews without saving.
  r.post('/api/schedule/autofill', ADMIN, (req) => {
    const b = obj(req.body);
    const start = weekStartOf(date(b, 'weekStart'));
    const scope = oneOf(b, 'scope', ['week', 'day'] as const);
    const onlyEmpty = optBool(b, 'onlyEmpty') ?? true;
    const dryRun = optBool(b, 'dryRun') ?? false;
    const days = weekDates(start);
    let dates = days;
    if (scope === 'day') {
      const d = date(b, 'date');
      if (!days.includes(d)) throw bad('date', `must fall in the week starting ${start}`);
      dates = [d];
    }
    const result = tx(db, () => {
      const ctx = loadContext(db, start, days[6]);
      const plan = planAutoFill(ctx, { dates, weekDates: days, onlyEmpty });
      if (!dryRun) {
        for (const id of plan.remove) run(db, 'DELETE FROM schedule_entries WHERE id = ? AND locked = 0', id);
        for (const a of plan.assign) {
          run(db, "INSERT INTO schedule_entries (date, slot_id, personnel_id, source, created_by) VALUES (?, ?, ?, 'autofill', ?)", a.date, a.slotId, a.personnelId, req.user.id);
        }
        audit(db, req.user.id, 'schedule.autofill', { start, scope, dates, onlyEmpty, filled: plan.assign.length, unfilled: plan.unfilled.length });
      }
      return {
        dryRun,
        scope,
        dates,
        onlyEmpty,
        summary: { willFill: plan.assign.length, cannotFill: plan.unfilled.length, replaced: plan.remove.length, keptLocked: plan.keptLocked, keptExisting: plan.keptExisting },
        assignments: plan.assign.map((a) => {
          const s = ctx.slots.get(a.slotId)!;
          return { ...a, lgNumber: ctx.personnel.get(a.personnelId)!.lgNumber, assignment: ctx.assignments.get(s.assignmentId)!.displayName, slot: s.name };
        }),
        unfilled: plan.unfilled,
      };
    });
    return result;
  });

  // Copy one week's assignments onto another week (e.g. last week -> this week).
  r.post('/api/schedule/copy-week', ADMIN, (req) => {
    const b = obj(req.body);
    const from = weekStartOf(date(b, 'fromWeek'));
    const to = weekStartOf(date(b, 'toWeek'));
    if (from === to) throw bad('toWeek', 'must differ from fromWeek');
    const keepLocks = optBool(b, 'keepLocks') ?? false;
    return tx(db, () => {
      const source = loadContext(db, from, addDays(from, 6)).entries;
      const ctx = loadContext(db, to, addDays(to, 6));
      const offset = Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
      const copied: { date: string; slotId: number; personnelId: number }[] = [];
      const skipped: { date: string; slotId: number; lgNumber: string; reason: string }[] = [];
      for (const e of source.sort((a, b) => a.date.localeCompare(b.date))) {
        const d = addDays(e.date, offset);
        const lg = ctx.personnel.get(e.personnelId)?.lgNumber ?? '?';
        if (ctx.entries.some((x) => x.date === d && x.slotId === e.slotId)) {
          skipped.push({ date: d, slotId: e.slotId, lgNumber: lg, reason: 'Slot already filled' });
          continue;
        }
        const issues = checkAssignment(ctx, { date: d, slotId: e.slotId, personnelId: e.personnelId });
        if (issues.length) {
          skipped.push({ date: d, slotId: e.slotId, lgNumber: lg, reason: issues.map((i) => i.message).join(' ') });
          continue;
        }
        const { lastId } = run(
          db,
          "INSERT INTO schedule_entries (date, slot_id, personnel_id, locked, source, created_by) VALUES (?, ?, ?, ?, 'copy', ?)",
          d,
          e.slotId,
          e.personnelId,
          bool(keepLocks && e.locked),
          req.user.id,
        );
        ctx.entries.push({ id: lastId, date: d, slotId: e.slotId, personnelId: e.personnelId, locked: keepLocks && e.locked, source: 'copy', overrideReason: null });
        copied.push({ date: d, slotId: e.slotId, personnelId: e.personnelId });
      }
      audit(db, req.user.id, 'schedule.copy_week', { from, to, copied: copied.length, skipped: skipped.length });
      return created({ fromWeek: from, toWeek: to, copied: copied.length, skipped });
    });
  });

  // Clear a week (locked entries are kept unless includeLocked: true).
  r.post('/api/schedule/clear', ADMIN, (req) => {
    const b = obj(req.body);
    const start = weekStartOf(date(b, 'weekStart'));
    const includeLocked = optBool(b, 'includeLocked') ?? false;
    const { changes } = includeLocked
      ? run(db, 'DELETE FROM schedule_entries WHERE date BETWEEN ? AND ?', start, addDays(start, 6))
      : run(db, 'DELETE FROM schedule_entries WHERE date BETWEEN ? AND ? AND locked = 0', start, addDays(start, 6));
    audit(db, req.user.id, 'schedule.clear', { start, includeLocked, removed: changes });
    return { weekStart: start, removed: changes };
  });

  // ----- publishing -----

  const weekJson = (start: string) => {
    const w = get<{ status: string; published_at: string | null; published_by: number | null }>(db, 'SELECT * FROM weeks WHERE week_start = ?', start);
    return { weekStart: start, status: w?.status ?? 'draft', publishedAt: w?.published_at ?? null, publishedBy: w?.published_by ?? null };
  };

  r.get('/api/weeks/:start', ADMIN, (req) => weekJson(weekParam(req.params.start)));

  r.post('/api/weeks/:start/publish', ADMIN, (req) => {
    const start = weekParam(req.params.start);
    run(
      db,
      `INSERT INTO weeks (week_start, status, published_at, published_by) VALUES (?, 'published', datetime('now'), ?)
       ON CONFLICT(week_start) DO UPDATE SET status = 'published', published_at = excluded.published_at, published_by = excluded.published_by`,
      start,
      req.user.id,
    );
    audit(db, req.user.id, 'week.publish', { start });
    return weekJson(start);
  });

  r.post('/api/weeks/:start/unpublish', ADMIN, (req) => {
    const start = weekParam(req.params.start);
    run(db, "INSERT INTO weeks (week_start, status) VALUES (?, 'draft') ON CONFLICT(week_start) DO UPDATE SET status = 'draft'", start);
    audit(db, req.user.id, 'week.unpublish', { start });
    return weekJson(start);
  });

  r.get('/api/audit', ADMIN, (req) => {
    const limit = Math.min(Number(req.query.get('limit') ?? 100) || 100, 500);
    return all<{ id: number; at: string; user_id: number | null; identifier: string | null; action: string; detail_json: string }>(
      db,
      'SELECT a.*, u.identifier FROM audit_log a LEFT JOIN users u ON u.id = a.user_id ORDER BY a.id DESC LIMIT ?',
      limit,
    ).map((a) => ({ id: a.id, at: a.at, admin: a.identifier, action: a.action, detail: JSON.parse(a.detail_json) }));
  });
}
