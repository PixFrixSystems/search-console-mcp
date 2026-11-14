export type Cell = string | number | boolean | null;

/** A column-oriented table: far fewer tokens than an array of objects with repeated keys. */
export interface Table {
  columns: string[];
  rows: Cell[][];
}

export interface Metrics {
  clicks: number;
  impressions: number;
  /** Fraction between 0 and 1, as the API returns it. */
  ctr: number;
  position: number;
}

export function round(value: number, digits = 0): number {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

/** A 0..1 fraction as a percentage with two decimals. */
export function pct(fraction: number): number {
  return round(fraction * 100, 2);
}

/** Percentage change from `before` to `now`; null when there is nothing to compare against. */
export function pctChange(now: number, before: number): number | null {
  if (before === 0) return null;
  return round(((now - before) / before) * 100, 1);
}

export const METRIC_COLUMNS = ['clicks', 'impressions', 'ctr_pct', 'position'] as const;

export function metricCells(metrics: Metrics): [number, number, number, number] {
  return [round(metrics.clicks), round(metrics.impressions), pct(metrics.ctr), round(metrics.position, 1)];
}

/** Totals as an object. Without impressions there is no CTR or position, so those are null, not 0. */
export function metricObject(metrics: Metrics): {
  clicks: number;
  impressions: number;
  ctr_pct: number | null;
  position: number | null;
} {
  const [clicks, impressions, ctr_pct, position] = metricCells(metrics);
  const seen = metrics.impressions > 0;
  return { clicks, impressions, ctr_pct: seen ? ctr_pct : null, position: seen ? position : null };
}

function isPrimitive(value: unknown): boolean {
  return value === null || typeof value !== 'object';
}

/**
 * JSON that stays valid and readable while keeping each table row on a single line.
 * Arrays of plain values are written inline; everything else is indented by one space per level.
 */
export function compactJson(value: unknown, depth = 0): string {
  const pad = ' '.repeat(depth);
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    if (value.every(isPrimitive)) return JSON.stringify(value.map((item) => item ?? null));
    return `[\n${value.map((item) => `${pad} ${compactJson(item, depth + 1)}`).join(',\n')}\n${pad}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value).filter(([, item]) => item !== undefined);
    if (entries.length === 0) return '{}';
    return `{\n${entries
      .map(([key, item]) => `${pad} ${JSON.stringify(key)}: ${compactJson(item, depth + 1)}`)
      .join(',\n')}\n${pad}}`;
  }
  return JSON.stringify(value ?? null) ?? 'null';
}
