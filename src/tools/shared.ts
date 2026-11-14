import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';
import type { AuthIdentity } from '../auth.js';
import type { Config } from '../config.js';
import {
  addDays,
  type DateInput,
  type DateRange,
  isValidDate,
  previousPeriod,
  rangeLength,
  resolveDateRange,
  yearAgoPeriod,
} from '../dates.js';
import { describeError, UserError } from '../errors.js';
import { type Cell, compactJson, type Metrics, pctChange, round, type Table } from '../format.js';
import type { GscClient } from '../gsc/client.js';
import {
  type AggregationType,
  type DataState,
  type Dimension,
  type DimensionFilter,
  FILTER_DIMENSIONS,
  FILTER_OPERATORS,
  SEARCH_TYPES,
  type SearchAnalyticsRequest,
  type SearchType,
} from '../gsc/types.js';
import type { SiteResolver } from '../sites.js';

export interface ToolDeps {
  config: Config;
  client: GscClient;
  sites: SiteResolver;
  identity: () => Promise<AuthIdentity>;
  /** Tells which day is the latest one Google has complete data for. */
  freshness: { lastCompleteDate(siteUrl: string): Promise<string> };
  now: () => Date;
  /** Stop starting new URL inspections after this long, so one call cannot outlast a client's timeout. */
  inspectionBudgetMs?: number;
  /** Used to download sitemaps; injectable for tests. */
  fetch?: typeof fetch;
  random?: () => number;
}

export const siteUrlField = z
  .string()
  .optional()
  .describe(
    'Search Console property, for example "sc-domain:example.com" or "https://www.example.com/". A bare domain or any page URL on the site also works. Optional when GSC_SITE_URL is set or the account has exactly one property.',
  );

export const dateFields = {
  start_date: z
    .string()
    .optional()
    .describe('First day of the period, YYYY-MM-DD in Pacific Time. Defaults to `days` before end_date.'),
  end_date: z
    .string()
    .optional()
    .describe(
      'Last day of the period, YYYY-MM-DD in Pacific Time, or "today" / "yesterday". Defaults to the latest day Google has complete data for, usually 3 to 4 days ago. A later date includes days that are still incomplete.',
    ),
  days: z
    .number()
    .int()
    .min(1)
    .max(500)
    .optional()
    .describe('Length of the period in days, used when start_date is not given. Default 28.'),
};

export const filterSchema = z.object({
  dimension: z.enum(FILTER_DIMENSIONS),
  operator: z.enum(FILTER_OPERATORS).default('equals'),
  expression: z.string().min(1).max(4096),
});

export const filtersField = z
  .array(filterSchema)
  .max(25)
  .optional()
  .describe(
    'Filters; a row must match all of them. Example: [{"dimension":"page","operator":"contains","expression":"/blog/"},{"dimension":"country","operator":"equals","expression":"usa"}]. Countries are ISO 3166-1 alpha-3 codes, devices are DESKTOP, MOBILE or TABLET, and the regex operators use RE2 syntax.',
  );

export const searchTypeField = z
  .enum(SEARCH_TYPES)
  .default('web')
  .describe('Which Google surface: web (default), image, video, news (the News tab), discover or googleNews.');

export const compareToField = z
  .enum(['previous_period', 'previous_year', 'custom', 'none'])
  .describe(
    'What to compare against: the same number of days immediately before, the same period 52 weeks earlier, a custom range (set compare_start_date and compare_end_date), or nothing.',
  );

/** For tools that are meaningless without a comparison. */
export const requiredCompareToField = z
  .enum(['previous_period', 'previous_year', 'custom'])
  .default('previous_period')
  .describe(
    'What to compare against: the same number of days immediately before (default), the same period 52 weeks earlier, or a custom range (set compare_start_date and compare_end_date).',
  );

export const compareDateFields = {
  compare_start_date: z.string().optional().describe('First day of the comparison period when compare_to is "custom".'),
  compare_end_date: z.string().optional().describe('Last day of the comparison period when compare_to is "custom".'),
};

