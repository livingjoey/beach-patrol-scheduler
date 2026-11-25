// Patrol weeks run Saturday through Friday. Weekday index 0 = Saturday … 6 = Friday.

export const WEEKDAYS = ['sat', 'sun', 'mon', 'tue', 'wed', 'thu', 'fri'] as const;
export type WeekdayName = (typeof WEEKDAYS)[number];

const ISO = /^\d{4}-\d{2}-\d{2}$/;

const toDate = (iso: string): Date => new Date(`${iso}T00:00:00Z`);
const toIso = (d: Date): string => d.toISOString().slice(0, 10);

export function isIsoDate(v: unknown): v is string {
  if (typeof v !== 'string' || !ISO.test(v)) return false;
  const d = toDate(v);
  return !Number.isNaN(d.getTime()) && toIso(d) === v;
}

export function addDays(iso: string, n: number): string {
  const d = toDate(iso);
  d.setUTCDate(d.getUTCDate() + n);
  return toIso(d);
}

/** 0 = Saturday … 6 = Friday */
export function weekdayIndex(iso: string): number {
  return (toDate(iso).getUTCDay() + 1) % 7;
}

export function weekdayName(iso: string): WeekdayName {
  return WEEKDAYS[weekdayIndex(iso)];
}

/** The Saturday that starts the patrol week containing `iso`. */
export function weekStartOf(iso: string): string {
  return addDays(iso, -weekdayIndex(iso));
}

export function weekDates(weekStart: string): string[] {
  return Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
}

export function dateRange(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

export function todayIso(): string {
  return toIso(new Date());
}
