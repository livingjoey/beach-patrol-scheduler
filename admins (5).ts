// Sign-in, admin accounts (at most 10) and global settings.
// Only administrators use the scheduler; lifeguards never sign in.

import { all, audit, bool, get, getSetting, run, setSetting, type DB } from '../db/index.ts';
import { hashPassword, signToken, verifyPassword } from '../auth/crypto.ts';
import { ADMIN, created, HttpError, PUBLIC, type AuthUser, type Router } from '../http/app.ts';
import { has, idParam, notFound, obj, optBool, optStr, str } from '../http/validate.ts';

export const MAX_ADMINS = 10;
const IDENTIFIER = /^[A-Za-z0-9_-]{2,20}$/;
const MIN_PASSWORD = 8;

interface UserRow {
  id: number;
  identifier: string;
  display_name: string;
  password_hash: string;
  can_override: number;
  active: number;
  last_login_at: string | null;
  created_at: string;
}

const adminJson = (u: UserRow) => ({
  id: u.id,
  identifier: u.identifier,
  displayName: u.display_name,
  canOverride: u.can_override === 1,
  active: u.active === 1,
  lastLoginAt: u.last_login_at,
  createdAt: u.created_at,
});

export function resolveUser(db: DB, id: number): AuthUser | null {
  const u = get<UserRow>(db, 'SELECT * FROM users WHERE id = ? AND active = 1', id);
  return u ? { id: u.id, identifier: u.identifier, displayName: u.display_name, canOverride: u.can_override === 1 } : null;
}

export function createAdmin(db: DB, a: { identifier: string; displayName: string; password: string; canOverride: boolean }): number {
  const count = get<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM users')!.n;
  if (count >= MAX_ADMINS) throw new HttpError(409, 'admin_limit', `The scheduler allows at most ${MAX_ADMINS} admin accounts. Deactivate or delete one first.`);
  if (!IDENTIFIER.test(a.identifier)) throw new HttpError(400, 'invalid_input', 'identifier may use 2–20 letters, digits, - and _', { field: 'identifier' });
  if (a.password.length < MIN_PASSWORD) throw new HttpError(400, 'invalid_input', `password must be at least ${MIN_PASSWORD} characters`, { field: 'password' });
  return run(
    db,
    'INSERT INTO users (identifier, display_name, password_hash, can_override) VALUES (?, ?, ?, ?)',
    a.identifier.toUpperCase(),
    a.displayName,
    hashPassword(a.password),
    bool(a.canOverride),
  ).lastId;
}

// Simple brute-force protection: 5 failed sign-ins per identifier locks it for 15 minutes.
const failures = new Map<string, { count: number; until: number }>();

function activeOverriders(db: DB, excludeId: number): number {
  return get<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM users WHERE active = 1 AND can_override = 1 AND id <> ?', excludeId)!.n;
}

