// Time Off window: the regular weekly pattern and date-specific overrides.

import { all, audit, get, run, tx, type DB } from '../db/index.ts';
import { addDays, WEEKDAYS, weekDates, weekdayIndex, weekStartOf, todayIso } from '../domain/dates.ts';
import { availability } from '../domain/scheduling.ts';
import { ADMIN, created, HttpError, type Router } from '../http/app.ts';
import { bad, boolean, date, has, idParam, int, notFound, obj, oneOf, optOneOf, optStr, queryDate } from '../http/validate.ts';
import { loadPersonnel } from '../services/context.ts';
import { requirePerson } from './personnel.ts';

export const TIME_OFF_TYPES = ['vacation', 'leave', 'training', 'other', 'extra_workday'] as const;
const ABSENCE_TYPES = ['vacation', 'leave', 'training', 'other'] as const;

interface TimeOffRow {
  id: number;
  personnel_id: number;
  start_date: string;
  end_date: string;
  type: string;
  note: string;
  created_at: string;
}

const timeOffJson = (t: TimeOffRow) => ({
  id: t.id,
  personnelId: t.personnel_id,
  startDate: t.start_date,
  endDate: t.end_date,
  type: t.type,
  note: t.note,
  createdAt: t.created_at,
});

function weekMatrix(db: DB, weekStart: string, includeInactive: boolean) {
  const dates = weekDates(weekStart);
  const people = [...loadPersonnel(db, { from: dates[0], to: dates[6] }).values()]
    .filter((p) => includeInactive || p.active)
    .sort((a, b) => Number(a.lgNumber.slice(2)) - Number(b.lgNumber.slice(2)));
  const working = dates.map(() => 0);
  const rows = people.map((p) => ({
    personnelId: p.id,
    lgNumber: p.lgNumber,
    name: p.name,
    active: p.active,
    regularDaysOff: [...p.daysOff].sort().map((d) => WEEKDAYS[d]),
    days: dates.map((d, i) => {
      const av = availability(p, d);
      const extra = av.available && av.timeOffId !== null;
      if (av.available) working[i]++;
      return {
        date: d,
        weekday: WEEKDAYS[i],
        status: av.available ? 'working' : av.reason,
        isOverride: av.timeOffId !== null,
        extraWorkday: extra,
        timeOffId: av.timeOffId,
        note: av.note,
      };
    }),
  }));
  return { weekStart, dates, rows, workingPerDay: dates.map((d, i) => ({ date: d, working: working[i], ofActive: people.filter((p) => p.active).length })) };
}

