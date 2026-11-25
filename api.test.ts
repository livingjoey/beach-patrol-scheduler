import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { openDb, get } from '../src/db/index.ts';
import { buildServer } from '../src/app.ts';
import { seedDemo, seedFirstAdmin, seedReference } from '../src/db/seed.ts';

const WEEK = '2027-06-05';
let server: Server;
let base = '';
let token = '';
const db = openDb(':memory:');

async function api(method: string, path: string, body?: unknown, auth = token) {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${auth}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const type = res.headers.get('content-type') ?? '';
  return { status: res.status, type, body: type.includes('json') ? await res.json() : new Uint8Array(await res.arrayBuffer()) } as { status: number; type: string; body: any };
}

before(async () => {
  seedReference(db);
  seedFirstAdmin(db, 'first-admin-pass');
  seedDemo(db);
  server = buildServer(db, { port: 0, dbPath: ':memory:', authSecret: 'test-secret', corsOrigin: '', tokenTtlHours: 1 });
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const login = await api('POST', '/api/auth/login', { identifier: 'adm01', password: 'first-admin-pass' }, '');
  assert.equal(login.status, 200);
  token = login.body.token;
});
after(() => server.close());

test('requires sign-in, rejects bad passwords', async () => {
  assert.equal((await api('GET', '/api/personnel', undefined, '')).status, 401);
  assert.equal((await api('POST', '/api/auth/login', { identifier: 'ADM01', password: 'nope-nope' }, '')).status, 401);
  assert.equal((await api('GET', '/api/me')).body.identifier, 'ADM01');
});

