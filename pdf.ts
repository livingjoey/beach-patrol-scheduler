// PDF export of the weekly schedule, with several layouts.
//
//   week-grid      Days down the side, assignments across (like the Schedule Builder). Landscape.
//   daily-sheet    One page per day listing every assignment, slot and lifeguard. For posting at HQ.
//   roster         One row per lifeguard, Sat–Fri across: where they are or why they're off.
//   by-assignment  One block per assignment: its slots down the side, days across.

import { degrees, PDFDocument, rgb, StandardFonts, type PDFFont, type PDFPage, type RGB } from 'pdf-lib';
import { WEEKDAYS } from '../domain/dates.ts';
import { availability, type AssignmentKind, type LabelColor, type ScheduleContext } from '../domain/scheduling.ts';
import type { AssignmentView, WeekView } from '../domain/week-view.ts';

export const LAYOUTS = ['week-grid', 'daily-sheet', 'roster', 'by-assignment'] as const;
export type Layout = (typeof LAYOUTS)[number];
export const PAPERS = { letter: [612, 792], legal: [612, 1008], tabloid: [792, 1224], a4: [595.28, 841.89], a3: [841.89, 1190.55] } as const;
export type Paper = keyof typeof PAPERS;

export interface ExportOptions {
  layout: Layout;
  paper: Paper;
  orientation: 'portrait' | 'landscape' | 'auto';
  kinds: AssignmentKind[]; // which assignment groups to include
  dates: string[]; // which days (subset of the week)
  showNames: boolean; // print names beside LG numbers
  colors: boolean; // print personnel label colors
  showCriteria: boolean; // print slot requirements (daily-sheet, by-assignment)
  showEmpty: boolean; // print open slots as "OPEN"
  watermarkDrafts: boolean;
  title?: string;
  patrolName: string;
  generatedBy: string;
}

export const LAYOUT_INFO: Record<Layout, { label: string; description: string; defaultOrientation: 'portrait' | 'landscape' }> = {
  'week-grid': { label: 'Week grid', description: 'Days down the side, stands and units across — matches the Schedule Builder.', defaultOrientation: 'landscape' },
  'daily-sheet': { label: 'Daily posting sheet', description: 'One page per day with every assignment, slot and lifeguard.', defaultOrientation: 'portrait' },
  roster: { label: 'Lifeguard roster', description: 'One row per lifeguard showing where they are each day or why they are off.', defaultOrientation: 'landscape' },
  'by-assignment': { label: 'By assignment', description: 'One block per stand or unit, slots down the side and days across.', defaultOrientation: 'landscape' },
};

// ---------- styling ----------

const hex = (h: string): RGB => rgb(parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255);
const C = {
  ink: hex('#0E1A2B'),
  muted: hex('#4F5D6D'),
  line: hex('#CBD5E1'),
  head: hex('#E7ECF1'),
  navy: hex('#0F2740'),
  closed: hex('#E5E9EE'),
  off: hex('#EEF1F4'),
  open: hex('#B45309'),
  white: rgb(1, 1, 1),
  override: hex('#4C2E9E'),
};
const LABEL: Record<LabelColor, { fill: RGB; text: RGB; border: RGB; borderWidth: number }> = {
  red: { fill: hex('#C62828'), text: C.white, border: hex('#C62828'), borderWidth: 0.5 },
  light_blue: { fill: hex('#BFE3F7'), text: C.ink, border: hex('#8CC8EA'), borderWidth: 0.5 },
  green: { fill: hex('#2E7D32'), text: C.white, border: hex('#2E7D32'), borderWidth: 0.5 },
  dark_blue: { fill: hex('#0D2F6B'), text: C.white, border: hex('#0D2F6B'), borderWidth: 0.5 },
  white: { fill: C.white, text: C.ink, border: hex('#E8B400'), borderWidth: 1.4 },
};
const PLAIN = { fill: C.white, text: C.ink, border: hex('#8C9AAB'), borderWidth: 0.6 };

const SIZE = 8;
const LINE = 10;
const CHIP_H = 11;
const PAD = 4;
const MARGIN = 30;

// Standard PDF fonts only encode WinAnsi; replace anything else so export never fails.
const WIN_ANSI_EXTRA = new Set('€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ');
export function safe(s: string): string {
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if ((c >= 0x20 && c <= 0x7e) || (c >= 0xa0 && c <= 0xff) || WIN_ANSI_EXTRA.has(ch)) out += ch;
    else if (ch === '→') out += '->';
    else if (ch === '\n' || ch === '\t') out += ' ';
    else out += '?';
  }
  return out;
}

