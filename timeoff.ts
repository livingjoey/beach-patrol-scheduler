// Time Off: regular weekly pattern matrix, this-week matrix with date overrides, override list and form.

import { addDays, todayIso, WEEKDAYS, weekDates, weekdayIndex, weekStartOf } from '../../../src/domain/dates.ts';
import { availability } from '../../../src/domain/scheduling.ts';
import { rerender, ui } from '../app-state.ts';
import { me, personnelCtx, sortedPeople } from '../model.ts';
import { audit, deleteTimeOff, savePerson, saveTimeOff, state, StoreError, type TimeOff } from '../store.ts';
import { $, $$, DAY_SHORT, html, icon, newId, raw, shortDate, toast, type Raw } from '../util.ts';
import { fmtWeek } from './schedule.ts';

const local = { view: 'week' as 'week' | 'pattern', q: '' };
const TYPES: { id: TimeOff['type']; label: string; short: string }[] = [
  { id: 'vacation', label: 'Vacation', short: 'VAC' },
  { id: 'leave', label: 'Approved leave', short: 'LV' },
  { id: 'training', label: 'Training', short: 'TRN' },
  { id: 'other', label: 'Other', short: 'OTH' },
  { id: 'extra_workday', label: 'Extra working day', short: 'XTRA' },
];
const typeOf = (id: string) => TYPES.find((t) => t.id === id) ?? TYPES[3];
const CLS: Record<string, string> = { vacation: 'vac', leave: 'lv', training: 'trn', other: 'oth', extra_workday: 'xtra' };

async function run(fn: () => Promise<unknown>, ok?: string) {
  try {
    await fn();
    if (ok) toast(ok);
  } catch (e) {
    toast(e instanceof StoreError ? e.message : 'Could not save.', 'error');
  }
}

function matrix(): Raw {
  const people = sortedPeople().filter((p) => p.active);
  const ctx = personnelCtx();
  const dates = weekDates(ui.weekStart);
  if (!people.length) return html`<div class="empty-state"><p>No active lifeguards yet.</p><a class="btn" href="#personnel">Add personnel</a></div>`;
  const working = dates.map(() => 0);
  const rows = people.map((p) => {
    const pc = ctx.get(p.id)!;
    const cells = WEEKDAYS.map((w, i) => {
      if (local.view === 'pattern') {
        const off = p.daysOff.includes(i);
        if (!off) working[i]++;
        return html`<button type="button" class="mx${off ? ' off' : ''}" data-pat="${p.id}" data-wd="${i}" aria-label="${p.lgNumber} ${DAY_SHORT[w]}: ${off ? 'regular day off' : 'works'}" aria-pressed="${off}">${off ? 'Off' : raw('<span class="dot"></span>')}</button>`;
      }
      const av = availability(pc, dates[i]);
      const t = av.timeOffId != null ? state.timeOff.get(av.timeOffId) : undefined;
      if (av.available) working[i]++;
      const cls = t ? CLS[t.type] : av.available ? '' : 'off';
      const label = t ? typeOf(t.type).short : av.available ? '' : av.reason === 'regular_day_off' ? 'Off' : '';
      return html`<button type="button" class="mx ${cls}" data-day="${p.id}" data-date="${dates[i]}" title="${t ? `${typeOf(t.type).label}${t.note ? `: ${t.note}` : ''} (${shortDate(t.startDate)}${t.endDate !== t.startDate ? `–${shortDate(t.endDate)}` : ''})` : ''}" aria-label="${p.lgNumber} ${DAY_SHORT[w]} ${shortDate(dates[i])}: ${av.available ? (t ? 'extra working day' : 'working') : t ? typeOf(t.type).label : 'regular day off'}">${av.available && !t ? raw('<span class="dot"></span>') : label}</button>`;
    });
    return html`<div class="mxrow" data-q="${(p.lgNumber + ' ' + p.name).toLowerCase()}"><div class="mxlg"><span class="chip lc-${p.labelColor}">${p.lgNumber}</span><span class="mxname">${p.name}</span></div>${cells}</div>`;
  });
  return html`<div class="mx-scroll" data-keep-scroll="mx"><div class="mx-grid">
    <div class="mxrow head"><div class="mxlg eyebrow">Lifeguard</div>${WEEKDAYS.map((w, i) => html`<div class="mxh"><strong>${DAY_SHORT[w]}</strong>${local.view === 'week' ? html`<span class="muted small">${shortDate(dates[i])}</span>` : ''}</div>`)}</div>
    ${rows}
    <div class="mxrow foot"><div class="mxlg small"><strong>Working</strong><span class="muted">of ${people.length} active</span></div>${working.map((n) => html`<div class="mxt mono">${n}</div>`)}</div>
  </div></div>`;
}

