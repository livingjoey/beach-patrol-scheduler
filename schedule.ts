// Weekly Schedule Builder: Sat–Fri grid, drag-and-drop, slot candidates, open/close, Auto-Fill, export.

import { addDays, todayIso, weekStartOf } from '../../../src/domain/dates.ts';
import { availability, candidatesFor, type AssignmentKind, type Candidate, type Issue } from '../../../src/domain/scheduling.ts';
import { weekDates } from '../../../src/domain/dates.ts';
import type { AssignmentView, SlotView, WeekView } from '../../../src/domain/week-view.ts';
import { rerender, ui } from '../app-state.ts';
import { assign, canOverride, contextFor, copyWeek, entryKey, removeEntry, setLocked, setOpen, setPublished, weekView, clearWeek, type AssignRequest } from '../model.ts';
import { state, StoreError } from '../store.ts';
import { $, $$, DAY_LONG, DAY_SHORT, esc, html, icon, modal, raw, shortDate, toast, type Raw } from '../util.ts';
import { openAutoFill, openExport } from './dialogs.ts';
import { openApplyLayout, openDayStaffing } from './layouts.ts';

const TABS: { id: string; label: string; kinds: AssignmentKind[] }[] = [
  { id: 'stands', label: 'Stands', kinds: ['stand'] },
  { id: 'units', label: 'Medical & PWC', kinds: ['medical', 'pwc'] },
  { id: 'boats', label: 'Boats', kinds: ['boat'] },
  { id: 'extras', label: 'Extras', kinds: ['extra'] },
];

const local = {
  tab: 'stands',
  selected: null as null | { date: string; slotId: number },
  search: '',
};

export const fmtWeek = (start: string) => `Sat ${shortDate(start)} – Fri ${shortDate(addDays(start, 6))}, ${addDays(start, 6).slice(0, 4)}`;

function chip(e: NonNullable<SlotView['entry']>, extra = ''): Raw {
  const problem = e.issues.length > 0;
  const cls = `chip lc-${e.labelColor}${problem && !e.overrideReason ? ' warn' : ''}${e.overrideReason ? ' ovr' : ''}${extra}`;
  const tip = [`${e.lgNumber} · ${e.name}`, e.locked ? 'Locked' : '', e.overrideReason ? `Override: ${e.overrideReason}` : '', ...e.issues.map((i) => i.message)].filter(Boolean).join('\n');
  return html`<span class="${cls}" title="${tip}">${e.locked ? icon('lock', 10) : ''}${problem ? icon('alert', 10) : ''}<span>${e.lgNumber}</span></span>`;
}

function slotButton(day: string, a: AssignmentView, s: SlotView): Raw {
  const sel = local.selected?.date === day && local.selected.slotId === s.slotId;
  const key = entryKey(day, s.slotId);
  if (s.entry) {
    return html`<button type="button" class="slot filled${sel ? ' sel' : ''}" data-date="${day}" data-slot="${s.slotId}" data-key="${key}" data-pid="${s.entry.personnelId}" draggable="${s.entry.locked ? 'false' : 'true'}" aria-label="${a.displayName} ${s.name}: ${s.entry.lgNumber}">${chip(s.entry)}</button>`;
  }
  const need = s.presetName ?? (s.criteria === 'No requirement' ? 'Anyone' : s.criteria);
  return html`<button type="button" class="slot empty${sel ? ' sel' : ''}" data-date="${day}" data-slot="${s.slotId}" title="${s.name} · needs ${s.criteria}" aria-label="${a.displayName} ${s.name}: open, needs ${s.criteria}"><span class="need">+ ${need}</span></button>`;
}