// ---------- table model ----------

type Item =
  | { kind: 'text'; text: string; bold?: boolean; size?: number; color?: RGB }
  | { kind: 'chip'; text: string; label: LabelColor | null; open?: boolean; mark?: string; after?: string };

interface Cell {
  items: Item[];
  fill?: RGB;
  span?: number;
}

interface Column {
  title: string;
  weight: number;
}

interface Fonts {
  reg: PDFFont;
  bold: PDFFont;
  mono: PDFFont;
}

class Renderer {
  doc: PDFDocument;
  fonts: Fonts;
  opts: ExportOptions;
  week: WeekView;
  size: [number, number];
  pages: PDFPage[] = [];
  page!: PDFPage;
  y = 0;
  subtitle = '';

  constructor(doc: PDFDocument, fonts: Fonts, opts: ExportOptions, week: WeekView, size: [number, number]) {
    this.doc = doc;
    this.fonts = fonts;
    this.opts = opts;
    this.week = week;
    this.size = size;
  }

  get width() {
    return this.size[0];
  }
  get height() {
    return this.size[1];
  }

  text(page: PDFPage, s: string, x: number, y: number, size: number, font: PDFFont, color: RGB = C.ink) {
    page.drawText(safe(s), { x, y, size, font, color });
  }

  fit(s: string, font: PDFFont, size: number, max: number): string {
    let t = safe(s);
    if (font.widthOfTextAtSize(t, size) <= max) return t;
    while (t.length > 1 && font.widthOfTextAtSize(`${t}…`, size) > max) t = t.slice(0, -1);
    return `${t}…`;
  }

  newPage(subtitle = this.subtitle) {
    this.subtitle = subtitle;
    this.page = this.doc.addPage(this.size);
    this.pages.push(this.page);
    const { reg, bold } = this.fonts;
    const top = this.height - MARGIN;
    this.text(this.page, this.opts.patrolName, MARGIN, top - 12, 13, bold, C.navy);
    const title = this.opts.title || `${LAYOUT_INFO[this.opts.layout].label} · ${fmtRange(this.week.weekStart, this.week.weekEnd)}`;
    this.text(this.page, title, MARGIN, top - 27, 10, reg, C.ink);
    if (subtitle) this.text(this.page, subtitle, MARGIN, top - 41, 11, bold, C.ink);
    // status badge
    const status = this.week.status === 'published' ? 'PUBLISHED' : 'DRAFT';
    const sw = bold.widthOfTextAtSize(status, 8) + 12;
    const sx = this.width - MARGIN - sw;
    this.page.drawRectangle({ x: sx, y: top - 16, width: sw, height: 14, color: this.week.status === 'published' ? C.navy : hex('#FDF1E4'), borderColor: this.week.status === 'published' ? C.navy : C.open, borderWidth: 0.6 });
    this.text(this.page, status, sx + 6, top - 12, 8, bold, this.week.status === 'published' ? C.white : hex('#8A3D05'));
    if (this.opts.colors && this.opts.layout !== 'daily-sheet') this.legend(sx - 8, top - 12);
    if (this.week.status !== 'published' && this.opts.watermarkDrafts) {
      this.page.drawText('DRAFT', { x: this.width * 0.22, y: this.height * 0.3, size: Math.min(this.width, this.height) * 0.22, font: bold, color: C.line, opacity: 0.25, rotate: degrees(30) });
    }
    this.y = top - (subtitle ? 54 : 40);
  }

  legend(right: number, y: number) {
    const { reg, mono } = this.fonts;
    const items: [LabelColor, string][] = [
      ['red', 'Red'],
      ['light_blue', 'Lt blue'],
      ['green', 'Green'],
      ['dark_blue', 'Dk blue'],
      ['white', 'White'],
    ];
    let x = right;
    for (const [color, name] of [...items].reverse()) {
      const w = reg.widthOfTextAtSize(name, 7);
      x -= w;
      this.text(this.page, name, x, y, 7, reg, C.muted);
      x -= 14;
      this.chip(this.page, '', color, x, y - 3, 11, false, mono);
      x -= 8;
    }
  }

