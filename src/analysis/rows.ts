import type { Metrics } from '../format.js';
import type { SearchAnalyticsRow } from '../gsc/types.js';

export interface KeyedRow extends Metrics {
  keys: string[];
}

export function toKeyed(rows: SearchAnalyticsRow[] | undefined): KeyedRow[] {
  return (rows ?? []).map((row) => ({
    keys: row.keys ?? [],
    clicks: row.clicks ?? 0,
    impressions: row.impressions ?? 0,
    ctr: row.ctr ?? 0,
    position: row.position ?? 0,
  }));
}

/** The first (and for an undimensioned query, only) row as totals; zeros when there is no data. */
export function totalsOf(rows: SearchAnalyticsRow[] | undefined): Metrics {
  const row = rows?.[0];
  return {
    clicks: row?.clicks ?? 0,
    impressions: row?.impressions ?? 0,
    ctr: row?.ctr ?? 0,
    position: row?.position ?? 0,
  };
}

/**
 * Search Console reports jump links ("/page#section") as separate pages.
 * Dropping the fragment folds them back into the page they belong to.
 */
export function stripFragment(url: string): string {
  const index = url.indexOf('#');
  return index === -1 ? url : url.slice(0, index);
}

/**
 * Merges rows that end up with the same keys after `keyFn`. Clicks and impressions are summed,
 * CTR is recomputed and position is averaged by impressions, which is how Search Console defines it.
 */
export function mergeRows(rows: KeyedRow[], keyFn: (row: KeyedRow) => string[]): KeyedRow[] {
  const merged = new Map<string, { keys: string[]; clicks: number; impressions: number; weighted: number }>();
  for (const row of rows) {
    const keys = keyFn(row);
    const id = keys.join('\u0000');
    const entry = merged.get(id);
    if (entry) {
      entry.clicks += row.clicks;
      entry.impressions += row.impressions;
      entry.weighted += row.position * row.impressions;
    } else {
      merged.set(id, {
        keys,
        clicks: row.clicks,
        impressions: row.impressions,
        weighted: row.position * row.impressions,
      });
    }
  }
  return [...merged.values()].map((entry) => ({
    keys: entry.keys,
    clicks: entry.clicks,
    impressions: entry.impressions,
    ctr: entry.impressions > 0 ? entry.clicks / entry.impressions : 0,
    position: entry.impressions > 0 ? entry.weighted / entry.impressions : 0,
  }));
}

/** Folds "#fragment" variants of a page into one row. `pageIndex` is the position of the page key. */
export function mergePageFragments(rows: KeyedRow[], pageIndex: number): KeyedRow[] {
  if (!rows.some((row) => row.keys[pageIndex]?.includes('#'))) return rows;
  return mergeRows(rows, (row) => row.keys.map((key, index) => (index === pageIndex ? stripFragment(key) : key)));
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] as number)
    : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}
