// Personnel profiles, certifications and certification equivalencies.

import { all, audit, bool, get, run, tx, type DB } from '../db/index.ts';
import { evaluate, missing } from '../domain/criteria.ts';
import { WEEKDAYS, weekDates, weekStartOf, todayIso } from '../domain/dates.ts';
import { ADMIN, created, HttpError, noContent, type Router } from '../http/app.ts';
import { bad, has, idParam, int, notFound, obj, optBool, optInt, optOneOf, optStr, str, type Body } from '../http/validate.ts';
import { knownCertCodes, loadEquivalencies, loadPersonnel, loadPresets } from '../services/context.ts';
import { entriesForPerson } from '../services/week.ts';

export const LABEL_COLORS = ['red', 'light_blue', 'green', 'dark_blue', 'white'] as const;
const LG = /^LG\d{1,4}$/i;
const CERT_CODE = /^[A-Z0-9][A-Z0-9_-]{0,15}$/;

export function personJson(db: DB, id: number) {
  const p = get<{ id: number; lg_number: string; name: string; active: number; label_color: string; created_at: string; updated_at: string }>(
    db,
    'SELECT * FROM personnel WHERE id = ?',
    id,
  );
  if (!p) return null;
  const certs = all<{ cert_code: string }>(
    db,
    'SELECT pc.cert_code FROM personnel_certs pc JOIN certifications c ON c.code = pc.cert_code WHERE pc.personnel_id = ? ORDER BY c.sort_order, c.code',
    id,
  ).map((r) => r.cert_code);
  const days = all<{ weekday: number }>(db, 'SELECT weekday FROM personnel_days_off WHERE personnel_id = ? ORDER BY weekday', id).map(
    (r) => WEEKDAYS[r.weekday],
  );
  return {
    id: p.id,
    lgNumber: p.lg_number,
    name: p.name,
    active: p.active === 1,
    labelColor: p.label_color,
    certifications: certs,
    regularDaysOff: days,
    createdAt: p.created_at,
    updatedAt: p.updated_at,
  };
}

function parseDaysOff(v: unknown): number[] {
  if (!Array.isArray(v)) throw bad('regularDaysOff', `must be an array of ${WEEKDAYS.join(', ')}`);
  const out = new Set<number>();
  for (const d of v) {
    const i = WEEKDAYS.indexOf(String(d).toLowerCase().slice(0, 3) as (typeof WEEKDAYS)[number]);
    if (i < 0) throw bad('regularDaysOff', `contains "${d}"; use ${WEEKDAYS.join(', ')}`);
    out.add(i);
  }
  return [...out];
}

function parseCerts(db: DB, v: unknown): string[] {
  if (!Array.isArray(v)) throw bad('certifications', 'must be an array of certification codes');
  const known = knownCertCodes(db);
  const out = new Set<string>();
  for (const c of v) {
    const code = String(c).trim().toUpperCase();
    if (!known.has(code)) throw bad('certifications', `contains unknown certification "${c}"`);
    out.add(code);
  }
  return [...out];
}

function writePersonDetails(db: DB, id: number, b: Body): void {
  if (has(b, 'certifications')) {
    const certs = parseCerts(db, b.certifications);
    run(db, 'DELETE FROM personnel_certs WHERE personnel_id = ?', id);
    for (const c of certs) run(db, 'INSERT INTO personnel_certs (personnel_id, cert_code) VALUES (?, ?)', id, c);
  }
  if (has(b, 'regularDaysOff')) {
    const days = parseDaysOff(b.regularDaysOff);
    run(db, 'DELETE FROM personnel_days_off WHERE personnel_id = ?', id);
    for (const d of days) run(db, 'INSERT INTO personnel_days_off (personnel_id, weekday) VALUES (?, ?)', id, d);
  }
}