export function registerAdmins(r: Router, db: DB, cfg: { authSecret: string; tokenTtlHours: number }): void {
  r.post('/api/auth/login', PUBLIC, (req) => {
    const b = obj(req.body);
    const identifier = str(b, 'identifier', { max: 20 }).toUpperCase();
    const password = str(b, 'password', { max: 200 });
    const f = failures.get(identifier);
    if (f && f.count >= 5 && f.until > Date.now()) {
      throw new HttpError(429, 'locked', 'Too many failed attempts. Try again in a few minutes.');
    }
    const u = get<UserRow>(db, 'SELECT * FROM users WHERE identifier = ?', identifier);
    if (!u || !u.active || !verifyPassword(password, u.password_hash)) {
      const next = { count: (f && f.until > Date.now() ? f.count : 0) + 1, until: Date.now() + 15 * 60_000 };
      failures.set(identifier, next);
      throw new HttpError(401, 'invalid_credentials', 'Identifier or password is incorrect.');
    }
    failures.delete(identifier);
    run(db, "UPDATE users SET last_login_at = datetime('now') WHERE id = ?", u.id);
    audit(db, u.id, 'auth.login', {});
    return { token: signToken({ sub: u.id }, cfg.authSecret, cfg.tokenTtlHours), admin: adminJson({ ...u, last_login_at: new Date().toISOString() }) };
  });

  r.get('/api/me', ADMIN, (req) => adminJson(get<UserRow>(db, 'SELECT * FROM users WHERE id = ?', req.user.id)!));

  r.post('/api/me/password', ADMIN, (req) => {
    const b = obj(req.body);
    const current = str(b, 'currentPassword', { max: 200 });
    const next = str(b, 'newPassword', { max: 200 });
    const u = get<UserRow>(db, 'SELECT * FROM users WHERE id = ?', req.user.id)!;
    if (!verifyPassword(current, u.password_hash)) throw new HttpError(400, 'invalid_credentials', 'Current password is incorrect.');
    if (next.length < MIN_PASSWORD) throw new HttpError(400, 'invalid_input', `newPassword must be at least ${MIN_PASSWORD} characters`);
    run(db, 'UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(next), u.id);
    audit(db, u.id, 'auth.password_change', {});
    return { ok: true };
  });

  // ----- admin accounts -----

  r.get('/api/admins', ADMIN, () => ({
    max: MAX_ADMINS,
    admins: all<UserRow>(db, 'SELECT * FROM users ORDER BY identifier').map(adminJson),
  }));

  r.post('/api/admins', ADMIN, (req) => {
    const b = obj(req.body);
    const id = createAdmin(db, {
      identifier: str(b, 'identifier', { max: 20 }),
      displayName: str(b, 'displayName', { max: 80 }),
      password: str(b, 'password', { max: 200 }),
      canOverride: optBool(b, 'canOverride') ?? false,
    });
    audit(db, req.user.id, 'admin.create', { id });
    return created(adminJson(get<UserRow>(db, 'SELECT * FROM users WHERE id = ?', id)!));
  });

  r.patch('/api/admins/:id', ADMIN, (req) => {
    const id = idParam(req.params.id);
    const b = obj(req.body);
    const u = get<UserRow>(db, 'SELECT * FROM users WHERE id = ?', id);
    if (!u) throw notFound('Admin');
    const active = optBool(b, 'active');
    const canOverride = optBool(b, 'canOverride');
    if (id === req.user.id && active === false) throw new HttpError(409, 'self_deactivate', 'You cannot deactivate your own account.');
    if ((active === false || canOverride === false) && u.can_override === 1 && activeOverriders(db, id) === 0) {
      throw new HttpError(409, 'last_overrider', 'At least one active admin must be able to approve overrides.');
    }
    const identifier = optStr(b, 'identifier', { max: 20 });
    if (identifier) {
      if (!IDENTIFIER.test(identifier)) throw new HttpError(400, 'invalid_input', 'identifier may use 2–20 letters, digits, - and _');
      run(db, 'UPDATE users SET identifier = ? WHERE id = ?', identifier.toUpperCase(), id);
    }
    const displayName = optStr(b, 'displayName', { max: 80 });
    if (displayName) run(db, 'UPDATE users SET display_name = ? WHERE id = ?', displayName, id);
    if (active !== undefined) run(db, 'UPDATE users SET active = ? WHERE id = ?', bool(active), id);
    if (canOverride !== undefined) run(db, 'UPDATE users SET can_override = ? WHERE id = ?', bool(canOverride), id);
    if (has(b, 'password')) {
      const pw = str(b, 'password', { max: 200 });
      if (pw.length < MIN_PASSWORD) throw new HttpError(400, 'invalid_input', `password must be at least ${MIN_PASSWORD} characters`);
      run(db, 'UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(pw), id);
    }
    audit(db, req.user.id, 'admin.update', { id, fields: Object.keys(b).filter((k) => k !== 'password') });
    return adminJson(get<UserRow>(db, 'SELECT * FROM users WHERE id = ?', id)!);
  });

  r.delete('/api/admins/:id', ADMIN, (req) => {
    const id = idParam(req.params.id);
    if (id === req.user.id) throw new HttpError(409, 'self_delete', 'You cannot delete your own account.');
    const u = get<UserRow>(db, 'SELECT * FROM users WHERE id = ?', id);
    if (!u) throw notFound('Admin');
    if (u.can_override === 1 && u.active === 1 && activeOverriders(db, id) === 0) {
      throw new HttpError(409, 'last_overrider', 'At least one active admin must be able to approve overrides.');
    }
    run(db, 'DELETE FROM users WHERE id = ?', id);
    audit(db, req.user.id, 'admin.delete', { id, identifier: u.identifier });
    return { ok: true };
  });

  // ----- settings -----

  r.get('/api/settings', ADMIN, () => ({
    overridesEnabled: getSetting(db, 'overrides_enabled', 'true') === 'true',
    patrolName: getSetting(db, 'patrol_name', 'Beach Patrol'),
  }));

  r.patch('/api/settings', ADMIN, (req) => {
    const b = obj(req.body);
    const overrides = optBool(b, 'overridesEnabled');
    if (overrides !== undefined) {
      if (!req.user.canOverride) throw new HttpError(403, 'forbidden', 'Only an admin who can approve overrides may change this.');
      setSetting(db, 'overrides_enabled', String(overrides));
    }
    const name = optStr(b, 'patrolName', { max: 80 });
    if (name) setSetting(db, 'patrol_name', name);
    audit(db, req.user.id, 'settings.update', b);
    return {
      overridesEnabled: getSetting(db, 'overrides_enabled', 'true') === 'true',
      patrolName: getSetting(db, 'patrol_name', 'Beach Patrol'),
    };
  });
}