  chip(page: PDFPage, label: string, color: LabelColor | null, x: number, y: number, w: number, open: boolean, font: PDFFont, mark = '') {
    const style = open ? { fill: C.white, text: C.open, border: C.open, borderWidth: 0.8 } : color && this.opts.colors ? LABEL[color] : PLAIN;
    page.drawRectangle({ x, y, width: w, height: CHIP_H, color: style.fill, borderColor: style.border, borderWidth: style.borderWidth, borderDashArray: open ? [2, 1.5] : undefined });
    if (label) this.text(page, label + mark, x + 3, y + 3, 7, open ? this.fonts.bold : font, style.text);
  }

  chipWidth(it: Extract<Item, { kind: 'chip' }>): number {
    const f = it.open ? this.fonts.bold : this.fonts.mono;
    return f.widthOfTextAtSize(safe(it.text + (it.mark ?? '')), 7) + 6;
  }

  wrap(text: string, font: PDFFont, size: number, width: number): string[] {
    const words = safe(text).split(' ');
    const lines: string[] = [];
    let cur = '';
    for (const w of words) {
      const t = cur ? `${cur} ${w}` : w;
      if (font.widthOfTextAtSize(t, size) <= width || !cur) cur = t;
      else {
        lines.push(cur);
        cur = w;
      }
    }
    if (cur) lines.push(cur);
    return lines.map((l) => this.fit(l, font, size, width));
  }

  /** Lays out a cell; draws it when `draw` is set. Returns its content height. */
  layout(cell: Cell, x: number, top: number, width: number, draw: boolean): number {
    const inner = width - PAD * 2;
    let y = top - PAD;
    let cx = 0;
    let rowOpen = false;
    const endChipRow = () => {
      if (rowOpen) {
        y -= CHIP_H + 2;
        cx = 0;
        rowOpen = false;
      }
    };
    for (const it of cell.items) {
      if (it.kind === 'chip') {
        const w = Math.min(this.chipWidth(it), inner);
        const afterW = it.after ? Math.min(this.fonts.reg.widthOfTextAtSize(safe(it.after), SIZE) + 4, Math.max(inner - w - 4, 0)) : 0;
        if (rowOpen && cx + w + afterW > inner) endChipRow();
        if (draw) {
          this.chip(this.page, this.fit(it.text, it.open ? this.fonts.bold : this.fonts.mono, 7, w - 6 - (it.mark ? 4 : 0)), it.label, x + PAD + cx, y - CHIP_H, w, !!it.open, this.fonts.mono, it.mark ?? '');
          if (it.after && afterW > 8) this.text(this.page, this.fit(it.after, this.fonts.reg, SIZE, afterW - 4), x + PAD + cx + w + 4, y - CHIP_H + 2.5, SIZE, this.fonts.reg);
        }
        cx += w + afterW + 2;
        rowOpen = true;
      } else {
        endChipRow();
        const font = it.bold ? this.fonts.bold : this.fonts.reg;
        const size = it.size ?? SIZE;
        for (const line of this.wrap(it.text, font, size, inner)) {
          if (draw) this.text(this.page, line, x + PAD, y - size, size, font, it.color ?? C.ink);
          y -= size + 2;
        }
      }
    }
    endChipRow();
    return top - y + PAD - 2;
  }

  table(columns: Column[], rows: Cell[][], opts: { minRow?: number } = {}) {
    const usable = this.width - MARGIN * 2;
    const total = columns.reduce((s, c) => s + c.weight, 0);
    const widths = columns.map((c) => (c.weight / total) * usable);
    const header = () => {
      const h = LINE + PAD * 2;
      let x = MARGIN;
      columns.forEach((c, i) => {
        this.page.drawRectangle({ x, y: this.y - h, width: widths[i], height: h, color: C.head, borderColor: C.line, borderWidth: 0.5 });
        this.text(this.page, this.fit(c.title, this.fonts.bold, SIZE, widths[i] - PAD * 2), x + PAD, this.y - h + PAD + 1.5, SIZE, this.fonts.bold);
        x += widths[i];
      });
      this.y -= h;
    };
    header();
    for (const row of rows) {
      // compute cell geometry (spans)
      const geo: { cell: Cell; x: number; w: number }[] = [];
      let col = 0;
      let x = MARGIN;
      for (const cell of row) {
        const span = cell.span ?? 1;
        const w = widths.slice(col, col + span).reduce((s, v) => s + v, 0);
        geo.push({ cell, x, w });
        x += w;
        col += span;
      }
      const h = Math.max(opts.minRow ?? 0, ...geo.map((g) => this.layout(g.cell, g.x, this.y, g.w, false)), LINE + PAD * 2);
      // keep a group header together with the first row under it
      const isHeader = row.length === 1 && (row[0].span ?? 1) === columns.length;
      if (this.y - h - (isHeader ? 24 : 0) < MARGIN + 18) {
        this.newPage();
        header();
      }
      for (const g of geo) {
        this.page.drawRectangle({ x: g.x, y: this.y - h, width: g.w, height: h, color: g.cell.fill ?? C.white, borderColor: C.line, borderWidth: 0.5 });
        this.layout(g.cell, g.x, this.y, g.w, true);
      }
      this.y -= h;
    }
    this.y -= 10;
  }

