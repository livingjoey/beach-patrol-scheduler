// Visual ANY / ALL criteria editor. Self-contained: mount it into a container and listen for changes.

import { describe, parseRule, type Rule } from '../../../src/domain/criteria.ts';
import { knownCerts } from '../model.ts';
import { state } from '../store.ts';
import { $$, html, icon, type Raw } from '../util.ts';

interface Group {
  op: 'all' | 'any';
  items: (string | Group)[];
}

export function toGroup(r: Rule | null): Group {
  if (!r) return { op: 'all', items: [] };
  if ('cert' in r) return { op: 'all', items: [r.cert] };
  const op = 'any' in r ? 'any' : 'all';
  return { op, items: ('any' in r ? r.any : r.all).map((x) => ('cert' in x ? x.cert : toGroup(x))) };
}

function clean(g: Group): Group | null {
  const items = g.items.map((i) => (typeof i === 'string' ? i : clean(i))).filter((i): i is string | Group => i !== null);
  return items.length ? { op: g.op, items } : null;
}

function toRuleInner(g: Group): Rule {
  const items = g.items.map((i) => (typeof i === 'string' ? { cert: i } : toRuleInner(i)));
  return g.op === 'any' ? { any: items } : { all: items };
}

/** Returns a valid rule, or { all: [] } meaning "no requirement". */
export function toRule(g: Group): Rule {
  const c = clean(g);
  if (!c) return { all: [] };
  return parseRule(toRuleInner(c), knownCerts());
}

const certName = (code: string) => state.certs?.list.find((c) => c.code === code)?.name ?? code;

function at(g: Group, path: number[]): Group {
  return path.reduce((cur, i) => cur.items[i] as Group, g);
}

function renderGroup(g: Group, path: number[]): Raw {
  const p = path.join('.');
  const depth = path.length;
  const used = new Set(g.items.filter((i): i is string => typeof i === 'string'));
  const options = (state.certs?.list ?? []).filter((c) => !used.has(c.code));
  const joiner = g.op === 'any' ? 'OR' : 'AND';
  return html`<div class="rb-group${depth ? ' nested' : ''}${g.op === 'any' ? ' any' : ''}">
    <div class="rb-head">
      ${depth ? html`<span class="rb-label">Group</span>` : html`<span class="rb-label">Qualifies with</span>`}
      <div class="seg" role="group" aria-label="Match">
        <button type="button" class="${g.op === 'all' ? 'on' : ''}" data-rb-op="${p}" data-v="all" aria-pressed="${g.op === 'all'}">ALL of</button>
        <button type="button" class="${g.op === 'any' ? 'on' : ''}" data-rb-op="${p}" data-v="any" aria-pressed="${g.op === 'any'}">ANY of</button>
      </div>
      ${depth ? html`<button type="button" class="icon-btn" data-rb-remove="${p}" aria-label="Remove group">${icon('trash', 14)}</button>` : ''}
    </div>
    <div class="rb-items">
      ${g.items.length ? '' : html`<span class="muted small">${depth ? 'Empty group' : 'No requirement: anyone qualifies.'}</span>`}
      ${g.items.map((it, i) => {
        const ip = [...path, i].join('.');
        const join = i > 0 ? html`<span class="op ${g.op}">${joiner}</span>` : '';
        if (typeof it === 'string') return html`${join}<span class="rb-cert">${certName(it)}<button type="button" data-rb-remove="${ip}" aria-label="Remove ${certName(it)}">${icon('x', 11)}</button></span>`;
        return html`${join}${renderGroup(it, [...path, i])}`;
      })}
    </div>
    <div class="rb-add">
      <select class="input small" data-rb-select="${p}" aria-label="Certification to add"><option value="">Add certification…</option>${options.map((c) => html`<option value="${c.code}">${c.name}</option>`)}</select>
      ${depth < 4 ? html`<button type="button" class="btn small ghost" data-rb-group="${p}">${icon('plus', 13)} Group (ANY / ALL)</button>` : ''}
    </div>
  </div>`;
}

export function mountRuleBuilder(container: HTMLElement, initial: Rule | null, onChange: (rule: Rule, text: string) => void): { get(): Rule } {
  let g = toGroup(initial);
  const path = (s: string) => (s ? s.split('.').map(Number) : []);
  const draw = () => {
    const rule = toRule(g);
    container.innerHTML = html`${renderGroup(g, [])}<p class="rb-summary">${icon('check', 14)} <span>In plain words: <strong>${describe(rule)}</strong></span></p>`.value;
    $$('[data-rb-op]', container).forEach((b) => (b.onclick = () => ((at(g, path(b.dataset.rbOp!)).op = b.dataset.v as 'all' | 'any'), changed())));
    $$('[data-rb-remove]', container).forEach(
      (b) =>
        (b.onclick = () => {
          const pp = path(b.dataset.rbRemove!);
          const idx = pp.pop()!;
          at(g, pp).items.splice(idx, 1);
          changed();
        }),
    );
    $$<HTMLSelectElement>('[data-rb-select]', container).forEach(
      (s) =>
        (s.onchange = () => {
          if (!s.value) return;
          at(g, path(s.dataset.rbSelect!)).items.push(s.value);
          changed();
        }),
    );
    $$('[data-rb-group]', container).forEach(
      (b) =>
        (b.onclick = () => {
          const parent = at(g, path(b.dataset.rbGroup!));
          parent.items.push({ op: parent.op === 'all' ? 'any' : 'all', items: [] });
          changed();
        }),
    );
  };
  const changed = () => {
    draw();
    const rule = toRule(g);
    onChange(rule, describe(rule));
  };
  draw();
  return {
    get: () => toRule(g),
  };
}
