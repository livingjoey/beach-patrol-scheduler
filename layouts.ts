// Staffing layouts: saved sets of open/closed stands and guards per stand (never names).
// Load one onto chosen days (e.g. every Sat & Sun), or adjust a single short-staffed day.

import { addDays, WEEKDAYS, weekDates } from '../../../src/domain/dates.ts';
import type { AssignmentKind } from '../../../src/domain/scheduling.ts';
import { rerender, ui } from '../app-state.ts';
import { applyLayout, datesFor, layoutFromBase, layoutFromDay, layoutSummary, me, planLayout, saveNewLayout, sortedAssignments, type LayoutItems } from '../model.ts';
import { audit, deleteLayout, saveLayout, state, StoreError, type Layout } from '../store.ts';
import { $, $$, DAY_LONG, DAY_SHORT, html, icon, modal, raw, shortDate, toast, type Raw } from '../util.ts';

const GROUPS: { kind: AssignmentKind; label: string }[] = [
  { kind: 'stand', label: 'Stands' },
  { kind: 'medical', label: 'Medical units' },
  { kind: 'pwc', label: 'PWC units' },
  { kind: 'boat', label: 'Rescue boats' },
  { kind: 'extra', label: 'Extras' },
];

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const fmtWhen = (iso: string) => (iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '');
const sortedLayouts = () => [...state.layouts.values()].sort((a, b) => a.name.localeCompare(b.name));

function summaryLine(items: LayoutItems): string {
  const s = layoutSummary(items);
  return `${s.open} of ${s.total} open · ${s.guards} guards${s.closedNames.length && s.closedNames.length <= 3 ? ` · closed: ${s.closedNames.join(', ')}` : ''}`;
}

// ---------- the open/closed + guards editor ----------

function editorRows(items: LayoutItems): Raw {
  const all = sortedAssignments().filter((a) => a.active);
  return html`${GROUPS.map((g) => {
    const list = all.filter((a) => a.kind === g.kind);
    if (!list.length) return '';
    return html`<div class="st-group"><div class="grp">${g.label}</div>${list.map((a) => {
      const it = items[a.id] ?? { open: a.openByDefault, slots: a.slots.length };
      const n = Math.min(it.slots, a.slots.length);
      return html`<div class="st-row${it.open ? '' : ' closed'}">
        <span class="st-name">${a.displayName}</span>
        <label class="switch small-switch"><input type="checkbox" data-st-open="${a.id}" ${it.open ? raw('checked') : ''} aria-label="${a.displayName} open"><span class="track" aria-hidden="true"></span>${it.open ? 'Open' : 'Closed'}</label>
        <span class="stepper${it.open ? '' : ' off'}" role="group" aria-label="${a.displayName} guards">
          <button type="button" class="icon-btn" data-st-dec="${a.id}" aria-label="One fewer guard at ${a.displayName}" ${!it.open || n <= 1 ? raw('disabled') : ''}>−</button>
          <span class="mono"><strong>${it.open ? n : 0}</strong><span class="muted"> of ${a.slots.length}</span></span>
          <button type="button" class="icon-btn" data-st-inc="${a.id}" aria-label="One more guard at ${a.displayName}" ${!it.open || n >= a.slots.length ? raw('disabled') : ''}>+</button>
        </span>
      </div>`;
    })}</div>`;
  })}`;
}

/** Mounts an editable open/closed + guards table. Calls onChange with the full item set. */
function mountEditor(container: HTMLElement, start: LayoutItems, onChange: (items: LayoutItems) => void): { get(): LayoutItems } {
  const items = clone(start);
  for (const a of sortedAssignments()) if (a.active && !items[a.id]) items[a.id] = { open: a.openByDefault, slots: a.slots.length };
  const draw = () => {
    container.innerHTML = html`<div class="st-totals" aria-live="polite">${summaryLine(items)}</div>${editorRows(items)}`.value;
    $$<HTMLInputElement>('[data-st-open]', container).forEach((c) => (c.onchange = () => ((items[c.dataset.stOpen!].open = c.checked), changed())));
    $$('[data-st-dec]', container).forEach((b) => (b.onclick = () => ((items[b.dataset.stDec!].slots = Math.max(1, items[b.dataset.stDec!].slots - 1)), changed())));
    $$('[data-st-inc]', container).forEach((b) => {
      const a = state.assignments.get(Number(b.dataset.stInc))!;
      b.onclick = () => ((items[b.dataset.stInc!].slots = Math.min(a.slots.length, items[b.dataset.stInc!].slots + 1)), changed());
    });
  };
  const changed = () => {
    draw();
    onChange(clone(items));
  };
  draw();
  return { get: () => clone(items) };
}

