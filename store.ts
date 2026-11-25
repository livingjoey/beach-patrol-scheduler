// Data layer. On claude.ai the data lives in the artifact's shared database (live across
// every open copy). Anywhere else (a preview, or if the database is unavailable) it falls
// back to an in-memory store so the page still works, and says so.

import type { Rule } from '../../src/domain/criteria.ts';
import type { AssignmentKind, LabelColor, TimeOffType } from '../../src/domain/scheduling.ts';
import { newId } from './util.ts';

export interface Admin {
  id: string;
  identifier: string;
  displayName: string;
  salt: string;
  hash: string;
  canOverride: boolean;
  active: boolean;
  createdAt: string;
  lastLoginAt?: string | null;
}

export interface Person {
  id: number;
  lgNumber: string;
  name: string;
  active: boolean;
  labelColor: LabelColor;
  certs: string[];
  daysOff: number[]; // 0 = Saturday
}

export interface TimeOff {
  id: number;
  personnelId: number;
  startDate: string;
  endDate: string;
  type: TimeOffType;
  note: string;
  createdBy?: string;
}

export interface Preset {
  id: number;
  name: string;
  rule: Rule;
  description: string;
}

export interface SlotDef {
  id: number;
  name: string;
  mode: 'default' | 'preset' | 'custom';
  presetId: number | null;
  rule: Rule | null;
}

export interface AssignmentDef {
  id: number;
  code: string;
  kind: AssignmentKind;
  displayName: string;
  active: boolean;
  sortOrder: number;
  defaultPresetId: number | null;
  openByDefault: boolean;
  startTime: string | null;
  endTime: string | null;
  slots: SlotDef[];
}

export interface Entry {
  id: number;
  date: string;
  slotId: number;
  personnelId: number;
  locked: boolean;
  source: 'manual' | 'autofill' | 'copy';
  overrideReason: string | null;
  overrideBy: string | null;
  by: string | null;
}

export interface WeekDoc {
  status: 'draft' | 'published';
  publishedAt: string | null;
  publishedBy: string | null;
  entries: Record<string, Entry | null>; // key `${date}|${slotId}`; null = removed
  dayStatus: Record<string, boolean | null>; // key `${assignmentId}|${date}`; null = default
  slotCounts: Record<string, number | null>; // key `${assignmentId}|${date}`; guards used that day; null = all slots
}

/** A saved staffing layout: which assignments are open and how many guards each uses. No names. */
export interface Layout {
  id: number;
  name: string;
  description: string;
  items: Record<string, { open: boolean; slots: number }>; // key = assignment id
  createdBy: string;
  createdAt: string;
  updatedBy: string;
  updatedAt: string;
}

export interface CertConfig {
  list: { code: string; name: string }[];
  equivalencies: { holder: string; satisfies: string; enabled: boolean }[];
}

export interface Settings {
  patrolName: string;
  overridesEnabled: boolean;
}

export interface AuditEvent {
  id: number;
  at: string;
  admin: string;
  action: string;
  detail: string;
}

export interface State {
  persistent: boolean;
  loaded: Set<string>;
  admins: Map<string, Admin>;
  personnel: Map<number, Person>;
  timeOff: Map<number, TimeOff>;
  presets: Map<number, Preset>;
  assignments: Map<number, AssignmentDef>;
  weeks: Map<string, WeekDoc>;
  layouts: Map<number, Layout>;
  certs: CertConfig | null;
  settings: Settings;
  audit: AuditEvent[];
}

export const state: State = {
  persistent: false,
  loaded: new Set(),
  admins: new Map(),
  personnel: new Map(),
  timeOff: new Map(),
  presets: new Map(),
  assignments: new Map(),
  weeks: new Map(),
  layouts: new Map(),
  certs: null,
  settings: { patrolName: 'Beach Patrol', overridesEnabled: true },
  audit: [],
};

const COLLECTIONS = ['admins', 'personnel', 'timeoff', 'presets', 'assignments', 'weeks', 'layouts', 'config', 'audit'] as const;