function grid(week: WeekView): Raw {
  const kinds = TABS.find((t) => t.id === local.tab)!.kinds;
  const cols = week.days[0]?.assignments.filter((a) => kinds.includes(a.kind)) ?? [];
  if (!cols.length) {
    return html`<div class="empty-state"><p>No active ${TABS.find((t) => t.id === local.tab)!.label.toLowerCase()} yet.</p><a class="btn" href="#assignments">Open assignment settings</a></div>`;
  }
  const template = `112px ${cols.map((a) => `minmax(${a.capacity > 3 ? 150 : 82}px, ${Math.max(1, Math.ceil(a.capacity / 3))}fr)`).join(' ')}`;
  const minW = 112 + cols.reduce((s, a) => s + (a.capacity > 3 ? 150 : 82) + 6, 0);
  return html`
    <div class="grid-scroll" data-keep-scroll="grid">
      <div class="grid" style="min-width:${minW}px">
        <div class="grow" style="grid-template-columns:${template}">
          <div class="ghead day-col">Day</div>
          ${cols.map((a) => html`<div class="ghead"><div class="gname">${a.displayName}</div><div class="gsub">up to ${a.capacity} ${a.capacity === 1 ? 'guard' : 'guards'}</div></div>`)}
        </div>
        ${week.days.map((d) => {
          const attn = d.stats.empty + d.stats.conflicts;
          return html`<div class="grow" style="grid-template-columns:${template}">
            <div class="dayhead${d.date === todayIso() ? ' today' : ''}">
              <strong>${DAY_LONG[d.weekday]}</strong><span class="muted">${shortDate(d.date)}</span>
              <span class="mono small">${d.stats.filled}/${d.stats.openSlots}</span>
              ${attn ? html`<span class="attn small">${icon('alert', 11)} ${attn}</span>` : ''}
              ${d.stats.closedAssignments ? html`<span class="small muted">${d.stats.closedAssignments} closed</span>` : ''}
              <button type="button" class="btn tiny stands-btn" data-day-stands="${d.date}" title="Close stands or change guard counts for ${DAY_LONG[d.weekday]}">${icon('layouts', 12)} Stands</button>
            </div>
            ${d.assignments
              .filter((a) => kinds.includes(a.kind))
              .map((a) =>
                a.open
                  ? html`<div class="cell" data-cell="${a.assignmentId}|${d.date}">
                      <div class="cell-tools"><button type="button" class="close-chip" data-close-cell="${a.assignmentId}" data-date="${d.date}" title="Close ${a.displayName} on ${DAY_LONG[d.weekday]} (frees its guards and skips it in Auto-Fill)" aria-label="Close ${a.displayName} on ${DAY_LONG[d.weekday]}">${icon('x', 10)} Close</button></div>
                      <div class="slots${a.slots.length > 3 ? ' two' : ''}">${a.slots.map((s) => slotButton(d.date, a, s))}</div>
                      ${a.slots.length < a.capacity ? html`<div class="cell-note">${a.slots.length} of ${a.capacity} guards</div>` : ''}
                    </div>`
                  : html`<div class="cell closed"><span>${icon('lock', 13)} Closed</span><button type="button" class="btn tiny" data-open-cell="${a.assignmentId}" data-date="${d.date}">Reopen</button></div>`,
              )}
          </div>`;
        })}
      </div>
    </div>`;
}

function candRow(c: Candidate, kind: 'ok' | 'busy' | 'unq' | 'off', date: string, slotId: number): Raw {
  const detail = kind === 'ok' ? `${c.certs.join(' ')} · ${c.shiftsThisWeek} this week` : c.issues.map((i) => i.message.replace(`${c.lgNumber} `, '')).join(' ');
  return html`<button type="button" class="cand ${kind}" data-q="${(c.lgNumber + ' ' + c.name).toLowerCase()}" data-assign="${c.personnelId}" data-date="${date}" data-slot="${slotId}" draggable="true" data-pid="${c.personnelId}">
    <span class="chip lc-${c.labelColor}">${c.lgNumber}</span>
    <span class="cand-main"><span class="cand-name">${c.name}</span><span class="cand-detail">${detail}</span></span>
    ${kind === 'ok' ? icon('check', 15, 'Qualified and available') : ''}
  </button>`;
}

