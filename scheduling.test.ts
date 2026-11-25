import { test } from 'node:test';
import assert from 'node:assert/strict';
import { availability, candidatesFor, checkAssignment, planAutoFill } from '../src/domain/scheduling.ts';
import { weekDates, weekdayIndex } from '../src/domain/dates.ts';
import { assignment, context, person } from './helpers.ts';

const SAT = '2027-06-05';
const WEEK = weekDates(SAT);

test('patrol week starts Saturday', () => {
  assert.equal(weekdayIndex(SAT), 0);
  assert.equal(weekdayIndex('2027-06-11'), 6);
});

test('regular days off repeat; date overrides win but never change the pattern', () => {
  const p = person(1, ['BASIC'], [3]); // Tuesdays off
  assert.equal(availability(p, '2027-06-08').reason, 'regular_day_off');
  assert.equal(availability(p, '2027-06-15').reason, 'regular_day_off');
  p.timeOff.push({ id: 1, personnelId: 1, startDate: '2027-06-08', endDate: '2027-06-08', type: 'extra_workday', note: '' });
  assert.equal(availability(p, '2027-06-08').available, true);
  assert.equal(availability(p, '2027-06-15').available, false);
  p.timeOff.push({ id: 2, personnelId: 1, startDate: '2027-06-05', endDate: '2027-06-06', type: 'vacation', note: '' });
  assert.equal(availability(p, SAT).reason, 'vacation');
  assert.equal(availability({ ...p, active: false }, '2027-06-07').reason, 'inactive');
});

test('checkAssignment flags day off, unqualified, double booking and closed stands', () => {
  const a = assignment(1, [{ cert: 'EMT' }]);
  const b = assignment(2, [null]);
  const ctx = context([person(1, ['BASIC'], [0]), person(2, ['EMT'])], [a, b]);
  const codes = (pid: number, slot = a.slots[0].id) => checkAssignment(ctx, { date: SAT, slotId: slot, personnelId: pid }).map((i) => i.code).sort();
  assert.deepEqual(codes(1), ['unavailable', 'unqualified']);
  assert.deepEqual(codes(2), []);
  ctx.entries.push({ id: 9, date: SAT, slotId: b.slots[0].id, personnelId: 2, locked: false, source: 'manual', overrideReason: null });
  assert.deepEqual(codes(2), ['double_booked']);
  ctx.dayStatus.set(`1|${SAT}`, false);
  const closed = checkAssignment(ctx, { date: SAT, slotId: a.slots[0].id, personnelId: 2 }).find((i) => i.code === 'closed');
  assert.equal(closed?.overridable, false);
});

test('shift times allow two non-overlapping assignments on one day', () => {
  const am = assignment(1, [null], { startTime: '08:00', endTime: '12:00' });
  const pm = assignment(2, [null], { startTime: '12:00', endTime: '17:00' });
  const ctx = context([person(1, ['BASIC'])], [am, pm]);
  ctx.entries.push({ id: 1, date: SAT, slotId: am.slots[0].id, personnelId: 1, locked: false, source: 'manual', overrideReason: null });
  assert.deepEqual(checkAssignment(ctx, { date: SAT, slotId: pm.slots[0].id, personnelId: 1 }), []);
});

test('candidates: qualified and available first, least-loaded first', () => {
  const a = assignment(1, [{ cert: 'EMT' }]);
  const ctx = context([person(1, ['EMT']), person(2, ['EMT']), person(3, ['BASIC']), person(4, ['EMT'], [0])], [a, assignment(2, [null])]);
  ctx.entries.push({ id: 1, date: '2027-06-06', slotId: [...ctx.slots.keys()][1], personnelId: 1, locked: false, source: 'manual', overrideReason: null });
  const g = candidatesFor(ctx, SAT, a.slots[0].id, WEEK);
  assert.deepEqual(g.qualifiedAvailable.map((c) => c.personnelId), [2, 1]);
  assert.deepEqual(g.unqualified.map((c) => c.personnelId), [3]);
  assert.deepEqual(g.unavailable.map((c) => c.personnelId), [4]);
});

test('Auto-Fill only places qualified, available people and keeps locked entries', () => {
  const a = assignment(1, [{ cert: 'EMT' }, { cert: 'BASIC' }, { cert: 'PWC3' }]);
  const people = [person(1, ['EMT', 'BASIC']), person(2, ['BASIC']), person(3, ['BASIC', 'PWC3'], [0]), person(4, ['BASIC'])];
  const ctx = context(people, [a]);
  ctx.entries.push({ id: 50, date: SAT, slotId: a.slots[1].id, personnelId: 4, locked: true, source: 'manual', overrideReason: null });
  const plan = planAutoFill(ctx, { dates: [SAT], weekDates: WEEK, onlyEmpty: false });
  assert.deepEqual(plan.assign, [{ date: SAT, slotId: a.slots[0].id, personnelId: 1 }]);
  assert.equal(plan.keptLocked, 1);
  assert.equal(plan.unfilled.length, 1);
  assert.match(plan.unfilled[0].reason, /off or already assigned/);
});

test('Auto-Fill finds the maximum matching where greedy would fail', () => {
  // Slot A accepts P1 or P2; slot B accepts only P1. Greedy-by-order might give P1 to A.
  const a = assignment(1, [{ any: [{ cert: 'EMT' }, { cert: 'EMR' }] }, { cert: 'EMT' }]);
  const ctx = context([person(1, ['EMT']), person(2, ['EMR'])], [a]);
  const plan = planAutoFill(ctx, { dates: [SAT], weekDates: WEEK, onlyEmpty: true });
  assert.equal(plan.assign.length, 2);
  assert.equal(plan.assign.find((x) => x.slotId === a.slots[1].id)?.personnelId, 1);
});

test('Auto-Fill skips closed stands and balances the week', () => {
  const a = assignment(1, [null]);
  const ctx = context([person(1, ['BASIC']), person(2, ['BASIC'])], [a]);
  ctx.dayStatus.set(`1|2027-06-07`, false);
  const plan = planAutoFill(ctx, { dates: WEEK, weekDates: WEEK, onlyEmpty: true });
  assert.equal(plan.assign.length, 6);
  const counts = [1, 2].map((id) => plan.assign.filter((x) => x.personnelId === id).length);
  assert.deepEqual(counts.sort(), [3, 3]);
});

test('staffing layouts: a day can use fewer guards, and Auto-Fill and checks follow it', async () => {
  const { buildWeekFromContext } = await import('../src/domain/week-view.ts');
  const a = assignment(1, [null, null, null, null]);
  const ctx = context([1, 2, 3, 4, 5].map((i) => person(i, ['BASIC'])), [a]);
  ctx.slotLimit = new Map([[`1|${SAT}`, 2]]);
  const plan = planAutoFill(ctx, { dates: [SAT, '2027-06-06'], weekDates: WEEK, onlyEmpty: true });
  assert.equal(plan.assign.filter((x) => x.date === SAT).length, 2);
  assert.equal(plan.assign.filter((x) => x.date === '2027-06-06').length, 4);
  const issue = checkAssignment(ctx, { date: SAT, slotId: a.slots[3].id, personnelId: 1 })[0];
  assert.equal(issue.code, 'slot_unused');
  assert.equal(issue.overridable, false);
  const view = buildWeekFromContext(ctx, SAT);
  assert.equal(view.days[0].assignments[0].slots.length, 2);
  assert.equal(view.days[0].assignments[0].capacity, 4);
  assert.equal(view.days[0].stats.openSlots, 2);
});
