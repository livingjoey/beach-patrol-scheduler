// Pure week-view builder (no database), shared by the API, PDF export and the browser app.

import { addDays, weekDates, weekdayName } from './dates.ts';
import { activeSlots, checkAssignment, isOpen, type AssignmentKind, type Issue, type LabelColor, type ScheduleContext } from './scheduling.ts';

export interface SlotView {
  slotId: number;
  name: string;
  position: number;
  criteria: string;
  presetName: string | null;
  entry: null | {
    id: number;
    personnelId: number;
    lgNumber: string;
    name: string;
    labelColor: LabelColor;
    locked: boolean;
    source: string;
    overrideReason: string | null;
    issues: Issue[];
  };
}

export interface AssignmentView {
  assignmentId: number;
  code: string;
  kind: AssignmentKind;
  displayName: string;
  open: boolean;
  /** Slots the assignment has in total (its most guards); `slots` holds only those used this day. */
  capacity: number;
  slots: SlotView[];
}

export interface DayView {
  date: string;
  weekday: string;
  assignments: AssignmentView[];
  stats: { openSlots: number; filled: number; empty: number; conflicts: number; closedAssignments: number };
}

export interface WeekView {
  weekStart: string;
  weekEnd: string;
  status: 'draft' | 'published';
  publishedAt: string | null;
  days: DayView[];
  totals: { openSlots: number; filled: number; empty: number; conflicts: number };
}

export function buildWeekFromContext(ctx: ScheduleContext, weekStart: string, status: WeekView['status'] = 'draft', publishedAt: string | null = null): WeekView {
  const dates = weekDates(weekStart);
  const entryAt = new Map(ctx.entries.map((e) => [`${e.date}|${e.slotId}`, e]));
  const assignments = [...ctx.assignments.values()].filter((a) => a.active).sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);
  const totals = { openSlots: 0, filled: 0, empty: 0, conflicts: 0 };

  const days: DayView[] = dates.map((date) => {
    const stats = { openSlots: 0, filled: 0, empty: 0, conflicts: 0, closedAssignments: 0 };
    const views: AssignmentView[] = assignments.map((a) => {
      const open = isOpen(ctx, a.id, date);
      if (!open) stats.closedAssignments++;
      const slots: SlotView[] = activeSlots(ctx, a, date).map((s) => {
        const e = entryAt.get(`${date}|${s.id}`);
        if (open) stats.openSlots++;
        if (!e) {
          if (open) stats.empty++;
          return { slotId: s.id, name: s.name, position: s.position, criteria: s.ruleText, presetName: s.presetName, entry: null };
        }
        const p = ctx.personnel.get(e.personnelId)!;
        const issues = checkAssignment(ctx, { date, slotId: s.id, personnelId: p.id, ignoreEntryIds: [e.id] });
        if (open) stats.filled++;
        if (issues.length && !(e.overrideReason && issues.every((i) => i.overridable))) stats.conflicts++;
        return {
          slotId: s.id,
          name: s.name,
          position: s.position,
          criteria: s.ruleText,
          presetName: s.presetName,
          entry: {
            id: e.id,
            personnelId: p.id,
            lgNumber: p.lgNumber,
            name: p.name,
            labelColor: p.labelColor,
            locked: e.locked,
            source: e.source,
            overrideReason: e.overrideReason,
            issues,
          },
        };
      });
      return { assignmentId: a.id, code: a.code, kind: a.kind, displayName: a.displayName, open, capacity: a.slots.length, slots };
    });
    totals.openSlots += stats.openSlots;
    totals.filled += stats.filled;
    totals.empty += stats.empty;
    totals.conflicts += stats.conflicts;
    return { date, weekday: weekdayName(date), assignments: views, stats };
  });
  return { weekStart, weekEnd: addDays(weekStart, 6), status, publishedAt, days, totals };
}

