// Hosts the Beach Patrol Scheduler web app on its own website.
//
// The browser app keeps its data as JSON documents in collections (admins, personnel,
// timeoff, presets, assignments, weeks, config, audit). This server stores them in SQLite,
// checks admin sign-in on the server, and lets every open browser pick up changes by polling.
//
//   GET  /                     the app
//   GET  /healthz              health check
//   GET  /auth/status          { setupNeeded, setupCodeRequired, admin }
//   POST /auth/setup           first-time setup (needs SETUP_CODE when one is set)
//   POST /auth/login           { identifier, password }  -> session cookie
//   POST /auth/logout
//   GET  /store/snapshot       every document + the change counter
//   GET  /store/changes?since= documents changed since a counter value (deleted ones as null)
//   GET  /store/backup         a JSON backup file of everything
//   GET|PUT|PATCH|DELETE /store/:collection/:id

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { pbkdf2Sync, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { all, get, run, tx, type DB } from './db/index.ts';
import { signToken, verifyToken } from './auth/crypto.ts';

export const COLLECTIONS = new Set(['admins', 'personnel', 'timeoff', 'presets', 'assignments', 'weeks', 'layouts', 'config', 'audit']);
const ID = /^[A-Za-z0-9_.:-]{1,100}$/;
const MAX_BODY = 2 * 1024 * 1024;
const MAX_ADMINS = 10;
const COOKIE = 'bps_session';

export const HOSTED_SCHEMA = `
CREATE TABLE IF NOT EXISTS app_docs (
  collection TEXT NOT NULL,
  id         TEXT NOT NULL,
  data       TEXT,             -- JSON; NULL once deleted (kept so other browsers learn about the delete)
  seq        INTEGER NOT NULL, -- change counter
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (collection, id)
);
CREATE INDEX IF NOT EXISTS app_docs_seq ON app_docs (seq);
`;

export interface HostedOptions {
  authSecret: string;
  setupCode: string; // empty = no code required
  pagePath: string;
  secureCookies: boolean;
  tokenTtlHours: number;
  /** Optional handler for /api/* (the separate REST API). */
  api?: Server;
}

type Doc = Record<string, unknown>;

class HttpErr extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// ---------- storage ----------

function nextSeq(db: DB): number {
  return get<{ s: number }>(db, 'SELECT COALESCE(MAX(seq), 0) + 1 AS s FROM app_docs')!.s;
}

function readDoc(db: DB, col: string, id: string): Doc | null {
  const r = get<{ data: string | null }>(db, 'SELECT data FROM app_docs WHERE collection = ? AND id = ?', col, id);
  return r?.data ? (JSON.parse(r.data) as Doc) : null;
}

function writeDoc(db: DB, col: string, id: string, data: Doc | null): number {
  const seq = nextSeq(db);
  run(
    db,
    `INSERT INTO app_docs (collection, id, data, seq, updated_at) VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(collection, id) DO UPDATE SET data = excluded.data, seq = excluded.seq, updated_at = excluded.updated_at`,
    col,
    id,
    data === null ? null : JSON.stringify(data),
    seq,
  );
  return seq;
}

const liveAdmins = (db: DB) =>
  all<{ id: string; data: string }>(db, "SELECT id, data FROM app_docs WHERE collection = 'admins' AND data IS NOT NULL").map((r) => ({ ...(JSON.parse(r.data) as Doc), id: r.id }) as Doc & { id: string });

/** Password material never leaves the server. */
function publicView(col: string, data: Doc | null): Doc | null {
  if (!data || col !== 'admins') return data;
  const { salt: _s, hash: _h, ...rest } = data;
  return rest;
}

function merge(target: Doc, patch: Doc): Doc {
  const out: Doc = { ...target };
  for (const [k, v] of Object.entries(patch)) {
    const cur = out[k];
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && cur && typeof cur === 'object' && !Array.isArray(cur) ? merge(cur as Doc, v as Doc) : v;
  }
  return out;
}

// ---------- passwords (same scheme as the browser app: PBKDF2-SHA256, 150k rounds) ----------

const pbkdf2 = (password: string, salt: string) => pbkdf2Sync(password, Buffer.from(salt, 'utf8'), 150_000, 32, 'sha256').toString('hex');

function checkPassword(password: string, salt: unknown, hash: unknown): boolean {
  if (typeof salt !== 'string' || typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) return false;
  return timingSafeEqual(Buffer.from(pbkdf2(password, salt), 'hex'), Buffer.from(hash, 'hex'));
}

// ---------- http helpers ----------

function cookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

async function body(req: IncomingMessage): Promise<Doc> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new HttpErr(413, 'That change is too large.');
    chunks.push(c as Buffer);
  }
  if (!size) return {};
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error();
    return v as Doc;
  } catch {
    throw new HttpErr(400, 'The request body must be a JSON object.');
  }
}

