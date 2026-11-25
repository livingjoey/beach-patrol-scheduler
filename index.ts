import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { SCHEMA_SQL } from './schema.ts';

export type DB = DatabaseSync;
export type Param = SQLInputValue;

const statementCache = new WeakMap<DB, Map<string, StatementSync>>();
const txDepth = new WeakMap<DB, number>();

export function openDb(path: string): DB {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA_SQL);
  return db;
}

function stmt(db: DB, sql: string): StatementSync {
  let cache = statementCache.get(db);
  if (!cache) {
    cache = new Map();
    statementCache.set(db, cache);
  }
  let s = cache.get(sql);
  if (!s) {
    s = db.prepare(sql);
    cache.set(sql, s);
  }
  return s;
}

export function all<T>(db: DB, sql: string, ...params: Param[]): T[] {
  return stmt(db, sql).all(...params) as unknown as T[];
}

export function get<T>(db: DB, sql: string, ...params: Param[]): T | undefined {
  return stmt(db, sql).get(...params) as unknown as T | undefined;
}

export function run(db: DB, sql: string, ...params: Param[]): { changes: number; lastId: number } {
  const r = stmt(db, sql).run(...params);
  return { changes: Number(r.changes), lastId: Number(r.lastInsertRowid) };
}

/** Runs fn in a transaction. Nested calls use savepoints. */
export function tx<T>(db: DB, fn: () => T): T {
  const depth = txDepth.get(db) ?? 0;
  const name = `sp${depth}`;
  db.exec(depth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${name}`);
  txDepth.set(db, depth + 1);
  try {
    const result = fn();
    db.exec(depth === 0 ? 'COMMIT' : `RELEASE ${name}`);
    return result;
  } catch (err) {
    db.exec(depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${name}; RELEASE ${name}`);
    throw err;
  } finally {
    txDepth.set(db, depth);
  }
}

export const bool = (v: unknown): number => (v ? 1 : 0);

export function getSetting(db: DB, key: string, fallback: string): string {
  return get<{ value: string }>(db, 'SELECT value FROM settings WHERE key = ?', key)?.value ?? fallback;
}

export function setSetting(db: DB, key: string, value: string): void {
  run(db, 'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value);
}

export function audit(db: DB, userId: number | null, action: string, detail: unknown): void {
  run(db, 'INSERT INTO audit_log (user_id, action, detail_json) VALUES (?, ?, ?)', userId, action, JSON.stringify(detail ?? {}));
}