function sidePanel(week: WeekView): Raw {
  if (!local.selected) return roster(week);
  const { date, slotId } = local.selected;
  const day = week.days.find((d) => d.date === date);
  const a = day?.assignments.find((x) => x.slots.some((s) => s.slotId === slotId));
  const s = a?.slots.find((x) => x.slotId === slotId);
  if (!day || !a || !s) {
    local.selected = null;
    return roster(week);
  }
  const ctx = contextFor(ui.weekStart);
  const g = candidatesFor(ctx, date, slotId, weekDates(ui.weekStart));
  const q = local.search.trim().toLowerCase();
  const f = (list: Candidate[]) => list;
  const key = entryKey(date, slotId);
  return html`
    <div class="panel sel-panel">
      <div class="panel-head"><span class="eyebrow accent">Selected slot</span><button type="button" class="icon-btn" id="desel" aria-label="Clear selection">${icon('x', 16)}</button></div>
      <h2 class="h3">${DAY_LONG[day.weekday]} · ${a.displayName} · ${s.name}</h2>
      <div class="req"><span class="muted small">Requires${s.presetName ? html` <a href="#criteria">${s.presetName}</a>` : ''}</span><span class="req-text">${s.criteria}</span></div>
      ${s.entry
        ? html`<div class="current">
            <span class="chip lc-${s.entry.labelColor}">${s.entry.lgNumber}</span><span>${s.entry.name}</span>
            ${s.entry.overrideReason ? html`<p class="ovr-note small">Override by ${state.weeks.get(ui.weekStart)?.entries[key]?.overrideBy ?? 'an admin'}: ${s.entry.overrideReason}</p>` : ''}
            ${s.entry.issues.length ? html`<ul class="issues">${s.entry.issues.map((i) => html`<li>${icon('alert', 12)} ${i.message}</li>`)}</ul>` : ''}
          </div>
          <div class="btn-row">
            <button type="button" class="btn small" id="lock" data-key="${key}" data-locked="${s.entry.locked}">${icon('lock', 13)} ${s.entry.locked ? 'Unlock' : 'Lock'}</button>
            <button type="button" class="btn small" id="unassign" data-key="${key}" ${s.entry.locked ? raw('disabled') : ''}>Remove</button>
          </div>`
        : ''}
      <button type="button" class="btn small ghost" id="close-day" data-aid="${a.assignmentId}" data-date="${date}">Close ${a.displayName} on ${DAY_SHORT[day.weekday]}</button>
    </div>
    <div class="panel">
      <label class="search">${icon('search', 15)}<input type="search" id="cand-search" placeholder="Search LG # or name" aria-label="Search lifeguards" value="${local.search}"></label>
      <div class="group-title ok">Qualified &amp; available · ${g.qualifiedAvailable.length}<span class="muted small">Click or drag to assign</span></div>
      <div class="cands">${f(g.qualifiedAvailable).map((c) => candRow(c, 'ok', date, slotId))}${g.qualifiedAvailable.length ? '' : html`<p class="muted small">Nobody qualified is free. Check the groups below.</p>`}</div>
      ${details('Already assigned that day', f(g.assignedElsewhere), 'busy', date, slotId, true)}
      ${details('Not qualified', f(g.unqualified), 'unq', date, slotId, !!q)}
      ${details('Off that day', f(g.unavailable), 'off', date, slotId, !!q)}
      <p class="muted small">Assigning someone from the last three groups needs a supervisor override with a reason.</p>
    </div>`;
}

function details(title: string, list: Candidate[], kind: 'busy' | 'unq' | 'off', date: string, slotId: number, open: boolean): Raw {
  if (!list.length) return html``;
  return html`<details class="cand-group" ${open ? raw('open') : ''}><summary>${title} · ${list.length}</summary><div class="cands">${list.map((c) => candRow(c, kind, date, slotId))}</div></details>`;
}