test('at most 10 admin accounts, each with its own identifier', async () => {
  for (let i = 2; i <= 10; i++) {
    const r = await api('POST', '/api/admins', { identifier: `ADM${String(i).padStart(2, '0')}`, displayName: `Admin ${i}`, password: 'password-123' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
  }
  const dup = await api('POST', '/api/admins', { identifier: 'ADM02', displayName: 'x', password: 'password-123' });
  assert.equal(dup.status, 409);
  const over = await api('POST', '/api/admins', { identifier: 'ADM11', displayName: 'x', password: 'password-123' });
  assert.equal(over.status, 409);
  assert.equal(over.body.error.code, 'admin_limit');
  // deactivated admins can't sign in
  const adm10 = (await api('GET', '/api/admins')).body.admins.find((a: any) => a.identifier === 'ADM10');
  await api('PATCH', `/api/admins/${adm10.id}`, { active: false });
  assert.equal((await api('POST', '/api/auth/login', { identifier: 'ADM10', password: 'password-123' }, '')).status, 401);
});

test('personnel profile: certifications toggle individually, days off and label color', async () => {
  const created = await api('POST', '/api/personnel', { lgNumber: 'LG200', name: 'Test Guard', certifications: ['Basic'], regularDaysOff: ['tue', 'wed'], labelColor: 'red' });
  assert.equal(created.status, 201);
  const id = created.body.id;
  assert.deepEqual(created.body.regularDaysOff, ['tue', 'wed']);
  const added = await api('PUT', `/api/personnel/${id}/certifications/PWC3`);
  assert.deepEqual(added.body.certifications, ['BASIC', 'PWC3']);
  const removed = await api('DELETE', `/api/personnel/${id}/certifications/BASIC`);
  assert.deepEqual(removed.body.certifications, ['PWC3']);
  assert.equal((await api('POST', '/api/personnel', { lgNumber: 'lg200', name: 'Dup' })).status, 409);
  const q = (await api('GET', `/api/personnel/${id}/qualifications`)).body;
  assert.equal(q.find((x: any) => x.name === 'PWC Rescuer').qualifies, false);
});

test('slots: add, rename, reorder, override criteria with a custom ANY/ALL rule', async () => {
  const list = (await api('GET', '/api/assignments?kind=stand')).body;
  const stand1 = list[0];
  assert.equal(stand1.slotCount, 6);
  assert.equal(list.find((a: any) => a.displayName === 'Stand 11').slotCount, 2);
  const slot = stand1.slots[2];
  const upd = await api('PATCH', `/api/slots/${slot.id}`, { name: 'Tower left', criteria: { mode: 'custom', rule: { all: [{ any: ['EMT', 'EMT2', 'PMD'] }, 'PWC3'] } } });
  const s = upd.body.slots.find((x: any) => x.id === slot.id);
  assert.equal(s.name, 'Tower left');
  assert.equal(s.tag, 'custom');
  assert.equal(s.effective.text, '(EMT or EMT2 or PMD) and PWC3');
  const bad = await api('PATCH', `/api/slots/${slot.id}`, { criteria: { mode: 'custom', rule: { any: ['XYZ'] } } });
  assert.equal(bad.status, 400);
  const ids = stand1.slots.map((x: any) => x.id).reverse();
  const reordered = await api('PUT', `/api/assignments/${stand1.id}/slots/order`, { slotIds: ids });
  assert.deepEqual(reordered.body.slots.map((x: any) => x.id), ids);
  const saved = await api('POST', `/api/slots/${slot.id}/save-as-preset`, { name: 'Tower PWC' });
  assert.equal(saved.status, 201);
  // other slots unchanged
  assert.equal(saved.body.assignment.slots.filter((x: any) => x.tag === 'custom').length, 2);
  // renameable extras + slot count
  const extra = (await api('GET', '/api/assignments?kind=extra')).body[0];
  const ren = await api('PATCH', `/api/assignments/${extra.id}`, { displayName: 'Rover North', active: true });
  assert.equal(ren.body.displayName, 'Rover North');
  assert.equal((await api('PUT', `/api/assignments/${extra.id}/slot-count`, { count: 3 })).body.slotCount, 3);
});

test('assigning: conflicts need a supervisor override with a reason', async () => {
  const p = (await api('GET', '/api/personnel?q=LG200')).body[0]; // off Tue/Wed, no BASIC
  const stand2 = (await api('GET', '/api/assignments?kind=stand')).body[1];
  const slotId = stand2.slots[0].id;
  const tue = '2027-06-08';
  const check = await api('POST', '/api/schedule/check', { date: tue, slotId, personnelId: p.id });
  assert.deepEqual(check.body.issues.map((i: any) => i.code).sort(), ['unavailable', 'unqualified']);
  const refused = await api('PUT', '/api/schedule/entries', { date: tue, slotId, personnelId: p.id });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error.code, 'needs_override');
  const ok = await api('PUT', '/api/schedule/entries', { date: tue, slotId, personnelId: p.id, override: { reason: 'Short-staffed, approved by phone' } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.overrideReason, 'Short-staffed, approved by phone');

  // an admin without override permission is refused
  const login = await api('POST', '/api/auth/login', { identifier: 'ADM02', password: 'password-123' }, '');
  const stand3 = (await api('GET', '/api/assignments?kind=stand')).body[2];
  const r = await api('PUT', '/api/schedule/entries', { date: tue, slotId: stand3.slots[0].id, personnelId: p.id, override: { reason: 'try' } }, login.body.token);
  assert.equal(r.status, 403);
});

test('closing a stand with people on it asks first', async () => {
  const week = (await api('GET', `/api/schedule/week?start=${WEEK}`)).body;
  const stand2 = week.days[3].assignments.find((a: any) => a.displayName === 'Stand 2');
  const res = await api('PUT', '/api/schedule/day-status', { assignmentId: stand2.assignmentId, date: '2027-06-08', open: false });
  assert.equal(res.status, 409);
  const ok = await api('PUT', '/api/schedule/day-status', { assignmentId: stand2.assignmentId, date: '2027-06-08', open: false, clearEntries: true });
  assert.equal(ok.body.open, false);
});

test('Auto-Fill fills the week with only qualified, available lifeguards', async () => {
  const preview = await api('POST', '/api/schedule/autofill', { weekStart: WEEK, scope: 'week', onlyEmpty: true, dryRun: true });
  assert.equal(preview.status, 200);
  assert.ok(preview.body.summary.willFill > 300, JSON.stringify(preview.body.summary));
  const run = await api('POST', '/api/schedule/autofill', { weekStart: WEEK, scope: 'week', onlyEmpty: true });
  assert.equal(run.body.summary.willFill, preview.body.summary.willFill);
  const week = (await api('GET', `/api/schedule/week?start=${WEEK}`)).body;
  const bad = week.days.flatMap((d: any) => d.assignments.flatMap((a: any) => a.slots.filter((s: any) => s.entry && s.entry.issues.length && !s.entry.overrideReason)));
  assert.equal(bad.length, 0);
  // closed stand stayed empty
  const closed = week.days[3].assignments.find((a: any) => a.displayName === 'Stand 2');
  assert.equal(closed.open, false);
  assert.ok(closed.slots.every((s: any) => !s.entry));
  const cands = await api('GET', `/api/schedule/candidates?date=${WEEK}&slotId=${week.days[0].assignments[0].slots[0].slotId}`);
  assert.ok(Array.isArray(cands.body.qualifiedAvailable));
});

test('PDF export works for every layout and paper option', async () => {
  const opts = (await api('GET', '/api/export/options')).body;
  assert.deepEqual(opts.layouts.map((l: any) => l.id), ['week-grid', 'daily-sheet', 'roster', 'by-assignment']);
  for (const layout of opts.layouts.map((l: any) => l.id)) {
    const r = await api('GET', `/api/export/schedule.pdf?week=${WEEK}&layout=${layout}&paper=letter&names=true&criteria=true`);
    assert.equal(r.status, 200, layout);
    assert.equal(r.type, 'application/pdf');
    assert.equal(Buffer.from(r.body.slice(0, 5)).toString(), '%PDF-');
  }
  const day = await api('GET', `/api/export/schedule.pdf?week=${WEEK}&layout=daily-sheet&days=sat&paper=a4&orientation=portrait&kinds=stand`);
  assert.equal(day.status, 200);
  assert.equal((await api('GET', `/api/export/schedule.pdf?week=${WEEK}&layout=poster`)).status, 400);
});

test('time off: date overrides do not change the regular pattern', async () => {
  const p = (await api('GET', '/api/personnel?q=LG200')).body[0];
  const res = await api('POST', '/api/availability/day', { personnelId: p.id, date: '2027-06-15', working: true });
  assert.equal(res.body.status, 'working');
  const again = (await api('GET', '/api/personnel?q=LG200')).body[0];
  assert.deepEqual(again.regularDaysOff, ['tue', 'wed']);
  const vac = await api('POST', '/api/time-off', { personnelId: p.id, startDate: '2027-06-20', endDate: '2027-06-24', type: 'vacation' });
  assert.equal(vac.status, 201);
  const matrix = (await api('GET', '/api/availability?week=2027-06-19')).body;
  const row = matrix.rows.find((r: any) => r.personnelId === p.id);
  assert.equal(row.days[1].status, 'vacation');
  assert.ok(get(db, 'SELECT 1 FROM audit_log WHERE action = ?', 'timeoff.create'));
});
