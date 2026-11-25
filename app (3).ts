import type { Server } from 'node:http';
import type { DB } from './db/index.ts';
import { createApp, PUBLIC, Router } from './http/app.ts';
import { registerAdmins, resolveUser } from './routes/admins.ts';
import { registerAssignments } from './routes/assignments.ts';
import { registerAvailability } from './routes/availability.ts';
import { registerExport } from './routes/export.ts';
import { registerPersonnel } from './routes/personnel.ts';
import { registerSchedule } from './routes/schedule.ts';
import type { Config } from './config.ts';

export function buildServer(db: DB, cfg: Config, opts: { log?: boolean } = {}): Server {
  const router = new Router();
  router.get('/api/health', PUBLIC, () => ({ ok: true }));
  registerAdmins(router, db, cfg);
  registerPersonnel(router, db);
  registerAvailability(router, db);
  registerAssignments(router, db);
  registerSchedule(router, db);
  registerExport(router, db);
  return createApp(router, { authSecret: cfg.authSecret, corsOrigin: cfg.corsOrigin, log: opts.log, resolveUser: (id) => resolveUser(db, id) });
}
