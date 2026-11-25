// Builds the weekly schedule view (Saturday–Friday) used by the grid, the API and PDF export.

import { get, type DB } from '../db/index.ts';
import { addDays, weekdayName } from '../domain/dates.ts';
import { availability } from '../domain/scheduling.ts';
import { buildWeekFromContext, type WeekView } from '../domain/week-view.ts';
import { loadContext } from './context.ts';

export * from '../domain/week-view.ts';

export function buildWeek(db: DB, weekStart: string): WeekView {
  const ctx = loadContext(db, weekStart, addDays(weekStart, 6));
  const w = get<{ status: 'draft' | 'published'; published_at: string | null }>(db, 'SELECT status, published_at FROM weeks WHERE week_start = ?', weekStart);
  return buildWeekFromContext(ctx, weekStart, w?.status ?? 'draft', w?.published_at ?? null);
}

/** One lifeguard's week: availability and assignments per day. */
export function entriesForPerson(db: DB, personnelId: number, dates: string[]) {
  const ctx = loadContext(db, dates[0], dates[dates.length - 1]);
  const p = ctx.personnel.get(personnelId);
  if (!p) return [];
  return dates.map((date) => {
    const av = availability(p, date);
    const assignments = ctx.entries
      .filter((e) => e.date === date && e.personnelId === personnelId)
      .map((e) => {
        const s = ctx.slots.get(e.slotId)!;
        const a = ctx.assignments.get(s.assignmentId)!;
        return { entryId: e.id, assignment: a.displayName, assignmentId: a.id, slot: s.name, slotId: s.id, criteria: s.ruleText, locked: e.locked };
      });
    return { date, weekday: weekdayName(date), available: av.available, unavailableReason: av.reason, assignments };
  });
}
