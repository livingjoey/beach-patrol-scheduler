// Seeds the reference data the scheduler needs, plus the first admin account.
//   npm run seed         certifications, example presets, assignment directory, admin ADM01
//   npm run seed:demo    the above plus demo lifeguards (clearly labeled) for trying things out
//
// Safe to run more than once: each part is only inserted when its table is empty.

import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { loadDotEnv, loadConfig } from '../config.ts';
import { createAdmin } from '../routes/admins.ts';
import { addDays, weekStartOf, todayIso } from '../domain/dates.ts';
import { get, openDb, run, setSetting, tx, type DB } from './index.ts';

export const CERTIFICATIONS = ['Basic', 'EMR', 'EMT', 'EMT2', 'PMD', 'PWC1', 'PWC2', 'PWC3', 'PWC4', 'PWC5', 'SUP'];

// Example presets only — operators define the real requirements.
export const EXAMPLE_PRESETS: { name: string; rule: unknown; description: string }[] = [
  { name: 'Basic Qualified', rule: { cert: 'BASIC' }, description: 'Example' },
  { name: 'Medical Response Qualified', rule: { any: [{ cert: 'EMT' }, { cert: 'EMT2' }, { cert: 'PMD' }] }, description: 'Example' },
  { name: 'PWC Rescuer', rule: { all: [{ any: [{ cert: 'EMT' }, { cert: 'EMT2' }, { cert: 'PMD' }] }, { cert: 'PWC3' }] }, description: 'Example' },
  { name: 'PWC Operator', rule: { any: [{ cert: 'PWC2' }, { cert: 'PWC3' }] }, description: 'Example' },
  { name: 'Boat Crew', rule: { all: [{ cert: 'BASIC' }, { cert: 'PWC4' }] }, description: 'Example' },
  { name: 'Supervisor', rule: { cert: 'SUP' }, description: 'Example' },
];

const isEmpty = (db: DB, table: string) => !get(db, `SELECT 1 FROM ${table} LIMIT 1`);

export function seedReference(db: DB): void {
  tx(db, () => {
    if (isEmpty(db, 'certifications')) {
      CERTIFICATIONS.forEach((c, i) => run(db, 'INSERT INTO certifications (code, name, sort_order) VALUES (?, ?, ?)', c.toUpperCase(), c, i + 1));
      // Possible equivalencies, all OFF. Nothing is implied unless an admin turns one on.
      for (const [h, s] of [['EMT2', 'EMT'], ['EMT', 'EMR'], ['PWC3', 'PWC2'], ['PWC4', 'PWC3'], ['PWC5', 'PWC4']]) {
        run(db, 'INSERT INTO cert_equivalencies (holder_code, satisfies_code, enabled) VALUES (?, ?, 0)', h, s);
      }
    }
    if (isEmpty(db, 'criteria_presets')) {
      for (const p of EXAMPLE_PRESETS) run(db, 'INSERT INTO criteria_presets (name, rule_json, description) VALUES (?, ?, ?)', p.name, JSON.stringify(p.rule), p.description);
    }
    if (isEmpty(db, 'assignments')) {
      const preset = (name: string) => get<{ id: number }>(db, 'SELECT id FROM criteria_presets WHERE name = ?', name)?.id ?? null;
      let order = 0;
      const add = (code: string, kind: string, name: string, slots: number, presetName: string | null, active = true) => {
        order += 10;
        const { lastId } = run(
          db,
          'INSERT INTO assignments (code, kind, display_name, active, sort_order, default_preset_id) VALUES (?, ?, ?, ?, ?, ?)',
          code,
          kind,
          name,
          active ? 1 : 0,
          order,
          presetName ? preset(presetName) : null,
        );
        for (let i = 1; i <= slots; i++) run(db, 'INSERT INTO slots (assignment_id, position, name) VALUES (?, ?, ?)', lastId, i, `Slot ${i}`);
        return lastId;
      };
      for (let n = 1; n <= 11; n++) {
        const slots = n === 1 || n === 9 ? 6 : n === 11 ? 2 : 3;
        const id = add(`STAND-${n}`, 'stand', `Stand ${n}`, slots, 'Basic Qualified');
        if (slots === 6) {
          // Illustrative per-slot criteria from the brief (Basic, EMT, Basic, EMR, PWC2, Basic).
          const sid = (pos: number) => get<{ id: number }>(db, 'SELECT id FROM slots WHERE assignment_id = ? AND position = ?', id, pos)!.id;
          run(db, "UPDATE slots SET criteria_mode = 'preset', preset_id = ? WHERE id = ?", preset('Medical Response Qualified'), sid(2));
          run(db, "UPDATE slots SET criteria_mode = 'custom', custom_rule_json = ? WHERE id = ?", JSON.stringify({ cert: 'EMR' }), sid(4));
          run(db, "UPDATE slots SET criteria_mode = 'custom', custom_rule_json = ? WHERE id = ?", JSON.stringify({ cert: 'PWC2' }), sid(5));
        }
      }
      add('SQUAD-4', 'medical', 'Squad 4', 2, 'Medical Response Qualified');
      add('SQUAD-11', 'medical', 'Squad 11', 2, 'Medical Response Qualified');
      add('SKI-4', 'pwc', 'Ski 4', 2, 'PWC Rescuer');
      add('SKI-11', 'pwc', 'Ski 11', 2, 'PWC Rescuer');
      add('RB-1', 'boat', 'Rescue Boat 1', 3, 'Boat Crew');
      add('RB-4', 'boat', 'Rescue Boat 4', 3, 'Boat Crew');
      add('RB-11', 'boat', 'Rescue Boat 11', 2, 'Boat Crew');
      for (let n = 1; n <= 10; n++) add(`EXTRA-${n}`, 'extra', `Extra ${n}`, 1, 'Basic Qualified', false);
    }
    if (isEmpty(db, 'settings')) {
      setSetting(db, 'overrides_enabled', 'true');
      setSetting(db, 'patrol_name', 'Beach Patrol');
    }
  });
}

