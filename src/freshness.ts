import { addDays, FINAL_DATA_LAG_DAYS, isValidDate, pacificToday } from './dates.js';
import type { GscClient } from './gsc/client.js';
import { firstIncompleteDate } from './gsc/types.js';

/**
 * Knows the most recent day for which Search Console has complete data.
 *
 * The delay is not fixed: it moves between about two and four days and depends on the time of day,
 * so guessing it either drops a finished day or lets a half-collected one into a period (which
 * skews every comparison). Google reports the boundary itself, so this asks once per property and
 * remembers the answer for a while.
 */
export class DataFreshness {
  private readonly cache = new Map<string, { date: string; at: number }>();

  constructor(
    private readonly client: Pick<GscClient, 'querySearchAnalytics'>,
    private readonly now: () => Date = () => new Date(),
    private readonly ttlMs: number = 30 * 60_000,
  ) {}

  /** The last day with complete data, as YYYY-MM-DD in Pacific Time. */
  async lastCompleteDate(siteUrl: string): Promise<string> {
    const current = this.now();
    const cached = this.cache.get(siteUrl);
    if (cached && current.getTime() - cached.at < this.ttlMs) return cached.date;

    const today = pacificToday(current);
    const response = await this.client.querySearchAnalytics(siteUrl, {
      startDate: addDays(today, -10),
      endDate: today,
      dimensions: ['date'],
      dataState: 'all',
      rowLimit: 20,
    });

    // Without a marker (a property with no recent data at all) fall back to the documented delay.
    const boundary = firstIncompleteDate(response.metadata);
    const date = boundary && isValidDate(boundary) ? addDays(boundary, -1) : addDays(today, -FINAL_DATA_LAG_DAYS);
    this.cache.set(siteUrl, { date, at: current.getTime() });
    return date;
  }
}