export function registerPersonnel(r: Router, db: DB): void {
  // ----- personnel -----

  r.get('/api/personnel', ADMIN, (req) => {
    const active = req.query.get('active');
    const q = (req.query.get('q') ?? '').trim().toLowerCase();
    const cert = (req.query.get('cert') ?? '').trim().toUpperCase();
    const ids = all<{ id: number }>(db, 'SELECT id FROM personnel ORDER BY CAST(SUBSTR(lg_number, 3) AS INTEGER), lg_number');
    return ids
      .map((row) => personJson(db, row.id)!)
      .filter((p) => (active === 'true' ? p.active : active === 'false' ? !p.active : true))
      .filter((p) => !q || p.lgNumber.toLowerCase().includes(q) || p.name.toLowerCase().includes(q))
      .filter((p) => !cert || p.certifications.includes(cert));
  });

  r.get('/api/personnel/:id', ADMIN, (req) => personJson(db, idParam(req.params.id)) ?? (() => { throw notFound('Lifeguard'); })());

  r.post('/api/personnel', ADMIN, (req) => {
    const b = obj(req.body);
    const lg = str(b, 'lgNumber', { max: 10, pattern: LG }).toUpperCase();
    const name = str(b, 'name', { max: 120 });
    const active = optBool(b, 'active') ?? true;
    const color = optOneOf(b, 'labelColor', LABEL_COLORS) ?? 'white';
    const id = tx(db, () => {
      const { lastId } = run(db, 'INSERT INTO personnel (lg_number, name, active, label_color) VALUES (?, ?, ?, ?)', lg, name, bool(active), color);
      writePersonDetails(db, lastId, b);
      audit(db, req.user.id, 'personnel.create', { id: lastId, lg });
      return lastId;
    });
    return created(personJson(db, id));
  });

  r.patch('/api/personnel/:id', ADMIN, (req) => {
    const id = idParam(req.params.id);
    const b = obj(req.body);
    if (!get(db, 'SELECT id FROM personnel WHERE id = ?', id)) throw notFound('Lifeguard');
    tx(db, () => {
      const lg = optStr(b, 'lgNumber', { max: 10, pattern: LG });
      if (lg) run(db, 'UPDATE personnel SET lg_number = ? WHERE id = ?', lg.toUpperCase(), id);
      const name = optStr(b, 'name', { max: 120 });
      if (name) run(db, 'UPDATE personnel SET name = ? WHERE id = ?', name, id);
      const active = optBool(b, 'active');
      if (active !== undefined) run(db, 'UPDATE personnel SET active = ? WHERE id = ?', bool(active), id);
      const color = optOneOf(b, 'labelColor', LABEL_COLORS);
      if (color) run(db, 'UPDATE personnel SET label_color = ? WHERE id = ?', color, id);
      writePersonDetails(db, id, b);
      run(db, "UPDATE personnel SET updated_at = datetime('now') WHERE id = ?", id);
      audit(db, req.user.id, 'personnel.update', { id, fields: Object.keys(b) });
    });
    return personJson(db, id);
  });

  r.delete('/api/personnel/:id', ADMIN, (req) => {
    const id = idParam(req.params.id);
    const { changes } = run(db, 'DELETE FROM personnel WHERE id = ?', id);
    if (!changes) throw notFound('Lifeguard');
    audit(db, req.user.id, 'personnel.delete', { id });
    return noContent();
  });

  // Add / remove a single certification.
  r.put('/api/personnel/:id/certifications/:code', ADMIN, (req) => {
    const id = idParam(req.params.id);
    const code = req.params.code.toUpperCase();
    if (!knownCertCodes(db).has(code)) throw notFound(`Certification ${code}`);
    if (!get(db, 'SELECT id FROM personnel WHERE id = ?', id)) throw notFound('Lifeguard');
    run(db, 'INSERT OR IGNORE INTO personnel_certs (personnel_id, cert_code) VALUES (?, ?)', id, code);
    audit(db, req.user.id, 'personnel.cert.add', { id, code });
    return personJson(db, id);
  });

  r.delete('/api/personnel/:id/certifications/:code', ADMIN, (req) => {
    const id = idParam(req.params.id);
    run(db, 'DELETE FROM personnel_certs WHERE personnel_id = ? AND cert_code = ?', id, req.params.code.toUpperCase());
    audit(db, req.user.id, 'personnel.cert.remove', { id, code: req.params.code.toUpperCase() });
    return personJson(db, id) ?? (() => { throw notFound('Lifeguard'); })();
  });

  // Which saved criteria this lifeguard meets (and what's missing for the rest).
  r.get('/api/personnel/:id/qualifications', ADMIN, (req) => {
    const id = idParam(req.params.id);
    const person = loadPersonnel(db).get(id);
    if (!person) throw notFound('Lifeguard');
    return [...loadPresets(db).values()].map((p) => ({
      presetId: p.id,
      name: p.name,
      qualifies: evaluate(p.rule, person.certs),
      missing: missing(p.rule, person.certs),
    }));
  });

  // Assigned shifts and positions for a week.
  r.get('/api/personnel/:id/shifts', ADMIN, (req) => {
    const id = idParam(req.params.id);
    const start = weekStartOf(req.query.get('week') ?? todayIso());
    return { weekStart: start, days: entriesForPerson(db, id, weekDates(start)) };
  });

  // ----- certifications -----

  r.get('/api/certifications', ADMIN, () => ({
    certifications: all<{ code: string; name: string; sort_order: number }>(db, 'SELECT * FROM certifications ORDER BY sort_order, code').map((c) => ({
      code: c.code,
      name: c.name,
      sortOrder: c.sort_order,
    })),
    equivalencies: all<{ id: number; holder_code: string; satisfies_code: string; enabled: number }>(
      db,
      'SELECT * FROM cert_equivalencies ORDER BY holder_code, satisfies_code',
    ).map((e) => ({ id: e.id, holder: e.holder_code, satisfies: e.satisfies_code, enabled: e.enabled === 1 })),
  }));

  r.post('/api/certifications', ADMIN, (req) => {
    const b = obj(req.body);
    const code = str(b, 'code', { max: 16 }).toUpperCase();
    if (!CERT_CODE.test(code)) throw bad('code', 'may use letters, digits, - and _ (max 16)');
    const name = optStr(b, 'name', { max: 80 }) ?? code;
    const sortOrder = optInt(b, 'sortOrder') ?? (get<{ m: number }>(db, 'SELECT COALESCE(MAX(sort_order), 0) + 1 AS m FROM certifications')!.m);
    run(db, 'INSERT INTO certifications (code, name, sort_order) VALUES (?, ?, ?)', code, name, sortOrder);
    audit(db, req.user.id, 'cert.create', { code });
    return created({ code, name, sortOrder });
  });

  r.patch('/api/certifications/:code', ADMIN, (req) => {
    const b = obj(req.body);
    const code = req.params.code.toUpperCase();
    if (!get(db, 'SELECT code FROM certifications WHERE code = ?', code)) throw notFound(`Certification ${code}`);
    const name = optStr(b, 'name', { max: 80 });
    if (name) run(db, 'UPDATE certifications SET name = ? WHERE code = ?', name, code);
    const sortOrder = optInt(b, 'sortOrder');
    if (sortOrder !== undefined) run(db, 'UPDATE certifications SET sort_order = ? WHERE code = ?', sortOrder, code);
    return get(db, 'SELECT code, name, sort_order AS sortOrder FROM certifications WHERE code = ?', code);
  });

  // Replace the full list of equivalency rules.
  r.put('/api/certifications/equivalencies', ADMIN, (req) => {
    const b = obj(req.body);
    if (!Array.isArray(b.items)) throw bad('items', 'must be an array of { holder, satisfies, enabled }');
    const known = knownCertCodes(db);
    const items = b.items.map((raw, i) => {
      const it = obj(raw, `items[${i}]`);
      const holder = str(it, 'holder').toUpperCase();
      const satisfies = str(it, 'satisfies').toUpperCase();
      if (!known.has(holder)) throw bad(`items[${i}].holder`, `is not a known certification`);
      if (!known.has(satisfies)) throw bad(`items[${i}].satisfies`, `is not a known certification`);
      if (holder === satisfies) throw bad(`items[${i}]`, 'cannot map a certification to itself');
      return { holder, satisfies, enabled: optBool(it, 'enabled') ?? false };
    });
    tx(db, () => {
      run(db, 'DELETE FROM cert_equivalencies');
      for (const it of items) {
        run(db, 'INSERT INTO cert_equivalencies (holder_code, satisfies_code, enabled) VALUES (?, ?, ?)', it.holder, it.satisfies, bool(it.enabled));
      }
      audit(db, req.user.id, 'cert.equivalencies', { items });
    });
    return { equivalencies: items, active: loadEquivalencies(db) };
  });
}

export function requirePerson(db: DB, id: number): void {
  if (!get(db, 'SELECT id FROM personnel WHERE id = ?', id)) throw new HttpError(404, 'not_found', 'Lifeguard not found.');
}

export { int };
