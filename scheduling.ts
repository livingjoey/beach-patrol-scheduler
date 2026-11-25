// Pure scheduling rules: availability, assignment checks, candidate ranking and Auto-Fill.
// Everything here works on an in-memory ScheduleContext so it is easy to test.

import { describe, evaluate, missing, type Rule } from './criteria.ts';
import { weekdayIndex } from './dates.ts';

export type TimeOffType = 'vacation' | 'leave' | 'training' | 'other' | 'extra_workday';
export type AssignmentKind = 'stand' | 'medical' | 'pwc' | 'boat' | 'extra';
export type LabelColor = 'red' | 'light_blue' | 'green' | 'dark_blue' | 'white';

export interface TimeOffCtx {
  id: number;
  personnelId: number;
  startDate: string;
  endDate: string;
  type: TimeOffType;
  note: string;
}

export interface PersonCtx {
  id: number;
  lgNumber: string;
  name: string;
  active: boolean;
  labelColor: LabelColor;
  heldCerts: string[];
  certs: Set<string>; // effective (held + enabled equivalencies)
  daysOff: Set<number>; // regular, 0 = Saturday
  timeOff: TimeOffCtx[];
}

export interface SlotCtx {
  id: number;
  assignmentId: number;
  position: number;
  name: string;
  mode: 'default' | 'preset' | 'custom';
  presetId: number | null;
  presetName: string | null; // name of the preset actually in effect, if any
  rule: Rule | null;
  ruleText: string;
}

export interface AssignmentCtx {
  id: number;
  code: string;
  kind: AssignmentKind;
  displayName: string;
  active: boolean;
  sortOrder: number;
  openByDefault: boolean;
  startTime: string | null;
  endTime: string | null;
  slots: SlotCtx[];
}

export interface EntryCtx {
  id: number;
  date: string;
  slotId: number;
  personnelId: number;
  locked: boolean;
  source: 'manual' | 'autofill' | 'copy';
  overrideReason: string | null;
}

export interface ScheduleContext {
  personnel: Map<number, PersonCtx>;
  assignments: Map<number, AssignmentCtx>;
  slots: Map<number, SlotCtx>;
  dayStatus: Map<string, boolean>; // `${assignmentId}|${date}`
  entries: EntryCtx[]; // every entry in the loaded date range
  /** Guards used on a day, when a staffing layout uses fewer than the assignment's slots. `${assignmentId}|${date}` */
  slotLimit?: Map<string, number>;
}

/** The slots an assignment actually uses on a date (the first N, when a layout limits it). */
export function activeSlots(ctx: ScheduleContext, asg: AssignmentCtx, date: string): SlotCtx[] {
  const n = ctx.slotLimit?.get(`${asg.id}|${date}`);
  return n === undefined ? asg.slots : asg.slots.slice(0, Math.max(0, n));
}

// ---------- availability ----------

export type Unavailability = 'inactive' | 'regular_day_off' | Exclude<TimeOffType, 'extra_workday'>;

export interface Availability {
  available: boolean;
  reason: Unavailability | null;
  timeOffId: number | null;
  note: string;
}

export function availability(p: PersonCtx, date: string): Availability {
  if (!p.active) return { available: false, reason: 'inactive', timeOffId: null, note: '' };
  const overrides = p.timeOff.filter((t) => t.startDate <= date && t.endDate >= date);
  const absence = overrides.find((t) => t.type !== 'extra_workday');
  if (absence) {
    return { available: false, reason: absence.type as Unavailability, timeOffId: absence.id, note: absence.note };
  }
  const extra = overrides.find((t) => t.type === 'extra_workday');
  if (extra) return { available: true, reason: null, timeOffId: extra.id, note: extra.note };
  if (p.daysOff.has(weekdayIndex(date))) return { available: false, reason: 'regular_day_off', timeOffId: null, note: '' };
  return { available: true, reason: null, timeOffId: null, note: '' };
}

const REASON_TEXT: Record<Unavailability, string> = {
  inactive: 'is marked inactive',
  regular_day_off: 'has a regular day off',
  vacation: 'is on vacation',
  leave: 'is on approved leave',
  training: 'is in training',
  other: 'is off (other)',
};

