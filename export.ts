// PDF export of a week's schedule.
//
// GET /api/export/schedule.pdf?week=2027-06-05&layout=week-grid&paper=letter&orientation=auto
//     &kinds=stand,medical,pwc,boat,extra&days=sat,sun&names=true&colors=true&criteria=true&empty=true&watermark=true&title=…

import { getSetting, type DB } from '../db/index.ts';
import { addDays, isIsoDate, WEEKDAYS, weekDates, weekStartOf, todayIso } from '../domain/dates.ts';
import { ADMIN, FileReply, type Router } from '../http/app.ts';
import { bad } from '../http/validate.ts';
import { loadContext } from '../services/context.ts';
import { LAYOUT_INFO, LAYOUTS, PAPERS, renderSchedulePdf, type ExportOptions, type Layout, type Paper } from '../services/pdf.ts';
import { buildWeekFromContext } from '../services/week.ts';
import { get } from '../db/index.ts';
import { KINDS } from './assignments.ts';
import type { AssignmentKind } from '../domain/scheduling.ts';

function flag(q: URLSearchParams, key: string, fallback: boolean): boolean {
  const v = q.get(key);
  if (v === null) return fallback;
  if (v === 'true' || v === '1') return true;
  if (v === 'false' || v === '0') return false;
  throw bad(key, 'must be true or false');
}

function list<T extends string>(q: URLSearchParams, key: string, allowed: readonly T[]): T[] {
  const v = q.get(key);
  if (!v) return [...allowed];
  const items = v.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  for (const it of items) if (!allowed.includes(it as T)) throw bad(key, `contains "${it}"; allowed: ${allowed.join(', ')}`);
  return allowed.filter((a) => items.includes(a));
}

export function registerExport(r: Router, db: DB): void {
  // Lets the UI build the export dialog.
  r.get('/api/export/options', ADMIN, () => ({
    layouts: LAYOUTS.map((id) => ({ id, ...LAYOUT_INFO[id] })),
    papers: Object.keys(PAPERS),
    orientations: ['auto', 'portrait', 'landscape'],
    kinds: KINDS,
    days: WEEKDAYS,
    toggles: {
      names: 'Print names beside LG numbers',
      colors: 'Print personnel label colors',
      criteria: 'Print slot requirements (daily sheet, by assignment)',
      empty: 'Show open slots as OPEN',
      watermark: 'Mark unpublished weeks DRAFT',
    },
  }));

  r.get('/api/export/schedule.pdf', ADMIN, async (req) => {
    const q = req.query;
    const weekRaw = q.get('week') ?? todayIso();
    if (!isIsoDate(weekRaw)) throw bad('week', 'must be a date like 2027-06-05');
    const start = weekStartOf(weekRaw);
    const layout = (q.get('layout') ?? 'week-grid') as Layout;
    if (!LAYOUTS.includes(layout)) throw bad('layout', `must be one of: ${LAYOUTS.join(', ')}`);
    const paper = (q.get('paper') ?? 'letter') as Paper;
    if (!(paper in PAPERS)) throw bad('paper', `must be one of: ${Object.keys(PAPERS).join(', ')}`);
    const orientation = (q.get('orientation') ?? 'auto') as ExportOptions['orientation'];
    if (!['auto', 'portrait', 'landscape'].includes(orientation)) throw bad('orientation', 'must be auto, portrait or landscape');
    const days = list(q, 'days', WEEKDAYS);
    const dates = weekDates(start).filter((_, i) => days.includes(WEEKDAYS[i]));
    if (!dates.length) throw bad('days', 'must include at least one day');
    const kinds = list<AssignmentKind>(q, 'kinds', KINDS);

    const ctx = loadContext(db, start, addDays(start, 6));
    const w = get<{ status: 'draft' | 'published'; published_at: string | null }>(db, 'SELECT status, published_at FROM weeks WHERE week_start = ?', start);
    const week = buildWeekFromContext(ctx, start, w?.status ?? 'draft', w?.published_at ?? null);
    const pdf = await renderSchedulePdf(week, ctx, {
      layout,
      paper,
      orientation,
      kinds,
      dates,
      showNames: flag(q, 'names', layout !== 'week-grid'),
      colors: flag(q, 'colors', true),
      showCriteria: flag(q, 'criteria', false),
      showEmpty: flag(q, 'empty', true),
      watermarkDrafts: flag(q, 'watermark', true),
      title: (q.get('title') ?? '').slice(0, 120) || undefined,
      patrolName: getSetting(db, 'patrol_name', 'Beach Patrol'),
      generatedBy: req.user.identifier,
    });
    return new FileReply(pdf, 'application/pdf', `schedule-${start}-${layout}.pdf`);
  });
}