function roster(week: WeekView): Raw {
  const load = new Map<number, number>();
  for (const d of week.days) for (const a of d.assignments) for (const s of a.slots) if (s.entry) load.set(s.entry.personnelId, (load.get(s.entry.personnelId) ?? 0) + 1);
  const people = [...state.personnel.values()]
    .filter((p) => p.active)
    .sort((a, b) => Number(a.lgNumber.replace(/\D/g, '')) - Number(b.lgNumber.replace(/\D/g, '')));
  return html`<div class="panel roster" data-drop-roster>
    <div class="panel-head"><h2 class="h3">Roster</h2><span class="muted small">${people.length} active</span></div>
    <p class="muted small">Select a slot to see who fits it, or drag a lifeguard onto the grid. Drag a label here to unassign it.</p>
    <label class="search">${icon('search', 15)}<input type="search" id="cand-search" placeholder="Search LG # or name" aria-label="Search lifeguards" value="${local.search}"></label>
    <div class="cands" data-keep-scroll="roster">${people.map(
      (p) => html`<div class="cand" draggable="true" data-pid="${p.id}" data-q="${(p.lgNumber + ' ' + p.name).toLowerCase()}"><span class="chip lc-${p.labelColor}">${p.lgNumber}</span><span class="cand-main"><span class="cand-name">${p.name}</span><span class="cand-detail">${p.certs.join(' ')}</span></span><span class="mono small muted">${load.get(p.id) ?? 0}</span></div>`,
    )}</div>
    ${people.length ? '' : html`<p class="muted small">No active lifeguards yet. <a href="#personnel">Add personnel</a>.</p>`}
  </div>`;
}

function firstProblem(week: WeekView): { date: string; slotId: number } | null {
  for (const d of week.days)
    for (const a of d.assignments) {
      if (!a.open) continue;
      for (const s of a.slots) if (!s.entry || (s.entry.issues.length && !s.entry.overrideReason)) return { date: d.date, slotId: s.slotId };
    }
  return null;
}

