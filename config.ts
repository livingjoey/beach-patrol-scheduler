import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

export interface Config {
  port: number;
  dbPath: string;
  authSecret: string;
  corsOrigin: string;
  tokenTtlHours: number;
}

/** Loads KEY=VALUE pairs from .env into process.env (without overriding real env vars). */
export function loadDotEnv(path = '.env'): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  let authSecret = env.AUTH_SECRET ?? '';
  if (!authSecret) {
    if (env.NODE_ENV === 'production') throw new Error('AUTH_SECRET must be set in production.');
    authSecret = randomBytes(32).toString('hex');
    console.warn('[config] AUTH_SECRET is not set; using a temporary secret. Sign-ins reset when the server restarts.');
  }
  return {
    port: Number(env.PORT ?? 3000),
    dbPath: env.DB_PATH ?? './data/beach-patrol.db',
    authSecret,
    corsOrigin: env.CORS_ORIGIN ?? '',
    tokenTtlHours: Number(env.TOKEN_TTL_HOURS ?? 12),
  };
}