// ---------- minimal db surface (real or in-memory) ----------

interface Snap {
  id: string;
  exists: boolean;
  data(): Record<string, unknown> | undefined;
}
interface DocRef {
  set(d: Record<string, unknown>): Promise<void>;
  update(d: Record<string, unknown>): Promise<void>;
  delete(): Promise<void>;
  get(): Promise<Snap>;
}
interface ColRef {
  onSnapshot(next: (s: { docs: Snap[] }) => void, err?: (e: { code: string; message: string }) => void): () => void;
}
interface DbLike {
  doc(path: string): DocRef;
  collection(path: string): ColRef;
}

function merge(target: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...target };
  for (const [k, v] of Object.entries(patch)) {
    const cur = out[k];
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && cur && typeof cur === 'object' && !Array.isArray(cur) ? merge(cur as Record<string, unknown>, v as Record<string, unknown>) : v;
  }
  return out;
}

class MemoryDb implements DbLike {
  docs = new Map<string, Record<string, unknown>>();
  listeners = new Map<string, Set<(s: { docs: Snap[] }) => void>>();
  private emit(col: string) {
    const docs = [...this.docs.entries()]
      .filter(([p]) => p.split('/')[0] === col)
      .map(([p, d]) => ({ id: p.split('/')[1], exists: true, data: () => d }));
    for (const fn of this.listeners.get(col) ?? []) fn({ docs });
  }
  doc(path: string): DocRef {
    const col = path.split('/')[0];
    return {
      set: async (d) => {
        this.docs.set(path, structuredClone(d));
        queueMicrotask(() => this.emit(col));
      },
      update: async (d) => {
        const cur = this.docs.get(path);
        if (!cur) throw { code: 'invalid_argument', message: 'missing document' };
        this.docs.set(path, merge(cur, structuredClone(d)));
        queueMicrotask(() => this.emit(col));
      },
      delete: async () => {
        this.docs.delete(path);
        queueMicrotask(() => this.emit(col));
      },
      get: async () => {
        const d = this.docs.get(path);
        return { id: path.split('/')[1], exists: !!d, data: () => d };
      },
    };
  }
  collection(path: string): ColRef {
    return {
      onSnapshot: (next) => {
        if (!this.listeners.has(path)) this.listeners.set(path, new Set());
        this.listeners.get(path)!.add(next);
        queueMicrotask(() => this.emit(path));
        return () => this.listeners.get(path)?.delete(next);
      },
    };
  }
}

// ---------- hosted mode (the app's own website, see src/hosted.ts) ----------

export type Mode = 'claude' | 'hosted' | 'memory';
export let mode: Mode = 'memory';

export interface HostedAdmin {
  id: string;
  identifier: string;
  displayName: string;
  canOverride: boolean;
}
export const hosted = {
  status: null as null | { setupNeeded: boolean; setupCodeRequired: boolean; admin: HostedAdmin | null },
  synced: false,
};

class HostedError extends Error {
  status: number;
  code: string;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.code = status === 404 ? 'invalid_argument' : 'hosted';
  }
}

async function hostedFetch<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', 'x-requested-with': 'bps', ...(init.headers ?? {}) },
  });
  let body: any = null;
  try {
    body = await res.json();
  } catch {
    /* not json */
  }
  if (!res.ok) {
    if (res.status === 401 && hosted.status?.admin) {
      hosted.status.admin = null;
      hosted.synced = false;
      remote?.clear();
      changed();
    }
    throw new HostedError(res.status, body?.error ?? 'The server could not complete that request.');
  }
  return body as T;
}

type Listener = (s: { docs: Snap[] }) => void;

class RemoteDb implements DbLike {
  cache = new Map<string, Map<string, Record<string, unknown>>>();
  listeners = new Map<string, Set<Listener>>();
  seq = 0;
  timer: ReturnType<typeof setTimeout> | null = null;

