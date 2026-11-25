// Personnel profiles: name, LG number, active, label color, certifications, regular days off, assignments.

import { evaluate, missing } from '../../../src/domain/criteria.ts';
import { WEEKDAYS, weekDates } from '../../../src/domain/dates.ts';
import { availability } from '../../../src/domain/scheduling.ts';
import { rerender, ui } from '../app-state.ts';
import { me, personnelCtx, sortedPeople, weekView } from '../model.ts';
import { audit, deletePerson, savePerson, state, StoreError, type Person } from '../store.ts';
import { $, $$, DAY_LONG, DAY_SHORT, html, icon, LABEL_COLORS, LABEL_NAMES, modal, newId, raw, shortDate, toast, type Raw } from '../util.ts';
import { fmtWeek } from './schedule.ts';

const local = { selected: null as number | null, q: '', filter: 'active' as 'active' | 'inactive' | 'all', cert: '' };
const LG = /^LG\d{1,4}$/i;

async function save(p: Person, msg?: string) {
  try {
    await savePerson(p);
    if (msg) toast(msg);
  } catch (e) {
    toast(e instanceof StoreError ? e.message : 'Could not save.', 'error');
  }
}

function list(): Raw {
  const q = local.q.trim().toLowerCase();
  const people = sortedPeople().filter(
    (p) =>
      (local.filter === 'all' || (local.filter === 'active' ? p.active : !p.active)) &&
      (!local.cert || p.certs.includes(local.cert)) &&
      (!q || p.lgNumber.toLowerCase().includes(q) || p.name.toLowerCase().includes(q)),
  );
  const count = (f: 'active' | 'inactive') => [...state.personnel.values()].filter((p) => (f === 'active' ? p.active : !p.active)).length;
  return html`<aside class="list-pane" aria-label="Personnel list">
    <div class="pane-head"><h1 class="h1">Personnel</h1><button type="button" class="btn primary small" id="add-person">${icon('plus', 14)} Add</button></div>
    <label class="search">${icon('search', 15)}<input type="search" id="p-q" placeholder="Search LG # or name" aria-label="Search personnel" value="${local.q}"></label>
    <div class="filters">
      <button type="button" class="fchip${local.filter === 'active' ? ' on' : ''}" data-f="active">Active · ${count('active')}</button>
      <button type="button" class="fchip${local.filter === 'inactive' ? ' on' : ''}" data-f="inactive">Inactive · ${count('inactive')}</button>
      <select id="p-cert" class="input small" aria-label="Filter by certification"><option value="">Any certification</option>${(state.certs?.list ?? []).map((c) => html`<option value="${c.code}" ${local.cert === c.code ? raw('selected') : ''}>${c.name}</option>`)}</select>
    </div>
    <div class="plist" data-keep-scroll="plist">
      ${people.map(
        (p) => html`<button type="button" class="pitem${p.id === local.selected ? ' on' : ''}${p.active ? '' : ' inactive'}" data-pid="${p.id}">
          <span class="chip lc-${p.labelColor}">${p.lgNumber}</span>
          <span class="pmain"><span class="pname">${p.name}</span><span class="pcerts">${p.certs.join(' ') || 'No certifications'}</span></span>
          ${p.active ? '' : html`<span class="tag">Inactive</span>`}
        </button>`,
      )}
      ${people.length ? '' : html`<p class="muted small pad">${state.personnel.size ? 'No one matches these filters.' : 'No lifeguards yet. Add the first one.'}</p>`}
    </div>
  </aside>`;
}