export const brandTermsField = z
  .array(z.string())
  .max(50)
  .optional()
  .describe('Brand names and their common spellings, for example ["acme", "acme corp"]. Defaults to GSC_BRAND_TERMS.');

export function limitField(defaultValue: number, max: number, what: string) {
  return z.number().int().min(1).max(max).default(defaultValue).describe(`Maximum number of ${what} to return.`);
}

export const scanRowsField = z
  .number()
  .int()
  .min(100)
  .max(100_000)
  .default(25_000)
  .describe(
    'How many rows to read from Search Console before analysing. Google returns rows sorted by clicks, so a larger scan reaches further into low-click, high-impression rows. Each 25,000 rows is one API call.',
  );

export type FilterInput = z.infer<typeof filterSchema>;

function normaliseFilters(filters: FilterInput[] | undefined): DimensionFilter[] {
  return (filters ?? []).map((filter) => ({
    dimension: filter.dimension,
    operator: filter.operator,
    expression: filter.dimension === 'device' ? filter.expression.toUpperCase() : filter.expression,
  }));
}

export interface RequestOptions {
  dimensions?: Dimension[];
  filters?: FilterInput[];
  searchType?: SearchType;
  dataState?: DataState;
  aggregationType?: AggregationType;
}

export function buildRequest(range: DateRange, options: RequestOptions = {}): SearchAnalyticsRequest {
  const filters = normaliseFilters(options.filters);
  return {
    startDate: range.startDate,
    endDate: range.endDate,
    ...(options.dimensions?.length ? { dimensions: options.dimensions } : {}),
    type: options.searchType ?? 'web',
    ...(filters.length ? { dimensionFilterGroups: [{ groupType: 'and' as const, filters }] } : {}),
    ...(options.aggregationType ? { aggregationType: options.aggregationType } : {}),
    // "all" is what the Search Console website shows. For finished days it equals "final"; for
    // recent days it returns the partial numbers instead of silently leaving the day out.
    dataState: options.dataState ?? 'all',
  };
}

export interface Period {
  range: DateRange;
  /** The latest day with complete data for this property. */
  lastComplete: string;
  /** Present when the period reaches into days Google is still collecting. */
  incompleteNote?: string;
}

/**
 * Resolves a tool's date inputs for one property. Without an end date the period ends on the last
 * day Google has complete data for, so default periods and their comparisons only hold whole days.
 */
export async function resolvePeriod(deps: ToolDeps, siteUrl: string, input: DateInput): Promise<Period> {
  const lastComplete = await deps.freshness.lastCompleteDate(siteUrl);
  const range = resolveDateRange({ ...input, end_date: input.end_date ?? lastComplete }, deps.now());
  return {
    range,
    lastComplete,
    ...(range.endDate > lastComplete
      ? {
          incompleteNote: `Search Console is still collecting data from ${addDays(lastComplete, 1)} onwards. Numbers for those days are partial and will rise, so totals and comparisons for this period are provisional.`,
        }
      : {}),
  };
}

export function withFilter(filters: FilterInput[] | undefined, extra: FilterInput): FilterInput[] {
  return [...(filters ?? []), extra];
}

export function periodOf(range: DateRange): { start_date: string; end_date: string; days: number } {
  return { start_date: range.startDate, end_date: range.endDate, days: rangeLength(range) };
}

export type CompareMode = 'previous_period' | 'previous_year' | 'custom' | 'none';

export function resolveComparison(
  range: DateRange,
  mode: CompareMode,
  custom: { compare_start_date?: string; compare_end_date?: string },
): DateRange | undefined {
  if (mode === 'none') return undefined;
  if (mode === 'previous_year') return yearAgoPeriod(range);
  if (mode === 'previous_period') return previousPeriod(range);
  const { compare_start_date: start, compare_end_date: end } = custom;
  if (!start || !end) {
    throw new UserError('compare_to "custom" needs both compare_start_date and compare_end_date.');
  }
  if (!isValidDate(start) || !isValidDate(end) || start > end) {
    throw new UserError('compare_start_date and compare_end_date must be real YYYY-MM-DD dates in order.');
  }
  return { startDate: start, endDate: end };
}

