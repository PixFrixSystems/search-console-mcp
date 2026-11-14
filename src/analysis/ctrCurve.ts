import { type Metrics, pct, round } from '../format.js';

const POSITIONS = 20;

/**
 * Rough cross-industry organic click-through rates for positions 1 to 20.
 * Only used to fill in positions where the site itself has too few impressions to say anything.
 */
export const BENCHMARK_CTR: readonly number[] = [
  0.28, 0.155, 0.11, 0.08, 0.06, 0.047, 0.038, 0.031, 0.026, 0.022, 0.015, 0.013, 0.012, 0.011, 0.01, 0.009, 0.008,
  0.008, 0.007, 0.007,
];

export interface CtrCurve {
  /** Expected CTR (0..1) per position; index 0 is position 1. */
  ctr: number[];
  /** The site's own impressions behind each position. */
  impressions: number[];
  /** How much of each point comes from the site's data (1) rather than the benchmark (0). */
  siteWeight: number[];
}

/** Pool-adjacent-violators: the closest sequence that never rises as the position gets worse. */
function enforceNonIncreasing(values: number[], weights: number[]): number[] {
  const blocks: { sum: number; weight: number; count: number }[] = [];
  values.forEach((value, index) => {
    const weight = weights[index] ?? 1;
    blocks.push({ sum: value * weight, weight, count: 1 });
    while (blocks.length > 1) {
      const last = blocks[blocks.length - 1] as (typeof blocks)[number];
      const previous = blocks[blocks.length - 2] as (typeof blocks)[number];
      if (last.sum / last.weight <= previous.sum / previous.weight) break;
      previous.sum += last.sum;
      previous.weight += last.weight;
      previous.count += last.count;
      blocks.pop();
    }
  });
  return blocks.flatMap((block) => Array<number>(block.count).fill(block.sum / block.weight));
}

/**
 * Builds the site's own "CTR by position" curve from query level rows.
 *
 * Each position blends the site's observed CTR with the benchmark, weighted by how many impressions
 * the site has there (full trust at `fullWeightImpressions`). A site with little data therefore gets
 * a sensible curve instead of noise, and a large site gets a curve that reflects its own SERPs.
 */
export function buildCtrCurve(rows: Metrics[], options: { fullWeightImpressions?: number } = {}): CtrCurve {
  const fullWeight = options.fullWeightImpressions ?? 1000;
  const clicks = Array<number>(POSITIONS).fill(0);
  const impressions = Array<number>(POSITIONS).fill(0);

  for (const row of rows) {
    const bucket = Math.round(row.position);
    if (bucket < 1 || bucket > POSITIONS || !(row.impressions > 0)) continue;
    clicks[bucket - 1] = (clicks[bucket - 1] as number) + row.clicks;
    impressions[bucket - 1] = (impressions[bucket - 1] as number) + row.impressions;
  }

  const siteWeight = impressions.map((count) => Math.min(1, count / fullWeight));
  const blended = impressions.map((count, index) => {
    const observed = count > 0 ? (clicks[index] as number) / count : 0;
    const weight = siteWeight[index] as number;
    return weight * observed + (1 - weight) * (BENCHMARK_CTR[index] as number);
  });

  const ctr = enforceNonIncreasing(
    blended,
    impressions.map((count) => count + fullWeight),
  );
  return { ctr, impressions, siteWeight };
}

/** Expected CTR (0..1) at a possibly fractional average position. */
export function expectedCtr(curve: CtrCurve, position: number): number {
  const last = curve.ctr[POSITIONS - 1] as number;
  if (!(position >= 1)) return curve.ctr[0] as number;
  if (position >= POSITIONS) return last * (POSITIONS / position);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const fraction = position - lower;
  return (curve.ctr[lower - 1] as number) * (1 - fraction) + (curve.ctr[upper - 1] as number) * fraction;
}

/** A short description of the curve for tool output, so the reader can judge how far to trust it. */
export function describeCurve(curve: CtrCurve): {
  expected_ctr_pct_positions_1_to_10: number[];
  based_on_site_data_pct: number;
} {
  const top = curve.siteWeight.slice(0, 10);
  const share = top.reduce((sum, weight) => sum + weight, 0) / top.length;
  return {
    expected_ctr_pct_positions_1_to_10: curve.ctr.slice(0, 10).map(pct),
    based_on_site_data_pct: round(share * 100),
  };
}