  footers() {
    const n = this.pages.length;
    const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
    this.pages.forEach((p, i) => {
      const left = `Generated ${stamp} UTC by ${this.opts.generatedBy}`;
      const marks = '* locked   ! supervisor override';
      this.text(p, left, MARGIN, MARGIN - 14, 7, this.fonts.reg, C.muted);
      this.text(p, marks, MARGIN + this.fonts.reg.widthOfTextAtSize(left, 7) + 16, MARGIN - 14, 7, this.fonts.reg, C.muted);
      const pg = `Page ${i + 1} of ${n}`;
      this.text(p, pg, this.width - MARGIN - this.fonts.reg.widthOfTextAtSize(pg, 7), MARGIN - 14, 7, this.fonts.reg, C.muted);
    });
  }
}

// ---------- formatting ----------

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAY_NAMES: Record<string, string> = { sat: 'Saturday', sun: 'Sunday', mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday' };
const short = (iso: string) => `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}`;
const fmtRange = (a: string, b: string) => `Sat ${short(a)} – Fri ${short(b)}, ${b.slice(0, 4)}`;
const dayLabel = (iso: string, wd: string) => `${DAY_NAMES[wd]}, ${short(iso)}`;
const KIND_TITLES: Record<AssignmentKind, string> = { stand: 'Stands', medical: 'Medical units', pwc: 'PWC units', boat: 'Rescue boats', extra: 'Extra assignments' };
const OFF_SHORT: Record<string, string> = { regular_day_off: 'OFF', vacation: 'VAC', leave: 'LEAVE', training: 'TRAIN', other: 'OTHER', inactive: 'INACTIVE' };

function entryChip(opts: ExportOptions, e: NonNullable<AssignmentView['slots'][number]['entry']>): Item {
  const surname = e.name.trim().split(/\s+/).slice(-1)[0] ?? '';
  const withName = opts.showNames && surname && !/^\d+$/.test(surname);
  return { kind: 'chip', text: withName ? `${e.lgNumber} ${surname}` : e.lgNumber, label: e.labelColor, mark: `${e.locked ? '*' : ''}${e.overrideReason ? '!' : ''}` };
}

// ---------- layouts ----------

function weekGrid(r: Renderer, week: WeekView, opts: ExportOptions) {
  const days = week.days.filter((d) => opts.dates.includes(d.date));
  for (const kind of opts.kinds) {
    const sample = days[0]?.assignments.filter((a) => a.kind === kind) ?? [];
    if (!sample.length) continue;
    r.newPage(KIND_TITLES[kind]);
    const columns: Column[] = [{ title: 'Day', weight: 1.1 }, ...sample.map((a) => ({ title: a.displayName, weight: Math.max(1, Math.ceil(a.capacity / 3)) }))];
    const rows: Cell[][] = days.map((d) => [
      { items: [{ kind: 'text', text: DAY_NAMES[d.weekday], bold: true }, { kind: 'text', text: short(d.date), color: C.muted }], fill: C.head },
      ...d.assignments
        .filter((a) => a.kind === kind)
        .map((a): Cell => {
          if (!a.open) return { items: [{ kind: 'text', text: 'CLOSED', bold: true, color: C.muted }], fill: C.closed };
          const items: Item[] = [];
          for (const s of a.slots) {
            if (s.entry) items.push(entryChip(opts, s.entry));
            else if (opts.showEmpty) items.push({ kind: 'chip', text: 'OPEN', label: null, open: true });
          }
          return { items };
        }),
    ]);
    r.table(columns, rows, { minRow: 40 });
  }
}

function dailySheet(r: Renderer, week: WeekView, opts: ExportOptions, ctx: ScheduleContext) {
  for (const d of week.days.filter((x) => opts.dates.includes(x.date))) {
    r.newPage(dayLabel(d.date, d.weekday));
    const columns: Column[] = [
      { title: 'Assignment', weight: 2 },
      { title: 'Slot', weight: 1.4 },
      ...(opts.showCriteria ? [{ title: 'Requirement', weight: 2.6 }] : []),
      { title: 'Lifeguard', weight: 3 },
      { title: 'Notes', weight: 2 },
    ];
    const rows: Cell[][] = [];
    for (const kind of opts.kinds) {
      const list = d.assignments.filter((a) => a.kind === kind);
      if (!list.length) continue;
      rows.push([{ items: [{ kind: 'text', text: KIND_TITLES[kind].toUpperCase(), bold: true, size: 7.5, color: C.navy }], fill: C.head, span: columns.length }]);
      for (const a of list) {
        if (!a.open) {
          rows.push([{ items: [{ kind: 'text', text: a.displayName, bold: true }] }, { items: [{ kind: 'text', text: 'CLOSED today', bold: true, color: C.muted }], fill: C.closed, span: columns.length - 1 }]);
          continue;
        }
        a.slots.forEach((s, i) => {
          if (!s.entry && !opts.showEmpty) return;
          const notes: string[] = [];
          if (s.entry?.locked) notes.push('Locked');
          if (s.entry?.overrideReason) notes.push(`Override: ${s.entry.overrideReason}`);
          rows.push([
            { items: i === 0 ? [{ kind: 'text', text: a.displayName, bold: true }] : [] },
            { items: [{ kind: 'text', text: s.name }] },
            ...(opts.showCriteria ? [{ items: [{ kind: 'text', text: s.criteria, color: C.muted } as Item] }] : []),
            {
              items: s.entry
                ? [{ kind: 'chip', text: s.entry.lgNumber, label: s.entry.labelColor, after: s.entry.name } as Item]
                : [{ kind: 'chip', text: 'OPEN', label: null, open: true } as Item],
            },
            { items: notes.map((n) => ({ kind: 'text', text: n, size: 7, color: n.startsWith('Override') ? C.override : C.muted }) as Item) },
          ]);
        });
      }
    }
    r.table(columns, rows);

    // Who is off today, so the sheet answers "where is LG31?"
    const off = [...ctx.personnel.values()]
      .filter((p) => p.active)
      .map((p) => ({ p, av: availability(p, d.date) }))
      .filter((x) => !x.av.available)
      .sort((a, b) => Number(a.p.lgNumber.slice(2)) - Number(b.p.lgNumber.slice(2)));
    if (off.length) {
      r.table([{ title: `Off today (${off.length})`, weight: 1 }], [[{ items: off.map((x) => ({ kind: 'chip', text: `${x.p.lgNumber} ${OFF_SHORT[x.av.reason ?? 'other']}`, label: x.p.labelColor }) as Item) }]]);
    }
  }
}

function roster(r: Renderer, week: WeekView, opts: ExportOptions, ctx: ScheduleContext) {
  r.newPage('Lifeguard roster');
  const days = week.days.filter((d) => opts.dates.includes(d.date));
  const columns: Column[] = [{ title: 'LG', weight: 0.9 }, { title: 'Name', weight: 2 }, ...days.map((d) => ({ title: `${WEEKDAYS[WEEKDAYS.indexOf(d.weekday as (typeof WEEKDAYS)[number])].toUpperCase()} ${short(d.date)}`, weight: 1.5 })), { title: 'Shifts', weight: 0.7 }];
  const people = [...ctx.personnel.values()].filter((p) => p.active).sort((a, b) => Number(a.lgNumber.slice(2)) - Number(b.lgNumber.slice(2)));
  const rows: Cell[][] = people.map((p) => {
    let count = 0;
    const cells: Cell[] = days.map((d) => {
      const mine = d.assignments.filter((a) => opts.kinds.includes(a.kind)).flatMap((a) => a.slots.filter((s) => s.entry?.personnelId === p.id).map((s) => ({ a, s })));
      if (mine.length) {
        count += mine.length;
        return { items: mine.map(({ a, s }) => ({ kind: 'text', text: `${a.displayName}${a.slots.length > 1 ? ` · ${s.name.replace(/^Slot /, 'S')}` : ''}${s.entry!.locked ? '*' : ''}${s.entry!.overrideReason ? '!' : ''}`, size: 7.5 }) as Item) };
      }
      const av = availability(p, d.date);
      if (!av.available) return { items: [{ kind: 'text', text: OFF_SHORT[av.reason ?? 'other'], bold: true, size: 7, color: C.muted }], fill: C.off };
      return { items: [{ kind: 'text', text: '—', color: C.muted }] };
    });
    return [{ items: [{ kind: 'chip', text: p.lgNumber, label: p.labelColor }] }, { items: [{ kind: 'text', text: p.name }] }, ...cells, { items: [{ kind: 'text', text: String(count), bold: true }] }];
  });
  r.table(columns, rows);
}

function byAssignment(r: Renderer, week: WeekView, opts: ExportOptions) {
  const days = week.days.filter((d) => opts.dates.includes(d.date));
  for (const kind of opts.kinds) {
    const list = days[0]?.assignments.filter((a) => a.kind === kind) ?? [];
    if (!list.length) continue;
    r.newPage(KIND_TITLES[kind]);
    const columns: Column[] = [{ title: 'Slot', weight: 1.6 }, ...(opts.showCriteria ? [{ title: 'Requirement', weight: 2.2 }] : []), ...days.map((d) => ({ title: `${DAY_NAMES[d.weekday].slice(0, 3)} ${short(d.date)}`, weight: 1.3 }))];
    const rows: Cell[][] = [];
    for (const first of list) {
      // rows come from the day that uses the most guards (layouts can use fewer on some days)
      const a = days.map((d) => d.assignments.find((x) => x.assignmentId === first.assignmentId)!).reduce((m, x) => (x.slots.length > m.slots.length ? x : m), first);
      rows.push([{ items: [{ kind: 'text', text: a.displayName, bold: true, color: C.navy }], fill: C.head, span: columns.length }]);
      a.slots.forEach((s, i) => {
        rows.push([
          { items: [{ kind: 'text', text: s.name }] },
          ...(opts.showCriteria ? [{ items: [{ kind: 'text', text: s.criteria, size: 7, color: C.muted } as Item] }] : []),
          ...days.map((d): Cell => {
            const da = d.assignments.find((x) => x.assignmentId === a.assignmentId)!;
            if (!da.open) return { items: i === 0 ? [{ kind: 'text', text: 'CLOSED', bold: true, size: 7, color: C.muted }] : [], fill: C.closed };
            const slot = da.slots[i];
            if (!slot) return { items: [{ kind: 'text', text: 'not used', size: 7, color: C.muted }], fill: C.off };
            if (slot.entry) return { items: [entryChip(opts, slot.entry)] };
            return { items: opts.showEmpty ? [{ kind: 'chip', text: 'OPEN', label: null, open: true }] : [] };
          }),
        ]);
      });
    }
    r.table(columns, rows);
  }
}

export async function renderSchedulePdf(week: WeekView, ctx: ScheduleContext, opts: ExportOptions): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(`${opts.patrolName} schedule ${week.weekStart}`);
  doc.setCreator('Beach Patrol Scheduler');
  const fonts = {
    reg: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
    mono: await doc.embedFont(StandardFonts.CourierBold),
  };
  const [w, h] = PAPERS[opts.paper];
  const orient = opts.orientation === 'auto' ? LAYOUT_INFO[opts.layout].defaultOrientation : opts.orientation;
  const size: [number, number] = orient === 'landscape' ? [Math.max(w, h), Math.min(w, h)] : [Math.min(w, h), Math.max(w, h)];
  const r = new Renderer(doc, fonts, opts, week, size);
  if (opts.layout === 'week-grid') weekGrid(r, week, opts);
  else if (opts.layout === 'daily-sheet') dailySheet(r, week, opts, ctx);
  else if (opts.layout === 'roster') roster(r, week, opts, ctx);
  else byAssignment(r, week, opts);
  if (!r.pages.length) {
    r.newPage('Nothing to show');
    r.text(r.page, 'No assignments match the chosen options.', MARGIN, r.y - 10, 10, fonts.reg, C.muted);
  }
  r.footers();
  return doc.save();
}
