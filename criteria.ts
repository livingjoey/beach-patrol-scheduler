// Saved criteria presets, certification list and equivalency rules.

import { describe, evaluate, type Rule } from '../../../src/domain/criteria.ts';
import { rerender } from '../app-state.ts';
import { me, personnelCtx, sortedAssignments } from '../model.ts';
import { audit, deletePreset, saveAssignment, saveCerts, savePreset, state, StoreError, type Preset } from '../store.ts';
import { $, $$, html, icon, modal, newId, raw, toast, type Raw } from '../util.ts';
import { mountRuleBuilder } from './rule-builder.ts';

const local = { selected: null as number | null, draft: null as null | { id: number; name: string; rule: Rule } };

function usage(id: number): string[] {
  const out: string[] = [];
  for (const a of sortedAssignments())
    a.slots.forEach((s) => {
      if (s.mode === 'preset' && s.presetId === id) out.push(`${a.displayName} · ${s.name} (override)`);
      else if (s.mode === 'default' && a.defaultPresetId === id) out.push(`${a.displayName} · ${s.name}`);
    });
  return out;
}

async function run(fn: () => Promise<unknown>, ok?: string) {
  try {
    await fn();
    if (ok) toast(ok);
  } catch (e) {
    toast(e instanceof StoreError ? e.message : 'Could not save.', 'error');
  }
}

function editor(p: Preset): Raw {
  const d = local.draft?.id === p.id ? local.draft : { id: p.id, name: p.name, rule: p.rule };
  local.draft = d;
  const people = [...personnelCtx().values()].filter((x) => x.active);
  const who = people.filter((x) => evaluate(d.rule, x.certs));
  const used = usage(p.id);
  const dirty = d.name !== p.name || JSON.stringify(d.rule) !== JSON.stringify(p.rule);
  return html`<section class="detail" aria-label="Preset editor">
    <div class="profile-head">
      <label class="field grow1"><span class="eyebrow">Preset name</span><input id="c-name" class="input big" value="${d.name}" maxlength="80"></label>
      <button type="button" class="btn" id="c-dup">Duplicate</button>
      <button type="button" class="btn primary" id="c-save" ${dirty ? '' : raw('disabled')}>${dirty ? 'Save preset' : 'Saved'}</button>
    </div>
    <div class="cards2 wide-left">
      <section class="card"><h3 class="h3">A lifeguard qualifies when they have</h3><div id="c-rb"></div></section>
      <div class="stack">
        <section class="card"><div class="card-head"><h3 class="h3">Who qualifies now</h3><span><strong class="mono big-num">${who.length}</strong> <span class="muted small">of ${people.length} active</span></span></div>
          <div class="lg-wrap">${who.slice(0, 60).map((x) => html`<span class="chip lc-${x.labelColor}">${x.lgNumber}</span>`)}${who.length > 60 ? html`<span class="muted small">+${who.length - 60} more</span>` : ''}</div>
          <p class="muted small">Updates as you edit the rule.</p></section>
        <section class="card"><h3 class="h3">Used by ${used.length} slot${used.length === 1 ? '' : 's'}</h3>
          ${used.length ? html`<ul class="plain">${used.slice(0, 20).map((u) => html`<li><a href="#assignments">${u}</a></li>`)}${used.length > 20 ? html`<li class="muted small">…and ${used.length - 20} more</li>` : ''}</ul>` : html`<p class="muted small">Not used yet. Pick it in Assignment settings.</p>`}
          <p class="muted small">Saving changes these slots. Slots with a custom rule are not affected.</p></section>
      </div>
    </div>
    <div class="danger-row"><button type="button" class="btn small ghost danger" id="c-del">${icon('trash', 13)} Delete preset</button></div>
  </section>`;
}

