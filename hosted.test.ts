import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { pbkdf2Sync } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { openDb } from '../src/db/index.ts';
import { createHostedServer } from '../src/hosted.ts';

let server: Server;
let base = '';
let cookie = '';

async function call(method: string, path: string, body?: unknown, opts: { cookie?: string; noHeader?: boolean } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(opts.noHeader ? {} : { 'x-requested-with': 'bps' }),
      ...((opts.cookie ?? cookie) ? { cookie: opts.cookie ?? cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const set = res.headers.get('set-cookie');
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* html */
  }
  return { status: res.status, json, text, set, headers: res.headers };
}

before(async () => {
  server = createHostedServer(openDb(':memory:'), {
    authSecret: 'test',
    setupCode: 'SECRET-CODE',
    pagePath: fileURLToPath(new URL('../web/dist/index.html', import.meta.url)),
    secureCookies: false,
    tokenTtlHours: 1,
  });
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

const setupBody = (code: string) => ({
  setupCode: code,
  password: 'first-pass-1',
  admin: { id: '1001', identifier: 'ADM01', displayName: 'Admin 01' },
  docs: [{ collection: 'config', id: 'settings', data: { patrolName: 'Test Patrol', overridesEnabled: true } }],
});

test('serves the app with security headers', async () => {
  const r = await call('GET', '/');
  assert.equal(r.status, 200);
  assert.match(r.text, /<title>Beach Patrol Scheduler<\/title>/);
  assert.match(r.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
  assert.equal((await call('GET', '/healthz')).json.ok, true);
});

test('first-time setup needs the setup code and can only happen once', async () => {
  const st = await call('GET', '/auth/status');
  assert.deepEqual(st.json, { setupNeeded: true, setupCodeRequired: true, admin: null });
  assert.equal((await call('POST', '/auth/setup', setupBody('wrong'))).status, 403);
  const ok = await call('POST', '/auth/setup', setupBody('SECRET-CODE'));
  assert.equal(ok.status, 200, ok.text);
  assert.match(ok.set ?? '', /bps_session=.*HttpOnly; SameSite=Strict/);
  assert.equal((await call('POST', '/auth/setup', setupBody('SECRET-CODE'))).status, 409);
});

test('the store is closed to anyone not signed in', async () => {
  assert.equal((await call('GET', '/store/snapshot', undefined, { cookie: '' })).status, 401);
  assert.equal((await call('PUT', '/store/personnel/1', { data: { x: 1 } }, { cookie: '' })).status, 401);
  assert.equal((await call('GET', '/auth/status', undefined, { cookie: '' })).json.admin, null);
});

test('sign in, and password data never leaves the server', async () => {
  assert.equal((await call('POST', '/auth/login', { identifier: 'adm01', password: 'nope-nope' }, { cookie: '' })).status, 401);
  const r = await call('POST', '/auth/login', { identifier: 'adm01', password: 'first-pass-1' }, { cookie: '' });
  assert.equal(r.status, 200);
  cookie = r.set!.split(';')[0];
  const snap = await call('GET', '/store/snapshot');
  const admin = snap.json.docs.find((d: any) => d.collection === 'admins');
  assert.equal(admin.data.identifier, 'ADM01');
  assert.equal(admin.data.salt, undefined);
  assert.equal(admin.data.hash, undefined);
  assert.equal(snap.json.docs.find((d: any) => d.id === 'settings').data.patrolName, 'Test Patrol');
});

test('changes need the app header (blocks cross-site requests)', async () => {
  assert.equal((await call('PUT', '/store/personnel/5', { data: { lgNumber: 'LG5' } }, { noHeader: true })).status, 403);
});

test('writes, merges, deletes and change polling', async () => {
  const start = (await call('GET', '/store/changes?since=0')).json.seq;
  assert.equal((await call('PUT', '/store/weeks/2027-06-05', { data: { status: 'draft', entries: { a: { id: 1 } } } })).status, 200);
  assert.equal((await call('PATCH', '/store/weeks/2027-06-05', { data: { entries: { b: { id: 2 }, a: null } } })).status, 200);
  const doc = (await call('GET', '/store/weeks/2027-06-05')).json;
  assert.deepEqual(doc.data.entries, { a: null, b: { id: 2 } });
  assert.equal((await call('PATCH', '/store/weeks/2099-01-01', { data: { x: 1 } })).status, 404);
  await call('DELETE', '/store/weeks/2027-06-05');
  const ch = (await call('GET', `/store/changes?since=${start}`)).json;
  assert.equal(ch.docs.at(-1).data, null);
  assert.equal((await call('PUT', '/store/secrets/x', { data: {} })).status, 400);
});

test('admin rules: keep passwords on edit, 10-account limit, no self-lockout', async () => {
  // editing without salt/hash keeps the stored password
  await call('PUT', '/store/admins/1001', { data: { identifier: 'ADM01', displayName: 'Renamed', active: true, canOverride: true } });
  assert.equal((await call('POST', '/auth/login', { identifier: 'ADM01', password: 'first-pass-1' }, { cookie: '' })).status, 200);
  // a new admin needs a password; the app sends a PBKDF2 hash made in the browser
  assert.equal((await call('PUT', '/store/admins/2000', { data: { identifier: 'ADMX', active: true } })).status, 400);
  const salt = 'abcd';
  const hash = pbkdf2Sync('second-pass', Buffer.from(salt), 150_000, 32, 'sha256').toString('hex');
  for (let i = 2; i <= 10; i++) {
    const r = await call('PUT', `/store/admins/${2000 + i}`, { data: { identifier: `ADM${i}`, displayName: `A${i}`, active: true, salt, hash } });
    assert.equal(r.status, 200, r.text);
  }
  assert.equal((await call('PUT', '/store/admins/3000', { data: { identifier: 'ADM11', active: true, salt, hash } })).status, 409);
  assert.equal((await call('POST', '/auth/login', { identifier: 'ADM5', password: 'second-pass' }, { cookie: '' })).status, 200);
  assert.equal((await call('DELETE', '/store/admins/1001')).status, 409);
  assert.equal((await call('PUT', '/store/admins/1001', { data: { identifier: 'ADM01', active: false } })).status, 409);
  // a deactivated admin's session stops working
  const s5 = (await call('POST', '/auth/login', { identifier: 'ADM5', password: 'second-pass' }, { cookie: '' })).set!.split(';')[0];
  await call('PATCH', '/store/admins/2005', { data: { active: false } });
  assert.equal((await call('GET', '/store/snapshot', undefined, { cookie: s5 })).status, 401);
});

test('backup download', async () => {
  const r = await call('GET', '/store/backup');
  assert.match(r.headers.get('content-disposition') ?? '', /beach-patrol-backup-/);
  assert.ok(r.json.docs.length > 0);
  assert.ok(r.json.docs.every((d: any) => d.data.hash === undefined));
});
