// Auto-Fill and PDF export dialogs.

import { WEEKDAYS, weekDates, addDays } from '../../../src/domain/dates.ts';
import type { AssignmentKind } from '../../../src/domain/scheduling.ts';
import { LAYOUT_INFO, LAYOUTS, PAPERS, renderSchedulePdf, type Layout, type Paper } from '../../../src/services/pdf.ts';
import { applyAutoFill, contextFor, me, previewAutoFill, weekView } from '../model.ts';
import { state, StoreError } from '../store.ts';
import { $, $$, DAY_LONG, DAY_SHORT, html, icon, lsGet, lsSet, modal, raw, shortDate, toast } from '../util.ts';

const fmt = (start: string) => `Sat ${shortDate(start)} – Fri ${shortDate(addDays(start, 6))}`;

export function openAutoFill(weekStart: string): void {
  const days = weekDates(weekStart);
  modal(
    html`<div class="dlg-head">${icon('wand', 20)}<div><h2 class="h2">Auto-Fill schedule</h2><p class="muted small">Week of ${fmt(weekStart)}</p></div></div>
      <fieldset class="fs"><legend class="eyebrow">What to fill</legend>
        <label class="opt"><input type="radio" name="af-scope" value="week" checked><span><strong>Entire week</strong><span class="muted small">All 7 days, every open stand and unit</span></span></label>
        <label class="opt"><input type="radio" name="af-scope" value="day"><span><strong>One day</strong>
          <select id="af-day" class="input" aria-label="Day to fill">${days.map((d, i) => html`<option value="${d}">${DAY_LONG[WEEKDAYS[i]]}, ${shortDate(d)}</option>`)}</select></span></label>
        <label class="check"><input type="checkbox" id="af-empty" checked> <span><strong>Only empty slots</strong> <span class="muted">(never change anyone already placed)</span></span></label>
      </fieldset>
      <div class="enforced"><span class="eyebrow">Always enforced</span>
        <ul>${['Regular days off', 'Date-specific time off', 'Certifications', 'Each slot’s criteria', 'Open / closed stands', 'Locked assignments', 'Staffing slot counts', 'No double-booking'].map((r) => html`<li>${icon('check', 13)} ${r}</li>`)}</ul></div>
      <div id="af-preview"></div>
      <div class="btn-row end"><button type="button" class="btn" data-close>Cancel</button><button type="button" class="btn primary" id="af-go">Fill slots</button></div>`,
    (root, close) => {
      const opts = () => {
        const scope = ($('input[name="af-scope"]:checked', root) as HTMLInputElement).value;
        return { dates: scope === 'week' ? days : [($('#af-day', root) as HTMLSelectElement).value], onlyEmpty: ($('#af-empty', root) as HTMLInputElement).checked };
      };
      const preview = () => {
        const o = opts();
        const { plan, ctx } = previewAutoFill(weekStart, o.dates, o.onlyEmpty);
        $('#af-preview', root)!.innerHTML = html`<div class="stats3">
            <div class="stat ok"><strong>${plan.assign.length}</strong><span>slots will be filled</span></div>
            <div class="stat warn"><strong>${plan.unfilled.length}</strong><span>can’t be filled</span></div>
            <div class="stat"><strong>${plan.keptLocked + plan.keptExisting}</strong><span>kept as they are${plan.remove.length ? `, ${plan.remove.length} replaced` : ''}</span></div>
          </div>
          ${plan.unfilled.length ? html`<ul class="unfilled">${plan.unfilled.slice(0, 40).map((u) => html`<li>${icon('alert', 13)} <span><strong>${DAY_SHORT[WEEKDAYS[days.indexOf(u.date)]]} · ${u.assignment} · ${u.slot}</strong><br><span class="muted small">${u.reason}</span></span></li>`)}${plan.unfilled.length > 40 ? html`<li class="muted small">…and ${plan.unfilled.length - 40} more</li>` : ''}</ul>` : ''}`.value;
        ($('#af-go', root) as HTMLButtonElement).textContent = plan.assign.length ? `Fill ${plan.assign.length} slots` : 'Nothing to fill';
        ($('#af-go', root) as HTMLButtonElement).disabled = !plan.assign.length;
        void ctx;
      };
      $$('input, select', root).forEach((el) => el.addEventListener('change', preview));
      preview();
      ($('#af-go', root) as HTMLButtonElement).onclick = async () => {
        const o = opts();
        close();
        try {
          const n = await applyAutoFill(weekStart, o.dates, o.onlyEmpty);
          toast(`Auto-Fill placed ${n} lifeguards.`);
        } catch (e) {
          toast(e instanceof StoreError ? e.message : 'Auto-Fill could not save. Try again.', 'error');
        }
      };
    },
  );
}

