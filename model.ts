// Turns stored data into the scheduling context the shared rules engine uses,
// plus sign-in, setup defaults, and the schedule actions.

import { describe, effectiveCerts, type Rule } from '../../src/domain/criteria.ts';
import { addDays, dateRange, weekDates, weekStartOf } from '../../src/domain/dates.ts';
import { checkAssignment, planAutoFill, type AssignmentCtx, type EntryCtx, type Issue, type PersonCtx, type ScheduleContext, type SlotCtx } from '../../src/domain/scheduling.ts';
import { buildWeekFromContext, type WeekView } from '../../src/domain/week-view.ts';
import {
  audit,
  hosted,
  hostedLogin,
  hostedLogout,
  hostedSetup,
  mode,
  patchWeek,
  saveAdmin,
  saveAssignment,
  saveCerts,
  saveLayout,
  savePerson,
  savePreset,
  saveSettings,
  state,
  writeMany,
  type Admin,
  type HostedAdmin,
  type AssignmentDef,
  type Entry,
  type Layout,
  type Person,
  type Preset,
  type SlotDef,
} from './store.ts';
import { lgNum, newId, ssGet, ssSet } from './util.ts';

// ---------- context ----------

export function resolvedSlots(): { assignments: Map<number, AssignmentCtx>; slots: Map<number, SlotCtx> } {
  const assignments = new Map<number, AssignmentCtx>();
  const slots = new Map<number, SlotCtx>();
  for (const a of state.assignments.values()) {
    const def = a.defaultPresetId != null ? state.presets.get(a.defaultPresetId) : undefined;
    const ctx: AssignmentCtx = {
      id: a.id,
      code: a.code,
      kind: a.kind,
      displayName: a.displayName,
      active: a.active,
      sortOrder: a.sortOrder,
      openByDefault: a.openByDefault,
      startTime: a.startTime,
      endTime: a.endTime,
      slots: [],
    };
    a.slots.forEach((s, i) => {
      let rule: Rule | null = null;
      let presetName: string | null = null;
      if (s.mode === 'custom') rule = s.rule;
      else {
        const p = s.mode === 'preset' && s.presetId != null ? state.presets.get(s.presetId) : def;
        if (p) {
          rule = p.rule;
          presetName = p.name;
        }
      }
      const sc: SlotCtx = { id: s.id, assignmentId: a.id, position: i + 1, name: s.name, mode: s.mode, presetId: s.presetId, presetName, rule, ruleText: describe(rule) };
      ctx.slots.push(sc);
      slots.set(s.id, sc);
    });
    assignments.set(a.id, ctx);
  }
  return { assignments, slots };
}

export function personnelCtx(): Map<number, PersonCtx> {
  const eqs = (state.certs?.equivalencies ?? []).filter((e) => e.enabled);
  const order = new Map((state.certs?.list ?? []).map((c, i) => [c.code, i]));
  const map = new Map<number, PersonCtx>();
  for (const p of state.personnel.values()) {
    const held = [...p.certs].sort((a, b) => (order.get(a) ?? 99) - (order.get(b) ?? 99));
    map.set(p.id, {
      id: p.id,
      lgNumber: p.lgNumber,
      name: p.name,
      active: p.active,
      labelColor: p.labelColor,
      heldCerts: held,
      certs: effectiveCerts(held, eqs),
      daysOff: new Set(p.daysOff),
      timeOff: [...state.timeOff.values()].filter((t) => t.personnelId === p.id),
    });
  }
  return map;
}

export function weekEntries(weekStart: string): EntryCtx[] {
  const w = state.weeks.get(weekStart);
  if (!w) return [];
  return Object.values(w.entries)
    .filter((e): e is Entry => !!e && state.personnel.has(e.personnelId))
    .map((e) => ({ id: e.id, date: e.date, slotId: e.slotId, personnelId: e.personnelId, locked: e.locked, source: e.source, overrideReason: e.overrideReason }));
}

export function contextFor(weekStart: string): ScheduleContext {
  const { assignments, slots } = resolvedSlots();
  const w = state.weeks.get(weekStart);
  const dayStatus = new Map<string, boolean>();
  for (const [k, v] of Object.entries(w?.dayStatus ?? {})) if (v !== null && v !== undefined) dayStatus.set(k, v);
  const slotLimit = new Map<string, number>();
  for (const [k, v] of Object.entries(w?.slotCounts ?? {})) if (typeof v === 'number') slotLimit.set(k, v);
  return { personnel: personnelCtx(), assignments, slots, dayStatus, slotLimit, entries: weekEntries(weekStart).filter((e) => slots.has(e.slotId)) };
}