function profile(p: Person): Raw {
  const ctx = personnelCtx().get(p.id)!;
  const certList = state.certs?.list ?? [];
  const week = weekView(ui.weekStart);
  const dates = weekDates(ui.weekStart);
  const shifts = dates.map((d, i) => {
    const day = week.days[i];
    const mine = day.assignments.flatMap((a) => a.slots.filter((s) => s.entry?.personnelId === p.id).map((s) => ({ a, s })));
    const av = availability(ctx, d);
    return { d, i, mine, av };
  });
  const upcoming = [...state.timeOff.values()].filter((t) => t.personnelId === p.id && t.endDate >= dates[0]).sort((a, b) => a.startDate.localeCompare(b.startDate));
  return html`<section class="detail" aria-label="Profile for ${p.lgNumber}">
    <div class="profile-head">
      <span class="avatar chip lc-${p.labelColor}">${p.lgNumber}</span>
      <div class="grow1"><h2 class="h1">${p.name}</h2><p class="muted">${p.certs.length} certifications · ${p.daysOff.length ? `regular days off ${p.daysOff.map((d) => DAY_SHORT[WEEKDAYS[d]]).join(', ')}` : 'no regular days off'} · ${shifts.reduce((n, s) => n + s.mine.length, 0)} shifts this week</p></div>
      <label class="switch"><input type="checkbox" id="p-active" ${p.active ? raw('checked') : ''}><span class="track" aria-hidden="true"></span>Active</label>
    </div>
    <div class="cards2">
      <section class="card">
        <h3 class="h3">Identity</h3>
        <div class="row2 fixed">
          <label class="field"><span>Name</span><input id="p-name" class="input" value="${p.name}" maxlength="120"></label>
          <label class="field"><span>LG number</span><input id="p-lg" class="input mono" value="${p.lgNumber}" maxlength="7"></label>
        </div>
        <p class="error small" id="p-lg-err" hidden></p>
        <div class="field"><span>Label color on the schedule</span>
          <div class="swatches" role="radiogroup" aria-label="Label color">${LABEL_COLORS.map(
            (c) => html`<button type="button" role="radio" aria-checked="${p.labelColor === c}" class="swatch${p.labelColor === c ? ' on' : ''}" data-color="${c}"><span class="chip lc-${c}">${p.lgNumber}</span>${LABEL_NAMES[c]}</button>`,
          )}</div>
        </div>
      </section>
      <section class="card">
        <div class="card-head"><h3 class="h3">Regular days off</h3><a href="#timeoff" class="small">Add one-time time off</a></div>
        <div class="days7" role="group" aria-label="Weekly pattern">${WEEKDAYS.map(
          (w, i) => html`<button type="button" class="dayt${p.daysOff.includes(i) ? ' off' : ''}" data-day="${i}" aria-pressed="${p.daysOff.includes(i)}">${DAY_SHORT[w]}<span>${p.daysOff.includes(i) ? 'Off' : 'Works'}</span></button>`,
        )}</div>
        <p class="muted small">Repeats every week.${upcoming.length ? html` Upcoming: ${upcoming.slice(0, 3).map((t, i) => html`${i ? ', ' : ''}<strong class="warntext">${t.type.replace('_', ' ')} ${shortDate(t.startDate)}${t.endDate !== t.startDate ? `–${shortDate(t.endDate)}` : ''}</strong>`)}` : ''}</p>
      </section>
    </div>
    <section class="card">
      <div class="card-head"><h3 class="h3">Certifications</h3><span class="muted small">Click to add or remove. Each one is independent; holding EMT2 doesn't count as EMT unless an equivalency rule says so.</span><a href="#criteria" class="small">Equivalency rules: ${(state.certs?.equivalencies ?? []).filter((e) => e.enabled).length || 'Off'}</a></div>
      <div class="cert-row">${certList.map((c) => {
        const on = p.certs.includes(c.code);
        return html`<button type="button" class="cert${on ? ' on' : ''}" data-cert="${c.code}" aria-pressed="${on}">${icon(on ? 'check' : 'plus', 13)} ${c.name}</button>`;
      })}</div>
      <div class="quals"><span class="lbl">Qualifies for saved criteria</span><div class="qual-row">${[...state.presets.values()]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((pr) => {
          const ok = evaluate(pr.rule, ctx.certs);
          return html`<span class="qual${ok ? ' ok' : ''}">${icon(ok ? 'check' : 'x', 12)} ${pr.name}${ok ? '' : html` <span class="muted">· needs ${missing(pr.rule, ctx.certs).join('; ')}</span>`}</span>`;
        })}</div></div>
    </section>
    <section class="card">
      <div class="card-head"><h3 class="h3">Assignments · ${fmtWeek(ui.weekStart)}</h3><a href="#schedule" class="small">Open in schedule</a></div>
      <div class="table-wrap"><table class="tbl"><tbody>${shifts.map(
        (s) => html`<tr><th scope="row">${DAY_LONG[WEEKDAYS[s.i]]}</th><td>${
          s.mine.length
            ? s.mine.map(({ a, s: sl }) => html`<div>${a.displayName} · ${sl.name} ${sl.entry?.locked ? icon('lock', 11, 'Locked') : ''}</div>`)
            : s.av.available
              ? html`<span class="muted">Unassigned</span>`
              : html`<span class="muted">${s.av.reason === 'regular_day_off' ? 'Regular day off' : String(s.av.reason).replace('_', ' ')}</span>`
        }</td><td class="muted small">${s.mine.map(({ s: sl }) => sl.criteria).join(', ')}</td></tr>`,
      )}</tbody></table></div>
    </section>
    <div class="danger-row"><button type="button" class="btn small ghost danger" id="p-del">${icon('trash', 13)} Delete ${p.lgNumber}</button><span class="muted small">To keep history, mark inactive instead.</span></div>
  </section>`;
}