// ---------- load a layout onto days ----------

export function openApplyLayout(weekStart: string, layoutId?: number, preset?: 'weekend' | 'weekdays' | 'all' | string): void {
  const layouts = sortedLayouts();
  if (!layouts.length) {
    modal(html`<h2 class="h2">No saved layouts yet</h2><p>Save one first: open <strong>Layouts</strong>, or use <strong>Stands</strong> on any day in the schedule and choose <em>Save as layout</em>.</p><div class="btn-row end"><button type="button" class="btn" data-close>Close</button><a class="btn primary" href="#layouts" data-close>Open Layouts</a></div>`);
    return;
  }
  const days = weekDates(weekStart);
  const initial = preset === 'weekend' ? [0, 1] : preset === 'weekdays' ? [2, 3, 4, 5, 6] : preset === 'all' ? [0, 1, 2, 3, 4, 5, 6] : preset ? [days.indexOf(preset)] : [0, 1];
  modal(
    html`<div class="dlg-head">${icon('layouts', 20)}<div><h2 class="h2">Load a staffing layout</h2><p class="muted small">Sets which stands are open and how many guards each uses. Guard names are never part of a layout.</p></div></div>
      <fieldset class="fs"><legend class="eyebrow">Layout</legend>
        <div class="layout-pick">${layouts.map(
          (l, i) => html`<label class="opt"><input type="radio" name="al-l" value="${l.id}" ${(layoutId ? l.id === layoutId : i === 0) ? raw('checked') : ''}><span><strong>${l.name}</strong><span class="muted small">${summaryLine(l.items)}</span><span class="muted small">Saved by ${l.updatedBy || l.createdBy} · ${fmtWhen(l.updatedAt || l.createdAt)}</span></span></label>`,
        )}</div>
      </fieldset>
      <fieldset class="fs"><legend class="eyebrow">Days</legend>
        <div class="chips-row">
          <button type="button" class="fchip" data-pick="0,1">Weekend</button>
          <button type="button" class="fchip" data-pick="2,3,4,5,6">Weekdays</button>
          <button type="button" class="fchip" data-pick="0,1,2,3,4,5,6">Whole week</button>
        </div>
        <div class="chips-row">${WEEKDAYS.map((w, i) => html`<label class="toggle-chip"><input type="checkbox" name="al-d" value="${i}" ${initial.includes(i) ? raw('checked') : ''}><span>${DAY_SHORT[w]} ${shortDate(days[i])}</span></label>`)}</div>
        <label class="check"><input type="checkbox" id="al-repeat"> Repeat on these days every week through</label>
        <input type="date" id="al-until" class="input" value="${addDays(weekStart, 7 * 8 + 6)}" aria-label="Repeat through date" style="max-width:220px">
      </fieldset>
      <div id="al-preview" class="al-preview"></div>
      <div class="btn-row end"><button type="button" class="btn" data-close>Cancel</button><button type="button" class="btn primary" id="al-go">Load layout</button></div>`,
    (root, close) => {
      const chosen = () => {
        const id = Number(($('input[name="al-l"]:checked', root) as HTMLInputElement).value);
        const wd = $$<HTMLInputElement>('input[name="al-d"]:checked', root).map((c) => Number(c.value));
        const repeat = ($('#al-repeat', root) as HTMLInputElement).checked;
        const until = ($('#al-until', root) as HTMLInputElement).value;
        const dates = repeat && until ? datesFor(weekStart, until, wd) : wd.map((i) => days[i]);
        return { layout: state.layouts.get(id)!, dates };
      };
      const preview = () => {
        const { layout, dates } = chosen();
        const btn = $('#al-go', root) as HTMLButtonElement;
        if (!dates.length) {
          $('#al-preview', root)!.innerHTML = html`<p class="muted small">Pick at least one day.</p>`.value;
          btn.disabled = true;
          return;
        }
        const plan = planLayout(layout.items, dates);
        const locked = plan.removed.filter((r) => r.locked).length;
        $('#al-preview', root)!.innerHTML = html`<p><strong>${dates.length} ${dates.length === 1 ? 'day' : 'days'}</strong> · ${dates.length <= 7 ? dates.map((d) => `${DAY_SHORT[WEEKDAYS[weekDates(weekStartOfLocal(d)).indexOf(d)]]} ${shortDate(d)}`).join(', ') : `${shortDate(dates[0])} to ${shortDate(dates[dates.length - 1])}`}</p>
          ${plan.removed.length
            ? html`<p class="warnbox">${icon('alert', 14)} <span>${plan.removed.length} assigned ${plan.removed.length === 1 ? 'guard is' : 'guards are'} on a stand this layout closes or cuts, and will be unassigned${locked ? html` (<strong>${locked} locked</strong>)` : ''}: ${plan.removed.slice(0, 6).map((r) => `${r.lgNumber} (${r.where}, ${shortDate(r.date)})`).join(', ')}${plan.removed.length > 6 ? '…' : ''}</span></p>`
            : html`<p class="muted small">No assigned guards are affected.</p>`}
          <p class="muted small">Closed stands and unused slots are skipped by Auto-Fill. Other days keep their own setup.</p>`.value;
        btn.disabled = false;
        btn.textContent = `Load onto ${dates.length} ${dates.length === 1 ? 'day' : 'days'}`;
      };
      $$('[data-pick]', root).forEach(
        (b) =>
          (b.onclick = () => {
            const want = b.dataset.pick!.split(',');
            $$<HTMLInputElement>('input[name="al-d"]', root).forEach((c) => (c.checked = want.includes(c.value)));
            preview();
          }),
      );
      $$('input', root).forEach((el) => el.addEventListener('change', preview));
      preview();
      ($('#al-go', root) as HTMLButtonElement).onclick = async () => {
        const { layout, dates } = chosen();
        close();
        try {
          const removed = await applyLayout(layout.name, layout.items, dates);
          toast(`Loaded “${layout.name}” onto ${dates.length} ${dates.length === 1 ? 'day' : 'days'}${removed ? `, unassigned ${removed}` : ''}.`);
        } catch (e) {
          toast(e instanceof StoreError ? e.message : 'Could not load the layout.', 'error');
        }
      };
    },
    true,
  );
}

