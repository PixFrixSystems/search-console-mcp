import { describe, expect, it } from 'vitest';
import {
  addDays,
  eachDate,
  isValidDate,
  pacificToday,
  previousPeriod,
  rangeLength,
  resolveDateRange,
  yearAgoPeriod,
} from '../src/dates.js';
import { UserError } from '../src/errors.js';

const NOW = new Date('2026-11-14T12:00:00Z');

describe('pacificToday', () => {
  it('uses Pacific Time, not UTC', () => {
    // 03:00 UTC is still the previous evening in California.
    expect(pacificToday(new Date('2026-11-14T03:00:00Z'))).toBe('2026-11-13');
    expect(pacificToday(new Date('2026-11-14T12:00:00Z'))).toBe('2026-11-14');
  });
});

describe('isValidDate', () => {
  it('accepts real dates and rejects impossible or malformed ones', () => {
    expect(isValidDate('2026-02-28')).toBe(true);
    expect(isValidDate('2026-02-30')).toBe(false);
    expect(isValidDate('2026-2-3')).toBe(false);
    expect(isValidDate('yesterday')).toBe(false);
  });
});

describe('resolveDateRange', () => {
  it('defaults to the last 28 finalised days', () => {
    const range = resolveDateRange({}, NOW);
    expect(range).toEqual({ startDate: '2026-10-15', endDate: '2026-11-11' });
    expect(rangeLength(range)).toBe(28);
  });

  it('counts back from an explicit end date', () => {
    expect(resolveDateRange({ end_date: '2026-06-30', days: 7 }, NOW)).toEqual({
      startDate: '2026-06-24',
      endDate: '2026-06-30',
    });
  });

  it('keeps explicit start and end dates', () => {
    expect(resolveDateRange({ start_date: '2026-01-01', end_date: '2026-01-31' }, NOW)).toEqual({
      startDate: '2026-01-01',
      endDate: '2026-01-31',
    });
  });

  it('ends today when fresh data is requested', () => {
    expect(resolveDateRange({ days: 3 }, NOW, 0)).toEqual({ startDate: '2026-11-12', endDate: '2026-11-14' });
  });

  it('rejects bad input with a readable message', () => {
    expect(() => resolveDateRange({ start_date: '2026-13-01' }, NOW)).toThrow(UserError);
    expect(() => resolveDateRange({ start_date: '2026-05-10', end_date: '2026-05-01' }, NOW)).toThrow(/after end_date/);
    expect(() => resolveDateRange({ days: 0 }, NOW)).toThrow(UserError);
  });
});

describe('period helpers', () => {
  const range = { startDate: '2026-10-15', endDate: '2026-11-11' };

  it('finds the preceding period of the same length', () => {
    const previous = previousPeriod(range);
    expect(previous).toEqual({ startDate: '2026-09-17', endDate: '2026-10-14' });
    expect(rangeLength(previous)).toBe(rangeLength(range));
  });

  it('shifts by 52 weeks so weekdays line up', () => {
    const earlier = yearAgoPeriod(range);
    expect(earlier).toEqual({ startDate: '2025-10-16', endDate: '2025-11-12' });
    expect(new Date(`${earlier.startDate}T00:00:00Z`).getUTCDay()).toBe(new Date(`${range.startDate}T00:00:00Z`).getUTCDay());
  });

  it('adds days across month and year boundaries', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('lists every date in a range', () => {
    expect(eachDate({ startDate: '2026-02-27', endDate: '2026-03-02' })).toEqual([
      '2026-02-27',
      '2026-02-28',
      '2026-03-01',
      '2026-03-02',
    ]);
  });
});
