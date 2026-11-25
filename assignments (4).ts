// Assignment directory and per-assignment configuration with modular staffing slots.

import { describe, evaluate, type Rule } from '../../../src/domain/criteria.ts';
import type { AssignmentKind } from '../../../src/domain/scheduling.ts';
import { rerender } from '../app-state.ts';
import { me, personnelCtx, resolvedSlots, sortedAssignments } from '../model.ts';
import { audit, deleteAssignment, saveAssignment, savePreset, state, StoreError, type AssignmentDef, type SlotDef } from '../store.ts';
import { $, $$, html, icon, modal, newId, raw, toast, type Raw } from '../util.ts';
import { mountRuleBuilder } from './rule-builder.ts';

const GROUPS: { kind: AssignmentKind; label: string }[] = [
  { kind: 'stand', label: 'Stands' },
  { kind: 'medical', label: 'Medical units' },
  { kind: 'pwc', label: 'PWC units' },
  { kind: 'boat', label: 'Boats' },
  { kind: 'extra', label: 'Extras · renameable' },
];
const local = { selected: null as number | null };

async function save(a: AssignmentDef, msg?: string) {
  try {
    await saveAssignment(a);
    if (msg) toast(msg);
  } catch (e) {
    toast(e instanceof StoreError ? e.message : 'Could not save.', 'error');
  }
}

const clone = (a: AssignmentDef): AssignmentDef => JSON.parse(JSON.stringify(a));

function directory(): Raw {
  const all = sortedAssignments();
  return html`<aside class="list-pane" aria-label="Assignment directory">
    <div class="pane-head"><h1 class="h1">Assignments</h1><button type="button" class="btn primary small" id="add-asg">${icon('plus', 14)} Add</button></div>
    <p class="muted small">${all.length} total · ${all.filter((a) => a.active).length} active</p>
    <div class="plist" data-keep-scroll="alist">${GROUPS.map((g) => {
      const items = all.filter((a) => a.kind === g.kind);
      if (!items.length) return '';
      return html`<div class="grp">${g.label}</div>${items.map(
        (a) => html`<button type="button" class="aitem${a.id === local.selected ? ' on' : ''}${a.active ? '' : ' inactive'}" data-aid="${a.id}"><span class="ind${a.active ? '' : ' no'}" aria-hidden="true"></span><span class="grow1">${a.displayName}</span><span class="mono small muted">${a.slots.length}</span></button>`,
      )}`;
    })}</div>
  </aside>`;
}