export const personnelView = {
  render(): Raw {
    const sel = local.selected != null ? state.personnel.get(local.selected) : undefined;
    if (!sel) local.selected = sortedPeople().find((p) => p.active)?.id ?? sortedPeople()[0]?.id ?? null;
    const p = local.selected != null ? state.personnel.get(local.selected) : undefined;
    return html`<div class="master">${list()}${p ? profile(p) : html`<section class="detail"><div class="empty-state"><p>Add your first lifeguard to start building schedules.</p></div></section>`}</div>`;
  },
  bind(root: HTMLElement): void {
    $('#add-person', root)!.onclick = addPerson;
    const q = $('#p-q', root) as HTMLInputElement;
    q.oninput = () => {
      local.q = q.value;
      const s = q.value.trim().toLowerCase();
      $$('.pitem', root).forEach((el) => {
        const p = state.personnel.get(Number(el.dataset.pid))!;
        el.hidden = !!s && !(p.lgNumber.toLowerCase().includes(s) || p.name.toLowerCase().includes(s));
      });
    };
    $$('[data-f]', root).forEach((b) => (b.onclick = () => ((local.filter = b.dataset.f as typeof local.filter), rerender(true))));
    ($('#p-cert', root) as HTMLSelectElement).onchange = (e) => ((local.cert = (e.target as HTMLSelectElement).value), rerender(true));
    $$('.pitem', root).forEach((b) => (b.onclick = () => ((local.selected = Number(b.dataset.pid)), rerender(true))));
    const p = local.selected != null ? state.personnel.get(local.selected) : undefined;
    if (!p) return;
    const upd = (patch: Partial<Person>, msg?: string) => save({ ...p, ...patch }, msg);
    ($('#p-active', root) as HTMLInputElement).onchange = (e) => {
      const on = (e.target as HTMLInputElement).checked;
      upd({ active: on }, on ? `${p.lgNumber} is active.` : `${p.lgNumber} marked inactive.`);
      audit(me(), on ? 'Activated' : 'Deactivated', p.lgNumber);
    };
    ($('#p-name', root) as HTMLInputElement).onchange = (e) => {
      const v = (e.target as HTMLInputElement).value.trim();
      if (v) upd({ name: v }, 'Name saved.');
    };
    ($('#p-lg', root) as HTMLInputElement).onchange = (e) => {
      const v = (e.target as HTMLInputElement).value.trim().toUpperCase();
      const err = $('#p-lg-err', root)!;
      if (!LG.test(v)) {
        err.textContent = 'Use the format LG followed by a number, like LG20.';
        err.hidden = false;
        return;
      }
      if ([...state.personnel.values()].some((x) => x.id !== p.id && x.lgNumber.toUpperCase() === v)) {
        err.textContent = `${v} is already used by another lifeguard.`;
        err.hidden = false;
        return;
      }
      err.hidden = true;
      upd({ lgNumber: v }, `LG number changed to ${v}.`);
      audit(me(), 'Changed LG number', `${p.lgNumber} → ${v}`);
    };
    $$('[data-color]', root).forEach((b) => (b.onclick = () => upd({ labelColor: b.dataset.color as Person['labelColor'] })));
    $$('[data-day]', root).forEach(
      (b) =>
        (b.onclick = () => {
          const d = Number(b.dataset.day);
          upd({ daysOff: p.daysOff.includes(d) ? p.daysOff.filter((x) => x !== d) : [...p.daysOff, d].sort() });
        }),
    );
    $$('[data-cert]', root).forEach(
      (b) =>
        (b.onclick = () => {
          const c = b.dataset.cert!;
          const has = p.certs.includes(c);
          upd({ certs: has ? p.certs.filter((x) => x !== c) : [...p.certs, c] }, `${has ? 'Removed' : 'Added'} ${c} for ${p.lgNumber}.`);
          audit(me(), has ? 'Removed certification' : 'Added certification', `${c} · ${p.lgNumber}`);
        }),
    );
    $('#p-del', root)!.onclick = () =>
      modal(html`<h2 class="h2">Delete ${p.lgNumber} · ${p.name}?</h2><p>This removes the profile. Their past assignments will show as empty. To keep history, mark them inactive instead.</p><div class="btn-row end"><button type="button" class="btn" data-close>Cancel</button><button type="button" class="btn danger" id="pd-go">Delete</button></div>`, (r, close) => {
        ($('#pd-go', r) as HTMLButtonElement).onclick = async () => {
          close();
          try {
            await deletePerson(p.id);
            audit(me(), 'Deleted lifeguard', p.lgNumber);
            local.selected = null;
            toast(`${p.lgNumber} deleted.`);
          } catch (e) {
            toast(e instanceof StoreError ? e.message : 'Could not delete.', 'error');
          }
        };
      });
  },
};