  private col(c: string) {
    if (!this.cache.has(c)) this.cache.set(c, new Map());
    return this.cache.get(c)!;
  }
  emit(c: string) {
    const docs = [...this.col(c).entries()].map(([id, d]) => ({ id, exists: true, data: () => d }));
    for (const fn of this.listeners.get(c) ?? []) fn({ docs });
  }
  emitAll() {
    for (const c of COLLECTIONS) this.emit(c);
  }
  apply(docs: { collection: string; id: string; data: Record<string, unknown> | null }[]) {
    const touched = new Set<string>();
    for (const d of docs) {
      if (d.data === null) this.col(d.collection).delete(d.id);
      else this.col(d.collection).set(d.id, d.data);
      touched.add(d.collection);
    }
    touched.forEach((c) => this.emit(c));
  }
  async start() {
    this.stop();
    const snap = await hostedFetch<{ seq: number; docs: { collection: string; id: string; data: Record<string, unknown> }[] }>('/store/snapshot');
    this.cache.clear();
    this.seq = snap.seq;
    for (const d of snap.docs) this.col(d.collection).set(d.id, d.data);
    this.emitAll();
    hosted.synced = true;
    changed();
    this.schedule();
  }
  schedule() {
    this.timer = setTimeout(() => this.poll(), document.hidden ? 15_000 : 4_000);
  }
  async poll() {
    this.timer = null;
    try {
      const r = await hostedFetch<{ seq: number; docs: { collection: string; id: string; data: Record<string, unknown> | null }[] }>(`/store/changes?since=${this.seq}`);
      if (r.docs.length) this.apply(r.docs);
      this.seq = r.seq;
    } catch (e) {
      if ((e as HostedError).status === 401) return;
    }
    if (hosted.status?.admin) this.schedule();
  }
  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
  clear() {
    this.stop();
    this.cache.clear();
    this.seq = 0;
    this.emitAll();
  }
  doc(path: string): DocRef {
    const [c, id] = path.split('/');
    const url = `/store/${c}/${encodeURIComponent(id)}`;
    const clean = (d: Record<string, unknown>) => {
      if (c !== 'admins') return d;
      const { salt: _s, hash: _h, ...rest } = d;
      return rest;
    };
    return {
      set: async (d) => {
        await hostedFetch(url, { method: 'PUT', body: JSON.stringify({ data: d }) });
        this.col(c).set(id, clean(structuredClone(d)));
        this.emit(c);
      },
      update: async (d) => {
        await hostedFetch(url, { method: 'PATCH', body: JSON.stringify({ data: d }) });
        const cur = this.col(c).get(id);
        if (cur) this.col(c).set(id, clean(merge(cur, structuredClone(d))));
        this.emit(c);
      },
      delete: async () => {
        await hostedFetch(url, { method: 'DELETE' });
        this.col(c).delete(id);
        this.emit(c);
      },
      get: async () => {
        const r = await hostedFetch<{ exists: boolean; data: Record<string, unknown> | null }>(url);
        return { id, exists: r.exists, data: () => r.data ?? undefined };
      },
    };
  }
  collection(c: string): ColRef {
    return {
      onSnapshot: (next) => {
        if (!this.listeners.has(c)) this.listeners.set(c, new Set());
        this.listeners.get(c)!.add(next);
        queueMicrotask(() => next({ docs: [...this.col(c).entries()].map(([id, d]) => ({ id, exists: true, data: () => d })) }));
        return () => this.listeners.get(c)?.delete(next);
      },
    };
  }
}

let remote: RemoteDb | null = null;

export async function hostedLogin(identifier: string, password: string): Promise<HostedAdmin> {
  const r = await hostedFetch<{ admin: HostedAdmin }>('/auth/login', { method: 'POST', body: JSON.stringify({ identifier, password }) });
  hosted.status = { setupNeeded: false, setupCodeRequired: hosted.status?.setupCodeRequired ?? false, admin: r.admin };
  await remote!.start();
  return r.admin;
}

export async function hostedLogout(): Promise<void> {
  try {
    await hostedFetch('/auth/logout', { method: 'POST' });
  } catch {
    /* already signed out */
  }
  if (hosted.status) hosted.status.admin = null;
  hosted.synced = false;
  remote?.clear();
}

