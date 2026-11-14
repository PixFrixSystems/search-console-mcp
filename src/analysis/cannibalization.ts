import type { QueryPageRow } from './opportunities.js';

export interface CannibalizationOptions {
  /** Ignore queries with fewer total impressions than this. */
  minImpressions: number;
  /** A page counts as competing when it holds at least this share (0..1) of the query's impressions. */
  minShare: number;
  /** How many pages to list per query. */
  maxPages: number;
}

export interface CompetingPage {
  page: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
  /** This page's share (0..1) of the query's impressions. */
  share: number;
}

export interface CannibalizedQuery {
  query: string;
  clicks: number;
  impressions: number;
  competingPages: number;
  /** Impressions that did not go to the strongest page: the size of the split. */
  splitImpressions: number;
  pages: CompetingPage[];
}

/**
 * Queries for which two or more of the site's pages each take a real share of the impressions.
 * Expects one row per query and page, with "#fragment" page variants already merged.
 */
export function findCannibalization(rows: QueryPageRow[], options: CannibalizationOptions): CannibalizedQuery[] {
  const byQuery = new Map<string, QueryPageRow[]>();
  for (const row of rows) {
    const group = byQuery.get(row.query);
    if (group) group.push(row);
    else byQuery.set(row.query, [row]);
  }

  const results: CannibalizedQuery[] = [];
  for (const [query, group] of byQuery) {
    if (group.length < 2) continue;
    const impressions = group.reduce((sum, row) => sum + row.impressions, 0);
    if (impressions < options.minImpressions) continue;

    const pages = group
      .map((row) => ({
        page: row.page,
        clicks: row.clicks,
        impressions: row.impressions,
        ctr: row.ctr,
        position: row.position,
        share: row.impressions / impressions,
      }))
      .sort((a, b) => b.impressions - a.impressions);

    const competing = pages.filter((page) => page.share >= options.minShare);
    if (competing.length < 2) continue;

    results.push({
      query,
      clicks: group.reduce((sum, row) => sum + row.clicks, 0),
      impressions,
      competingPages: competing.length,
      splitImpressions: impressions - (pages[0] as CompetingPage).impressions,
      pages: pages.slice(0, options.maxPages),
    });
  }
  return results.sort((a, b) => b.splitImpressions - a.splitImpressions);
}