function sidePanel(): Raw {
  const dates = weekDates(ui.weekStart);
  const items = [...state.timeOff.values()]
    .filter((t) => t.endDate >= dates[0] && t.startDate <= dates[6])
    .sort((a, b) => a.startDate.localeCompare(b.startDate));
  const people = sortedPeople().filter((p) => p.active);
  return html`
    <form class="panel" id="to-form" novalidate>
      <h2 class="h3">Add date override</h2>
      <label class="field"><span>Lifeguard</span><select id="to-p" class="input">${people.map((p) => html`<option value="${p.id}">${p.lgNumber} · ${p.name}</option>`)}</select></label>
      <label class="field"><span>Type</span><select id="to-type" class="input">${TYPES.map((t) => html`<option value="${t.id}">${t.label}</option>`)}</select></label>
      <div class="row2 fixed"><label class="field"><span>From</span><input id="to-from" type="date" class="input" value="${dates[0]}"></label><label class="field"><span>To</span><input id="to-to" type="date" class="input" value="${dates[0]}"></label></div>
      <label class="field"><span>Note (optional)</span><input id="to-note" class="input" maxlength="300" placeholder="Approved by…"></label>
      <p class="info small">${icon('check', 13)} Applies to these dates only. The regular weekly pattern stays the same.</p>
      <p class="error" id="to-err" hidden></p>
      <button type="submit" class="btn primary">Add override</button>
    </form>
    <div class="panel">
      <div class="panel-head"><h2 class="h3">Overrides this week</h2><span class="muted small">${items.length}</span></div>
      ${items.length ? '' : html`<p class="muted small">None. Click a cell in the matrix or use the form above.</p>`}
      ${items.map((t) => {
        const p = state.personnel.get(t.personnelId);
        return html`<div class="ov-item"><span class="mx ${CLS[t.type]} tag-cell">${typeOf(t.type).short}</span><div class="grow1"><strong><span class="mono">${p?.lgNumber ?? '?'}</span> · ${typeOf(t.type).label}</strong><div class="muted small">${shortDate(t.startDate)}${t.endDate !== t.startDate ? ` – ${shortDate(t.endDate)}` : ''}${t.note ? ` · ${t.note}` : ''}</div></div><button type="button" class="icon-btn" data-del-to="${t.id}" aria-label="Remove override">${icon('x', 14)}</button></div>`;
      })}
    </div>`;
}