export async function hostedSetup(payload: unknown): Promise<HostedAdmin> {
  const r = await hostedFetch<{ admin: HostedAdmin }>('/auth/setup', { method: 'POST', body: JSON.stringify(payload) });
  hosted.status = { setupNeeded: false, setupCodeRequired: false, admin: r.admin };
  await remote!.start();
  return r.admin;
}

let db: DbLike = new MemoryDb();
const listeners = new Set<() => void>();
export const onChange = (fn: () => void) => listeners.add(fn);
let pending = false;
function changed() {
  if (pending) return;
  pending = true;
  requestAnimationFrame(() => {
    pending = false;
    listeners.forEach((fn) => fn());
  });
}

function apply(col: string, docs: Snap[]) {
  const rows = docs.filter((d) => d.exists).map((d) => [d.id, d.data() as Record<string, unknown>] as const);
  switch (col) {
    case 'admins':
      state.admins = new Map(rows.map(([id, d]) => [id, { ...(d as unknown as Admin), id }]));
      break;
    case 'personnel':
      state.personnel = new Map(rows.map(([, d]) => [Number(d.id), d as unknown as Person]));
      break;
    case 'timeoff':
      state.timeOff = new Map(rows.map(([, d]) => [Number(d.id), d as unknown as TimeOff]));
      break;
    case 'presets':
      state.presets = new Map(rows.map(([, d]) => [Number(d.id), d as unknown as Preset]));
      break;
    case 'assignments':
      state.assignments = new Map(rows.map(([, d]) => [Number(d.id), d as unknown as AssignmentDef]));
      break;
    case 'weeks':
      state.weeks = new Map(rows.map(([id, d]) => [id, { entries: {}, dayStatus: {}, slotCounts: {}, status: 'draft', publishedAt: null, publishedBy: null, ...(d as Partial<WeekDoc>) } as WeekDoc]));
      break;
    case 'layouts':
      state.layouts = new Map(rows.map(([, d]) => [Number(d.id), d as unknown as Layout]));
      break;
    case 'config': {
      const m = new Map(rows);
      state.certs = (m.get('certs') as unknown as CertConfig) ?? null;
      state.settings = { patrolName: 'Beach Patrol', overridesEnabled: true, ...((m.get('settings') as Partial<Settings>) ?? {}) };
      break;
    }
    case 'audit':
      state.audit = rows
        .flatMap(([, d]) => Object.values((d.events as Record<string, AuditEvent>) ?? {}))
        .sort((a, b) => b.id - a.id)
        .slice(0, 300);
      break;
  }
  state.loaded.add(col);
  changed();
}

export async function initStore(): Promise<void> {
  const claude = (window as unknown as { claude?: { use(n: string): Promise<unknown> } }).claude;
  const real = claude ? ((await claude.use('db').catch(() => null)) as DbLike | null) : null;
  if (real) {
    db = real;
    mode = 'claude';
    state.persistent = true;
  } else if (!claude) {
    try {
      const r = await fetch('/auth/status', { credentials: 'same-origin' });
      if (r.ok && (r.headers.get('content-type') ?? '').includes('json')) {
        hosted.status = await r.json();
        mode = 'hosted';
        state.persistent = true;
        remote = new RemoteDb();
        db = remote;
      }
    } catch {
      /* not on the scheduler's own server */
    }
  }
  for (const col of COLLECTIONS) {
    db.collection(col).onSnapshot(
      (s) => apply(col, s.docs),
      (e) => {
        console.warn('db', col, e);
        state.loaded.add(col);
        changed();
      },
    );
  }
  if (mode === 'hosted' && hosted.status?.admin) await remote!.start().catch(() => changed());
}

export const allLoaded = () => COLLECTIONS.every((c) => state.loaded.has(c));

// ---------- writes ----------

export class StoreError extends Error {}