export const scheduleView = {
  render(): Raw {
    const week = weekView(ui.weekStart);
    const t = week.totals;
    const pct = t.openSlots ? Math.round((t.filled / t.openSlots) * 100) : 0;
    const pub = week.status === 'published';
    return html`
      <header class="topbar">
        <div class="weeknav">
          <button type="button" class="icon-btn boxed" id="prev" aria-label="Previous week">${icon('left', 16)}</button>
          <div><div class="eyebrow">Weekly schedule</div><h1 class="h1">${fmtWeek(ui.weekStart)}</h1></div>
          <button type="button" class="icon-btn boxed" id="next" aria-label="Next week">${icon('right', 16)}</button>
          <button type="button" class="btn small ghost" id="today">This week</button>
        </div>
        <span class="pill ${pub ? 'pub' : 'draft'}">${pub ? 'Published' : 'Draft'}</span>
        <div class="progress" title="${t.filled} of ${t.openSlots} open slots filled"><div class="bar"><div style="width:${pct}%"></div></div><span>${t.filled} of ${t.openSlots} filled</span></div>
        ${t.empty + t.conflicts ? html`<button type="button" class="pill warnpill" id="attn">${icon('alert', 13)} ${t.empty} open · ${t.conflicts} conflict${t.conflicts === 1 ? '' : 's'}</button>` : html`<span class="pill okpill">${icon('check', 13)} Fully staffed</span>`}
        <div class="spacer"></div>
        <div class="actions">
          <button type="button" class="btn" id="copy">Copy last week</button>
          <button type="button" class="btn" id="clear">Clear</button>
          <button type="button" class="btn" id="layouts-btn">${icon('layouts', 15)} Layouts</button>
          <button type="button" class="btn accent" id="autofill">${icon('wand', 15)} Auto-Fill</button>
          <button type="button" class="btn" id="export">${icon('file', 15)} Export PDF</button>
          <button type="button" class="btn primary" id="publish">${pub ? 'Back to draft' : 'Publish week'}</button>
        </div>
      </header>
      <div class="subbar">
        <div class="tabs" role="tablist" aria-label="Assignment group">
          ${TABS.map((x) => html`<button type="button" role="tab" class="tab${x.id === local.tab ? ' on' : ''}" aria-selected="${x.id === local.tab}" data-tab="${x.id}">${x.label} <span class="muted">${week.days[0]?.assignments.filter((a) => x.kinds.includes(a.kind)).length ?? 0}</span></button>`)}
        </div>
        <div class="legend small">
          <span class="lg-item"><span class="chip lc-red sw"></span><span class="chip lc-light_blue sw"></span><span class="chip lc-green sw"></span><span class="chip lc-dark_blue sw"></span><span class="chip lc-white sw"></span> Label colors</span>
          <span class="lg-item">${icon('lock', 12)} Locked</span>
          <span class="lg-item"><span class="chip warn sw"></span> Conflict</span>
          <span class="lg-item"><span class="chip ovr sw"></span> Override</span>
          <span class="lg-item"><span class="slot empty sw"></span> Open</span>
        </div>
      </div>
      <div class="split">
        <section class="split-main" aria-label="Weekly grid">${grid(week)}</section>
        <aside class="split-side" aria-label="Slot details">${sidePanel(week)}</aside>
      </div>`;
  },

  bind(root: HTMLElement): void {
    const go = (d: string) => {
      ui.weekStart = weekStartOf(d);
      local.selected = null;
      rerender(true);
    };
    $('#prev', root)!.onclick = () => go(addDays(ui.weekStart, -7));
    $('#next', root)!.onclick = () => go(addDays(ui.weekStart, 7));
    $('#today', root)!.onclick = () => go(todayIso());
    $$('[data-tab]', root).forEach((b) => (b.onclick = () => ((local.tab = b.dataset.tab!), rerender(true))));
    const attn = $('#attn', root);
    if (attn)
      attn.onclick = () => {
        const p = firstProblem(weekView(ui.weekStart));
        if (!p) return;
        const s = [...state.assignments.values()].find((a) => a.slots.some((x) => x.id === p.slotId));
        local.tab = TABS.find((t) => s && t.kinds.includes(s.kind))?.id ?? local.tab;
        local.selected = p;
        rerender(true);
      };

    $('#autofill', root)!.onclick = () => openAutoFill(ui.weekStart);
    $('#layouts-btn', root)!.onclick = () => openApplyLayout(ui.weekStart);
    $$('[data-day-stands]', root).forEach((b) => (b.onclick = () => openDayStaffing(ui.weekStart, b.dataset.dayStands!)));
    $('#export', root)!.onclick = () => openExport(ui.weekStart);
    $('#publish', root)!.onclick = () => run(() => setPublished(ui.weekStart, state.weeks.get(ui.weekStart)?.status !== 'published'), state.weeks.get(ui.weekStart)?.status === 'published' ? 'Week moved back to draft.' : 'Week published.');
    $('#copy', root)!.onclick = () =>
      confirmBox(`Copy last week's assignments into ${fmtWeek(ui.weekStart)}?`, 'Only empty slots are filled. Anyone who is now off, unqualified or closed is skipped.', 'Copy', async () => {
        const r = await copyWeek(addDays(ui.weekStart, -7), ui.weekStart);
        toast(`Copied ${r.copied} assignments${r.skipped ? `, skipped ${r.skipped}` : ''}.`);
      });
    $('#clear', root)!.onclick = () =>
      confirmBox(`Clear ${fmtWeek(ui.weekStart)}?`, 'Removes every unlocked assignment this week. Locked ones stay.', 'Clear week', async () => {
        const n = await clearWeek(ui.weekStart);
        toast(`Removed ${n} assignments.`);
      });

    // slot selection
    $$('.slot', root).forEach((el) => {
      el.addEventListener('click', () => {
        local.selected = { date: el.dataset.date!, slotId: Number(el.dataset.slot) };
        rerender(true);
      });
    });
    const desel = $('#desel', root);
    if (desel) desel.onclick = () => ((local.selected = null), rerender(true));

    // open / close a stand for one day
    $$('[data-close-cell]', root).forEach((b) => (b.onclick = (e) => (e.stopPropagation(), closeCell(Number(b.dataset.closeCell), b.dataset.date!))));
    $$('[data-open-cell]', root).forEach((b) => (b.onclick = () => run(() => setOpen(ui.weekStart, Number(b.dataset.openCell), b.dataset.date!, true), 'Reopened.')));
    const cd = $('#close-day', root);
    if (cd) cd.onclick = () => closeCell(Number(cd.dataset.aid), cd.dataset.date!);

    // selected-slot actions
    const lock = $('#lock', root);
    if (lock) lock.onclick = () => run(() => setLocked(ui.weekStart, lock.dataset.key!, lock.dataset.locked !== 'true'), lock.dataset.locked === 'true' ? 'Unlocked.' : 'Locked. Auto-Fill and Clear will leave it alone.');
    const un = $('#unassign', root);
    if (un) un.onclick = () => run(() => removeEntry(ui.weekStart, un.dataset.key!), 'Removed.');

    // candidates
    $$('[data-assign]', root).forEach((b) => (b.onclick = () => drop({ weekStart: ui.weekStart, date: b.dataset.date!, slotId: Number(b.dataset.slot), personnelId: Number(b.dataset.assign) })));
    const search = $('#cand-search', root) as HTMLInputElement | null;
    if (search) {
      const filter = () => {
        local.search = search.value;
        const q = search.value.trim().toLowerCase();
        $$('.split-side [data-q]', root).forEach((el) => (el.hidden = !!q && !el.dataset.q!.includes(q)));
        if (q) $$('.split-side details', root).forEach((d) => ((d as HTMLDetailsElement).open = true));
      };
      search.oninput = filter;
      filter();
    }

    // drag and drop
    $$('[draggable="true"]', root).forEach((el) =>
      el.addEventListener('dragstart', (e) => {
        e.dataTransfer!.setData('text/plain', JSON.stringify({ pid: Number(el.dataset.pid), fromKey: el.dataset.key ?? null }));
        e.dataTransfer!.effectAllowed = 'move';
        root.classList.add('dragging');
      }),
    );
    root.addEventListener('dragend', () => root.classList.remove('dragging'));
    $$('.slot', root).forEach((el) => {
      el.addEventListener('dragover', (e) => {
        e.preventDefault();
        el.classList.add('over');
      });
      el.addEventListener('dragleave', () => el.classList.remove('over'));
      el.addEventListener('drop', (e) => {
        e.preventDefault();
        el.classList.remove('over');
        const data = parse(e.dataTransfer!.getData('text/plain'));
        if (!data) return;
        if (data.fromKey === entryKey(el.dataset.date!, Number(el.dataset.slot))) return;
        drop({ weekStart: ui.weekStart, date: el.dataset.date!, slotId: Number(el.dataset.slot), personnelId: data.pid, moveFromKey: data.fromKey ?? undefined });
      });
    });
    const rosterEl = $('[data-drop-roster]', root);
    if (rosterEl) {
      rosterEl.addEventListener('dragover', (e) => e.preventDefault());
      rosterEl.addEventListener('drop', (e) => {
        e.preventDefault();
        const data = parse(e.dataTransfer!.getData('text/plain'));
        if (data?.fromKey) run(() => removeEntry(ui.weekStart, data.fromKey!), 'Unassigned.');
      });
    }
  },
};