const KINDS: { id: AssignmentKind; label: string }[] = [
  { id: 'stand', label: 'Stands' },
  { id: 'medical', label: 'Medical' },
  { id: 'pwc', label: 'PWC' },
  { id: 'boat', label: 'Boats' },
  { id: 'extra', label: 'Extras' },
];

interface ExportPrefs {
  layout: Layout;
  paper: Paper;
  orientation: 'auto' | 'portrait' | 'landscape';
  kinds: AssignmentKind[];
  days: string[];
  names: boolean;
  colors: boolean;
  criteria: boolean;
  empty: boolean;
  watermark: boolean;
}

function loadPrefs(): ExportPrefs {
  const d: ExportPrefs = { layout: 'week-grid', paper: 'letter', orientation: 'auto', kinds: KINDS.map((k) => k.id), days: [...WEEKDAYS], names: false, colors: true, criteria: false, empty: true, watermark: true };
  try {
    return { ...d, ...JSON.parse(lsGet('bps-export') ?? '{}') };
  } catch {
    return d;
  }
}

const SKETCH: Record<Layout, string> = {
  'week-grid': '<rect x="2" y="2" width="44" height="30" rx="2"/><path d="M2 8h44M10 2v30M18 2v30M26 2v30M34 2v30M2 14h44M2 20h44M2 26h44"/>',
  'daily-sheet': '<rect x="10" y="1" width="28" height="32" rx="2"/><path d="M10 7h28M14 11h20M14 15h20M14 19h20M14 23h20M14 27h12"/>',
  roster: '<rect x="2" y="2" width="44" height="30" rx="2"/><path d="M2 8h44M12 2v30M2 13h44M2 18h44M2 23h44M2 28h44"/>',
  'by-assignment': '<rect x="2" y="2" width="44" height="30" rx="2"/><path d="M2 8h44M2 12h44M14 8v24M2 22h44M2 26h44"/>',
};

