import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { detectAnomalies, groupEpisodes } from '../analysis/anomalies.js';
import { brandMatcher, brandPattern, normaliseBrandTerms } from '../analysis/brand.js';
import { findCannibalization } from '../analysis/cannibalization.js';
import { compareRows, DECLINE_CAUSES, diagnoseDecline } from '../analysis/compare.js';
import { buildCtrCurve, describeCurve } from '../analysis/ctrCurve.js';
import { summariseInspection } from '../analysis/inspection.js';
import {
  estimateExtraClicks,
  findCtrGaps,
  findPageCtrGaps,
  findStrikingDistance,
  type QueryPageRow,
} from '../analysis/opportunities.js';
import { type KeyedRow, mergePageFragments, toKeyed, totalsOf } from '../analysis/rows.js';
import { type DateRange, eachDate } from '../dates.js';
import { describeError, UserError } from '../errors.js';
import { type Cell, METRIC_COLUMNS, metricCells, metricObject, pct, pctChange, round } from '../format.js';
import type { Dimension, SearchType } from '../gsc/types.js';
import {
  brandTermsField,
  buildRequest,
  changeOf,
  compareDateFields,
  compareToField,
  dateFields,
  defineTool,
  emptyComparisonNote,
  type FilterInput,
  filtersField,
  limitField,
  NOTES,
  periodOf,
  requiredCompareToField,
  resolveComparison,
  resolvePeriod,
  scanRowsField,
  searchTypeField,
  siteUrlField,
  table,
  type ToolDeps,
  withFilter,
} from './shared.js';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

const DEFAULT_QUESTION_PATTERN =
  '^(who|what|when|where|why|how|which|whose|can|could|should|does|do|did|is|are|was|were|will|would)\\b';

interface ScanOptions {
  filters?: FilterInput[];
  searchType: SearchType;
  scanRows: number;
}

/** Reads one row per query and page, with "#fragment" page variants folded together. */
async function scanQueryPages(
  deps: ToolDeps,
  siteUrl: string,
  range: DateRange,
  options: ScanOptions,
): Promise<{ rows: QueryPageRow[]; truncated: boolean }> {
  const result = await deps.client.queryAllRows(
    siteUrl,
    buildRequest(range, { dimensions: ['query', 'page'], filters: options.filters, searchType: options.searchType }),
    options.scanRows,
  );
  const rows = mergePageFragments(toKeyed(result.rows), 1).map((row) => ({
    query: row.keys[0] ?? '',
    page: row.keys[1] ?? '',
    clicks: row.clicks,
    impressions: row.impressions,
    ctr: row.ctr,
    position: row.position,
  }));
  return { rows, truncated: result.truncated };
}

/** The language or region code a URL starts with ("/es/...", "/pt-br/..."), or null when it has none. */
export function localeOf(url: string): string | null {
  try {
    const first = new URL(url).pathname.split('/')[1] ?? '';
    return /^[a-z]{2}(-[a-z]{2})?$/i.test(first) ? first.toLowerCase() : null;
  } catch {
    return null;
  }
}

function brandTermsFor(deps: ToolDeps, given: string[] | undefined): string[] {
  return normaliseBrandTerms(given ?? deps.config.brandTerms);
}