function detail(a: AssignmentDef): Raw {
  const presets = [...state.presets.values()].sort((x, y) => x.name.localeCompare(y.name));
  const def = a.defaultPresetId != null ? state.presets.get(a.defaultPresetId) : undefined;
  const resolved = resolvedSlots().slots;
  const people = [...personnelCtx().values()].filter((p) => p.active);
  return html`<section class="detail" aria-label="${a.displayName} settings">
    <div class="profile-head">
      <div class="grow1"><div class="eyebrow">${GROUPS.find((g) => g.kind === a.kind)?.label.replace(' · renameable', '')}</div><h2 class="h1">${a.displayName}</h2></div>
      <label class="switch"><input type="checkbox" id="a-active" ${a.active ? raw('checked') : ''}><span class="track" aria-hidden="true"></span>Active (shows on the schedule)</label>
    </div>
    <section class="card form-grid">
      <label class="field"><span>Display name</span><input id="a-name" class="input" value="${a.displayName}" maxlength="60"></label>
      <label class="field"><span>Default criteria for its slots</span><select id="a-def" class="input"><option value="">No requirement</option>${presets.map((p) => html`<option value="${p.id}" ${p.id === a.defaultPresetId ? raw('selected') : ''}>${p.name}</option>`)}</select></label>
      <label class="field"><span>Default status on the schedule</span><select id="a-open" class="input"><option value="1" ${a.openByDefault ? raw('selected') : ''}>Open every day</option><option value="0" ${a.openByDefault ? '' : raw('selected')}>Closed every day</option></select></label>
      <div class="field"><span>Shift times (optional, for overlap checks)</span><div class="row2 fixed"><input id="a-start" type="time" class="input" value="${a.startTime ?? ''}" aria-label="Start time"><input id="a-end" type="time" class="input" value="${a.endTime ?? ''}" aria-label="End time"></div></div>
    </section>
    <section class="card flush">
      <div class="card-head pad"><h3 class="h3">Staffing slots</h3><span class="count mono">${a.slots.length}</span><span class="muted small grow1">Each slot can use the default${def ? ` (${def.name})` : ''}, a saved preset, or its own rule.</span>
        <select id="a-apply" class="input small" aria-label="Apply a preset to every slot"><option value="">Apply to all slots…</option><option value="default">Use the default</option>${presets.map((p) => html`<option value="${p.id}">${p.name}</option>`)}</select></div>
      <div class="table-wrap"><table class="tbl slots-tbl">
        <thead><tr><th scope="col"><span class="sr">Order</span></th><th scope="col">#</th><th scope="col">Slot name</th><th scope="col">Criteria</th><th scope="col">Qualified</th><th scope="col"><span class="sr">Actions</span></th></tr></thead>
        <tbody>${a.slots.map((s, i) => {
          const r = resolved.get(s.id);
          const q = r ? people.filter((p) => evaluate(r.rule, p.certs)).length : 0;
          const tag = s.mode === 'default' ? html`<span class="tag def">Default</span>` : s.mode === 'preset' ? html`<span class="tag ovr">Override</span>` : html`<span class="tag cus">Custom</span>`;
          return html`<tr>
            <td class="nowrap"><button type="button" class="icon-btn" data-up="${i}" aria-label="Move ${s.name} up" ${i === 0 ? raw('disabled') : ''}>${icon('up', 14)}</button><button type="button" class="icon-btn" data-down="${i}" aria-label="Move ${s.name} down" ${i === a.slots.length - 1 ? raw('disabled') : ''}>${icon('down', 14)}</button></td>
            <td class="mono muted">${i + 1}</td>
            <td><input class="input" data-sname="${i}" value="${s.name}" maxlength="40" aria-label="Slot ${i + 1} name"></td>
            <td><div class="crit-cell"><select class="input" data-scrit="${i}" aria-label="Criteria for ${s.name}">
                <option value="default" ${s.mode === 'default' ? raw('selected') : ''}>Default${def ? ` · ${def.name}` : ' · none'}</option>
                ${presets.map((p) => html`<option value="p${p.id}" ${s.mode === 'preset' && s.presetId === p.id ? raw('selected') : ''}>${p.name}</option>`)}
                <option value="custom" ${s.mode === 'custom' ? raw('selected') : ''}>Custom rule for this slot…</option>
              </select>${tag}</div><div class="muted small">${r?.ruleText ?? ''}</div></td>
            <td class="mono">${q}<span class="muted"> of ${people.length}</span></td>
            <td class="nowrap">
              ${s.mode === 'custom' ? html`<button type="button" class="btn tiny" data-edit="${i}">Edit rule</button><button type="button" class="btn tiny" data-savepreset="${i}">Save as preset</button>` : ''}
              <button type="button" class="icon-btn" data-remove="${i}" aria-label="Remove ${s.name}">${icon('trash', 14)}</button>
            </td></tr>`;
        })}</tbody></table></div>
      <div class="card-foot pad"><button type="button" class="btn small dashed" id="add-slot">${icon('plus', 13)} Add slot</button><span class="muted small">New slots use the default criteria.</span></div>
    </section>
    <p class="info small">${icon('check', 13)} <span><strong>Override</strong> = this slot uses a different saved preset. <strong>Custom</strong> = a one-off rule only this slot uses. Editing a preset updates every slot that uses it; custom rules are left alone.</span></p>
    <div class="danger-row"><button type="button" class="btn small ghost danger" id="a-del">${icon('trash', 13)} Delete ${a.displayName}</button><span class="muted small">Or turn off Active to hide it from the schedule.</span></div>
  </section>`;
}