export function table(columns: string[], rows: Cell[][]): Table {
  return { columns, rows };
}

/** How the headline metrics moved between two periods. A negative position change is an improvement. */
export function changeOf(current: Metrics, previous: Metrics) {
  // CTR and position only exist where there were impressions; against an empty period they have no change.
  const comparable = previous.impressions > 0 && current.impressions > 0;
  return {
    clicks: round(current.clicks - previous.clicks),
    clicks_pct: pctChange(current.clicks, previous.clicks),
    impressions: round(current.impressions - previous.impressions),
    impressions_pct: pctChange(current.impressions, previous.impressions),
    ctr_pct_points: comparable ? round((current.ctr - previous.ctr) * 100, 2) : null,
    position: comparable ? round(current.position - previous.position, 1) : null,
  };
}

/** A note for when the comparison period is empty, which usually means the property is newer than that. */
export function emptyComparisonNote(previous: Metrics, comparison: DateRange): string | undefined {
  if (previous.impressions > 0) return undefined;
  return `The comparison period (${comparison.startDate} to ${comparison.endDate}) has no data at all, so there is nothing to compare against. The property is probably newer than that, or was not tracked then. Do not read the change as growth.`;
}

export const NOTES = {
  anonymised:
    'Rows broken down by query leave out anonymised queries (rare searches Google hides for privacy), so they add up to less than the property totals.',
  position:
    'position is the average topmost position the site held when it was shown; lower is better, and a negative change is an improvement.',
  estimate:
    'Click estimates take today\'s impressions and the site\'s typical CTR at the target position, adjusted for how each query is clicked relative to its current position. Treat them as a way to rank opportunities, not as forecasts.',
  rowCap:
    'Google returns rows sorted by clicks. The scan stopped at its row cap, so low-click rows beyond it were not examined; raise scan_rows or add a filter to go deeper.',
  serpFeatures:
    'A low CTR is not always the snippet\'s fault: AI Overviews, ads, featured snippets and sitelinks of other results all take clicks at the same position.',
};

type Shape = Record<string, z.ZodType>;

export interface ToolSpec<S extends Shape> {
  name: string;
  title: string;
  description: string;
  input: S;
  /** "read" (default) never changes anything; "write" adds or updates; "destructive" removes. */
  kind?: 'read' | 'write' | 'destructive';
  run: (args: z.infer<z.ZodObject<S>>) => Promise<unknown>;
}

/**
 * Registers a tool whose result is a JSON document. Failures come back as a readable tool error
 * (with a "How to fix" line when one is known) so the assistant can correct itself or tell the user.
 */
export function defineTool<S extends Shape>(server: McpServer, spec: ToolSpec<S>): void {
  const kind = spec.kind ?? 'read';
  server.registerTool(
    spec.name,
    {
      title: spec.title,
      description: spec.description,
      // Strict, so a misspelled parameter (say "filter" for "filters") is an error the assistant can
      // correct, instead of being dropped and silently returning unfiltered data.
      inputSchema: z.strictObject(spec.input),
      annotations: {
        title: spec.title,
        readOnlyHint: kind === 'read',
        destructiveHint: kind === 'destructive',
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args: unknown) => {
      try {
        const result = await spec.run(args as z.infer<z.ZodObject<S>>);
        return { content: [{ type: 'text' as const, text: compactJson(result) }] };
      } catch (error) {
        if (!(error instanceof UserError)) console.error(`[${spec.name}]`, error);
        return { content: [{ type: 'text' as const, text: describeError(error) }], isError: true };
      }
    },
  );
}
