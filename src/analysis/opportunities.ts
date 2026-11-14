import type { Metrics } from '../format.js';
import { type CtrCurve, expectedCtr } from './ctrCurve.js';

/**
 * Pseudo-clicks that pull a query's click propensity toward average until it has data of its own.
 * Three means a query needs about three expected clicks before its own behaviour counts for half.
 * Fewer lets one lucky or unlucky click swing the estimate; more ignores queries that plainly differ.
 */
const PRIOR_CLICKS = 3;
/** No ranking is assumed to convert more than half of its impressions. */
const MAX_TARGET_CTR = 0.5;

/**
 * Extra clicks a row could earn at `targetPosition`, keeping today's impressions.
 *
 * Some searches are clicked far more or less than their position suggests (a results page full of
 * ads and answer boxes, or a query only this site can answer). So the site's typical CTR at the
 * target is scaled by the row's own propensity: its clicks against what its current position would
 * normally earn. The propensity is shrunk toward 1 with a few pseudo-clicks, so a row with a
 * handful of impressions and no clicks is treated as average rather than as hopeless.
 */
export function estimateExtraClicks(row: Metrics, curve: CtrCurve, targetPosition: number): number {
  if (!(row.position > targetPosition) || !(row.impressions > 0)) return 0;
  const expectedNow = row.impressions * expectedCtr(curve, row.position);
  const propensity = (row.clicks + PRIOR_CLICKS) / (expectedNow + PRIOR_CLICKS);
  const targetCtr = Math.min(MAX_TARGET_CTR, expectedCtr(curve, targetPosition) * propensity);
  return Math.max(0, row.impressions * targetCtr - row.clicks);
}

export interface QueryPageRow extends Metrics {
  query: string;
  page: string;
}

export interface StrikingOptions {
  minPosition: number;
  maxPosition: number;
  minImpressions: number;
  /** The position the estimate assumes the page reaches. */
  targetPosition: number;
}

export interface StrikingRow extends QueryPageRow {
  estimatedExtraClicks: number;
}

/**
 * Queries that already rank close to the top and get seen, so a modest ranking gain pays off.
 * The estimate keeps today's impressions, which understates the gain for page-two rankings.
 */
export function findStrikingDistance(rows: QueryPageRow[], curve: CtrCurve, options: StrikingOptions): StrikingRow[] {
  return rows
    .filter(
      (row) =>
        row.position >= options.minPosition &&
        row.position <= options.maxPosition &&
        row.impressions >= options.minImpressions,
    )
    .map((row) => ({ ...row, estimatedExtraClicks: estimateExtraClicks(row, curve, options.targetPosition) }))
    .sort((a, b) => b.estimatedExtraClicks - a.estimatedExtraClicks || b.impressions - a.impressions);
}

export interface CtrGapOptions {
  maxPosition: number;
  minImpressions: number;
  /** Flag rows whose CTR is at or below this share of the expected CTR (0.6 means 40% under). */
  maxRatio: number;
}

export interface CtrGapRow extends QueryPageRow {
  expectedCtr: number;
  /** Actual CTR divided by expected CTR. */
  ratio: number;
  missedClicks: number;
}

/** Query and page pairs that rank well but get clicked far less than the position should earn. */
export function findCtrGaps(rows: QueryPageRow[], curve: CtrCurve, options: CtrGapOptions): CtrGapRow[] {
  const gaps: CtrGapRow[] = [];
  for (const row of rows) {
    if (row.position < 1 || row.position > options.maxPosition || row.impressions < options.minImpressions) continue;
    const expected = expectedCtr(curve, row.position);
    if (expected <= 0) continue;
    const ratio = row.ctr / expected;
    if (ratio > options.maxRatio) continue;
    gaps.push({ ...row, expectedCtr: expected, ratio, missedClicks: row.impressions * expected - row.clicks });
  }
  return gaps.sort((a, b) => b.missedClicks - a.missedClicks);
}

export interface PageCtrGap {
  page: string;
  queries: number;
  clicks: number;
  impressions: number;
  expectedClicks: number;
  ratio: number;
  missedClicks: number;
}

/**
 * The same comparison rolled up per page: expected clicks are summed query by query, which is
 * more reliable than judging a page by its single blended average position.
 */
export function findPageCtrGaps(rows: QueryPageRow[], curve: CtrCurve, options: CtrGapOptions): PageCtrGap[] {
  const pages = new Map<string, PageCtrGap>();
  for (const row of rows) {
    if (row.position < 1 || row.position > options.maxPosition) continue;
    const entry = pages.get(row.page) ?? {
      page: row.page,
      queries: 0,
      clicks: 0,
      impressions: 0,
      expectedClicks: 0,
      ratio: 0,
      missedClicks: 0,
    };
    entry.queries += 1;
    entry.clicks += row.clicks;
    entry.impressions += row.impressions;
    entry.expectedClicks += row.impressions * expectedCtr(curve, row.position);
    pages.set(row.page, entry);
  }
  const gaps: PageCtrGap[] = [];
  for (const entry of pages.values()) {
    if (entry.impressions < options.minImpressions || entry.expectedClicks <= 0) continue;
    entry.ratio = entry.clicks / entry.expectedClicks;
    entry.missedClicks = entry.expectedClicks - entry.clicks;
    if (entry.ratio <= options.maxRatio) gaps.push(entry);
  }
  return gaps.sort((a, b) => b.missedClicks - a.missedClicks);
}