export const assignmentsView = {
  render(): Raw {
    if (local.selected == null || !state.assignments.has(local.selected)) local.selected = sortedAssignments()[0]?.id ?? null;
    const a = local.selected != null ? state.assignments.get(local.selected) : undefined;
    return html`<div class="master">${directory()}${a ? detail(a) : html`<section class="detail"><div class="empty-state"><p>No assignments yet.</p></div></section>`}</div>`;
  },
  bind(root: HTMLElement): void {
    $$('[data-aid]', root).forEach((b) => (b.onclick = () => ((local.selected = Number(b.dataset.aid)), rerender(true))));
    $('#add-asg', root)!.onclick = addAssignment;
    const cur = local.selected != null ? state.assignments.get(local.selected) : undefined;
    if (!cur) return;
    const edit = (fn: (a: AssignmentDef) => void, msg?: string) => {
      const a = clone(state.assignments.get(cur.id)!);
      fn(a);
      save(a, msg);
    };
    ($('#a-active', root) as HTMLInputElement).onchange = (e) => {
      const on = (e.target as HTMLInputElement).checked;
      edit((a) => (a.active = on), on ? `${cur.displayName} is active.` : `${cur.displayName} hidden from the schedule.`);
      audit(me(), on ? 'Activated assignment' : 'Deactivated assignment', cur.displayName);
    };
    ($('#a-name', root) as HTMLInputElement).onchange = (e) => {
      const v = (e.target as HTMLInputElement).value.trim();
      if (!v) return;
      edit((a) => (a.displayName = v), 'Renamed.');
      audit(me(), 'Renamed assignment', `${cur.displayName} → ${v}`);
    };
    ($('#a-def', root) as HTMLSelectElement).onchange = (e) => edit((a) => (a.defaultPresetId = (e.target as HTMLSelectElement).value ? Number((e.target as HTMLSelectElement).value) : null), 'Default criteria saved.');
    ($('#a-open', root) as HTMLSelectElement).onchange = (e) => edit((a) => (a.openByDefault = (e.target as HTMLSelectElement).value === '1'), 'Saved.');
    ($('#a-start', root) as HTMLInputElement).onchange = (e) => edit((a) => (a.startTime = (e.target as HTMLInputElement).value || null), 'Shift time saved.');
    ($('#a-end', root) as HTMLInputElement).onchange = (e) => edit((a) => (a.endTime = (e.target as HTMLInputElement).value || null), 'Shift time saved.');
    ($('#a-apply', root) as HTMLSelectElement).onchange = (e) => {
      const v = (e.target as HTMLSelectElement).value;
      if (!v) return;
      edit((a) => (a.slots = a.slots.map((s) => (v === 'default' ? { ...s, mode: 'default', presetId: null, rule: null } : { ...s, mode: 'preset', presetId: Number(v), rule: null }))), 'Applied to every slot.');
    };
    $$('[data-up]', root).forEach((b) => (b.onclick = () => edit((a) => move(a.slots, Number(b.dataset.up), -1))));
    $$('[data-down]', root).forEach((b) => (b.onclick = () => edit((a) => move(a.slots, Number(b.dataset.down), 1))));
    $$<HTMLInputElement>('[data-sname]', root).forEach(
      (inp) =>
        (inp.onchange = () => {
          const v = inp.value.trim();
          if (v) edit((a) => (a.slots[Number(inp.dataset.sname)].name = v), 'Slot renamed.');
        }),
    );
    $$<HTMLSelectElement>('[data-scrit]', root).forEach(
      (sel) =>
        (sel.onchange = () => {
          const i = Number(sel.dataset.scrit);
          const v = sel.value;
          if (v === 'custom') return editRule(cur.id, i);
          edit((a) => (a.slots[i] = { ...a.slots[i], mode: v === 'default' ? 'default' : 'preset', presetId: v === 'default' ? null : Number(v.slice(1)), rule: null }), 'Slot criteria saved.');
        }),
    );
    $$('[data-edit]', root).forEach((b) => (b.onclick = () => editRule(cur.id, Number(b.dataset.edit))));
    $$('[data-savepreset]', root).forEach((b) => (b.onclick = () => saveAsPreset(cur.id, Number(b.dataset.savepreset))));
    $$('[data-remove]', root).forEach(
      (b) =>
        (b.onclick = () => {
          const i = Number(b.dataset.remove);
          edit((a) => a.slots.splice(i, 1), `${cur.slots[i].name} removed.`);
          audit(me(), 'Removed slot', `${cur.displayName} · ${cur.slots[i].name}`);
        }),
    );
    $('#add-slot', root)!.onclick = () => {
      edit((a) => a.slots.push({ id: newId(), name: `Slot ${a.slots.length + 1}`, mode: 'default', presetId: null, rule: null }), 'Slot added.');
      audit(me(), 'Added slot', cur.displayName);
    };
    $('#a-del', root)!.onclick = () =>
      modal(html`<h2 class="h2">Delete ${cur.displayName}?</h2><p>Its slots and any assignments to them disappear from every week. To keep history, turn off Active instead.</p><div class="btn-row end"><button type="button" class="btn" data-close>Cancel</button><button type="button" class="btn danger" id="ad-go">Delete</button></div>`, (r, close) => {
        ($('#ad-go', r) as HTMLButtonElement).onclick = async () => {
          close();
          try {
            await deleteAssignment(cur.id);
            audit(me(), 'Deleted assignment', cur.displayName);
            local.selected = null;
            toast(`${cur.displayName} deleted.`);
          } catch (e) {
            toast(e instanceof StoreError ? e.message : 'Could not delete.', 'error');
          }
        };
      });
  },
};

function move(list: SlotDef[], i: number, d: number) {
  const j = i + d;
  if (j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j], list[i]];
}