function weekStartOfLocal(d: string): string {
  const idx = (new Date(`${d}T00:00:00Z`).getUTCDay() + 1) % 7;
  return addDays(d, -idx);
}

// ---------- one day's stands ----------

export function openDayStaffing(weekStart: string, date: string): void {
  const day = DAY_LONG[WEEKDAYS[weekDates(weekStart).indexOf(date)]];
  let items = layoutFromDay(date);
  modal(
    html`<div class="dlg-head">${icon('layouts', 20)}<div><h2 class="h2">Stands on ${day}, ${shortDate(date)}</h2><p class="muted small">Close stands or use fewer guards for this day only. Closed stands are skipped by Auto-Fill.</p></div></div>
      <div class="chips-row"><button type="button" class="btn small" id="ds-load">Load a saved layout…</button><button type="button" class="btn small" id="ds-base">Reset to standard setup</button></div>
      <div id="ds-editor" class="st-editor"></div>
      <div id="ds-warn"></div>
      <div class="btn-row end"><button type="button" class="btn ghost" id="ds-save">Save as layout…</button><span class="spacer"></span><button type="button" class="btn" data-close>Cancel</button><button type="button" class="btn primary" id="ds-go">Apply to ${DAY_SHORT[WEEKDAYS[weekDates(weekStart).indexOf(date)]]} ${shortDate(date)}</button></div>`,
    (root, close) => {
      const warn = () => {
        const plan = planLayout(items, [date]);
        $('#ds-warn', root)!.innerHTML = plan.removed.length
          ? html`<p class="warnbox">${icon('alert', 14)} <span>Applying unassigns ${plan.removed.map((r) => `${r.lgNumber} (${r.where})`).join(', ')}.</span></p>`.value
          : '';
      };
      let ed = mountEditor($('#ds-editor', root)!, items, (next) => ((items = next), warn()));
      warn();
      ($('#ds-base', root) as HTMLButtonElement).onclick = () => {
        items = layoutFromBase();
        ed = mountEditor($('#ds-editor', root)!, items, (next) => ((items = next), warn()));
        warn();
      };
      ($('#ds-load', root) as HTMLButtonElement).onclick = () => {
        close();
        openApplyLayout(weekStart, undefined, date);
      };
      ($('#ds-save', root) as HTMLButtonElement).onclick = () => {
        close();
        saveLayoutDialog(ed.get(), `${day} ${shortDate(date)}`);
      };
      ($('#ds-go', root) as HTMLButtonElement).onclick = async () => {
        close();
        try {
          const removed = await applyLayout(`custom (${day})`, ed.get(), [date]);
          toast(`${day} updated${removed ? `, unassigned ${removed}` : ''}.`);
        } catch (e) {
          toast(e instanceof StoreError ? e.message : 'Could not save.', 'error');
        }
      };
    },
    true,
  );
}

