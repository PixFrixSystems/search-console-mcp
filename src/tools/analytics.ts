import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { compareRows } from '../analysis/compare.js';
import { type KeyedRow, mergePageFragments, toKeyed, totalsOf } from '../analysis/rows.js';
import { addDays, type DateRange, rangeLength, resolveDateRange } from '../dates.js';
import { type Cell, METRIC_COLUMNS, metricCells, metricObject, pct, round } from '../format.js';
import { MAX_ROWS_PER_REQUEST } from '../gsc/client.js';
import { AGGREGATION_TYPES, DATA_STATES, DIMENSIONS, type Dimension, firstIncompleteHour } from '../gsc/types.js';
import { propertyType } from '../sites.js';
import {
  buildRequest,
  changeOf,
  compareDateFields,
  compareToField,
  dateFields,
  defineTool,
  emptyComparisonNote,
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
} from './shared.js';

const SORTABLE = ['clicks', 'impressions', 'ctr', 'position'] as const;

function sortRows(rows: KeyedRow[], metric: (typeof SORTABLE)[number], direction: 'asc' | 'desc'): KeyedRow[] {
  const sign = direction === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => sign * (a[metric] - b[metric]));
}

/** Sums a daily series into weeks (seven-day blocks from the first day) for long periods. */
function weekly(rows: KeyedRow[], startDate: string): Cell[][] {
  const weeks = new Map<string, { clicks: number; impressions: number; weighted: number }>();
  const origin = Date.parse(`${startDate}T00:00:00Z`);
  for (const row of rows) {
    const date = row.keys[0] as string;
    const offset = Math.floor((Date.parse(`${date}T00:00:00Z`) - origin) / (7 * 86_400_000));
    const week = addDays(startDate, offset * 7);
    const entry = weeks.get(week) ?? { clicks: 0, impressions: 0, weighted: 0 };
    entry.clicks += row.clicks;
    entry.impressions += row.impressions;
    entry.weighted += row.position * row.impressions;
    weeks.set(week, entry);
  }
  return [...weeks.entries()].map(([week, entry]) => [
    week,
    round(entry.clicks),
    round(entry.impressions),
    entry.impressions > 0 ? pct(entry.clicks / entry.impressions) : 0,
    entry.impressions > 0 ? round(entry.weighted / entry.impressions, 1) : 0,
  ]);
}