function editRule(aid: number, i: number) {
  const a = state.assignments.get(aid)!;
  const slot = a.slots[i];
  const start = slot.mode === 'custom' ? slot.rule : resolvedSlots().slots.get(slot.id)?.rule ?? null;
  let rule: Rule = start ?? { all: [] };
  modal(
    html`<h2 class="h2">Custom rule · ${a.displayName} · ${slot.name}</h2><p class="muted small">Only this slot uses it. Other slots keep their criteria.</p><div id="rb"></div><p class="muted small" id="rb-count"></p>
      <div class="btn-row end"><button type="button" class="btn" data-close>Cancel</button><button type="button" class="btn primary" id="rb-save">Save rule</button></div>`,
    (root, close) => {
      const people = [...personnelCtx().values()].filter((p) => p.active);
      const count = () => ($('#rb-count', root)!.textContent = `${people.filter((p) => evaluate(rule, p.certs)).length} of ${people.length} active lifeguards qualify.`);
      mountRuleBuilder($('#rb', root)!, start, (r) => ((rule = r), count()));
      count();
      ($('#rb-save', root) as HTMLButtonElement).onclick = () => {
        close();
        const next = clone(state.assignments.get(aid)!);
        next.slots[i] = { ...next.slots[i], mode: 'custom', presetId: null, rule };
        save(next, `Custom rule saved: ${describe(rule)}.`);
        audit(me(), 'Set custom slot rule', `${a.displayName} · ${slot.name}: ${describe(rule)}`);
      };
    },
    true,
  );
}

function saveAsPreset(aid: number, i: number) {
  const a = state.assignments.get(aid)!;
  const slot = a.slots[i];
  if (!slot.rule) return;
  modal(
    html`<h2 class="h2">Save as a reusable preset</h2><p class="muted">${describe(slot.rule)}</p><label class="field"><span>Preset name</span><input id="sp-name" class="input" maxlength="80" autofocus></label><p class="error" id="sp-err" hidden></p>
      <div class="btn-row end"><button type="button" class="btn" data-close>Cancel</button><button type="button" class="btn primary" id="sp-go">Save preset</button></div>`,
    (root, close) => {
      ($('#sp-go', root) as HTMLButtonElement).onclick = async () => {
        const name = ($('#sp-name', root) as HTMLInputElement).value.trim();
        const err = $('#sp-err', root)!;
        if (!name) return ((err.textContent = 'Enter a name.'), (err.hidden = false));
        if ([...state.presets.values()].some((p) => p.name.toLowerCase() === name.toLowerCase())) return ((err.textContent = 'A preset with that name already exists.'), (err.hidden = false));
        close();
        const id = newId();
        try {
          await savePreset({ id, name, rule: slot.rule!, description: '' });
          const next = clone(state.assignments.get(aid)!);
          next.slots[i] = { ...next.slots[i], mode: 'preset', presetId: id, rule: null };
          await saveAssignment(next);
          toast(`Saved “${name}” and applied it to ${slot.name}.`);
          audit(me(), 'Saved preset from slot', name);
        } catch (e) {
          toast(e instanceof StoreError ? e.message : 'Could not save.', 'error');
        }
      };
    },
  );
}

function addAssignment() {
  modal(
    html`<h2 class="h2">Add assignment</h2>
      <div class="row2 fixed"><label class="field"><span>Type</span><select id="na-kind" class="input">${GROUPS.map((g) => html`<option value="${g.kind}">${g.label.replace(' · renameable', '')}</option>`)}</select></label>
      <label class="field"><span>Slots</span><input id="na-slots" class="input" type="number" min="1" max="30" value="2"></label></div>
      <label class="field"><span>Display name</span><input id="na-name" class="input" maxlength="60" autofocus></label><p class="error" id="na-err" hidden></p>
      <div class="btn-row end"><button type="button" class="btn" data-close>Cancel</button><button type="button" class="btn primary" id="na-go">Add</button></div>`,
    (root, close) => {
      ($('#na-go', root) as HTMLButtonElement).onclick = async () => {
        const name = ($('#na-name', root) as HTMLInputElement).value.trim();
        const n = Math.min(30, Math.max(1, Number(($('#na-slots', root) as HTMLInputElement).value) || 1));
        if (!name) return (($('#na-err', root)!.textContent = 'Enter a name.'), ($('#na-err', root)!.hidden = false));
        close();
        const order = Math.max(0, ...[...state.assignments.values()].map((a) => a.sortOrder)) + 10;
        const a: AssignmentDef = {
          id: newId(),
          code: name.toUpperCase().replace(/[^A-Z0-9]+/g, '-'),
          kind: ($('#na-kind', root) as HTMLSelectElement).value as AssignmentKind,
          displayName: name,
          active: true,
          sortOrder: order,
          defaultPresetId: [...state.presets.values()].find((p) => p.name === 'Basic Qualified')?.id ?? null,
          openByDefault: true,
          startTime: null,
          endTime: null,
          slots: Array.from({ length: n }, (_, i) => ({ id: newId(), name: `Slot ${i + 1}`, mode: 'default' as const, presetId: null, rule: null })),
        };
        await save(a, `${name} added.`);
        audit(me(), 'Added assignment', name);
        local.selected = a.id;
        rerender(true);
      };
    },
  );
}
