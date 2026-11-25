import { describe as describeRule, effectiveCerts, type Rule } from '../src/domain/criteria.ts';
import type { AssignmentCtx, PersonCtx, ScheduleContext, SlotCtx } from '../src/domain/scheduling.ts';

export function person(id: number, certs: string[], daysOff: number[] = [], extra: Partial<PersonCtx> = {}): PersonCtx {
  return { id, lgNumber: `LG${id}`, name: `Guard ${id}`, active: true, labelColor: 'white', heldCerts: certs, certs: effectiveCerts(certs, []), daysOff: new Set(daysOff), timeOff: [], ...extra };
}

let nextSlot = 1;
export function assignment(id: number, rules: (Rule | null)[], extra: Partial<AssignmentCtx> = {}): AssignmentCtx {
  const slots: SlotCtx[] = rules.map((rule, i) => ({
    id: nextSlot++, assignmentId: id, position: i + 1, name: `Slot ${i + 1}`, mode: 'custom', presetId: null, presetName: null, rule, ruleText: describeRule(rule),
  }));
  return { id, code: `A${id}`, kind: 'stand', displayName: `Stand ${id}`, active: true, sortOrder: id, openByDefault: true, startTime: null, endTime: null, slots, ...extra };
}

export function context(people: PersonCtx[], assignments: AssignmentCtx[]): ScheduleContext {
  return {
    personnel: new Map(people.map((p) => [p.id, p])),
    assignments: new Map(assignments.map((a) => [a.id, a])),
    slots: new Map(assignments.flatMap((a) => a.slots.map((s) => [s.id, s] as const))),
    dayStatus: new Map(),
    entries: [],
  };
}