function fail(e: unknown): never {
  if (e instanceof HostedError) throw new StoreError(e.message);
  const code = (e as { code?: string })?.code;
  if (code === 'quota_exceeded') throw new StoreError('The scheduler database is full. Delete old weeks or time-off entries to make room.');
  if (code === 'invalid_argument') throw new StoreError('You do not have edit access to this scheduler.');
  throw new StoreError('Could not save. Check your connection and try again.');
}

async function write(fn: () => Promise<void>) {
  try {
    await fn();
  } catch (e) {
    try {
      await new Promise((r) => setTimeout(r, 400 + Math.random() * 400));
      await fn();
    } catch (e2) {
      fail(e2 ?? e);
    }
  }
}

const strip = <T extends object>(v: T) => JSON.parse(JSON.stringify(v)) as Record<string, unknown>;

export const savePerson = (p: Person) => write(() => db.doc(`personnel/${p.id}`).set(strip(p)));
export const deletePerson = (id: number) => write(() => db.doc(`personnel/${id}`).delete());
export const saveTimeOff = (t: TimeOff) => write(() => db.doc(`timeoff/${t.id}`).set(strip(t)));
export const deleteTimeOff = (id: number) => write(() => db.doc(`timeoff/${id}`).delete());
export const savePreset = (p: Preset) => write(() => db.doc(`presets/${p.id}`).set(strip(p)));
export const deletePreset = (id: number) => write(() => db.doc(`presets/${id}`).delete());
export const saveAssignment = (a: AssignmentDef) => write(() => db.doc(`assignments/${a.id}`).set(strip(a)));
export const deleteAssignment = (id: number) => write(() => db.doc(`assignments/${id}`).delete());
export const saveAdmin = (a: Admin) => write(() => db.doc(`admins/${a.id}`).set(strip(a)));
export const deleteAdmin = (id: string) => write(() => db.doc(`admins/${id}`).delete());
export const saveLayout = (l: Layout) => write(() => db.doc(`layouts/${l.id}`).set(strip(l)));
export const deleteLayout = (id: number) => write(() => db.doc(`layouts/${id}`).delete());
export const saveCerts = (c: CertConfig) => write(() => db.doc('config/certs').set(strip(c)));
export const saveSettings = (s: Settings) => write(() => db.doc('config/settings').set(strip(s)));

/** Merge-patch a week document (entries / dayStatus keys, status). Creates the week if needed. */
export function patchWeek(weekStart: string, patch: Partial<WeekDoc>): Promise<void> {
  const exists = state.weeks.has(weekStart);
  const body = strip(patch);
  return write(async () => {
    if (exists) await db.doc(`weeks/${weekStart}`).update(body);
    else {
      const snap = await db.doc(`weeks/${weekStart}`).get();
      if (snap.exists) await db.doc(`weeks/${weekStart}`).update(body);
      else await db.doc(`weeks/${weekStart}`).set({ status: 'draft', publishedAt: null, publishedBy: null, entries: {}, dayStatus: {}, slotCounts: {}, ...body });
    }
  });
}

/** Append an audit event to today's audit document. Never blocks the action it records. */
export async function audit(admin: string, action: string, detail = ''): Promise<void> {
  const day = new Date().toISOString().slice(0, 10);
  const id = newId();
  const ev = { id, at: new Date().toISOString(), admin, action, detail: detail.slice(0, 300) };
  const ref = db.doc(`audit/${day}`);
  try {
    await ref.update({ events: { [String(id)]: ev } });
  } catch {
    try {
      const snap = await ref.get();
      if (snap.exists) await ref.update({ events: { [String(id)]: ev } });
      else await ref.set({ events: { [String(id)]: ev } });
    } catch {
      /* audit is best-effort */
    }
  }
}

/** Apply many writes with a little parallelism (setup, bulk changes). */
export async function writeMany(tasks: (() => Promise<void>)[], parallel = 6): Promise<void> {
  const queue = [...tasks];
  await Promise.all(
    Array.from({ length: parallel }, async () => {
      while (queue.length) await queue.shift()!();
    }),
  );
}