function saveLayoutDialog(items: LayoutItems, hint = '') {
  modal(
    html`<h2 class="h2">Save as a staffing layout</h2><p class="muted">${summaryLine(items)}</p>
      <label class="field"><span>Name</span><input id="sl-name" class="input" maxlength="60" placeholder="e.g. Summer weekend, Short-staffed weekday" autofocus></label>
      <label class="field"><span>Note (optional)</span><input id="sl-desc" class="input" maxlength="200" placeholder="${hint ? `Based on ${hint}` : ''}"></label>
      <p class="muted small">Shared with every admin. It saves which stands are open and how many guards each uses, never who is assigned.</p>
      <p class="error" id="sl-err" hidden></p>
      <div class="btn-row end"><button type="button" class="btn" data-close>Cancel</button><button type="button" class="btn primary" id="sl-go">Save layout</button></div>`,
    (root, close) => {
      ($('#sl-go', root) as HTMLButtonElement).onclick = async () => {
        const name = ($('#sl-name', root) as HTMLInputElement).value.trim();
        const err = $('#sl-err', root)!;
        if (!name) return ((err.textContent = 'Give the layout a name.'), (err.hidden = false));
        if (sortedLayouts().some((l) => l.name.toLowerCase() === name.toLowerCase())) return ((err.textContent = 'A layout with that name already exists.'), (err.hidden = false));
        close();
        try {
          const l = await saveNewLayout(name, ($('#sl-desc', root) as HTMLInputElement).value.trim(), items);
          local.selected = l.id;
          local.draft = null;
          toast(`Saved layout “${name}”. Load it from the schedule with Layouts.`);
        } catch (e) {
          toast(e instanceof StoreError ? e.message : 'Could not save.', 'error');
        }
      };
    },
  );
}

// ---------- Layouts page ----------

const local = { selected: null as number | null, draft: null as null | { id: number; name: string; description: string; items: LayoutItems } };

