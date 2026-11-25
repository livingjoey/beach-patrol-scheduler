// Starts the Beach Patrol Scheduler website: the web app plus its data store.
// Set ENABLE_REST_API=true to also serve the separate REST API under /api (see README).

import { fileURLToPath } from 'node:url';
import { loadConfig, loadDotEnv } from './config.ts';
import { openDb } from './db/index.ts';
import { buildServer } from './app.ts';
import { createHostedServer } from './hosted.ts';

loadDotEnv();
const cfg = loadConfig();
const db = openDb(cfg.dbPath);
const production = process.env.NODE_ENV === 'production';

const server = createHostedServer(db, {
  authSecret: cfg.authSecret,
  setupCode: (process.env.SETUP_CODE ?? '').trim(),
  pagePath: fileURLToPath(new URL('../web/dist/index.html', import.meta.url)),
  secureCookies: production || process.env.SECURE_COOKIES === 'true',
  tokenTtlHours: cfg.tokenTtlHours,
  api: process.env.ENABLE_REST_API === 'true' ? buildServer(db, cfg, { log: false }) : undefined,
});

server.listen(cfg.port, () => console.log(`Beach Patrol Scheduler running on http://localhost:${cfg.port}`));

const shutdown = () => server.close(() => { db.close(); process.exit(0); });
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