export function weekView(weekStart: string): WeekView {
  const w = state.weeks.get(weekStart);
  return buildWeekFromContext(contextFor(weekStart), weekStart, w?.status ?? 'draft', w?.publishedAt ?? null);
}

export const knownCerts = () => new Set((state.certs?.list ?? []).map((c) => c.code));
export const sortedPeople = () => [...state.personnel.values()].sort((a, b) => lgNum(a.lgNumber) - lgNum(b.lgNumber));
export const sortedAssignments = () => [...state.assignments.values()].sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);

// ---------- sign-in ----------

const enc = new TextEncoder();
const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

export async function hashPassword(password: string, salt?: string): Promise<{ salt: string; hash: string }> {
  const s = salt ?? hex(crypto.getRandomValues(new Uint8Array(16)).buffer as ArrayBuffer);
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: enc.encode(s), iterations: 150_000, hash: 'SHA-256' }, key, 256);
  return { salt: s, hash: hex(bits) };
}

export let currentAdmin: Admin | null = null;

/** In hosted mode the server never sends password data, so build the record from what it returns. */
const fromHosted = (a: HostedAdmin): Admin => state.admins.get(a.id) ?? { ...a, salt: '', hash: '', active: true, createdAt: '' };

export function restoreSession(): void {
  if (mode === 'hosted') {
    const a = hosted.status?.admin;
    currentAdmin = a ? fromHosted(a) : null;
    return;
  }
  const id = ssGet('bps-admin');
  const a = id ? state.admins.get(id) : undefined;
  currentAdmin = a && a.active ? a : null;
}

export async function signIn(identifier: string, password: string): Promise<Admin> {
  if (mode === 'hosted') {
    const h = await hostedLogin(identifier, password);
    currentAdmin = fromHosted(h);
    audit(h.identifier, 'Signed in');
    return currentAdmin;
  }
  const a = [...state.admins.values()].find((x) => x.identifier.toUpperCase() === identifier.trim().toUpperCase());
  if (!a || !a.active) throw new Error('Identifier or password is incorrect.');
  const { hash } = await hashPassword(password, a.salt);
  if (hash !== a.hash) throw new Error('Identifier or password is incorrect.');
  currentAdmin = a;
  ssSet('bps-admin', a.id);
  saveAdmin({ ...a, lastLoginAt: new Date().toISOString() }).catch(() => {});
  audit(a.identifier, 'Signed in');
  return a;
}

export async function signOut(): Promise<void> {
  currentAdmin = null;
  ssSet('bps-admin', null);
  if (mode === 'hosted') await hostedLogout();
}

/** Keeps the signed-in admin's record fresh (e.g. after permissions change). */
export function refreshAdmin(): void {
  if (mode === 'hosted') {
    const h = hosted.status?.admin;
    if (!h) currentAdmin = null;
    else {
      const a = state.admins.get(h.id);
      currentAdmin = a ? (a.active ? a : null) : currentAdmin ?? fromHosted(h);
    }
    return;
  }
  if (!currentAdmin) return;
  const a = state.admins.get(currentAdmin.id);
  currentAdmin = a && a.active ? a : null;
  if (!currentAdmin) ssSet('bps-admin', null);
}

export const me = () => currentAdmin?.identifier ?? '—';
export const canOverride = () => !!currentAdmin?.canOverride && state.settings.overridesEnabled;
export const MAX_ADMINS = 10;
export const IDENTIFIER = /^[A-Za-z0-9_-]{2,20}$/;

// ---------- first-time setup ----------

export const DEFAULT_CERTS = ['Basic', 'EMR', 'EMT', 'EMT2', 'PMD', 'PWC1', 'PWC2', 'PWC3', 'PWC4', 'PWC5', 'SUP'];

