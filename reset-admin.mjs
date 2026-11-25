// Emergency password reset for a scheduler admin, run on the server:
//   node scripts/reset-admin.mjs ADM01
// Prints a new temporary password and re-activates the account. Uses DB_PATH like the server.
import { DatabaseSync } from 'node:sqlite';
import { pbkdf2Sync, randomBytes, randomInt } from 'node:crypto';
import { existsSync } from 'node:fs';

const identifier = (process.argv[2] ?? '').trim().toUpperCase();
const dbPath = process.env.DB_PATH ?? './data/beach-patrol.db';
if (!identifier) {
  console.error('Usage: node scripts/reset-admin.mjs <identifier>   e.g. ADM01');
  process.exit(1);
}
if (!existsSync(dbPath)) {
  console.error(`No database at ${dbPath}. Set DB_PATH to the scheduler's database file.`);
  process.exit(1);
}
const db = new DatabaseSync(dbPath);
const rows = db.prepare("SELECT id, data FROM app_docs WHERE collection = 'admins' AND data IS NOT NULL").all();
const row = rows.find((r) => String(JSON.parse(r.data).identifier).toUpperCase() === identifier);
if (!row) {
  const known = rows.map((r) => JSON.parse(r.data).identifier).join(', ') || 'none';
  console.error(`No admin with identifier ${identifier}. Admins: ${known}`);
  process.exit(1);
}
const words = ['Surf', 'Dune', 'Tide', 'Reef', 'Wave', 'Gull', 'Kelp', 'Buoy', 'Cove', 'Jetty'];
const password = `${words[randomInt(words.length)]}-${words[randomInt(words.length)]}-${randomInt(1000, 10000)}`;
const salt = randomBytes(16).toString('hex');
const hash = pbkdf2Sync(password, Buffer.from(salt, 'utf8'), 150_000, 32, 'sha256').toString('hex');
const data = { ...JSON.parse(row.data), salt, hash, active: true };
const seq = db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS s FROM app_docs').get().s;
db.prepare("UPDATE app_docs SET data = ?, seq = ?, updated_at = datetime('now') WHERE collection = 'admins' AND id = ?").run(JSON.stringify(data), seq, row.id);
console.log(`New temporary password for ${identifier}: ${password}`);
console.log('Sign in with it, then change it under Admins → Reset password.');