function equivalencies(): Raw {
  const eqs = state.certs?.equivalencies ?? [];
  const certs = state.certs?.list ?? [];
  return html`<section class="card">
    <div class="card-head"><h3 class="h3">Certification equivalencies</h3><span class="muted small grow1">Off by default. No certification counts as another unless you add a rule here and switch it on. Applies everywhere.</span></div>
    ${eqs.map(
      (e, i) => html`<div class="eq-row"><span class="rb-cert solid">${e.holder}</span><span>also counts as</span><span class="rb-cert solid">${e.satisfies}</span><span class="grow1"></span>
        <label class="switch"><input type="checkbox" data-eq="${i}" ${e.enabled ? raw('checked') : ''}><span class="track" aria-hidden="true"></span>${e.enabled ? 'On' : 'Off'}</label>
        <button type="button" class="icon-btn" data-eq-del="${i}" aria-label="Remove rule">${icon('trash', 14)}</button></div>`,
    )}
    <div class="eq-add"><select id="eq-h" class="input small" aria-label="Holding">${certs.map((c) => html`<option value="${c.code}">${c.name}</option>`)}</select><span>also counts as</span><select id="eq-s" class="input small" aria-label="Counts as">${certs.map((c) => html`<option value="${c.code}">${c.name}</option>`)}</select><button type="button" class="btn small" id="eq-add">${icon('plus', 13)} Add rule</button></div>
  </section>
  <section class="card">
    <div class="card-head"><h3 class="h3">Certifications</h3><span class="muted small grow1">Shown as toggles on every personnel profile.</span></div>
    <div class="cert-row">${certs.map((c) => html`<span class="rb-cert solid">${c.name}</span>`)}</div>
    <div class="eq-add"><input id="nc-code" class="input small mono" placeholder="New code, e.g. CPR" maxlength="16" aria-label="New certification code"><button type="button" class="btn small" id="nc-add">${icon('plus', 13)} Add certification</button></div>
  </section>`;
}