function addPerson() {
  const nextNum = Math.max(0, ...[...state.personnel.values()].map((p) => Number(p.lgNumber.replace(/\D/g, '')) || 0)) + 1;
  modal(
    html`<h2 class="h2">Add lifeguard</h2>
      <div class="row2 fixed"><label class="field"><span>Name</span><input id="np-name" class="input" maxlength="120" autofocus></label><label class="field"><span>LG number</span><input id="np-lg" class="input mono" value="LG${nextNum}" maxlength="7"></label></div>
      <p class="muted small">You can add certifications and days off on the profile next.</p>
      <p class="error" id="np-err" hidden></p>
      <div class="btn-row end"><button type="button" class="btn" data-close>Cancel</button><button type="button" class="btn primary" id="np-go">Add lifeguard</button></div>`,
    (root, close) => {
      ($('#np-go', root) as HTMLButtonElement).onclick = async () => {
        const name = ($('#np-name', root) as HTMLInputElement).value.trim();
        const lg = ($('#np-lg', root) as HTMLInputElement).value.trim().toUpperCase();
        const err = $('#np-err', root)!;
        const fail = (m: string) => ((err.textContent = m), (err.hidden = false));
        if (!name) return fail('Enter a name.');
        if (!LG.test(lg)) return fail('Use the format LG followed by a number, like LG20.');
        if ([...state.personnel.values()].some((x) => x.lgNumber.toUpperCase() === lg)) return fail(`${lg} is already in use.`);
        const p: Person = { id: newId(), lgNumber: lg, name, active: true, labelColor: 'white', certs: state.certs?.list.some((c) => c.code === 'BASIC') ? ['BASIC'] : [], daysOff: [] };
        close();
        await save(p, `${lg} added.`);
        audit(me(), 'Added lifeguard', lg);
        local.selected = p.id;
        local.filter = 'active';
        rerender(true);
      };
    },
  );
}
