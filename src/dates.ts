import { UserError } from './errors.js';

/** Search Console finalises a day's numbers two to three days later. */
export const FINAL_DATA_LAG_DAYS = 3;
export const DEFAULT_DAYS = 28;
/** Search Console keeps 16 months of performance data. */
export const MAX_HISTORY_DAYS = 16 * 31;

export interface DateRange {
  startDate: string;
  endDate: string;
}

export interface DateInput {
  start_date?: string;
  end_date?: string;
  days?: number;
}

/** Today's date in Pacific Time, the time zone Search Console reports in. */
export function pacificToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

export function isValidDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function addDays(date: string, days: number): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

/** Number of days in the range, counting both ends. */
export function rangeLength(range: DateRange): number {
  const start = Date.parse(`${range.startDate}T00:00:00Z`);
  const end = Date.parse(`${range.endDate}T00:00:00Z`);
  return Math.round((end - start) / 86_400_000) + 1;
}

/** Accepts YYYY-MM-DD, or the words "today" and "yesterday" (in Pacific Time). */
function parseDate(value: string, name: string, now: Date): string {
  const word = value.trim().toLowerCase();
  if (word === 'today') return pacificToday(now);
  if (word === 'yesterday') return addDays(pacificToday(now), -1);
  if (!isValidDate(value)) {
    throw new UserError(`${name} must be a real date in YYYY-MM-DD format (or "today" / "yesterday"), got "${value}".`);
  }
  return value;
}

/**
 * Turns the optional start_date / end_date / days inputs into a concrete range.
 * With nothing given it returns the last 28 days that Search Console has finalised.
 */
export function resolveDateRange(
  input: DateInput,
  now: Date = new Date(),
  lagDays: number = FINAL_DATA_LAG_DAYS,
): DateRange {
  const days = input.days ?? DEFAULT_DAYS;
  if (!Number.isInteger(days) || days < 1) throw new UserError('days must be a whole number of at least 1.');

  const endDate = input.end_date ? parseDate(input.end_date, 'end_date', now) : addDays(pacificToday(now), -lagDays);
  const startDate = input.start_date ? parseDate(input.start_date, 'start_date', now) : addDays(endDate, -(days - 1));

  if (startDate > endDate) {
    throw new UserError(`start_date (${startDate}) is after end_date (${endDate}).`);
  }
  return { startDate, endDate };
}

/** The range of the same length that ends the day before `range` starts. */
export function previousPeriod(range: DateRange): DateRange {
  const length = rangeLength(range);
  const endDate = addDays(range.startDate, -1);
  return { startDate: addDays(endDate, -(length - 1)), endDate };
}

/** The same range 52 weeks earlier, so weekdays line up. */
export function yearAgoPeriod(range: DateRange): DateRange {
  return { startDate: addDays(range.startDate, -364), endDate: addDays(range.endDate, -364) };
}

/** Every date in the range, in order. */
export function eachDate(range: DateRange): string[] {
  const dates: string[] = [];
  for (let date = range.startDate; date <= range.endDate; date = addDays(date, 1)) dates.push(date);
  return dates;
}
