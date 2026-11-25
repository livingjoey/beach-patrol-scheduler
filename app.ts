// A small dependency-free HTTP layer: routing, JSON bodies, auth, CORS and errors.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { verifyToken, type TokenPayload } from '../auth/crypto.ts';
import { RuleError } from '../domain/criteria.ts';

export class HttpError extends Error {
  status: number;
  code: string;
  details: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export class Reply {
  status: number;
  body: unknown;
  constructor(status: number, body: unknown) {
    this.status = status;
    this.body = body;
  }
}
export const created = (body: unknown) => new Reply(201, body);

export class FileReply {
  data: Uint8Array;
  contentType: string;
  filename: string;
  constructor(data: Uint8Array, contentType: string, filename: string) {
    this.data = data;
    this.contentType = contentType;
    this.filename = filename;
  }
}
export const noContent = () => new Reply(204, null);

export interface AuthUser {
  id: number;
  identifier: string;
  displayName: string;
  canOverride: boolean;
}

export interface Req {
  method: string;
  path: string;
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
  user: AuthUser;
}

/** 'admin' = any signed-in, active admin account. */
type Access = 'public' | 'admin';
type Handler = (req: Req) => unknown | Promise<unknown>;

interface Route {
  method: string;
  parts: string[];
  access: Access;
  handler: Handler;
}

export const ADMIN: Access = 'admin';
export const PUBLIC: Access = 'public';

export class Router {
  routes: Route[] = [];
  add(method: string, pattern: string, access: Access, handler: Handler): void {
    this.routes.push({ method, parts: pattern.split('/').filter(Boolean), access, handler });
  }
  get(p: string, a: Access, h: Handler) { this.add('GET', p, a, h); }
  post(p: string, a: Access, h: Handler) { this.add('POST', p, a, h); }
  put(p: string, a: Access, h: Handler) { this.add('PUT', p, a, h); }
  patch(p: string, a: Access, h: Handler) { this.add('PATCH', p, a, h); }
  delete(p: string, a: Access, h: Handler) { this.add('DELETE', p, a, h); }

  match(method: string, path: string): { route: Route; params: Record<string, string> } | 'method' | null {
    const parts = path.split('/').filter(Boolean);
    let pathMatched = false;
    for (const route of this.routes) {
      if (route.parts.length !== parts.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < parts.length; i++) {
        const rp = route.parts[i];
        if (rp.startsWith(':')) params[rp.slice(1)] = decodeURIComponent(parts[i]);
        else if (rp !== parts[i]) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      pathMatched = true;
      if (route.method === method) return { route, params };
    }
    return pathMatched ? 'method' : null;
  }
}

const MAX_BODY = 1024 * 1024;

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, 'body_too_large', 'Request body is too large.');
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid_json', 'Request body is not valid JSON.');
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  if (status === 204) {
    res.writeHead(204).end();
    return;
  }
  const json = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(json) });
  res.end(json);
}

export interface AppOptions {
  authSecret: string;
  /** Looks up an active admin by id; returns null if missing or deactivated. */
  resolveUser: (id: number) => AuthUser | null;
  corsOrigin: string;
  log?: boolean;
}

export function createApp(router: Router, opts: AppOptions): Server {
  return createServer(async (req, res) => {
    const started = Date.now();
    const url = new URL(req.url ?? '/', 'http://localhost');
    const method = req.method ?? 'GET';
    if (opts.corsOrigin) {
      res.setHeader('access-control-allow-origin', opts.corsOrigin);
      res.setHeader('vary', 'origin');
      res.setHeader('access-control-allow-headers', 'authorization, content-type');
      res.setHeader('access-control-allow-methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    }
    res.setHeader('x-content-type-options', 'nosniff');
    try {
      if (method === 'OPTIONS') {
        send(res, 204, null);
        return;
      }
      const m = router.match(method, url.pathname);
      if (m === null) throw new HttpError(404, 'not_found', `No route for ${url.pathname}`);
      if (m === 'method') throw new HttpError(405, 'method_not_allowed', `${method} is not supported on ${url.pathname}`);

      let user: AuthUser = { id: 0, identifier: '', displayName: '', canOverride: false };
      if (m.route.access !== 'public') {
        const header = req.headers.authorization ?? '';
        const token = header.startsWith('Bearer ') ? header.slice(7) : '';
        const payload: TokenPayload | null = token ? verifyToken(token, opts.authSecret) : null;
        const found = payload ? opts.resolveUser(payload.sub) : null;
        if (!found) throw new HttpError(401, 'unauthorized', 'Sign in required.');
        user = found;
      }
      const body = method === 'GET' || method === 'DELETE' ? {} : await readJson(req);
      const result = await m.route.handler({ method, path: url.pathname, params: m.params, query: url.searchParams, body, user });
      if (result instanceof FileReply) {
        res.writeHead(200, {
          'content-type': result.contentType,
          'content-length': result.data.byteLength,
          'content-disposition': `attachment; filename="${result.filename.replace(/[^\w.-]/g, '_')}"`,
        });
        res.end(result.data);
      } else if (result instanceof Reply) send(res, result.status, result.body);
      else send(res, 200, result ?? { ok: true });
    } catch (err) {
      if (err instanceof HttpError) {
        send(res, err.status, { error: { code: err.code, message: err.message, details: err.details } });
      } else if (err instanceof RuleError) {
        send(res, 400, { error: { code: 'invalid_rule', message: err.message, details: { path: err.path } } });
      } else if (err instanceof Error && /UNIQUE constraint failed/.test(err.message)) {
        send(res, 409, { error: { code: 'duplicate', message: 'That value is already in use.', details: err.message.replace('UNIQUE constraint failed: ', '') } });
      } else if (err instanceof Error && /FOREIGN KEY constraint failed/.test(err.message)) {
        send(res, 400, { error: { code: 'invalid_reference', message: 'A referenced record does not exist.' } });
      } else {
        console.error(err);
        send(res, 500, { error: { code: 'internal', message: 'Something went wrong.' } });
      }
    } finally {
      if (opts.log) console.log(`${method} ${url.pathname} ${res.statusCode} ${Date.now() - started}ms`);
    }
  });
}