export const layoutsView = {
  render(): Raw {
    const list = sortedLayouts();
    if (local.selected == null || !state.layouts.has(local.selected)) local.selected = list[0]?.id ?? null;
    const l = local.selected != null ? state.layouts.get(local.selected) : undefined;
    if (l && local.draft?.id !== l.id) local.draft = { id: l.id, name: l.name, description: l.description, items: clone(l.items) };
    return html`<div class="master">
      <aside class="list-pane" aria-label="Saved layouts">
        <div class="pane-head"><h1 class="h1">Staffing layouts</h1></div>
        <div class="btn-row"><button type="button" class="btn primary small" id="ly-new">${icon('plus', 14)} New from standard setup</button><button type="button" class="btn small" id="ly-from-day">From a day…</button></div>
        <div class="plist">${list.map(
          (x) => html`<button type="button" class="preitem${x.id === local.selected ? ' on' : ''}" data-lid="${x.id}"><strong>${x.name}</strong><span class="small">${summaryLine(x.items)}</span><span class="muted small">by ${x.updatedBy || x.createdBy} · ${fmtWhen(x.updatedAt || x.createdAt)}</span></button>`,
        )}</div>
        ${list.length ? '' : html`<p class="muted small pad">No layouts yet. Start from the standard setup, or from a day you have already adjusted.</p>`}
        <p class="info small">Layouts are shared by all admins. They hold open/closed and guards per stand, never names.</p>
      </aside>
      ${l && local.draft
        ? html`<section class="detail" aria-label="Layout editor">
            <div class="profile-head">
              <label class="field grow1"><span class="eyebrow">Layout name</span><input id="ly-name" class="input big" value="${local.draft.name}" maxlength="60"></label>
              <button type="button" class="btn accent" id="ly-apply">${icon('layouts', 15)} Load onto days…</button>
              <button type="button" class="btn primary" id="ly-save">Save changes</button>
            </div>
            <label class="field"><span>Note</span><input id="ly-desc" class="input" value="${local.draft.description}" maxlength="200" placeholder="When to use it"></label>
            <p class="muted small">Saved by ${l.createdBy} on ${fmtWhen(l.createdAt)}${l.updatedAt !== l.createdAt ? ` · last changed by ${l.updatedBy} on ${fmtWhen(l.updatedAt)}` : ''}. Changing a layout doesn't change days it was already loaded onto.</p>
            <section class="card"><div id="ly-editor" class="st-editor"></div></section>
            <div class="danger-row"><button type="button" class="btn small" id="ly-dup">Duplicate</button><button type="button" class="btn small ghost danger" id="ly-del">${icon('trash', 13)} Delete layout</button></div>
          </section>`
        : html`<section class="detail"><div class="empty-state"><p>Save a layout for each situation you staff for: a summer weekend, a quiet weekday, a short-staffed day.</p><button type="button" class="btn primary" id="ly-new2">Create the first layout</button></div></section>`}
    </div>`;
  },
  bind(root: HTMLElement): void {
    const startNew = (items: LayoutItems, hint: string) => saveLayoutDialog(items, hint);
    $('#ly-new', root)!.onclick = () => startNew(layoutFromBase(), 'the standard setup');
    const n2 = $('#ly-new2', root);
    if (n2) n2.onclick = () => startNew(layoutFromBase(), 'the standard setup');
    $('#ly-from-day', root)!.onclick = () =>
      modal(
        html`<h2 class="h2">Start from a day</h2><p class="muted">Copies that day's open/closed stands and guard counts.</p><label class="field"><span>Day</span><input type="date" id="fd-date" class="input" value="${ui.weekStart}"></label><div class="btn-row end"><button type="button" class="btn" data-close>Cancel</button><button type="button" class="btn primary" id="fd-go">Continue</button></div>`,
        (r, close) => {
          ($('#fd-go', r) as HTMLButtonElement).onclick = () => {
            const d = ($('#fd-date', r) as HTMLInputElement).value;
            if (!d) return;
            close();
            startNew(layoutFromDay(d), shortDate(d));
          };
        },
      );
    $$('[data-lid]', root).forEach((b) => (b.onclick = () => ((local.selected = Number(b.dataset.lid)), (local.draft = null), rerender(true))));
    const l = local.selected != null ? state.layouts.get(local.selected) : undefined;
    if (!l || !local.draft) return;
    const draft = local.draft;
    mountEditor($('#ly-editor', root)!, draft.items, (items) => (draft.items = items));
    ($('#ly-name', root) as HTMLInputElement).oninput = (e) => (draft.name = (e.target as HTMLInputElement).value);
    ($('#ly-desc', root) as HTMLInputElement).oninput = (e) => (draft.description = (e.target as HTMLInputElement).value);
    $('#ly-save', root)!.onclick = async () => {
      const name = draft.name.trim();
      if (!name) return toast('Give the layout a name.', 'warn');
      if (sortedLayouts().some((x) => x.id !== l.id && x.name.toLowerCase() === name.toLowerCase())) return toast('Another layout already has that name.', 'warn');
      try {
        await saveLayout({ ...l, name, description: draft.description.trim(), items: draft.items, updatedBy: me(), updatedAt: new Date().toISOString() });
        audit(me(), 'Changed staffing layout', name);
        toast(`Saved “${name}”.`);
      } catch (e) {
        toast(e instanceof StoreError ? e.message : 'Could not save.', 'error');
      }
    };
    $('#ly-apply', root)!.onclick = () => openApplyLayout(ui.weekStart, l.id);
    $('#ly-dup', root)!.onclick = () => saveLayoutDialog(draft.items, l.name);
    $('#ly-del', root)!.onclick = () =>
      modal(html`<h2 class="h2">Delete “${l.name}”?</h2><p>Days it was already loaded onto keep their setup.</p><div class="btn-row end"><button type="button" class="btn" data-close>Cancel</button><button type="button" class="btn danger" id="ld-go">Delete</button></div>`, (r, close) => {
        ($('#ld-go', r) as HTMLButtonElement).onclick = async () => {
          close();
          try {
            await deleteLayout(l.id);
            audit(me(), 'Deleted staffing layout', l.name);
            local.selected = null;
            local.draft = null;
            toast('Layout deleted.');
          } catch (e) {
            toast(e instanceof StoreError ? e.message : 'Could not delete.', 'error');
          }
        };
      });
  },
};

export type { Layout };