export const timeOffView = {
  render(): Raw {
    return html`
      <header class="topbar">
        <div><div class="eyebrow">Time off &amp; availability</div><h1 class="h1">${local.view === 'week' ? `Who's working, ${fmtWeek(ui.weekStart)}` : 'Regular weekly pattern'}</h1></div>
        <div class="tabs" role="tablist" aria-label="View">
          <button type="button" role="tab" class="tab${local.view === 'pattern' ? ' on' : ''}" aria-selected="${local.view === 'pattern'}" data-view="pattern">Regular weekly pattern</button>
          <button type="button" role="tab" class="tab${local.view === 'week' ? ' on' : ''}" aria-selected="${local.view === 'week'}" data-view="week">This week, with overrides</button>
        </div>
        ${local.view === 'week' ? html`<div class="weeknav"><button type="button" class="icon-btn boxed" id="to-prev" aria-label="Previous week">${icon('left', 16)}</button><button type="button" class="btn small ghost" id="to-today">This week</button><button type="button" class="icon-btn boxed" id="to-next" aria-label="Next week">${icon('right', 16)}</button></div>` : ''}
        <div class="spacer"></div>
        <label class="search narrow">${icon('search', 15)}<input type="search" id="to-q" placeholder="Filter LG # or name" aria-label="Filter lifeguards" value="${local.q}"></label>
      </header>
      <div class="subbar small">
        <span>${local.view === 'week' ? 'Click a cell to switch working ↔ off for that date only.' : 'Click a cell to change a regular day off. It repeats every week.'}</span>
        <div class="legend">
          <span class="lg-item"><span class="mx sw"><span class="dot"></span></span>Working</span>
          <span class="lg-item"><span class="mx off sw"></span>Regular day off</span>
          ${local.view === 'week' ? TYPES.map((t) => html`<span class="lg-item"><span class="mx ${CLS[t.id]} sw"></span>${t.label}</span>`) : ''}
        </div>
      </div>
      <div class="split">
        <section class="split-main" aria-label="Availability matrix">${matrix()}</section>
        <aside class="split-side" aria-label="Date overrides">${sidePanel()}</aside>
      </div>`;
  },
  bind(root: HTMLElement): void {
    $$('[data-view]', root).forEach((b) => (b.onclick = () => ((local.view = b.dataset.view as 'week' | 'pattern'), rerender(true))));
    const go = (d: string) => ((ui.weekStart = weekStartOf(d)), rerender(true));
    $('#to-prev', root) && ($('#to-prev', root)!.onclick = () => go(addDays(ui.weekStart, -7)));
    $('#to-next', root) && ($('#to-next', root)!.onclick = () => go(addDays(ui.weekStart, 7)));
    $('#to-today', root) && ($('#to-today', root)!.onclick = () => go(todayIso()));
    const q = $('#to-q', root) as HTMLInputElement;
    const filter = () => {
      local.q = q.value;
      const s = q.value.trim().toLowerCase();
      $$('.mxrow[data-q]', root).forEach((r) => (r.hidden = !!s && !r.dataset.q!.includes(s)));
    };
    q.oninput = filter;
    filter();

    $$('[data-pat]', root).forEach(
      (b) =>
        (b.onclick = () => {
          const p = state.personnel.get(Number(b.dataset.pat))!;
          const d = Number(b.dataset.wd);
          const off = !p.daysOff.includes(d);
          run(() => savePerson({ ...p, daysOff: off ? [...p.daysOff, d].sort() : p.daysOff.filter((x) => x !== d) }));
          audit(me(), 'Changed regular days off', `${p.lgNumber} ${DAY_SHORT[WEEKDAYS[d]]}: ${off ? 'off' : 'works'}`);
        }),
    );
    $$('[data-day]', root).forEach((b) => (b.onclick = () => toggleDate(Number(b.dataset.day), b.dataset.date!)));
    $$('[data-del-to]', root).forEach(
      (b) =>
        (b.onclick = () => {
          const t = state.timeOff.get(Number(b.dataset.delTo));
          run(() => deleteTimeOff(Number(b.dataset.delTo)), 'Override removed.');
          if (t) audit(me(), 'Removed time off', `${state.personnel.get(t.personnelId)?.lgNumber} ${t.type} ${t.startDate}–${t.endDate}`);
        }),
    );
    $('#to-form', root)!.addEventListener('submit', (e) => {
      e.preventDefault();
      const err = $('#to-err', root)!;
      const v = (id: string) => ($(`#${id}`, root) as HTMLInputElement).value;
      const from = v('to-from');
      const to = v('to-to') || from;
      if (!from) return ((err.textContent = 'Pick a start date.'), (err.hidden = false));
      if (to < from) return ((err.textContent = 'The end date must be on or after the start date.'), (err.hidden = false));
      const pid = Number(v('to-p'));
      if (!pid) return ((err.textContent = 'Pick a lifeguard.'), (err.hidden = false));
      const t: TimeOff = { id: newId(), personnelId: pid, startDate: from, endDate: to, type: v('to-type') as TimeOff['type'], note: v('to-note').trim(), createdBy: me() };
      run(() => saveTimeOff(t), 'Override added.');
      audit(me(), 'Added time off', `${state.personnel.get(pid)?.lgNumber} ${t.type} ${from}–${to}`);
    });
  },
};

/** Clicking a cell in "this week": change that one date without touching the pattern. */
function toggleDate(pid: number, date: string) {
  const p = state.personnel.get(pid)!;
  const single = [...state.timeOff.values()].filter((t) => t.personnelId === pid && t.startDate === date && t.endDate === date);
  const range = [...state.timeOff.values()].find((t) => t.personnelId === pid && t.startDate <= date && t.endDate >= date && !(t.startDate === date && t.endDate === date));
  if (single.length) {
    run(async () => {
      for (const t of single) await deleteTimeOff(t.id);
    }, `${p.lgNumber} back to the regular pattern on ${shortDate(date)}.`);
    audit(me(), 'Removed time off', `${p.lgNumber} ${date}`);
    return;
  }
  if (range) return toast(`${shortDate(date)} is part of ${typeOf(range.type).label.toLowerCase()} ${shortDate(range.startDate)}–${shortDate(range.endDate)}. Remove or edit it in the list.`, 'warn');
  const regularOff = p.daysOff.includes(weekdayIndex(date));
  const t: TimeOff = { id: newId(), personnelId: pid, startDate: date, endDate: date, type: regularOff ? 'extra_workday' : 'other', note: '', createdBy: me() };
  run(() => saveTimeOff(t), regularOff ? `${p.lgNumber} will work ${shortDate(date)}.` : `${p.lgNumber} marked off on ${shortDate(date)}.`);
  audit(me(), 'Changed one date', `${p.lgNumber} ${date}: ${regularOff ? 'extra working day' : 'off'}`);
}