export const criteriaView = {
  render(): Raw {
    const presets = [...state.presets.values()].sort((a, b) => a.name.localeCompare(b.name));
    if (local.selected == null || !state.presets.has(local.selected)) local.selected = presets[0]?.id ?? null;
    const p = local.selected != null ? state.presets.get(local.selected) : undefined;
    return html`<div class="master">
      <aside class="list-pane" aria-label="Saved presets">
        <div class="pane-head"><h1 class="h1">Criteria presets</h1><button type="button" class="btn primary small" id="c-new">${icon('plus', 14)} New</button></div>
        <div class="plist">${presets.map(
          (x) => html`<button type="button" class="preitem${x.id === local.selected ? ' on' : ''}" data-cid="${x.id}"><strong>${x.name}</strong><span class="small">${describe(x.rule)}</span><span class="muted small">${usage(x.id).length} slots</span></button>`,
        )}</div>
        <p class="info small">Preset names and rules are yours to define. The starting six are examples.</p>
      </aside>
      <div class="detail-col">${p ? editor(p) : html`<section class="detail"><div class="empty-state"><p>No presets yet.</p></div></section>`}<div class="detail pad-top">${equivalencies()}</div></div>
    </div>`;
  },
  bind(root: HTMLElement): void {
    $$('[data-cid]', root).forEach((b) => (b.onclick = () => ((local.selected = Number(b.dataset.cid)), (local.draft = null), rerender(true))));
    $('#c-new', root)!.onclick = () => {
      const p: Preset = { id: newId(), name: `New preset ${state.presets.size + 1}`, rule: { all: [{ cert: 'BASIC' }] }, description: '' };
      run(() => savePreset(p), 'Preset created.');
      local.selected = p.id;
      local.draft = null;
    };
    const p = local.selected != null ? state.presets.get(local.selected) : undefined;
    if (p && local.draft) {
      const btn = $('#c-save', root) as HTMLButtonElement;
      const refresh = () => {
        const dirty = local.draft!.name !== p.name || JSON.stringify(local.draft!.rule) !== JSON.stringify(p.rule);
        btn.disabled = !dirty;
        btn.textContent = dirty ? 'Save preset' : 'Saved';
      };
      mountRuleBuilder($('#c-rb', root)!, local.draft.rule, (rule) => {
        local.draft!.rule = rule;
        refresh();
        // update qualifying count without losing builder state
        const people = [...personnelCtx().values()].filter((x) => x.active);
        const n = people.filter((x) => evaluate(rule, x.certs));
        const num = $('.big-num', root);
        if (num) num.textContent = String(n.length);
        const wrap = $('.lg-wrap', root);
        if (wrap) wrap.innerHTML = html`${n.slice(0, 60).map((x) => html`<span class="chip lc-${x.labelColor}">${x.lgNumber}</span>`)}${n.length > 60 ? html`<span class="muted small">+${n.length - 60} more</span>` : ''}`.value;
      });
      ($('#c-name', root) as HTMLInputElement).oninput = (e) => ((local.draft!.name = (e.target as HTMLInputElement).value), refresh());
      btn.onclick = async () => {
        const name = local.draft!.name.trim();
        if (!name) return toast('Enter a preset name.', 'warn');
        if ([...state.presets.values()].some((x) => x.id !== p.id && x.name.toLowerCase() === name.toLowerCase())) return toast('Another preset already has that name.', 'warn');
        await run(() => savePreset({ ...p, name, rule: local.draft!.rule }), `Saved “${name}”.`);
        audit(me(), 'Saved preset', `${name}: ${describe(local.draft!.rule)}`);
        local.draft = null;
      };
      $('#c-dup', root)!.onclick = () => {
        const np: Preset = { id: newId(), name: `${p.name} (copy)`, rule: local.draft!.rule, description: '' };
        run(() => savePreset(np), 'Duplicated.');
        local.selected = np.id;
        local.draft = null;
      };
      $('#c-del', root)!.onclick = () => {
        const used = usage(p.id);
        modal(
          html`<h2 class="h2">Delete “${p.name}”?</h2><p>${used.length ? `${used.length} slots use it. They will fall back to their assignment default, or to no requirement.` : 'No slots use it.'}</p><div class="btn-row end"><button type="button" class="btn" data-close>Cancel</button><button type="button" class="btn danger" id="cd-go">Delete</button></div>`,
          (r, close) => {
            ($('#cd-go', r) as HTMLButtonElement).onclick = async () => {
              close();
              try {
                for (const a of sortedAssignments()) {
                  if (!a.slots.some((s) => s.presetId === p.id) && a.defaultPresetId !== p.id) continue;
                  const next = JSON.parse(JSON.stringify(a));
                  if (next.defaultPresetId === p.id) next.defaultPresetId = null;
                  next.slots = next.slots.map((s: { mode: string; presetId: number | null }) => (s.mode === 'preset' && s.presetId === p.id ? { ...s, mode: 'default', presetId: null } : s));
                  await saveAssignment(next);
                }
                await deletePreset(p.id);
                audit(me(), 'Deleted preset', p.name);
                local.selected = null;
                local.draft = null;
                toast('Preset deleted.');
              } catch (e) {
                toast(e instanceof StoreError ? e.message : 'Could not delete.', 'error');
              }
            };
          },
        );
      };
    }

    // equivalencies & certifications
    const certs = state.certs;
    if (!certs) return;
    $$<HTMLInputElement>('[data-eq]', root).forEach(
      (c) =>
        (c.onchange = () => {
          const i = Number(c.dataset.eq);
          const equivalencies = certs.equivalencies.map((e, j) => (j === i ? { ...e, enabled: c.checked } : e));
          run(() => saveCerts({ ...certs, equivalencies }), c.checked ? `${equivalencies[i].holder} now counts as ${equivalencies[i].satisfies}.` : 'Rule switched off.');
          audit(me(), 'Changed equivalency', `${equivalencies[i].holder} → ${equivalencies[i].satisfies}: ${c.checked ? 'on' : 'off'}`);
        }),
    );
    $$('[data-eq-del]', root).forEach((b) => (b.onclick = () => run(() => saveCerts({ ...certs, equivalencies: certs.equivalencies.filter((_, j) => j !== Number(b.dataset.eqDel)) }), 'Rule removed.')));
    $('#eq-add', root)!.onclick = () => {
      const holder = ($('#eq-h', root) as HTMLSelectElement).value;
      const satisfies = ($('#eq-s', root) as HTMLSelectElement).value;
      if (holder === satisfies) return toast('Pick two different certifications.', 'warn');
      if (certs.equivalencies.some((e) => e.holder === holder && e.satisfies === satisfies)) return toast('That rule already exists.', 'warn');
      run(() => saveCerts({ ...certs, equivalencies: [...certs.equivalencies, { holder, satisfies, enabled: false }] }), 'Rule added (off). Switch it on to apply it.');
    };
    $('#nc-add', root)!.onclick = () => {
      const code = ($('#nc-code', root) as HTMLInputElement).value.trim().toUpperCase();
      if (!/^[A-Z0-9][A-Z0-9_-]{0,15}$/.test(code)) return toast('Use letters, digits, - or _ (up to 16).', 'warn');
      if (certs.list.some((c) => c.code === code)) return toast('That certification already exists.', 'warn');
      run(() => saveCerts({ ...certs, list: [...certs.list, { code, name: code }] }), `${code} added.`);
      audit(me(), 'Added certification type', code);
    };
  },
};