export function registerInsightTools(server: McpServer, deps: ToolDeps): void {
  defineTool(server, {
    name: 'find_quick_wins',
    title: 'Find quick-win keywords',
    description:
      'Finds "striking distance" keywords: queries where a page already ranks just below the top results (positions 4 to 20 by default) and is being seen. These are the cheapest rankings to improve. Returns each query with its page and an estimate of the extra clicks from reaching the target position, plus the pages with the most combined potential.',
    input: {
      site_url: siteUrlField,
      ...dateFields,
      filters: filtersField,
      search_type: searchTypeField,
      min_position: z.number().min(1).max(100).default(4).describe('Best (lowest) average position to include.'),
      max_position: z.number().min(1).max(100).default(20).describe('Worst (highest) average position to include.'),
      min_impressions: z.number().int().min(0).default(30).describe('Ignore rows with fewer impressions than this in the period.'),
      target_position: z.number().min(1).max(10).default(3).describe('The position the click estimate assumes the page reaches.'),
      brand_terms: brandTermsField,
      limit: limitField(50, 500, 'opportunities'),
      scan_rows: scanRowsField,
    },
    run: async (args) => {
      if (args.min_position > args.max_position) throw new UserError('min_position must not be greater than max_position.');
      const site = await deps.sites.resolve(args.site_url);
      const { range, incompleteNote } = await resolvePeriod(deps, site.siteUrl, args);
      const scan = await scanQueryPages(deps, site.siteUrl, range, {
        filters: args.filters,
        searchType: args.search_type,
        scanRows: args.scan_rows,
      });
      const brandTerms = brandTermsFor(deps, args.brand_terms);
      const isBrand = brandMatcher(brandTerms);
      const rows = scan.rows.filter((row) => !isBrand(row.query));
      const curve = buildCtrCurve(rows);
      const found = findStrikingDistance(rows, curve, {
        minPosition: args.min_position,
        maxPosition: args.max_position,
        minImpressions: args.min_impressions,
        targetPosition: args.target_position,
      });

      const byPage = new Map<string, { queries: number; impressions: number; extra: number }>();
      for (const row of found) {
        const entry = byPage.get(row.page) ?? { queries: 0, impressions: 0, extra: 0 };
        entry.queries += 1;
        entry.impressions += row.impressions;
        entry.extra += row.estimatedExtraClicks;
        byPage.set(row.page, entry);
      }
      const pages = [...byPage.entries()].sort((a, b) => b[1].extra - a[1].extra).slice(0, 20);

      const notes = [NOTES.estimate, 'For rankings on page two the real gain is larger, because impressions also rise once a result reaches page one.'];
      if (incompleteNote) notes.unshift(incompleteNote);
      if (scan.truncated) notes.push(NOTES.rowCap);
      if (brandTerms.length) notes.push(`Queries containing a brand term (${brandTerms.join(', ')}) were left out.`);

      return {
        site: site.siteUrl,
        period: periodOf(range),
        criteria: {
          position: `${args.min_position} to ${args.max_position}`,
          min_impressions: args.min_impressions,
          target_position: args.target_position,
        },
        rows_scanned: scan.rows.length,
        opportunities_found: found.length,
        estimated_extra_clicks_total: round(found.reduce((sum, row) => sum + row.estimatedExtraClicks, 0)),
        opportunities: table(
          ['query', 'page', ...METRIC_COLUMNS, 'est_extra_clicks'],
          found.slice(0, args.limit).map((row) => [row.query, row.page, ...metricCells(row), round(row.estimatedExtraClicks)]),
        ),
        pages_with_most_potential: table(
          ['page', 'queries', 'impressions', 'est_extra_clicks'],
          pages.map(([page, entry]) => [page, entry.queries, round(entry.impressions), round(entry.extra)]),
        ),
        ctr_model: describeCurve(curve),
        notes,
      };
    },
  });

  defineTool(server, {
    name: 'find_ctr_opportunities',
    title: 'Find pages with weak click-through',
    description:
      'Finds results that rank well but are clicked much less than their position should earn, judged against the site\'s own CTR-by-position curve. These are candidates for a better title, meta description or structured data. Returns the underperforming pages (rolled up across their queries) and the individual query and page pairs, each with the clicks being missed.',
    input: {
      site_url: siteUrlField,
      ...dateFields,
      filters: filtersField,
      search_type: searchTypeField,
      max_position: z.number().min(1).max(20).default(10).describe('Only consider rankings at this average position or better.'),
      min_impressions: z.number().int().min(0).default(50).describe('Ignore rows with fewer impressions than this in the period.'),
      max_ctr_ratio: z
        .number()
        .min(0.05)
        .max(1)
        .default(0.6)
        .describe('Flag a row when its CTR is at most this fraction of the expected CTR. 0.6 means at least 40% below expected.'),
      brand_terms: brandTermsField,
      limit: limitField(30, 300, 'rows in each list'),
      scan_rows: scanRowsField,
    },
    run: async (args) => {
      const site = await deps.sites.resolve(args.site_url);
      const { range, incompleteNote } = await resolvePeriod(deps, site.siteUrl, args);
      const scan = await scanQueryPages(deps, site.siteUrl, range, {
        filters: args.filters,
        searchType: args.search_type,
        scanRows: args.scan_rows,
      });
      const brandTerms = brandTermsFor(deps, args.brand_terms);
      const isBrand = brandMatcher(brandTerms);
      const rows = scan.rows.filter((row) => !isBrand(row.query));
      const curve = buildCtrCurve(rows);
      const options = {
        maxPosition: args.max_position,
        minImpressions: args.min_impressions,
        maxRatio: args.max_ctr_ratio,
      };
      const pairs = findCtrGaps(rows, curve, options);
      const pages = findPageCtrGaps(rows, curve, options);

      const notes = [NOTES.serpFeatures, NOTES.estimate];
      if (incompleteNote) notes.unshift(incompleteNote);
      if (scan.truncated) notes.push(NOTES.rowCap);
      if (brandTerms.length) notes.push(`Queries containing a brand term (${brandTerms.join(', ')}) were left out.`);

      return {
        site: site.siteUrl,
        period: periodOf(range),
        criteria: {
          max_position: args.max_position,
          min_impressions: args.min_impressions,
          max_ctr_ratio: args.max_ctr_ratio,
        },
        rows_scanned: scan.rows.length,
        pages_found: pages.length,
        pages: table(
          ['page', 'queries', 'clicks', 'impressions', 'expected_clicks', 'ctr_vs_expected_pct', 'missed_clicks'],
          pages
            .slice(0, args.limit)
            .map((page) => [
              page.page,
              page.queries,
              round(page.clicks),
              round(page.impressions),
              round(page.expectedClicks),
              round(page.ratio * 100),
              round(page.missedClicks),
            ]),
        ),
        query_page_pairs_found: pairs.length,
        query_page_pairs: table(
          ['query', 'page', ...METRIC_COLUMNS, 'expected_ctr_pct', 'missed_clicks'],
          pairs
            .slice(0, args.limit)
            .map((row) => [row.query, row.page, ...metricCells(row), pct(row.expectedCtr), round(row.missedClicks)]),
        ),
        ctr_model: describeCurve(curve),
        notes,
      };
    },
  });

  defineTool(server, {
    name: 'find_keyword_cannibalization',
    title: 'Find keyword cannibalization',
    description:
      'Finds queries for which two or more pages of the site each take a meaningful share of the impressions, which often means the pages compete with each other. Returns each query with the competing pages, their share of impressions and their positions, ordered by how many impressions are split away from the strongest page.',
    input: {
      site_url: siteUrlField,
      ...dateFields,
      filters: filtersField,
      search_type: searchTypeField,
      min_impressions: z.number().int().min(0).default(50).describe('Ignore queries with fewer total impressions than this.'),
      min_share_pct: z
        .number()
        .min(1)
        .max(50)
        .default(10)
        .describe('A page counts as competing when it holds at least this percentage of the query\'s impressions.'),
      brand_terms: brandTermsField,
      limit: limitField(25, 200, 'queries'),
      scan_rows: scanRowsField,
    },
    run: async (args) => {
      const site = await deps.sites.resolve(args.site_url);
      const { range, incompleteNote } = await resolvePeriod(deps, site.siteUrl, args);
      const scan = await scanQueryPages(deps, site.siteUrl, range, {
        filters: args.filters,
        searchType: args.search_type,
        scanRows: args.scan_rows,
      });
      const brandTerms = brandTermsFor(deps, args.brand_terms);
      const isBrand = brandMatcher(brandTerms);
      const found = findCannibalization(
        scan.rows.filter((row) => !isBrand(row.query)),
        { minImpressions: args.min_impressions, minShare: args.min_share_pct / 100, maxPages: 5 },
      );

      const cells: Cell[][] = [];
      let translations = false;
      for (const item of found.slice(0, args.limit)) {
        if (new Set(item.pages.map((page) => localeOf(page.page))).size > 1) translations = true;
        for (const page of item.pages) {
          cells.push([
            item.query,
            page.page,
            localeOf(page.page),
            round(page.share * 100),
            round(page.clicks),
            round(page.impressions),
            pct(page.ctr),
            round(page.position, 1),
          ]);
        }
      }

      const notes = [
        'Several pages showing for one query is only a problem when they serve the same intent. If the positions are close or both pages sit low, merge them or make each target a distinct intent. If one page ranks at the top and the other appears beneath it, leave it alone.',
      ];
      if (translations) {
        notes.unshift(
          'Some of these pages are different language versions of each other (see the locale column, taken from the first URL segment). That is a language-targeting question, not duplicate content: check the hreflang tags and which country each version is shown in before merging anything.',
        );
      }
      if (!brandTerms.length) {
        notes.push('Brand searches naturally show several pages. Pass brand_terms (or set GSC_BRAND_TERMS) to leave them out.');
      }
      if (incompleteNote) notes.unshift(incompleteNote);
      if (scan.truncated) notes.push(NOTES.rowCap);

      return {
        site: site.siteUrl,
        period: periodOf(range),
        criteria: { min_impressions: args.min_impressions, min_share_pct: args.min_share_pct },
        rows_scanned: scan.rows.length,
        queries_found: found.length,
        competing_pages: table(
          ['query', 'page', 'locale', 'impression_share_pct', 'clicks', 'impressions', 'ctr_pct', 'position'],
          cells,
        ),
        notes,
      };
    },
  });

  defineTool(server, {
    name: 'find_declining_pages',
    title: 'Find declining pages',
    description:
      'Finds the pages (or queries) that lost the most clicks against a comparison period and gives a first reading of why: a ranking loss, fewer impressions, or a lower click-through rate. For the worst cases it also lists what lost the most underneath (the queries of a page, or the pages of a query). Use it to plan content refreshes and to investigate traffic drops.',
    input: {
      site_url: siteUrlField,
      ...dateFields,
      compare_to: requiredCompareToField,
      ...compareDateFields,
      dimension: z.enum(['page', 'query']).default('page').describe('Look for declining pages or declining queries.'),
      filters: filtersField,
      search_type: searchTypeField,
      min_previous_clicks: z
        .number()
        .int()
        .min(1)
        .default(10)
        .describe('Only consider rows that had at least this many clicks in the comparison period.'),
      min_drop_pct: z.number().min(1).max(100).default(20).describe('Only report rows whose clicks fell by at least this percentage.'),
      limit: limitField(25, 200, 'rows'),
      explain_top: z
        .number()
        .int()
        .min(0)
        .max(10)
        .default(3)
        .describe('For this many of the worst rows, also fetch the breakdown underneath. Each costs two API calls; 0 turns it off.'),
      scan_rows: scanRowsField,
    },
    run: async (args) => {
      const site = await deps.sites.resolve(args.site_url);
      const { range, incompleteNote } = await resolvePeriod(deps, site.siteUrl, args);
      const comparison = resolveComparison(range, args.compare_to, args) as DateRange;
      const dimension = args.dimension as Dimension;
      const options = { filters: args.filters, searchType: args.search_type };
      const prepare = (rows: Parameters<typeof toKeyed>[0]): KeyedRow[] =>
        dimension === 'page' ? mergePageFragments(toKeyed(rows), 0) : toKeyed(rows);

      const [now, before] = await Promise.all([
        deps.client.queryAllRows(site.siteUrl, buildRequest(range, { ...options, dimensions: [dimension] }), args.scan_rows),
        deps.client.queryAllRows(site.siteUrl, buildRequest(comparison, { ...options, dimensions: [dimension] }), args.scan_rows),
      ]);

      const declining = compareRows(prepare(now.rows), prepare(before.rows))
        .filter(
          (row) =>
            row.status !== 'new' &&
            row.previous.clicks >= args.min_previous_clicks &&
            row.clicksChange < 0 &&
            (-row.clicksChange / row.previous.clicks) * 100 >= args.min_drop_pct,
        )
        .sort((a, b) => a.clicksChange - b.clicksChange);
      const shown = declining.slice(0, args.limit);
      const causeOf = (row: (typeof declining)[number]) =>
        row.status === 'lost' ? 'no_longer_shown' : diagnoseDecline(row.current, row.previous);

      const under: Dimension = dimension === 'page' ? 'query' : 'page';
      const breakdowns = await Promise.all(
        shown.slice(0, args.explain_top).map(async (row) => {
          const key = row.keys[0] ?? '';
          const filters = withFilter(args.filters, { dimension: dimension as 'page' | 'query', operator: 'equals', expression: key });
          const request = (period: DateRange) => ({
            ...buildRequest(period, { dimensions: [under], filters, searchType: args.search_type }),
            rowLimit: 1000,
          });
          try {
            const [current, earlier] = await Promise.all([
              deps.client.querySearchAnalytics(site.siteUrl, request(range)),
              deps.client.querySearchAnalytics(site.siteUrl, request(comparison)),
            ]);
            const losers = compareRows(toKeyed(current.rows), toKeyed(earlier.rows))
              .filter((item) => item.clicksChange < 0)
              .sort((a, b) => a.clicksChange - b.clicksChange)
              .slice(0, 8);
            return {
              [dimension]: key,
              biggest_losses: table(
                [under, 'clicks', 'clicks_before', 'clicks_change', 'position', 'position_before'],
                losers.map((item) => [
                  item.keys[0] ?? '',
                  round(item.current.clicks),
                  round(item.previous.clicks),
                  round(item.clicksChange),
                  item.status === 'lost' ? null : round(item.current.position, 1),
                  round(item.previous.position, 1),
                ]),
              ),
            };
          } catch (error) {
            return { [dimension]: key, error: describeError(error) };
          }
        }),
      );

      const causes = new Set(shown.map(causeOf));
      const legend: Record<string, string> = {};
      for (const cause of causes) {
        legend[cause] =
          cause === 'no_longer_shown'
            ? 'No impressions at all in the current period. Check that the URL still resolves, was not redirected or removed, and is still indexed (inspect_url).'
            : DECLINE_CAUSES[cause];
      }

      const notes = [NOTES.position];
      if (incompleteNote) notes.unshift(incompleteNote);
      if ((before.rows ?? []).length === 0) {
        notes.unshift(
          `The comparison period (${comparison.startDate} to ${comparison.endDate}) has no data at all, so nothing can have declined. The property is probably newer than that.`,
        );
      }
      if (dimension === 'query') notes.push(NOTES.anonymised);
      if (now.truncated || before.truncated) notes.push(NOTES.rowCap);

      return {
        site: site.siteUrl,
        period: periodOf(range),
        compared_to: periodOf(comparison),
        criteria: { min_previous_clicks: args.min_previous_clicks, min_drop_pct: args.min_drop_pct },
        declining_found: declining.length,
        clicks_lost_total: round(-declining.reduce((sum, row) => sum + row.clicksChange, 0)),
        declining: table(
          [
            dimension,
            'clicks',
            'clicks_before',
            'clicks_change',
            'clicks_change_pct',
            'impressions',
            'impressions_before',
            'ctr_pct',
            'ctr_pct_before',
            'position',
            'position_before',
            'likely_cause',
          ],
          shown.map((row) => [
            row.keys[0] ?? '',
            round(row.current.clicks),
            round(row.previous.clicks),
            round(row.clicksChange),
            pctChange(row.current.clicks, row.previous.clicks),
            round(row.current.impressions),
            round(row.previous.impressions),
            pct(row.current.ctr),
            pct(row.previous.ctr),
            row.status === 'lost' ? null : round(row.current.position, 1),
            round(row.previous.position, 1),
            causeOf(row),
          ]),
        ),
        likely_causes: legend,
        ...(breakdowns.length ? { breakdowns } : {}),
        notes,
      };
    },
  });

  defineTool(server, {
    name: 'find_content_gaps',
    title: 'Find content gaps and question keywords',
    description:
      'Finds topics the site is visible for but does not serve well: queries with real impressions where the best page ranks beyond the second results page, and question-style queries (who, what, how ...) that suit FAQ sections, how-to content or new articles. Use it to plan new content.',
    input: {
      site_url: siteUrlField,
      ...dateFields,
      filters: filtersField,
      search_type: searchTypeField,
      min_impressions: z.number().int().min(0).default(30).describe('Ignore queries with fewer impressions than this in the period.'),
      weak_position: z
        .number()
        .min(5)
        .max(100)
        .default(20)
        .describe('A query counts as weakly served when the site\'s average position is worse than this.'),
      question_pattern: z
        .string()
        .max(500)
        .optional()
        .describe(
          'Regular expression (JavaScript syntax, case-insensitive) that marks a query as a question. The default matches English question words at the start of the query; pass your own for other languages, for example "^(qué|cómo|dónde|cuándo|por qué|cuál)\\\\b".',
        ),
      brand_terms: brandTermsField,
      limit: limitField(40, 300, 'rows in each list'),
      scan_rows: scanRowsField,
    },
    run: async (args) => {
      let questionTest: RegExp;
      try {
        questionTest = new RegExp(args.question_pattern ?? DEFAULT_QUESTION_PATTERN, 'iu');
      } catch {
        throw new UserError(`question_pattern is not a valid regular expression: ${args.question_pattern}`);
      }
      const site = await deps.sites.resolve(args.site_url);
      const { range, incompleteNote } = await resolvePeriod(deps, site.siteUrl, args);
      const result = await deps.client.queryAllRows(
        site.siteUrl,
        buildRequest(range, { dimensions: ['query'], filters: args.filters, searchType: args.search_type }),
        args.scan_rows,
      );
      const brandTerms = brandTermsFor(deps, args.brand_terms);
      const isBrand = brandMatcher(brandTerms);
      const rows = toKeyed(result.rows).filter(
        (row) => row.impressions >= args.min_impressions && !isBrand(row.keys[0] ?? ''),
      );
      const byImpressions = (a: KeyedRow, b: KeyedRow) => b.impressions - a.impressions;
      const weak = rows.filter((row) => row.position > args.weak_position).sort(byImpressions);
      const questions = rows.filter((row) => questionTest.test(row.keys[0] ?? '')).sort(byImpressions);
      const cells = (list: KeyedRow[]) => list.slice(0, args.limit).map((row) => [row.keys[0] ?? '', ...metricCells(row)]);

      const notes = [
        'weakly_served_queries: Google already connects the site with these searches, but no page ranks well. They are candidates for a new page or for expanding an existing one. To see which page shows today, call search_analytics with a query filter and the page dimension.',
        'question_queries: questions people ask where the site appears. Low positions are openings for a direct answer, an FAQ block or a how-to section.',
        NOTES.anonymised,
      ];
      if (!args.question_pattern) notes.push('The default question pattern is English. Pass question_pattern for other languages.');
      if (incompleteNote) notes.unshift(incompleteNote);
      if (result.truncated) notes.push(NOTES.rowCap);

      return {
        site: site.siteUrl,
        period: periodOf(range),
        criteria: { min_impressions: args.min_impressions, weak_position: args.weak_position },
        rows_scanned: result.rows.length,
        weakly_served_found: weak.length,
        weakly_served_queries: table(['query', ...METRIC_COLUMNS], cells(weak)),
        question_queries_found: questions.length,
        question_queries: table(['query', ...METRIC_COLUMNS], cells(questions)),
        notes,
      };
    },
  });

  defineTool(server, {
    name: 'get_brand_split',
    title: 'Branded versus non-branded search',
    description:
      'Splits search performance into branded queries (containing the brand name), non-branded queries and anonymised queries, with the change against a comparison period. Non-branded traffic is the part SEO work actually wins, so this separates real organic growth from brand demand.',
    input: {
      site_url: siteUrlField,
      ...dateFields,
      compare_to: compareToField.default('previous_period'),
      ...compareDateFields,
      brand_terms: brandTermsField,
      filters: filtersField,
      search_type: searchTypeField,
    },
    run: async (args) => {
      const brandTerms = brandTermsFor(deps, args.brand_terms);
      if (brandTerms.length === 0) {
        throw new UserError(
          'No brand terms were given.',
          'Pass brand_terms, for example ["acme", "acme corp"], or set the GSC_BRAND_TERMS environment variable.',
        );
      }
      const pattern = brandPattern(brandTerms);
      const site = await deps.sites.resolve(args.site_url);
      const { range, incompleteNote } = await resolvePeriod(deps, site.siteUrl, args);
      const comparison = resolveComparison(range, args.compare_to, args);

      const segments = async (period: DateRange) => {
        const run = (filters: FilterInput[] | undefined) =>
          deps.client
            .querySearchAnalytics(site.siteUrl, {
              ...buildRequest(period, { filters, searchType: args.search_type }),
              rowLimit: 1,
            })
            .then((response) => totalsOf(response.rows));
        const [total, brand, nonBrand] = await Promise.all([
          run(args.filters),
          run(withFilter(args.filters, { dimension: 'query', operator: 'includingRegex', expression: pattern })),
          run(withFilter(args.filters, { dimension: 'query', operator: 'excludingRegex', expression: pattern })),
        ]);
        const clicks = Math.max(0, total.clicks - brand.clicks - nonBrand.clicks);
        const impressions = Math.max(0, total.impressions - brand.impressions - nonBrand.impressions);
        const anonymised = { clicks, impressions, ctr: impressions > 0 ? clicks / impressions : 0, position: 0 };
        return { total, brand, nonBrand, anonymised };
      };

      const [current, earlier] = await Promise.all([segments(range), comparison ? segments(comparison) : undefined]);
      const share = (value: number) => (current.total.clicks > 0 ? round((value / current.total.clicks) * 100, 1) : 0);
      const row = (label: string, key: 'brand' | 'nonBrand' | 'anonymised' | 'total'): Cell[] => [
        label,
        round(current[key].clicks),
        share(current[key].clicks),
        round(current[key].impressions),
        pct(current[key].ctr),
        key === 'anonymised' ? null : round(current[key].position, 1),
        ...(earlier
          ? [round(earlier[key].clicks), pctChange(current[key].clicks, earlier[key].clicks)]
          : []),
      ];

      return {
        site: site.siteUrl,
        period: periodOf(range),
        ...(comparison ? { compared_to: periodOf(comparison) } : {}),
        brand_terms: brandTerms,
        segments: table(
          [
            'segment',
            'clicks',
            'share_of_clicks_pct',
            'impressions',
            'ctr_pct',
            'position',
            ...(earlier ? ['clicks_before', 'clicks_change_pct'] : []),
          ],
          [row('branded', 'brand'), row('non_branded', 'nonBrand'), row('anonymised', 'anonymised'), row('total', 'total')],
        ),
        ...(earlier ? { non_branded_change: changeOf(current.nonBrand, earlier.nonBrand) } : {}),
        notes: [
          ...(incompleteNote ? [incompleteNote] : []),
          ...(earlier && comparison ? [emptyComparisonNote(earlier.total, comparison)].filter((note): note is string => !!note) : []),
          'anonymised is what remains after branded and non-branded: searches Google does not report by query, so they cannot be classified.',
          NOTES.position,
        ],
      };
    },
  });

  defineTool(server, {
    name: 'detect_traffic_anomalies',
    title: 'Detect traffic drops and spikes',
    description:
      'Scans the daily trend for days that differ sharply from the same weekday in the preceding weeks, so the weekly rhythm does not trigger false alarms. Returns the unusual days with the expected value and how the latest week compares with a typical one. Use it for monitoring and as the first step when someone asks "did our traffic drop?".',
    input: {
      site_url: siteUrlField,
      end_date: dateFields.end_date,
      days: z.number().int().min(35).max(480).default(90).describe('How many days of history to examine. At least 35 are needed to form a baseline.'),
      metric: z.enum(['clicks', 'impressions']).default('clicks').describe('Which metric to watch.'),
      min_deviation_pct: z
        .number()
        .min(5)
        .max(95)
        .default(30)
        .describe('Smallest deviation from the expected value, in percent, worth reporting.'),
      filters: filtersField,
      search_type: searchTypeField,
    },
    run: async (args) => {
      const site = await deps.sites.resolve(args.site_url);
      const { range, incompleteNote } = await resolvePeriod(deps, site.siteUrl, { end_date: args.end_date, days: args.days });
      const response = await deps.client.querySearchAnalytics(site.siteUrl, {
        ...buildRequest(range, { dimensions: ['date'], filters: args.filters, searchType: args.search_type }),
        rowLimit: 1000,
      });
      const byDate = new Map(toKeyed(response.rows).map((row) => [row.keys[0] ?? '', row[args.metric]]));
      const dates = eachDate(range);
      const series = dates.map((date) => ({ date, value: byDate.get(date) ?? 0 }));
      // A baseline needs about five weeks of data. Before that, "typical" is mostly empty days.
      const firstWithData = dates.find((date) => byDate.has(date));
      const historyDays = firstWithData ? dates.length - dates.indexOf(firstWithData) : 0;
      const established = historyDays >= 35;
      const anomalies = detectAnomalies(series, {
        minDeviation: args.min_deviation_pct / 100,
        lookbackWeeks: 4,
        minBaseline: args.metric === 'clicks' ? 10 : 50,
      });

      const sum = (points: typeof series) => points.reduce((total, point) => total + point.value, 0);
      const latestWeek = sum(series.slice(-7));
      const typicalWeek = sum(series.slice(-35, -7)) / 4;

      return {
        site: site.siteUrl,
        period: periodOf(range),
        metric: args.metric,
        history_days: historyDays,
        latest_7_days: {
          value: round(latestWeek),
          typical_week: established ? round(typicalWeek) : null,
          change_pct: established ? pctChange(latestWeek, typicalWeek) : null,
        },
        episodes: table(
          ['start', 'end', 'direction', 'kind', 'flagged_days', 'largest_deviation_pct'],
          groupEpisodes(anomalies).map((episode) => [
            episode.start,
            episode.end,
            episode.direction,
            episode.flaggedDays > 1 ? 'sustained' : 'single_day',
            episode.flaggedDays,
            round(episode.largestDeviation * 100, 1),
          ]),
        ),
        anomalies_found: anomalies.length,
        anomalies: table(
          ['date', 'weekday', args.metric, 'expected', 'deviation_pct', 'direction'],
          anomalies.map((anomaly) => [
            anomaly.date,
            WEEKDAYS[new Date(`${anomaly.date}T00:00:00Z`).getUTCDay()] ?? '',
            round(anomaly.value),
            round(anomaly.expected),
            round(anomaly.deviation * 100, 1),
            anomaly.direction,
          ]),
        ),
        notes: [
          ...(incompleteNote ? [incompleteNote] : []),
          ...(!firstWithData
            ? ['The property has no data in this period.']
            : !established
              ? [
                  `The property only has data from ${firstWithData} (${historyDays} days). Each day is compared with the same weekday over the previous four weeks, so about five weeks of history are needed before anything can be flagged. Until then, read the trend in get_performance_overview instead.`,
                ]
              : []),
          'expected is the median of the same weekday over the previous four weeks.',
          'To find what moved, run compare_periods or find_declining_pages around the dates above. Check them against Google ranking updates (https://status.search.google.com/summary) and against your own releases.',
          'Read episodes first. A "sustained" episode is traffic moving to a new level and staying there: the days after the change keep being flagged until the baseline catches up, so its start date is when to look for a cause. A "single_day" episode is a one-off.',
          'Small numbers swing by chance (a day that averages 10 clicks lands between 4 and 16 without anything having changed), so low-traffic days are flagged only for large moves.',
        ],
      };
    },
  });

  defineTool(server, {
    name: 'analyze_page',
    title: 'Analyse one page',
    description:
      'Everything Search Console knows about a single page: its totals against a comparison period, the queries it ranks for with their change, the queries worth optimising for (ranked 4 to 20 with the most impressions), devices, countries, the trend, and its index status. Use it before rewriting or refreshing a page.',
    input: {
      site_url: siteUrlField,
      page_url: z.string().url().describe('Full URL of the page, exactly as it appears in Search Console.'),
      ...dateFields,
      compare_to: compareToField.default('previous_period'),
      ...compareDateFields,
      search_type: searchTypeField,
      top_queries: limitField(25, 200, 'queries'),
      include_index_status: z
        .boolean()
        .default(true)
        .describe('Also run a URL inspection for the page (one call against the daily inspection quota).'),
    },
    run: async (args) => {
      const site = await deps.sites.resolve(args.site_url ?? args.page_url);
      const { range, incompleteNote } = await resolvePeriod(deps, site.siteUrl, args);
      const comparison = resolveComparison(range, args.compare_to, args);
      const filters: FilterInput[] = [{ dimension: 'page', operator: 'equals', expression: args.page_url }];
      const query = (dimensions: Dimension[], rowLimit: number, period = range) =>
        deps.client.querySearchAnalytics(site.siteUrl, {
          ...buildRequest(period, { dimensions, filters, searchType: args.search_type }),
          rowLimit,
        });

      const [totals, earlierTotals, queries, earlierQueries, devices, countries, daily, inspection] = await Promise.all([
        query([], 1),
        comparison ? query([], 1, comparison) : undefined,
        query(['query'], 1000),
        comparison ? query(['query'], 1000, comparison) : undefined,
        query(['device'], 10),
        query(['country'], 5),
        query(['date'], 1000),
        args.include_index_status
          ? deps.client
              .inspectUrl(site.siteUrl, args.page_url)
              .then((result) => summariseInspection(args.page_url, result))
              .catch((error: unknown) => ({ error: describeError(error) }))
          : undefined,
      ]);

      const current = totalsOf(totals.rows);
      const queryRows = toKeyed(queries.rows);
      const before = new Map(toKeyed(earlierQueries?.rows).map((row) => [row.keys[0] ?? '', row]));
      const curve = buildCtrCurve(queryRows);
      const targets = queryRows
        .filter((row) => row.position >= 4 && row.position <= 20)
        .sort((a, b) => b.impressions - a.impressions)
        .slice(0, 15);
      const simple = (dimension: string, response: typeof devices) =>
        table(
          [dimension, ...METRIC_COLUMNS],
          toKeyed(response.rows).map((row) => [row.keys[0] ?? '', ...metricCells(row)]),
        );

      const notes = [NOTES.position, NOTES.anonymised];
      if (comparison && earlierTotals && current.impressions > 0) {
        const empty = emptyComparisonNote(totalsOf(earlierTotals.rows), comparison);
        if (empty) notes.unshift(empty);
      }
      if (incompleteNote) notes.unshift(incompleteNote);
      if (current.impressions === 0) {
        notes.unshift(
          'No data for this exact URL in the period. Search Console matches the page URL exactly (protocol, www and trailing slash included). Try search_analytics with a page "contains" filter to find the form it reports.',
        );
      }

      return {
        site: site.siteUrl,
        page: args.page_url,
        period: periodOf(range),
        totals: metricObject(current),
        ...(comparison && earlierTotals
          ? {
              compared_to: periodOf(comparison),
              previous_totals: metricObject(totalsOf(earlierTotals.rows)),
              change: changeOf(current, totalsOf(earlierTotals.rows)),
            }
          : {}),
        queries_found: queryRows.length,
        top_queries: table(
          ['query', ...METRIC_COLUMNS, ...(comparison ? ['clicks_before', 'position_before'] : [])],
          queryRows.slice(0, args.top_queries).map((row) => {
            const earlier = before.get(row.keys[0] ?? '');
            return [
              row.keys[0] ?? '',
              ...metricCells(row),
              ...(comparison ? [earlier ? round(earlier.clicks) : 0, earlier ? round(earlier.position, 1) : null] : []),
            ];
          }),
        ),
        optimisation_targets: table(
          ['query', ...METRIC_COLUMNS, 'est_extra_clicks_at_position_3'],
          targets.map((row) => [
            row.keys[0] ?? '',
            ...metricCells(row),
            round(estimateExtraClicks(row, curve, 3)),
          ]),
        ),
        devices: simple('device', devices),
        countries: simple('country', countries),
        trend: simple('date', daily),
        ...(inspection ? { index_status: inspection } : {}),
        notes,
      };
    },
  });
}
