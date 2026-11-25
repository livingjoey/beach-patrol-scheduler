// Minimal input validation helpers. Each throws a 400 HttpError naming the field.

import { isIsoDate } from '../domain/dates.ts';
import { HttpError } from './app.ts';

export type Body = Record<string, unknown>;

export function obj(v: unknown, name = 'body'): Body {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw bad(name, 'must be a JSON object');
  return v as Body;
}

export const bad = (field: string, msg: string) => new HttpError(400, 'invalid_input', `${field} ${msg}`, { field });

export function has(b: Body, key: string): boolean {
  return b[key] !== undefined;
}

export function str(b: Body, key: string, opts: { min?: number; max?: number; pattern?: RegExp } = {}): string {
  const v = b[key];
  if (typeof v !== 'string') throw bad(key, 'must be a string');
  const s = v.trim();
  if (s.length < (opts.min ?? 1)) throw bad(key, opts.min === 0 ? 'must be a string' : 'is required');
  if (s.length > (opts.max ?? 200)) throw bad(key, `must be at most ${opts.max ?? 200} characters`);
  if (opts.pattern && !opts.pattern.test(s)) throw bad(key, 'has an invalid format');
  return s;
}

export function optStr(b: Body, key: string, opts: { min?: number; max?: number; pattern?: RegExp } = {}): string | undefined {
  return has(b, key) ? str(b, key, opts) : undefined;
}

export function boolean(b: Body, key: string): boolean {
  if (typeof b[key] !== 'boolean') throw bad(key, 'must be true or false');
  return b[key] as boolean;
}

export function optBool(b: Body, key: string): boolean | undefined {
  return has(b, key) ? boolean(b, key) : undefined;
}

export function int(b: Body, key: string, opts: { min?: number; max?: number } = {}): number {
  const v = b[key];
  if (typeof v !== 'number' || !Number.isInteger(v)) throw bad(key, 'must be an integer');
  if (opts.min !== undefined && v < opts.min) throw bad(key, `must be at least ${opts.min}`);
  if (opts.max !== undefined && v > opts.max) throw bad(key, `must be at most ${opts.max}`);
  return v;
}

export function optInt(b: Body, key: string, opts: { min?: number; max?: number } = {}): number | undefined {
  return has(b, key) ? int(b, key, opts) : undefined;
}

export function date(b: Body, key: string): string {
  if (!isIsoDate(b[key])) throw bad(key, 'must be a date like 2027-06-05');
  return b[key] as string;
}

export function oneOf<T extends string>(b: Body, key: string, values: readonly T[]): T {
  const v = b[key];
  if (typeof v !== 'string' || !values.includes(v as T)) throw bad(key, `must be one of: ${values.join(', ')}`);
  return v as T;
}

export function optOneOf<T extends string>(b: Body, key: string, values: readonly T[]): T | undefined {
  return has(b, key) ? oneOf(b, key, values) : undefined;
}

export function idParam(v: string | undefined, name = 'id'): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, 'invalid_input', `${name} must be a positive integer`, { field: name });
  return n;
}

export function queryDate(q: URLSearchParams, key: string): string {
  const v = q.get(key);
  if (!isIsoDate(v)) throw bad(key, 'query parameter must be a date like 2027-06-05');
  return v;
}

export function notFound(what: string): HttpError {
  return new HttpError(404, 'not_found', `${what} not found.`);
}

export const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