export function registerAnalyticsTools(server: McpServer, deps: ToolDeps): void {
  defineTool(server, {
    name: 'list_sites',
    title: 'List Search Console properties',
    description:
      'Lists every Search Console property the connected Google account can read, with its type and permission level. Call this first when you do not know the exact property name.',
    input: {},
    run: async () => {
      const [sites, identity] = await Promise.all([deps.sites.list(true), deps.identity()]);
      const rows = [...sites]
        .sort((a, b) => a.siteUrl.localeCompare(b.siteUrl))
        .map((site) => [site.siteUrl, propertyType(site.siteUrl), site.permissionLevel]);
      const notes: string[] = [];
      if (sites.some((site) => site.permissionLevel === 'siteUnverifiedUser')) {
        notes.push('Properties with permission "siteUnverifiedUser" are not verified, so they return no data.');
      }
      if (sites.length === 0) {
        notes.push(
          identity.email
            ? `No properties yet. In Search Console open Settings > Users and permissions and add ${identity.email} as a user.`
            : 'No properties yet. Sign in with a Google account that has access to Search Console, or add this account as a user on a property.',
        );
      }
      return {
        account: { method: identity.method, ...(identity.email ? { email: identity.email } : {}) },
        default_site: deps.config.defaultSite ?? null,
        write_tools_enabled: deps.config.allowWrite,
        properties: table(['site_url', 'type', 'permission'], rows),
        ...(notes.length ? { notes } : {}),
      };
    },
  });

  defineTool(server, {
    name: 'search_analytics',
    title: 'Query search performance data',
    description:
      'Runs a raw Search Console performance query: clicks, impressions, CTR and average position, broken down by any mix of query, page, country, device, date, hour and search appearance, with filters. Use it for anything the specialised tools do not cover. Rows come back sorted by clicks unless order_by says otherwise.',
    input: {
      site_url: siteUrlField,
      ...dateFields,
      dimensions: z
        .array(z.enum(DIMENSIONS))
        .max(4)
        .default([])
        .describe(
          'How to break the numbers down, in order. Empty returns one row of totals. "searchAppearance" cannot be combined with other dimensions. "hour" needs data_state "hourly_all" and only covers the last few days.',
        ),
      filters: filtersField,
      search_type: searchTypeField,
      data_state: z
        .enum(DATA_STATES)
        .default('all')
        .describe(
          '"all" (default) matches the Search Console website: complete days, plus partial numbers for recent days if the period reaches that far. "final" leaves out any day that is not final yet. "hourly_all" is for the hour dimension.',
        ),
      aggregation_type: z
        .enum(AGGREGATION_TYPES)
        .optional()
        .describe(
          'How impressions are counted: "byProperty" counts a search once however many of your pages appear, "byPage" counts each page. Leave unset for Google\'s default.',
        ),
      order_by: z
        .enum(SORTABLE)
        .optional()
        .describe(
          'Sort by this metric instead of clicks. The tool then reads up to 25,000 rows and sorts them locally, so "top by impressions" is correct within that scan.',
        ),
      order: z.enum(['asc', 'desc']).optional().describe('Sort direction. Default desc, or asc for position (best first).'),
      row_limit: z.number().int().min(1).max(100_000).default(100).describe('Maximum number of rows to return.'),
      start_row: z.number().int().min(0).default(0).describe('Zero-based offset, for paging through results.'),
    },
    run: async (args) => {
      const site = await deps.sites.resolve(args.site_url);
      const dimensions = args.dimensions as Dimension[];
      const hourly = dimensions.includes('hour');
      const dataState = hourly ? 'hourly_all' : args.data_state;
      // Hourly data only exists for the last few days, so it defaults to the three days ending today.
      const period = hourly
        ? { range: resolveDateRange({ ...args, days: args.days ?? 3 }, deps.now(), 0), lastComplete: undefined, incompleteNote: undefined }
        : await resolvePeriod(deps, site.siteUrl, args);
      const { range } = period;
      const request = buildRequest(range, {
        dimensions,
        filters: args.filters,
        searchType: args.search_type,
        dataState,
        aggregationType: args.aggregation_type,
      });

      const timeSeries = dimensions[0] === 'date' || dimensions[0] === 'hour';
      const localSort = args.order_by !== undefined && !(args.order_by === 'clicks' && args.order !== 'asc');
      let rows: KeyedRow[];
      let hasMore: boolean;
      let metadata;

      if (localSort && !timeSeries && args.order_by) {
        const result = await deps.client.queryAllRows(site.siteUrl, request, MAX_ROWS_PER_REQUEST);
        const direction = args.order ?? (args.order_by === 'position' ? 'asc' : 'desc');
        const sorted = sortRows(toKeyed(result.rows), args.order_by, direction);
        rows = sorted.slice(args.start_row, args.start_row + args.row_limit);
        hasMore = result.truncated || sorted.length > args.start_row + args.row_limit;
        metadata = result.metadata;
      } else {
        const result = await deps.client.queryAllRows(
          site.siteUrl,
          { ...request, startRow: args.start_row },
          args.row_limit,
        );
        rows = toKeyed(result.rows);
        hasMore = result.truncated;
        metadata = result.metadata;
      }

      const notes: string[] = [];
      if (dimensions.includes('query')) notes.push(NOTES.anonymised);
      if (hourly && args.data_state !== 'hourly_all') notes.push('data_state was switched to "hourly_all", which the hour dimension requires.');
      if (hourly) {
        const hour = firstIncompleteHour(metadata);
        notes.push(
          hour
            ? `Hours from ${hour} onwards are still incomplete and will change.`
            : 'The most recent hours may still change.',
        );
      } else if (dataState === 'final' && period.lastComplete && range.endDate > period.lastComplete) {
        notes.push(
          `data_state "final" leaves out days that are not final yet, so nothing after ${period.lastComplete} is included. Use "all" to see the partial numbers.`,
        );
      } else if (period.incompleteNote) {
        notes.push(period.incompleteNote);
      }
      if (localSort && hasMore) {
        notes.push('The local sort covers the first 25,000 rows by clicks. Add filters to make the ranking exhaustive.');
      }

      return {
        site: site.siteUrl,
        period: periodOf(range),
        search_type: args.search_type,
        data_state: dataState,
        row_count: rows.length,
        has_more: hasMore,
        ...(hasMore && !localSort ? { next_start_row: args.start_row + rows.length } : {}),
        rows: table(
          [...dimensions, ...METRIC_COLUMNS],
          rows.map((row) => [...row.keys, ...metricCells(row)]),
        ),
        ...(notes.length ? { notes } : {}),
      };
    },
  });

  defineTool(server, {
    name: 'get_performance_overview',
    title: 'Performance overview',
    description:
      'One-call snapshot of a property: total clicks, impressions, CTR and position against a comparison period, the trend over time, and the top queries, pages, countries, devices and search appearances. The best starting point for a report or before digging into a specific question.',
    input: {
      site_url: siteUrlField,
      ...dateFields,
      compare_to: compareToField.default('previous_period'),
      ...compareDateFields,
      filters: filtersField,
      search_type: searchTypeField,
      top: limitField(10, 50, 'rows in each top list'),
    },
    run: async (args) => {
      const site = await deps.sites.resolve(args.site_url);
      const { range, incompleteNote } = await resolvePeriod(deps, site.siteUrl, args);
      const comparison = resolveComparison(range, args.compare_to, args);
      const base = { filters: args.filters, searchType: args.search_type };
      const query = (dimensions: Dimension[], rowLimit: number, period = range) =>
        deps.client.querySearchAnalytics(site.siteUrl, { ...buildRequest(period, { ...base, dimensions }), rowLimit });

      const [totals, previous, daily, queries, pages, countries, devices, appearance] = await Promise.all([
        query([], 1),
        comparison ? query([], 1, comparison) : Promise.resolve(undefined),
        query(['date'], 1000),
        query(['query'], args.top),
        query(['page'], args.top),
        query(['country'], args.top),
        query(['device'], 10),
        // Search appearance is not available for every search type or filter; treat a failure as "no data".
        query(['searchAppearance'], args.top).catch(() => undefined),
      ]);

      const current = totalsOf(totals.rows);
      const dailyRows = toKeyed(daily.rows);
      const list = (dimension: string, response: typeof queries | undefined) =>
        table(
          [dimension, ...METRIC_COLUMNS],
          toKeyed(response?.rows).map((row) => [row.keys[0] ?? '', ...metricCells(row)]),
        );
      const useWeeks = rangeLength(range) > 92;

      const notes: string[] = [];
      if (incompleteNote) notes.push(incompleteNote);
      if (comparison && previous) {
        const empty = emptyComparisonNote(totalsOf(previous.rows), comparison);
        if (empty) notes.push(empty);
      }
      if (dailyRows.length > 0 && dailyRows.length < rangeLength(range)) {
        notes.push(
          `Only ${dailyRows.length} of the ${rangeLength(range)} days in the period have any impressions; the first is ${dailyRows[0]?.keys[0]}.`,
        );
      }
      notes.push(NOTES.position, NOTES.anonymised);

      return {
        site: site.siteUrl,
        period: periodOf(range),
        search_type: args.search_type,
        totals: metricObject(current),
        ...(comparison && previous
          ? {
              compared_to: { ...periodOf(comparison), mode: args.compare_to },
              previous_totals: metricObject(totalsOf(previous.rows)),
              change: changeOf(current, totalsOf(previous.rows)),
            }
          : {}),
        trend: useWeeks
          ? table(['week_starting', ...METRIC_COLUMNS], weekly(dailyRows, range.startDate))
          : table(
              ['date', ...METRIC_COLUMNS],
              dailyRows.map((row) => [row.keys[0] ?? '', ...metricCells(row)]),
            ),
        top_queries: list('query', queries),
        top_pages: list('page', pages),
        countries: list('country', countries),
        devices: list('device', devices),
        search_appearance: list('search_appearance', appearance),
        notes,
      };
    },
  });

  defineTool(server, {
    name: 'compare_periods',
    title: 'Compare two periods',
    description:
      'Compares two periods row by row for one dimension (queries, pages, countries, devices or search appearances) and returns the biggest gainers and decliners plus what is new and what disappeared. Use it to explain why traffic moved.',
    input: {
      site_url: siteUrlField,
      ...dateFields,
      compare_to: requiredCompareToField,
      ...compareDateFields,
      dimension: z
        .enum(['query', 'page', 'country', 'device', 'searchAppearance'])
        .default('query')
        .describe('What to compare.'),
      filters: filtersField,
      search_type: searchTypeField,
      sort_by: z
        .enum(['clicks', 'impressions'])
        .default('clicks')
        .describe('Rank gainers and decliners by change in this metric.'),
      limit: limitField(25, 200, 'rows in each list'),
      scan_rows: scanRowsField,
    },
    run: async (args) => {
      const site = await deps.sites.resolve(args.site_url);
      const { range, incompleteNote } = await resolvePeriod(deps, site.siteUrl, args);
      const comparison = resolveComparison(range, args.compare_to, args) as DateRange;
      const dimension = args.dimension as Dimension;
      const options = { filters: args.filters, searchType: args.search_type };

      const [nowRows, beforeRows, nowTotals, beforeTotals] = await Promise.all([
        deps.client.queryAllRows(site.siteUrl, buildRequest(range, { ...options, dimensions: [dimension] }), args.scan_rows),
        deps.client.queryAllRows(
          site.siteUrl,
          buildRequest(comparison, { ...options, dimensions: [dimension] }),
          args.scan_rows,
        ),
        deps.client.querySearchAnalytics(site.siteUrl, { ...buildRequest(range, options), rowLimit: 1 }),
        deps.client.querySearchAnalytics(site.siteUrl, { ...buildRequest(comparison, options), rowLimit: 1 }),
      ]);

      const prepare = (rows: typeof nowRows.rows) =>
        dimension === 'page' ? mergePageFragments(toKeyed(rows), 0) : toKeyed(rows);
      const compared = compareRows(prepare(nowRows.rows), prepare(beforeRows.rows));
      const metric = args.sort_by === 'impressions' ? 'impressionsChange' : 'clicksChange';
      const both = compared.filter((row) => row.status === 'both');

      const changeColumns = [
        dimension,
        'clicks',
        'clicks_before',
        'clicks_change',
        'impressions',
        'impressions_before',
        'ctr_pct',
        'ctr_pct_before',
        'position',
        'position_before',
        'position_change',
      ];
      const changeCells = (row: (typeof compared)[number]): Cell[] => [
        row.keys[0] ?? '',
        round(row.current.clicks),
        round(row.previous.clicks),
        round(row.clicksChange),
        round(row.current.impressions),
        round(row.previous.impressions),
        pct(row.current.ctr),
        pct(row.previous.ctr),
        round(row.current.position, 1),
        round(row.previous.position, 1),
        row.positionChange === null ? null : round(row.positionChange, 1),
      ];

      const gainers = both
        .filter((row) => row[metric] > 0)
        .sort((a, b) => b[metric] - a[metric])
        .slice(0, args.limit);
      const decliners = both
        .filter((row) => row[metric] < 0)
        .sort((a, b) => a[metric] - b[metric])
        .slice(0, args.limit);
      const appeared = compared
        .filter((row) => row.status === 'new')
        .sort((a, b) => b.current.clicks - a.current.clicks || b.current.impressions - a.current.impressions)
        .slice(0, args.limit);
      const disappeared = compared
        .filter((row) => row.status === 'lost')
        .sort((a, b) => b.previous.clicks - a.previous.clicks || b.previous.impressions - a.previous.impressions)
        .slice(0, args.limit);

      const current = totalsOf(nowTotals.rows);
      const earlier = totalsOf(beforeTotals.rows);

      const notes: string[] = [];
      if (incompleteNote) notes.push(incompleteNote);
      const empty = emptyComparisonNote(earlier, comparison);
      if (empty) notes.push(empty);
      notes.push(NOTES.position);
      if (dimension === 'query') notes.push(NOTES.anonymised);
      if (nowRows.truncated || beforeRows.truncated) {
        notes.push(
          `${NOTES.rowCap} Rows listed as new or lost may simply have fallen outside the scan in one of the periods.`,
        );
      }

      return {
        site: site.siteUrl,
        period: periodOf(range),
        compared_to: { ...periodOf(comparison), mode: args.compare_to },
        totals: metricObject(current),
        previous_totals: metricObject(earlier),
        change: changeOf(current, earlier),
        gainers: table(changeColumns, gainers.map(changeCells)),
        decliners: table(changeColumns, decliners.map(changeCells)),
        new: table(
          [dimension, ...METRIC_COLUMNS],
          appeared.map((row) => [row.keys[0] ?? '', ...metricCells(row.current)]),
        ),
        lost: table(
          [dimension, 'clicks_before', 'impressions_before', 'ctr_pct_before', 'position_before'],
          disappeared.map((row) => [row.keys[0] ?? '', ...metricCells(row.previous)]),
        ),
        notes,
      };
    },
  });
}