function parse(s: string): { pid: number; fromKey: string | null } | null {
  try {
    const v = JSON.parse(s);
    return typeof v?.pid === 'number' ? v : null;
  } catch {
    return null;
  }
}

async function run(fn: () => Promise<unknown>, ok?: string) {
  try {
    await fn();
    if (ok) toast(ok);
  } catch (e) {
    toast(e instanceof StoreError ? e.message : 'Something went wrong. Try again.', 'error');
  }
}

function confirmBox(title: string, body: string, action: string, fn: () => Promise<void>) {
  modal(
    html`<h2 class="h2">${title}</h2><p>${body}</p><div class="btn-row end"><button type="button" class="btn" data-close>Cancel</button><button type="button" class="btn primary" id="cb-go">${action}</button></div>`,
    (root, close) => {
      ($('#cb-go', root) as HTMLButtonElement).onclick = async () => {
        close();
        await run(fn);
      };
    },
  );
}

function closeCell(assignmentId: number, date: string) {
  const a = state.assignments.get(assignmentId)!;
  const filled = a.slots.filter((s) => state.weeks.get(ui.weekStart)?.entries[entryKey(date, s.id)]).length;
  const go = () => run(() => setOpen(ui.weekStart, assignmentId, date, false), `${a.displayName} closed for ${shortDate(date)}.`);
  if (!filled) return go();
  confirmBox(`Close ${a.displayName} on ${shortDate(date)}?`, `${filled} ${filled === 1 ? 'person is' : 'people are'} assigned there. Closing removes them from this stand for the day.`, 'Close and remove', async () => {
    await setOpen(ui.weekStart, assignmentId, date, false);
    toast(`${a.displayName} closed for ${shortDate(date)}.`);
  });
}