export function seedFirstAdmin(db: DB, password?: string): { identifier: string; password: string } | null {
  if (!isEmpty(db, 'users')) return null;
  const pw = password || randomBytes(9).toString('base64url');
  createAdmin(db, { identifier: 'ADM01', displayName: 'Admin 01', password: pw, canOverride: true });
  return { identifier: 'ADM01', password: pw };
}

/** Demo lifeguards for trying the app. Names are clearly placeholders. */
export function seedDemo(db: DB): void {
  if (!isEmpty(db, 'personnel')) return;
  const colors = ['red', 'light_blue', 'green', 'dark_blue', 'white'];
  tx(db, () => {
    for (let n = 10; n <= 85; n++) {
      const { lastId } = run(db, 'INSERT INTO personnel (lg_number, name, label_color) VALUES (?, ?, ?)', `LG${n}`, `Demo Lifeguard ${n}`, colors[n % 5]);
      const certs = ['BASIC'];
      if (n % 3 === 0) certs.push('EMR', 'PWC4');
      if (n % 2 === 0) certs.push('EMT');
      if (n % 7 === 0) certs.push('EMT2');
      if (n % 11 === 0) certs.push('PMD');
      if (n % 4 === 0) certs.push('PWC1');
      if (n % 5 < 2) certs.push('PWC2');
      if (n % 6 === 0) certs.push('PWC3');
      if (n % 13 === 0) certs.push('PWC5');
      if (n % 10 === 0) certs.push('SUP');
      for (const c of new Set(certs)) run(db, 'INSERT INTO personnel_certs (personnel_id, cert_code) VALUES (?, ?)', lastId, c);
      const first = n % 7;
      for (const d of [first, (first + 1) % 7]) run(db, 'INSERT INTO personnel_days_off (personnel_id, weekday) VALUES (?, ?)', lastId, d);
    }
    const start = weekStartOf(todayIso());
    const pid = (lg: string) => get<{ id: number }>(db, 'SELECT id FROM personnel WHERE lg_number = ?', lg)!.id;
    run(db, "INSERT INTO time_off (personnel_id, start_date, end_date, type, note) VALUES (?, ?, ?, 'vacation', 'Demo')", pid('LG18'), start, addDays(start, 1));
    run(db, "INSERT INTO time_off (personnel_id, start_date, end_date, type, note) VALUES (?, ?, ?, 'training', 'Demo')", pid('LG25'), addDays(start, 5), addDays(start, 6));
    run(db, "INSERT INTO time_off (personnel_id, start_date, end_date, type, note) VALUES (?, ?, ?, 'leave', 'Demo')", pid('LG40'), addDays(start, 2), addDays(start, 2));
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  loadDotEnv();
  const cfg = loadConfig({ ...process.env, AUTH_SECRET: process.env.AUTH_SECRET || 'seed-only' });
  const db = openDb(cfg.dbPath);
  seedReference(db);
  const admin = seedFirstAdmin(db, process.env.SEED_ADMIN_PASSWORD);
  if (process.argv.includes('--demo')) seedDemo(db);
  console.log(`Seeded ${cfg.dbPath}${process.argv.includes('--demo') ? ' (with demo lifeguards)' : ''}.`);
  if (admin) console.log(`First admin created. Identifier: ${admin.identifier}  Password: ${admin.password}\nSign in and change this password.`);
  db.close();
}