// ---------- open / closed ----------

export function isOpen(ctx: ScheduleContext, assignmentId: number, date: string): boolean {
  const a = ctx.assignments.get(assignmentId);
  if (!a || !a.active) return false;
  return ctx.dayStatus.get(`${assignmentId}|${date}`) ?? a.openByDefault;
}

// ---------- overlap ----------

function minutes(t: string): number {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

/** Two assignments overlap unless both have shift times that don't intersect. */
export function shiftsOverlap(a: AssignmentCtx, b: AssignmentCtx): boolean {
  if (!a.startTime || !a.endTime || !b.startTime || !b.endTime) return true;
  return minutes(a.startTime) < minutes(b.endTime) && minutes(b.startTime) < minutes(a.endTime);
}

// ---------- assignment checks ----------

export type IssueCode =
  | 'slot_not_found'
  | 'person_not_found'
  | 'assignment_inactive'
  | 'closed'
  | 'slot_unused'
  | 'unavailable'
  | 'unqualified'
  | 'double_booked';

export interface Issue {
  code: IssueCode;
  /** Overridable issues can be accepted by a supervisor with a reason; the others always block. */
  overridable: boolean;
  message: string;
}

export interface CheckInput {
  date: string;
  slotId: number;
  personnelId: number;
  /** Entries to pretend don't exist (the entry being replaced or moved). */
  ignoreEntryIds?: number[];
}

export function checkAssignment(ctx: ScheduleContext, input: CheckInput): Issue[] {
  const slot = ctx.slots.get(input.slotId);
  if (!slot) return [{ code: 'slot_not_found', overridable: false, message: 'That slot does not exist.' }];
  const person = ctx.personnel.get(input.personnelId);
  if (!person) return [{ code: 'person_not_found', overridable: false, message: 'That lifeguard does not exist.' }];
  const asg = ctx.assignments.get(slot.assignmentId)!;
  const issues: Issue[] = [];

  if (!asg.active) {
    issues.push({ code: 'assignment_inactive', overridable: false, message: `${asg.displayName} is inactive.` });
  } else if (!isOpen(ctx, asg.id, input.date)) {
    issues.push({ code: 'closed', overridable: false, message: `${asg.displayName} is closed on ${input.date}.` });
  } else if (!activeSlots(ctx, asg, input.date).some((s) => s.id === slot.id)) {
    const n = activeSlots(ctx, asg, input.date).length;
    issues.push({ code: 'slot_unused', overridable: false, message: `${asg.displayName} uses ${n} ${n === 1 ? 'guard' : 'guards'} on ${input.date}; ${slot.name} isn't staffed that day.` });
  }

  const av = availability(person, input.date);
  if (!av.available && av.reason) {
    issues.push({ code: 'unavailable', overridable: true, message: `${person.lgNumber} ${REASON_TEXT[av.reason]} on ${input.date}.` });
  }

  if (!evaluate(slot.rule, person.certs)) {
    issues.push({
      code: 'unqualified',
      overridable: true,
      message: `${person.lgNumber} does not meet ${slot.presetName ?? 'the slot criteria'} — needs ${missing(slot.rule, person.certs).join('; ')}.`,
    });
  }

  const ignore = new Set(input.ignoreEntryIds ?? []);
  for (const e of ctx.entries) {
    if (e.date !== input.date || e.personnelId !== person.id || ignore.has(e.id) || e.slotId === slot.id) continue;
    const other = ctx.slots.get(e.slotId);
    const otherAsg = other && ctx.assignments.get(other.assignmentId);
    if (otherAsg && shiftsOverlap(asg, otherAsg)) {
      issues.push({
        code: 'double_booked',
        overridable: true,
        message: `${person.lgNumber} is already on ${otherAsg.displayName} · ${other!.name} that day.`,
      });
    }
  }
  return issues;
}

// ---------- week load ----------

export function weekLoad(ctx: ScheduleContext, weekDatesList: readonly string[]): Map<number, number> {
  const inWeek = new Set(weekDatesList);
  const load = new Map<number, number>();
  for (const e of ctx.entries) if (inWeek.has(e.date)) load.set(e.personnelId, (load.get(e.personnelId) ?? 0) + 1);
  return load;
}

// ---------- candidates for a selected slot ----------

export interface Candidate {
  personnelId: number;
  lgNumber: string;
  name: string;
  labelColor: LabelColor;
  certs: string[];
  shiftsThisWeek: number;
  issues: Issue[];
  detail: string;
}

export interface CandidateGroups {
  slot: { id: number; name: string; assignment: string; criteria: string; presetName: string | null };
  qualifiedAvailable: Candidate[];
  assignedElsewhere: Candidate[];
  unqualified: Candidate[];
  unavailable: Candidate[];
}

export function candidatesFor(ctx: ScheduleContext, date: string, slotId: number, weekDatesList: readonly string[]): CandidateGroups {
  const slot = ctx.slots.get(slotId);
  if (!slot) throw new Error('slot not found');
  const asg = ctx.assignments.get(slot.assignmentId)!;
  const load = weekLoad(ctx, weekDatesList);
  const current = ctx.entries.find((e) => e.date === date && e.slotId === slotId);
  const groups: CandidateGroups = {
    slot: { id: slot.id, name: slot.name, assignment: asg.displayName, criteria: slot.ruleText, presetName: slot.presetName },
    qualifiedAvailable: [],
    assignedElsewhere: [],
    unqualified: [],
    unavailable: [],
  };
  for (const p of ctx.personnel.values()) {
    if (!p.active) continue;
    if (current && current.personnelId === p.id) continue;
    const issues = checkAssignment(ctx, { date, slotId, personnelId: p.id }).filter((i) => i.overridable);
    const c: Candidate = {
      personnelId: p.id,
      lgNumber: p.lgNumber,
      name: p.name,
      labelColor: p.labelColor,
      certs: p.heldCerts,
      shiftsThisWeek: load.get(p.id) ?? 0,
      issues,
      detail: issues.map((i) => i.message).join(' '),
    };
    const codes = new Set(issues.map((i) => i.code));
    if (codes.has('unavailable')) groups.unavailable.push(c);
    else if (codes.has('unqualified')) groups.unqualified.push(c);
    else if (codes.has('double_booked')) groups.assignedElsewhere.push(c);
    else groups.qualifiedAvailable.push(c);
  }
  const byLoad = (a: Candidate, b: Candidate) => a.shiftsThisWeek - b.shiftsThisWeek || lgCompare(a.lgNumber, b.lgNumber);
  groups.qualifiedAvailable.sort(byLoad);
  for (const g of [groups.assignedElsewhere, groups.unqualified, groups.unavailable]) g.sort((a, b) => lgCompare(a.lgNumber, b.lgNumber));
  return groups;
}

export function lgCompare(a: string, b: string): number {
  const na = Number(a.replace(/\D/g, ''));
  const nb = Number(b.replace(/\D/g, ''));
  return na - nb || a.localeCompare(b);
}

// ---------- Auto-Fill ----------

export interface AutoFillOptions {
  dates: string[]; // days to fill, in order
  weekDates: string[]; // the full week, for balancing shifts
  onlyEmpty: boolean; // false = unlocked entries may be replaced
}

export interface AutoFillPlan {
  assign: { date: string; slotId: number; personnelId: number }[];
  remove: number[]; // unlocked entry ids that will be replaced
  unfilled: { date: string; slotId: number; assignment: string; slot: string; reason: string }[];
  keptLocked: number;
  keptExisting: number;
}

/**
 * Fills open slots with available, qualified lifeguards.
 * Per day it runs a maximum bipartite matching (slots ↔ lifeguards), trying the most
 * constrained slots first and preferring lifeguards with the fewest shifts this week,
 * so it fills as many slots as is possible while keeping workload even.
 * Locked entries are never touched. One Auto-Fill assignment per lifeguard per day.
 */
export function planAutoFill(ctx: ScheduleContext, opts: AutoFillOptions): AutoFillPlan {
  const plan: AutoFillPlan = { assign: [], remove: [], unfilled: [], keptLocked: 0, keptExisting: 0 };
  const load = weekLoad(ctx, opts.weekDates);
  const assignments = [...ctx.assignments.values()].sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);

  for (const date of opts.dates) {
    const dayEntries = ctx.entries.filter((e) => e.date === date);
    const kept: EntryCtx[] = [];
    for (const e of dayEntries) {
      if (e.locked) {
        plan.keptLocked++;
        kept.push(e);
      } else if (opts.onlyEmpty) {
        plan.keptExisting++;
        kept.push(e);
      } else {
        plan.remove.push(e.id);
        load.set(e.personnelId, (load.get(e.personnelId) ?? 1) - 1);
      }
    }
    const filledSlots = new Set(kept.map((e) => e.slotId));
    const busyPeople = new Set(kept.map((e) => e.personnelId));

    // Slots that need someone today.
    const open: { slot: SlotCtx; asg: AssignmentCtx; eligible: PersonCtx[] }[] = [];
    for (const asg of assignments) {
      if (!isOpen(ctx, asg.id, date)) continue;
      for (const slot of activeSlots(ctx, asg, date)) {
        if (filledSlots.has(slot.id)) continue;
        const eligible = [...ctx.personnel.values()].filter(
          (p) => !busyPeople.has(p.id) && availability(p, date).available && evaluate(slot.rule, p.certs),
        );
        open.push({ slot, asg, eligible });
      }
    }

    // How many open slots each person could fill today (versatile people are saved for hard slots).
    const flexibility = new Map<number, number>();
    for (const o of open) for (const p of o.eligible) flexibility.set(p.id, (flexibility.get(p.id) ?? 0) + 1);
    for (const o of open) {
      o.eligible.sort(
        (a, b) =>
          (load.get(a.id) ?? 0) - (load.get(b.id) ?? 0) ||
          (flexibility.get(a.id) ?? 0) - (flexibility.get(b.id) ?? 0) ||
          lgCompare(a.lgNumber, b.lgNumber),
      );
    }
    open.sort((a, b) => a.eligible.length - b.eligible.length || a.asg.sortOrder - b.asg.sortOrder || a.slot.position - b.slot.position);

    // Kuhn's augmenting-path matching.
    const personToSlot = new Map<number, number>(); // personId -> index in open
    const slotToPerson = new Map<number, number>(); // index -> personId
    const tryAssign = (i: number, seen: Set<number>): boolean => {
      for (const p of open[i].eligible) {
        if (seen.has(p.id)) continue;
        seen.add(p.id);
        const holder = personToSlot.get(p.id);
        if (holder === undefined || tryAssign(holder, seen)) {
          personToSlot.set(p.id, i);
          slotToPerson.set(i, p.id);
          return true;
        }
      }
      return false;
    };
    open.forEach((_, i) => tryAssign(i, new Set()));

    open.forEach((o, i) => {
      const pid = slotToPerson.get(i);
      if (pid !== undefined) {
        plan.assign.push({ date, slotId: o.slot.id, personnelId: pid });
        load.set(pid, (load.get(pid) ?? 0) + 1);
      } else {
        plan.unfilled.push({ date, slotId: o.slot.id, assignment: o.asg.displayName, slot: o.slot.name, reason: unfilledReason(ctx, o.slot, date, o.eligible.length) });
      }
    });
  }
  return plan;
}

function unfilledReason(ctx: ScheduleContext, slot: SlotCtx, date: string, eligibleCount: number): string {
  if (eligibleCount > 0) return `Every lifeguard who meets ${slot.ruleText} was needed for another slot.`;
  const qualified = [...ctx.personnel.values()].filter((p) => p.active && evaluate(slot.rule, p.certs));
  if (qualified.length === 0) return `No active lifeguard meets ${slot.ruleText}.`;
  return `All ${qualified.length} lifeguards who meet ${slot.ruleText} are off or already assigned.`;
}

export { describe as describeRule };