async function drop(req: AssignRequest) {
  try {
    const out = await assign(req);
    if (out.ok) {
      local.selected = { date: req.date, slotId: req.slotId };
      rerender(true);
      return;
    }
    if (out.kind === 'locked') return toast(out.message, 'warn');
    if (out.kind === 'blocked') return toast(out.issues.map((i) => i.message).join(' '), 'warn');
    overrideDialog(req, out.issues);
  } catch (e) {
    toast(e instanceof StoreError ? e.message : 'Could not assign. Try again.', 'error');
  }
}

function overrideDialog(req: AssignRequest, issues: Issue[]) {
  const p = state.personnel.get(req.personnelId)!;
  const allowed = canOverride();
  modal(
    html`<div class="dlg-head warnhead">${icon('alert', 20)}<h2 class="h2">This assignment breaks a scheduling rule</h2></div>
      <ul class="issues big">${issues.map((i) => html`<li>${i.message}</li>`)}</ul>
      ${allowed
        ? html`<label class="field"><span>Supervisor override reason (saved with the shift)</span><textarea id="ov-reason" class="input" rows="2" maxlength="300" placeholder="e.g. Short-staffed, approved by phone"></textarea></label>
            <p class="error" id="ov-err" hidden>Enter a reason of at least 3 characters.</p>
            <div class="btn-row end"><button type="button" class="btn" data-close>Cancel</button><button type="button" class="btn warnbtn" id="ov-go">Assign ${esc(p.lgNumber)} with override</button></div>`
        : html`<p>${state.settings.overridesEnabled ? 'Your account cannot approve overrides. Ask an admin who can, or pick someone from “Qualified & available”.' : 'Supervisor overrides are turned off in Admins & settings.'}</p><div class="btn-row end"><button type="button" class="btn primary" data-close>OK</button></div>`}`,
    (root, close) => {
      const go = $('#ov-go', root) as HTMLButtonElement | null;
      if (!go) return;
      go.onclick = async () => {
        const reason = ($('#ov-reason', root) as HTMLTextAreaElement).value.trim();
        if (reason.length < 3) {
          $('#ov-err', root)!.hidden = false;
          return;
        }
        close();
        await drop({ ...req, overrideReason: reason });
        toast('Assigned with supervisor override.', 'warn');
      };
    },
  );
}

export { availability };