export function registerAvailability(r: Router, db: DB): void {
  // Matrix: view=week (default, includes overrides) or view=pattern (regular weekly days off only).
  r.get('/api/availability', ADMIN, (req) => {
    const view = req.query.get('view') ?? 'week';
    const includeInactive = req.query.get('includeInactive') === 'true';
    if (view === 'pattern') {
      const people = [...loadPersonnel(db).values()]
        .filter((p) => includeInactive || p.active)
        .sort((a, b) => Number(a.lgNumber.slice(2)) - Number(b.lgNumber.slice(2)));
      return {
        view: 'pattern',
        weekdays: WEEKDAYS,
        rows: people.map((p) => ({
          personnelId: p.id,
          lgNumber: p.lgNumber,
          name: p.name,
          days: WEEKDAYS.map((w, i) => ({ weekday: w, off: p.daysOff.has(i) })),
        })),
      };
    }
    const start = weekStartOf(req.query.get('week') ?? todayIso());
    return { view: 'week', ...weekMatrix(db, start, includeInactive) };
  });

  // Toggle a regular weekly day off (repeats every week).
  r.put('/api/availability/pattern', ADMIN, (req) => {
    const b = obj(req.body);
    const pid = int(b, 'personnelId', { min: 1 });
    const weekday = WEEKDAYS.indexOf(oneOf(b, 'weekday', WEEKDAYS));
    const off = boolean(b, 'off');
    requirePerson(db, pid);
    if (off) run(db, 'INSERT OR IGNORE INTO personnel_days_off (personnel_id, weekday) VALUES (?, ?)', pid, weekday);
    else run(db, 'DELETE FROM personnel_days_off WHERE personnel_id = ? AND weekday = ?', pid, weekday);
    audit(db, req.user.id, 'availability.pattern', { pid, weekday: WEEKDAYS[weekday], off });
    return { personnelId: pid, weekday: WEEKDAYS[weekday], off };
  });

  // Click a cell in "this week" view: change one date only. The regular pattern is untouched.
  r.post('/api/availability/day', ADMIN, (req) => {
    const b = obj(req.body);
    const pid = int(b, 'personnelId', { min: 1 });
    const d = date(b, 'date');
    const working = boolean(b, 'working');
    const type = optOneOf(b, 'type', ABSENCE_TYPES) ?? 'other';
    const note = optStr(b, 'note', { min: 0, max: 300 }) ?? '';
    requirePerson(db, pid);
    return tx(db, () => {
      // Single-day overrides on this exact date are replaced; multi-day ones must be edited as a range.
      run(db, 'DELETE FROM time_off WHERE personnel_id = ? AND start_date = ? AND end_date = ?', pid, d, d);
      const range = get<TimeOffRow>(db, 'SELECT * FROM time_off WHERE personnel_id = ? AND start_date <= ? AND end_date >= ?', pid, d, d);
      if (range) {
        throw new HttpError(409, 'covered_by_range', `This date is part of a ${range.type} from ${range.start_date} to ${range.end_date}. Edit that entry instead.`, {
          timeOff: timeOffJson(range),
        });
      }
      const regularOff = !!get(db, 'SELECT 1 FROM personnel_days_off WHERE personnel_id = ? AND weekday = ?', pid, weekdayIndex(d));
      if (working && regularOff) {
        run(db, "INSERT INTO time_off (personnel_id, start_date, end_date, type, note, created_by) VALUES (?, ?, ?, 'extra_workday', ?, ?)", pid, d, d, note, req.user.id);
      } else if (!working && !regularOff) {
        run(db, 'INSERT INTO time_off (personnel_id, start_date, end_date, type, note, created_by) VALUES (?, ?, ?, ?, ?, ?)', pid, d, d, type, note, req.user.id);
      }
      audit(db, req.user.id, 'availability.day', { pid, date: d, working, type });
      const p = loadPersonnel(db, { from: d, to: d }).get(pid)!;
      const av = availability(p, d);
      return { personnelId: pid, date: d, status: av.available ? 'working' : av.reason, isOverride: av.timeOffId !== null, timeOffId: av.timeOffId };
    });
  });

  // ----- date overrides (vacations, leave, training, other, extra workdays) -----

  r.get('/api/time-off', ADMIN, (req) => {
    const from = req.query.get('from') ? queryDate(req.query, 'from') : '0000-01-01';
    const to = req.query.get('to') ? queryDate(req.query, 'to') : '9999-12-31';
    const pid = req.query.get('personnelId');
    const rows = pid
      ? all<TimeOffRow>(db, 'SELECT * FROM time_off WHERE personnel_id = ? AND end_date >= ? AND start_date <= ? ORDER BY start_date', idParam(pid, 'personnelId'), from, to)
      : all<TimeOffRow>(db, 'SELECT * FROM time_off WHERE end_date >= ? AND start_date <= ? ORDER BY start_date', from, to);
    return rows.map(timeOffJson);
  });

  r.post('/api/time-off', ADMIN, (req) => {
    const b = obj(req.body);
    const pid = int(b, 'personnelId', { min: 1 });
    const start = date(b, 'startDate');
    const end = has(b, 'endDate') ? date(b, 'endDate') : start;
    if (end < start) throw bad('endDate', 'must be on or after startDate');
    if (end > addDays(start, 366)) throw bad('endDate', 'must be within a year of startDate');
    const type = oneOf(b, 'type', TIME_OFF_TYPES);
    const note = optStr(b, 'note', { min: 0, max: 300 }) ?? '';
    requirePerson(db, pid);
    const { lastId } = run(db, 'INSERT INTO time_off (personnel_id, start_date, end_date, type, note, created_by) VALUES (?, ?, ?, ?, ?, ?)', pid, start, end, type, note, req.user.id);
    audit(db, req.user.id, 'timeoff.create', { id: lastId, pid, start, end, type });
    const conflicts = all<{ date: string; display_name: string }>(
      db,
      `SELECT e.date, a.display_name FROM schedule_entries e JOIN slots s ON s.id = e.slot_id JOIN assignments a ON a.id = s.assignment_id
       WHERE e.personnel_id = ? AND e.date BETWEEN ? AND ? ORDER BY e.date`,
      pid,
      start,
      end,
    );
    return created({
      ...timeOffJson(get<TimeOffRow>(db, 'SELECT * FROM time_off WHERE id = ?', lastId)!),
      // Existing assignments that now conflict, so the UI can flag them.
      conflictingAssignments: type === 'extra_workday' ? [] : conflicts.map((c) => ({ date: c.date, assignment: c.display_name })),
    });
  });

  r.patch('/api/time-off/:id', ADMIN, (req) => {
    const id = idParam(req.params.id);
    const t = get<TimeOffRow>(db, 'SELECT * FROM time_off WHERE id = ?', id);
    if (!t) throw notFound('Time off entry');
    const b = obj(req.body);
    const start = has(b, 'startDate') ? date(b, 'startDate') : t.start_date;
    const end = has(b, 'endDate') ? date(b, 'endDate') : t.end_date;
    if (end < start) throw bad('endDate', 'must be on or after startDate');
    const type = optOneOf(b, 'type', TIME_OFF_TYPES) ?? t.type;
    const note = optStr(b, 'note', { min: 0, max: 300 }) ?? t.note;
    run(db, 'UPDATE time_off SET start_date = ?, end_date = ?, type = ?, note = ? WHERE id = ?', start, end, type, note, id);
    audit(db, req.user.id, 'timeoff.update', { id });
    return timeOffJson(get<TimeOffRow>(db, 'SELECT * FROM time_off WHERE id = ?', id)!);
  });

  r.delete('/api/time-off/:id', ADMIN, (req) => {
    const id = idParam(req.params.id);
    const { changes } = run(db, 'DELETE FROM time_off WHERE id = ?', id);
    if (!changes) throw notFound('Time off entry');
    audit(db, req.user.id, 'timeoff.delete', { id });
    return { ok: true };
  });
}