function json(res: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}) {
  const text = JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(text);
}

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'same-origin',
  'x-frame-options': 'DENY',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
};

const PAGE_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  'font-src https://fonts.gstatic.com',
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ');

// ---------- server ----------

export function createHostedServer(db: DB, opts: HostedOptions): Server {
  db.exec(HOSTED_SCHEMA);
  const attempts = new Map<string, { n: number; until: number }>();

  const sessionCookie = (value: string, maxAge: number) =>
    `${COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${opts.secureCookies ? '; Secure' : ''}`;

  function currentAdmin(req: IncomingMessage): Doc | null {
    const token = cookies(req)[COOKIE];
    const payload = token ? verifyToken(token, opts.authSecret) : null;
    if (!payload) return null;
    const a = readDoc(db, 'admins', String(payload.sub));
    return a && a.active ? { ...a, id: String(payload.sub) } : null;
  }

  const adminInfo = (a: Doc) => ({ id: a.id, identifier: a.identifier, displayName: a.displayName, canOverride: !!a.canOverride });
  const setupNeeded = () => liveAdmins(db).length === 0;

  const startSession = (adminId: string): string =>
    sessionCookie(signToken({ sub: Number(adminId) }, opts.authSecret, opts.tokenTtlHours), Math.round(opts.tokenTtlHours * 3600));

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const method = req.method ?? 'GET';
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);

    if (path === '/healthz') return json(res, 200, { ok: true });

    if (method === 'GET' && (path === '/' || path === '/index.html')) {
      if (!existsSync(opts.pagePath)) return json(res, 500, { error: 'The web app has not been built. Run npm run build:web.' });
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache', 'content-security-policy': PAGE_CSP });
      res.end(readFileSync(opts.pagePath));
      return;
    }

    if (path.startsWith('/api/') && opts.api) {
      opts.api.emit('request', req, res);
      return;
    }

    if (!path.startsWith('/auth/') && !path.startsWith('/store/')) return json(res, 404, { error: 'Not found.' });

    // Changes must come from the app itself: a custom header can't be sent cross-site without CORS, which is never allowed.
    if (method !== 'GET' && req.headers['x-requested-with'] !== 'bps') throw new HttpErr(403, 'Request refused.');

    // ----- auth -----
    if (path === '/auth/status' && method === 'GET') {
      const a = currentAdmin(req);
      return json(res, 200, { setupNeeded: setupNeeded(), setupCodeRequired: !!opts.setupCode, admin: a ? adminInfo(a) : null });
    }

    if (path === '/auth/setup' && method === 'POST') {
      const b = await body(req);
      if (opts.setupCode && b.setupCode !== opts.setupCode) throw new HttpErr(403, 'The setup code is incorrect. Find SETUP_CODE in your hosting dashboard.');
      const admin = b.admin as Doc | undefined;
      const docs = b.docs as { collection: string; id: string; data: Doc }[] | undefined;
      const password = typeof b.password === 'string' ? b.password : '';
      if (!admin || typeof admin.id !== 'string' || !ID.test(admin.id) || !Array.isArray(docs)) throw new HttpErr(400, 'Incomplete setup request.');
      if (password.length < 8) throw new HttpErr(400, 'Choose a password with at least 8 characters.');
      const id = tx(db, () => {
        if (!setupNeeded()) throw new HttpErr(409, 'This scheduler is already set up. Sign in instead.');
        for (const d of docs) {
          if (!COLLECTIONS.has(d.collection) || d.collection === 'admins' || !ID.test(String(d.id)) || !d.data || typeof d.data !== 'object') throw new HttpErr(400, 'Invalid setup data.');
          writeDoc(db, d.collection, String(d.id), d.data);
        }
        const salt = randomBytes(16).toString('hex');
        writeDoc(db, 'admins', admin.id as string, { ...admin, salt, hash: pbkdf2(password, salt), active: true, canOverride: true, lastLoginAt: new Date().toISOString() });
        return admin.id as string;
      });
      const a = readDoc(db, 'admins', id)!;
      return json(res, 200, { admin: adminInfo({ ...a, id }) }, { 'set-cookie': startSession(id) });
    }

    if (path === '/auth/login' && method === 'POST') {
      const b = await body(req);
      const identifier = String(b.identifier ?? '').trim().toUpperCase();
      const password = String(b.password ?? '');
      const key = `${identifier}|${req.socket.remoteAddress}`;
      const f = attempts.get(key);
      if (f && f.n >= 5 && f.until > Date.now()) throw new HttpErr(429, 'Too many failed attempts. Try again in 15 minutes.');
      const a = liveAdmins(db).find((x) => String(x.identifier).toUpperCase() === identifier);
      if (!a || !a.active || !checkPassword(password, a.salt, a.hash)) {
        attempts.set(key, { n: (f && f.until > Date.now() ? f.n : 0) + 1, until: Date.now() + 15 * 60_000 });
        throw new HttpErr(401, 'Identifier or password is incorrect.');
      }
      attempts.delete(key);
      const { id, ...rest } = a;
      writeDoc(db, 'admins', String(id), { ...rest, lastLoginAt: new Date().toISOString() });
      return json(res, 200, { admin: adminInfo(a) }, { 'set-cookie': startSession(String(id)) });
    }

    if (path === '/auth/logout' && method === 'POST') return json(res, 200, { ok: true }, { 'set-cookie': sessionCookie('', 0) });

    // ----- store (signed-in admins only) -----
    const me = currentAdmin(req);
    if (!me) throw new HttpErr(401, 'Sign in required.');

    if (path === '/store/snapshot' && method === 'GET') {
      const rows = all<{ collection: string; id: string; data: string }>(db, 'SELECT collection, id, data FROM app_docs WHERE data IS NOT NULL');
      const seq = get<{ s: number }>(db, 'SELECT COALESCE(MAX(seq), 0) AS s FROM app_docs')!.s;
      return json(res, 200, { seq, docs: rows.map((r) => ({ collection: r.collection, id: r.id, data: publicView(r.collection, JSON.parse(r.data)) })) });
    }

    if (path === '/store/changes' && method === 'GET') {
      const since = Number(url.searchParams.get('since') ?? 0) || 0;
      const rows = all<{ collection: string; id: string; data: string | null; seq: number }>(db, 'SELECT collection, id, data, seq FROM app_docs WHERE seq > ? ORDER BY seq', since);
      const seq = rows.length ? rows[rows.length - 1].seq : since;
      return json(res, 200, { seq, docs: rows.map((r) => ({ collection: r.collection, id: r.id, data: r.data ? publicView(r.collection, JSON.parse(r.data)) : null })) });
    }

    if (path === '/store/backup' && method === 'GET') {
      const rows = all<{ collection: string; id: string; data: string }>(db, 'SELECT collection, id, data FROM app_docs WHERE data IS NOT NULL ORDER BY collection, id');
      const day = new Date().toISOString().slice(0, 10);
      return json(res, 200, { app: 'beach-patrol-scheduler', exportedAt: new Date().toISOString(), docs: rows.map((r) => ({ collection: r.collection, id: r.id, data: publicView(r.collection, JSON.parse(r.data)) })) }, { 'content-disposition': `attachment; filename="beach-patrol-backup-${day}.json"` });
    }

    const m = path.match(/^\/store\/([a-z]+)\/([^/]+)$/);
    if (!m) throw new HttpErr(404, 'Not found.');
    const col = m[1];
    const id = decodeURIComponent(m[2]);
    if (!COLLECTIONS.has(col) || !ID.test(id)) throw new HttpErr(400, 'Unknown collection or invalid id.');

    if (method === 'GET') {
      const d = readDoc(db, col, id);
      return json(res, 200, { exists: !!d, data: publicView(col, d) });
    }

    const seq = tx(db, () => {
      const existing = readDoc(db, col, id);
      if (method === 'DELETE') {
        if (col === 'admins' && id === me.id) throw new HttpErr(409, 'You cannot delete your own account.');
        return existing ? writeDoc(db, col, id, null) : nextSeq(db) - 1;
      }
      if (method !== 'PUT' && method !== 'PATCH') throw new HttpErr(405, 'Method not allowed.');
      return null;
    });
    if (seq !== null) return json(res, 200, { seq });

    const b = await body(req);
    const data = b.data as Doc | undefined;
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new HttpErr(400, 'Send { data: { … } }.');
    const out = tx(db, () => {
      const existing = readDoc(db, col, id);
      if (method === 'PATCH' && !existing) throw new HttpErr(404, 'That record does not exist.');
      let next = method === 'PATCH' ? merge(existing!, data) : data;
      if (col === 'admins') {
        if (!existing && liveAdmins(db).length >= MAX_ADMINS) throw new HttpErr(409, `The scheduler allows at most ${MAX_ADMINS} admin accounts.`);
        // keep the stored password unless the change sets a new one
        if (existing && (typeof data.salt !== 'string' || typeof data.hash !== 'string')) next = { ...next, salt: existing.salt, hash: existing.hash };
        if (!next.salt || !next.hash) throw new HttpErr(400, 'A new admin needs a password.');
        if (id === me.id && next.active === false) throw new HttpErr(409, 'You cannot deactivate your own account.');
      }
      return writeDoc(db, col, id, next);
    });
    return json(res, 200, { seq: out });
  }

  return createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (res.headersSent) return res.end();
      if (err instanceof HttpErr) return json(res, err.status, { error: err.message });
      console.error(err);
      json(res, 500, { error: 'Something went wrong on the server.' });
    });
  });
}