export function openExport(weekStart: string): void {
  const p = loadPrefs();
  const status = state.weeks.get(weekStart)?.status ?? 'draft';
  modal(
    html`<div class="dlg-head">${icon('file', 20)}<div><h2 class="h2">Export schedule as PDF</h2><p class="muted small">Week of ${fmt(weekStart)} · ${status === 'published' ? 'Published' : 'Draft'}</p></div></div>
      <fieldset class="fs"><legend class="eyebrow">Layout</legend>
        <div class="layouts">${LAYOUTS.map(
          (l) => html`<label class="layout-card"><input type="radio" name="ex-layout" value="${l}" ${p.layout === l ? raw('checked') : ''}>
            <svg viewBox="0 0 48 34" width="72" height="51" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">${raw(SKETCH[l])}</svg>
            <span><strong>${LAYOUT_INFO[l].label}</strong><span class="muted small">${LAYOUT_INFO[l].description}</span></span></label>`,
        )}</div>
      </fieldset>
      <div class="row3">
        <label class="field"><span>Paper</span><select id="ex-paper" class="input">${Object.keys(PAPERS).map((k) => html`<option value="${k}" ${p.paper === k ? raw('selected') : ''}>${k === 'a4' || k === 'a3' ? k.toUpperCase() : k[0].toUpperCase() + k.slice(1)}</option>`)}</select></label>
        <label class="field"><span>Orientation</span><select id="ex-orient" class="input">${(['auto', 'portrait', 'landscape'] as const).map((o) => html`<option value="${o}" ${p.orientation === o ? raw('selected') : ''}>${o === 'auto' ? 'Best for layout' : o[0].toUpperCase() + o.slice(1)}</option>`)}</select></label>
      </div>
      <fieldset class="fs"><legend class="eyebrow">Include</legend>
        <div class="chips-row">${KINDS.map((k) => html`<label class="toggle-chip"><input type="checkbox" name="ex-kind" value="${k.id}" ${p.kinds.includes(k.id) ? raw('checked') : ''}><span>${k.label}</span></label>`)}</div>
        <div class="chips-row">${WEEKDAYS.map((d) => html`<label class="toggle-chip"><input type="checkbox" name="ex-day" value="${d}" ${p.days.includes(d) ? raw('checked') : ''}><span>${DAY_SHORT[d]}</span></label>`)}</div>
      </fieldset>
      <fieldset class="fs"><legend class="eyebrow">Options</legend>
        <div class="opts2">
          <label class="check"><input type="checkbox" id="ex-names" ${p.names ? raw('checked') : ''}> Names beside LG numbers</label>
          <label class="check"><input type="checkbox" id="ex-colors" ${p.colors ? raw('checked') : ''}> Personnel label colors</label>
          <label class="check"><input type="checkbox" id="ex-criteria" ${p.criteria ? raw('checked') : ''}> Slot requirements</label>
          <label class="check"><input type="checkbox" id="ex-empty" ${p.empty ? raw('checked') : ''}> Show open slots as OPEN</label>
          <label class="check"><input type="checkbox" id="ex-watermark" ${p.watermark ? raw('checked') : ''}> Mark drafts “DRAFT”</label>
        </div>
      </fieldset>
      <p class="error" id="ex-err" role="alert" hidden></p>
      <div class="btn-row end"><button type="button" class="btn" data-close>Cancel</button><button type="button" class="btn primary" id="ex-go">${icon('file', 15)} Download PDF</button></div>`,
    (root, close) => {
      ($('#ex-go', root) as HTMLButtonElement).onclick = async () => {
        const err = $('#ex-err', root)!;
        err.hidden = true;
        const checked = (name: string) => $$<HTMLInputElement>(`input[name="${name}"]:checked`, root).map((i) => i.value);
        const prefs: ExportPrefs = {
          layout: (checked('ex-layout')[0] ?? 'week-grid') as Layout,
          paper: ($('#ex-paper', root) as HTMLSelectElement).value as Paper,
          orientation: ($('#ex-orient', root) as HTMLSelectElement).value as ExportPrefs['orientation'],
          kinds: checked('ex-kind') as AssignmentKind[],
          days: checked('ex-day'),
          names: ($('#ex-names', root) as HTMLInputElement).checked,
          colors: ($('#ex-colors', root) as HTMLInputElement).checked,
          criteria: ($('#ex-criteria', root) as HTMLInputElement).checked,
          empty: ($('#ex-empty', root) as HTMLInputElement).checked,
          watermark: ($('#ex-watermark', root) as HTMLInputElement).checked,
        };
        if (!prefs.kinds.length || !prefs.days.length) {
          err.textContent = 'Pick at least one group and one day.';
          err.hidden = false;
          return;
        }
        lsSet('bps-export', JSON.stringify(prefs));
        const btn = $('#ex-go', root) as HTMLButtonElement;
        btn.disabled = true;
        btn.textContent = 'Building PDF…';
        try {
          const dates = weekDates(weekStart).filter((_, i) => prefs.days.includes(WEEKDAYS[i]));
          const bytes = await renderSchedulePdf(weekView(weekStart), contextFor(weekStart), {
            layout: prefs.layout,
            paper: prefs.paper,
            orientation: prefs.orientation,
            kinds: prefs.kinds,
            dates,
            showNames: prefs.names,
            colors: prefs.colors,
            showCriteria: prefs.criteria,
            showEmpty: prefs.empty,
            watermarkDrafts: prefs.watermark,
            patrolName: state.settings.patrolName,
            generatedBy: me(),
          });
          const claude = (window as unknown as { claude?: { use(n: string): Promise<{ save(r: { filename: string; data: Uint8Array }): Promise<unknown> } | null> } }).claude;
          const downloads = claude ? await claude.use('downloads').catch(() => null) : null;
          if (!downloads) {
            // On the scheduler's own website the browser can save the file directly.
            const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/pdf' }));
            const a = document.createElement('a');
            a.href = url;
            a.download = `schedule-${weekStart}-${prefs.layout}.pdf`;
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 30_000);
            close();
            toast('PDF downloaded.');
            return;
          }
          await downloads.save({ filename: `schedule-${weekStart}-${prefs.layout}.pdf`, data: bytes });
          close();
          toast('PDF ready.');
        } catch (e) {
          const code = (e as { code?: string })?.code;
          btn.disabled = false;
          btn.textContent = 'Download PDF';
          if (code === 'declined') return;
          err.textContent = code === 'rate_limited' ? 'A download is already waiting for you to confirm.' : 'Could not build the PDF. Try again.';
          err.hidden = false;
          console.error(e);
        }
      };
    },
    true,
  );
}