export async function runSetup(opts: { identifier: string; displayName: string; password: string; patrolName: string; demo: boolean; setupCode?: string }): Promise<void> {
  const tasks: (() => Promise<void>)[] = [];
  const docs: { collection: string; id: string; data: unknown }[] = [];
  const certDoc = (() => ({
      list: DEFAULT_CERTS.map((c) => ({ code: c.toUpperCase(), name: c })),
      equivalencies: [
        ['EMT2', 'EMT'],
        ['EMT', 'EMR'],
        ['PWC3', 'PWC2'],
        ['PWC4', 'PWC3'],
        ['PWC5', 'PWC4'],
      ].map(([holder, satisfies]) => ({ holder, satisfies, enabled: false })),
    }))();
  const settingsDoc = { patrolName: opts.patrolName || 'Beach Patrol', overridesEnabled: true };
  tasks.push(() => saveCerts(certDoc));
  tasks.push(() => saveSettings(settingsDoc));
  docs.push({ collection: 'config', id: 'certs', data: certDoc }, { collection: 'config', id: 'settings', data: settingsDoc });
  const medical: Rule = { any: [{ cert: 'EMT' }, { cert: 'EMT2' }, { cert: 'PMD' }] };
  const presets: Preset[] = [
    { id: newId(), name: 'Basic Qualified', rule: { cert: 'BASIC' }, description: 'Example' },
    { id: newId(), name: 'Medical Response Qualified', rule: medical, description: 'Example' },
    { id: newId(), name: 'PWC Rescuer', rule: { all: [medical, { cert: 'PWC3' }] }, description: 'Example' },
    { id: newId(), name: 'PWC Operator', rule: { any: [{ cert: 'PWC2' }, { cert: 'PWC3' }] }, description: 'Example' },
    { id: newId(), name: 'Boat Crew', rule: { all: [{ cert: 'BASIC' }, { cert: 'PWC4' }] }, description: 'Example' },
    { id: newId(), name: 'Supervisor', rule: { cert: 'SUP' }, description: 'Example' },
  ];
  const byName = (n: string) => presets.find((p) => p.name === n)!.id;
  for (const p of presets) {
    tasks.push(() => savePreset(p));
    docs.push({ collection: 'presets', id: String(p.id), data: p });
  }

  let order = 0;
  const assignments: AssignmentDef[] = [];
  const add = (code: string, kind: AssignmentDef['kind'], name: string, count: number, preset: string, active = true): AssignmentDef => {
    order += 10;
    const a: AssignmentDef = {
      id: newId(),
      code,
      kind,
      displayName: name,
      active,
      sortOrder: order,
      defaultPresetId: byName(preset),
      openByDefault: true,
      startTime: null,
      endTime: null,
      slots: Array.from({ length: count }, (_, i): SlotDef => ({ id: newId(), name: `Slot ${i + 1}`, mode: 'default', presetId: null, rule: null })),
    };
    assignments.push(a);
    return a;
  };
  for (let n = 1; n <= 11; n++) {
    const a = add(`STAND-${n}`, 'stand', `Stand ${n}`, n === 1 || n === 9 ? 6 : n === 11 ? 2 : 3, 'Basic Qualified');
    if (n === 1 || n === 9) {
      a.slots[1] = { ...a.slots[1], mode: 'preset', presetId: byName('Medical Response Qualified') };
      a.slots[3] = { ...a.slots[3], mode: 'custom', rule: { cert: 'EMR' } };
      a.slots[4] = { ...a.slots[4], mode: 'custom', rule: { cert: 'PWC2' } };
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
  for (const a of assignments) {
    tasks.push(() => saveAssignment(a));
    docs.push({ collection: 'assignments', id: String(a.id), data: a });
  }

  if (mode === 'hosted') {
    if (opts.demo) for (const p of demoPeople()) docs.push({ collection: 'personnel', id: String(p.id), data: p });
    const h = await hostedSetup({
      setupCode: opts.setupCode ?? '',
      password: opts.password,
      admin: { id: String(newId()), identifier: opts.identifier.toUpperCase(), displayName: opts.displayName, createdAt: new Date().toISOString() },
      docs,
    });
    currentAdmin = fromHosted(h);
    audit(h.identifier, 'Set up the scheduler', opts.demo ? 'with demo lifeguards' : '');
    return;
  }

  const { salt, hash } = await hashPassword(opts.password);
  const admin: Admin = { id: String(newId()), identifier: opts.identifier.toUpperCase(), displayName: opts.displayName, salt, hash, canOverride: true, active: true, createdAt: new Date().toISOString() };
  tasks.push(() => saveAdmin(admin));

  if (opts.demo) for (const p of demoPeople()) tasks.push(() => savePerson(p));
  await writeMany(tasks);
  currentAdmin = admin;
  ssSet('bps-admin', admin.id);
  audit(admin.identifier, 'Set up the scheduler', opts.demo ? 'with demo lifeguards' : '');
}

/** 76 clearly-labelled placeholder lifeguards for trying the app. */
function demoPeople(): Person[] {
  const out: Person[] = [];
  {
    const colors = ['red', 'light_blue', 'green', 'dark_blue', 'white'] as const;
    for (let n = 10; n <= 85; n++) {
      const certs = new Set(['BASIC']);
      if (n % 3 === 0) ['EMR', 'PWC4'].forEach((c) => certs.add(c));
      if (n % 2 === 0) certs.add('EMT');
      if (n % 7 === 0) certs.add('EMT2');
      if (n % 11 === 0) certs.add('PMD');
      if (n % 4 === 0) certs.add('PWC1');
      if (n % 5 < 2) certs.add('PWC2');
      if (n % 6 === 0) certs.add('PWC3');
      if (n % 13 === 0) certs.add('PWC5');
      if (n % 10 === 0) certs.add('SUP');
      const first = n % 7;
      out.push({ id: newId(), lgNumber: `LG${n}`, name: `Demo Lifeguard ${n}`, active: true, labelColor: colors[n % 5], certs: [...certs], daysOff: [first, (first + 1) % 7] });
    }
  }
  return out;
}

// ---------- schedule actions ----------

export const entryKey = (date: string, slotId: number) => `${date}|${slotId}`;

export interface AssignRequest {
  weekStart: string;
  date: string;
  slotId: number;
  personnelId: number;
  moveFromKey?: string; // dragging an existing entry
  overrideReason?: string;
}

export type AssignOutcome =
  | { ok: true }
  | { ok: false; kind: 'blocked'; issues: Issue[] }
  | { ok: false; kind: 'needs_override'; issues: Issue[] }
  | { ok: false; kind: 'locked'; message: string };

export function checkDrop(req: AssignRequest): AssignOutcome {
  const ctx = contextFor(req.weekStart);
  const existing = ctx.entries.find((e) => e.date === req.date && e.slotId === req.slotId);
  const moving = req.moveFromKey ? state.weeks.get(req.weekStart)?.entries[req.moveFromKey] : null;
  if (existing?.locked && existing.personnelId !== req.personnelId) return { ok: false, kind: 'locked', message: 'That slot is locked. Unlock it first.' };
  if (moving?.locked) return { ok: false, kind: 'locked', message: 'That assignment is locked. Unlock it before moving it.' };
  const issues = checkAssignment(ctx, { date: req.date, slotId: req.slotId, personnelId: req.personnelId, ignoreEntryIds: [existing?.id ?? 0, moving?.id ?? 0] });
  if (issues.some((i) => !i.overridable)) return { ok: false, kind: 'blocked', issues };
  if (issues.length && !req.overrideReason) return { ok: false, kind: 'needs_override', issues };
  return { ok: true };
}

export async function assign(req: AssignRequest): Promise<AssignOutcome> {
  const out = checkDrop(req);
  if (!out.ok) return out;
  if (req.overrideReason && !canOverride()) return { ok: false, kind: 'locked', message: 'Your account cannot approve overrides.' };
  const key = entryKey(req.date, req.slotId);
  const prev = state.weeks.get(req.weekStart)?.entries[key];
  const entry: Entry = {
    id: prev && prev.personnelId === req.personnelId ? prev.id : newId(),
    date: req.date,
    slotId: req.slotId,
    personnelId: req.personnelId,
    locked: prev && prev.personnelId === req.personnelId ? prev.locked : false,
    source: 'manual',
    overrideReason: req.overrideReason ?? null,
    overrideBy: req.overrideReason ? me() : null,
    by: me(),
  };
  const entries: Record<string, Entry | null> = { [key]: entry };
  if (req.moveFromKey && req.moveFromKey !== key) entries[req.moveFromKey] = null;
  await patchWeek(req.weekStart, { entries });
  const p = state.personnel.get(req.personnelId);
  const s = resolvedSlots().slots.get(req.slotId);
  const a = s && state.assignments.get(s.assignmentId);
  audit(me(), req.overrideReason ? 'Assigned with override' : req.moveFromKey ? 'Moved' : 'Assigned', `${p?.lgNumber} → ${a?.displayName} · ${s?.name} on ${req.date}${req.overrideReason ? ` (reason: ${req.overrideReason})` : ''}`);
  return { ok: true };
}

export async function removeEntry(weekStart: string, key: string): Promise<void> {
  const e = state.weeks.get(weekStart)?.entries[key];
  await patchWeek(weekStart, { entries: { [key]: null } });
  if (e) audit(me(), 'Removed', `${state.personnel.get(e.personnelId)?.lgNumber} from ${e.date}`);
}

export async function setLocked(weekStart: string, key: string, locked: boolean): Promise<void> {
  const e = state.weeks.get(weekStart)?.entries[key];
  if (!e) return;
  await patchWeek(weekStart, { entries: { [key]: { ...e, locked } } });
}

/** Opens or closes an assignment on one date. Closing removes anyone assigned there. */
export async function setOpen(weekStart: string, assignmentId: number, date: string, open: boolean): Promise<void> {
  const a = state.assignments.get(assignmentId)!;
  const entries: Record<string, Entry | null> = {};
  if (!open) for (const s of a.slots) if (state.weeks.get(weekStart)?.entries[entryKey(date, s.id)]) entries[entryKey(date, s.id)] = null;
  await patchWeek(weekStart, { dayStatus: { [`${assignmentId}|${date}`]: open === a.openByDefault ? null : open }, entries });
  audit(me(), open ? 'Opened' : 'Closed', `${a.displayName} on ${date}`);
}

export function previewAutoFill(weekStart: string, dates: string[], onlyEmpty: boolean) {
  const ctx = contextFor(weekStart);
  return { ctx, plan: planAutoFill(ctx, { dates, weekDates: weekDates(weekStart), onlyEmpty }) };
}

export async function applyAutoFill(weekStart: string, dates: string[], onlyEmpty: boolean): Promise<number> {
  const { ctx, plan } = previewAutoFill(weekStart, dates, onlyEmpty);
  const w = state.weeks.get(weekStart);
  const entries: Record<string, Entry | null> = {};
  if (w) for (const [k, e] of Object.entries(w.entries)) if (e && plan.remove.includes(e.id)) entries[k] = null;
  for (const a of plan.assign) {
    entries[entryKey(a.date, a.slotId)] = { id: newId(), date: a.date, slotId: a.slotId, personnelId: a.personnelId, locked: false, source: 'autofill', overrideReason: null, overrideBy: null, by: me() };
  }
  void ctx;
  await patchWeek(weekStart, { entries });
  audit(me(), 'Ran Auto-Fill', `${dates.length === 7 ? 'whole week' : dates.join(', ')} · filled ${plan.assign.length}, could not fill ${plan.unfilled.length}`);
  return plan.assign.length;
}

export async function copyWeek(fromWeek: string, toWeek: string): Promise<{ copied: number; skipped: number }> {
  const offset = Math.round((Date.parse(toWeek) - Date.parse(fromWeek)) / 86_400_000);
  const ctx = contextFor(toWeek);
  const entries: Record<string, Entry | null> = {};
  let skipped = 0;
  for (const e of weekEntries(fromWeek)) {
    const d = addDays(e.date, offset);
    if (ctx.entries.some((x) => x.date === d && x.slotId === e.slotId) || !ctx.slots.has(e.slotId)) {
      skipped++;
      continue;
    }
    if (checkAssignment(ctx, { date: d, slotId: e.slotId, personnelId: e.personnelId }).length) {
      skipped++;
      continue;
    }
    const id = newId();
    ctx.entries.push({ id, date: d, slotId: e.slotId, personnelId: e.personnelId, locked: false, source: 'copy', overrideReason: null });
    entries[entryKey(d, e.slotId)] = { id, date: d, slotId: e.slotId, personnelId: e.personnelId, locked: false, source: 'copy', overrideReason: null, overrideBy: null, by: me() };
  }
  const copied = Object.keys(entries).length;
  if (copied) await patchWeek(toWeek, { entries });
  audit(me(), 'Copied week', `${fromWeek} → ${toWeek}: ${copied} copied, ${skipped} skipped`);
  return { copied, skipped };
}

export async function clearWeek(weekStart: string): Promise<number> {
  const w = state.weeks.get(weekStart);
  const entries: Record<string, Entry | null> = {};
  for (const [k, e] of Object.entries(w?.entries ?? {})) if (e && !e.locked) entries[k] = null;
  await patchWeek(weekStart, { entries });
  audit(me(), 'Cleared week', `${weekStart} (${Object.keys(entries).length} removed, locked kept)`);
  return Object.keys(entries).length;
}

export async function setPublished(weekStart: string, published: boolean): Promise<void> {
  await patchWeek(weekStart, { status: published ? 'published' : 'draft', publishedAt: published ? new Date().toISOString() : null, publishedBy: published ? me() : null });
  audit(me(), published ? 'Published week' : 'Moved week back to draft', weekStart);
}

// ---------- staffing layouts ----------

export type LayoutItems = Layout['items'];

/** The standard setup: every active assignment at its default open/closed status, all its slots. */
export function layoutFromBase(): LayoutItems {
  const items: LayoutItems = {};
  for (const a of sortedAssignments()) if (a.active) items[a.id] = { open: a.openByDefault, slots: a.slots.length };
  return items;
}

/** What a given day in the schedule currently uses. */
export function layoutFromDay(date: string): LayoutItems {
  const ws = weekStartOf(date);
  const w = state.weeks.get(ws);
  const items: LayoutItems = {};
  for (const a of sortedAssignments()) {
    if (!a.active) continue;
    const k = `${a.id}|${date}`;
    const open = w?.dayStatus?.[k] ?? a.openByDefault;
    const n = w?.slotCounts?.[k];
    items[a.id] = { open, slots: typeof n === 'number' ? Math.min(n, a.slots.length) : a.slots.length };
  }
  return items;
}

export function layoutSummary(items: LayoutItems): { open: number; total: number; guards: number; closedNames: string[] } {
  let open = 0;
  let total = 0;
  let guards = 0;
  const closedNames: string[] = [];
  for (const a of sortedAssignments()) {
    if (!a.active) continue;
    const it = items[a.id] ?? { open: a.openByDefault, slots: a.slots.length };
    total++;
    if (it.open) {
      open++;
      guards += Math.min(it.slots, a.slots.length);
    } else closedNames.push(a.displayName);
  }
  return { open, total, guards, closedNames };
}

interface ApplyPlan {
  weeks: Map<string, { dayStatus: Record<string, boolean | null>; slotCounts: Record<string, number | null>; entries: Record<string, Entry | null> }>;
  removed: { date: string; lgNumber: string; where: string; locked: boolean }[];
}

/** Works out what loading a layout onto these dates changes, including assignments it removes. */
export function planLayout(items: LayoutItems, dates: string[]): ApplyPlan {
  const plan: ApplyPlan = { weeks: new Map(), removed: [] };
  for (const date of dates) {
    const ws = weekStartOf(date);
    if (!plan.weeks.has(ws)) plan.weeks.set(ws, { dayStatus: {}, slotCounts: {}, entries: {} });
    const p = plan.weeks.get(ws)!;
    const w = state.weeks.get(ws);
    for (const a of sortedAssignments()) {
      const it = items[a.id];
      if (!it || !a.active) continue;
      const k = `${a.id}|${date}`;
      const slots = Math.max(1, Math.min(it.slots, a.slots.length));
      p.dayStatus[k] = it.open === a.openByDefault ? null : it.open;
      p.slotCounts[k] = slots >= a.slots.length ? null : slots;
      a.slots.forEach((s, i) => {
        const key = entryKey(date, s.id);
        const e = w?.entries[key];
        if (e && (!it.open || i >= slots)) {
          p.entries[key] = null;
          plan.removed.push({ date, lgNumber: state.personnel.get(e.personnelId)?.lgNumber ?? '?', where: `${a.displayName} · ${s.name}`, locked: e.locked });
        }
      });
    }
  }
  return plan;
}

export async function applyLayout(name: string, items: LayoutItems, dates: string[]): Promise<number> {
  const plan = planLayout(items, dates);
  for (const [ws, patch] of plan.weeks) await patchWeek(ws, patch);
  audit(me(), 'Loaded staffing layout', `${name} → ${dates.length === 1 ? dates[0] : `${dates.length} days (${dates[0]} to ${dates[dates.length - 1]})`}${plan.removed.length ? `, removed ${plan.removed.length} assignments` : ''}`);
  return plan.removed.length;
}

/** Dates between `from` and `to` that fall on the chosen weekdays (0 = Saturday). */
export function datesFor(from: string, to: string, weekdays: number[]): string[] {
  if (to < from) return [];
  return dateRange(from, to).filter((d) => weekdays.includes(weekDates(weekStartOf(d)).indexOf(d)));
}

export async function saveNewLayout(name: string, description: string, items: LayoutItems): Promise<Layout> {
  const now = new Date().toISOString();
  const l: Layout = { id: newId(), name, description, items, createdBy: me(), createdAt: now, updatedBy: me(), updatedAt: now };
  await saveLayout(l);
  audit(me(), 'Saved staffing layout', name);
  return l;
}
