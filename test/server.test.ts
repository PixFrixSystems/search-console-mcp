import { afterEach, describe, expect, it } from 'vitest';
import { AuthSetupError } from '../src/errors.js';
import { GscClient } from '../src/gsc/client.js';
import type { SearchAnalyticsRequest, SearchAnalyticsRow } from '../src/gsc/types.js';
import { type Harness, harness, records, row } from './helpers.js';

// With the fixed test clock the default period is the 28 days ending 2026-11-11.
const CURRENT_START = '2026-10-15';
const PREVIOUS_START = '2026-09-17';

type Dataset = Record<string, Record<string, SearchAnalyticsRow[]>>;

/** Serves rows by period start date and dimension list, ignoring filters. */
function byPeriod(dataset: Dataset) {
  return (request: SearchAnalyticsRequest) => dataset[request.startDate]?.[(request.dimensions ?? []).join(',')] ?? [];
}

function filterValue(request: SearchAnalyticsRequest, dimension: string): string | undefined {
  return request.dimensionFilterGroups?.[0]?.filters.find((filter) => filter.dimension === dimension)?.expression;
}

let open: Harness | undefined;
async function start(options: Parameters<typeof harness>[0] = {}): Promise<Harness> {
  open = await harness(options);
  return open;
}
afterEach(async () => {
  await open?.close();
  open = undefined;
});

describe('server surface', () => {
  it('exposes read-only tools by default and marks them as such', async () => {
    const { client } = await start();
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'analyze_page',
      'audit_sitemap_indexing',
      'compare_periods',
      'detect_traffic_anomalies',
      'find_content_gaps',
      'find_ctr_opportunities',
      'find_declining_pages',
      'find_keyword_cannibalization',
      'find_quick_wins',
      'get_brand_split',
      'get_performance_overview',
      'inspect_url',
      'inspect_urls',
      'list_sitemaps',
      'list_sites',
      'search_analytics',
    ]);
    for (const tool of tools) {
      expect(tool.annotations?.readOnlyHint, tool.name).toBe(true);
      expect(tool.description?.length, tool.name).toBeGreaterThan(60);
      expect(tool.inputSchema.type).toBe('object');
    }
  });

  it('adds the sitemap write tools only when writing is switched on', async () => {
    const { client } = await start({ config: { allowWrite: true } });
    const { tools } = await client.listTools();
    const submit = tools.find((tool) => tool.name === 'submit_sitemap');
    const remove = tools.find((tool) => tool.name === 'delete_sitemap');
    expect(submit?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(remove?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
  });

  it('sends usage instructions and offers prompts', async () => {
    const { client } = await start();
    expect(client.getInstructions()).toMatch(/Pacific Time/);
    const { prompts } = await client.listPrompts();
    expect(prompts.map((prompt) => prompt.name).sort()).toEqual([
      'content_refresh_plan',
      'diagnose_traffic_drop',
      'indexing_health_check',
      'optimize_page',
      'seo_opportunity_audit',
      'seo_weekly_report',
    ]);
    const prompt = await client.getPrompt({ name: 'seo_weekly_report', arguments: { site: 'example.com', brand_terms: 'Acme, acme corp' } });
    const text = (prompt.messages[0]?.content as { text: string }).text;
    expect(text).toContain('"example.com"');
    expect(text).toContain('brand_terms ["Acme", "acme corp"]');
  });
});

describe('list_sites', () => {
  it('lists properties with type and permission, and names the account', async () => {
    const { call } = await start({
      api: {
        sites: [
          { siteUrl: 'sc-domain:example.com', permissionLevel: 'siteOwner' },
          { siteUrl: 'https://blog.example.org/', permissionLevel: 'siteUnverifiedUser' },
        ],
      },
    });
    const result = await call('list_sites');
    expect(result.account).toEqual({ method: 'service_account', email: 'bot@project.iam.gserviceaccount.com' });
    expect(result.properties.rows).toEqual([
      ['https://blog.example.org/', 'url_prefix', 'siteUnverifiedUser'],
      ['sc-domain:example.com', 'domain', 'siteOwner'],
    ]);
    expect(result.notes[0]).toMatch(/not verified/);
  });

  it('tells a service account user exactly what to add when there are no properties', async () => {
    const { call } = await start({ api: { sites: [] } });
    const result = await call('list_sites');
    expect(result.notes[0]).toContain('add bot@project.iam.gserviceaccount.com as a user');
  });
});

describe('search_analytics', () => {
  it('builds the API request from friendly inputs and returns a compact table', async () => {
    const { call, calls } = await start({
      api: { analytics: () => [row(['seo guide', 'MOBILE'], 12, 400, 4.26), row(['seo tips', 'MOBILE'], 3, 90, 8)] },
    });
    const result = await call('search_analytics', {
      site_url: 'example.com',
      dimensions: ['query', 'device'],
      filters: [
        { dimension: 'device', expression: 'mobile' },
        { dimension: 'page', operator: 'contains', expression: '/blog/' },
      ],
      row_limit: 10,
    });

    const request = calls.find((item) => item.url.endsWith('/searchAnalytics/query'))?.body as SearchAnalyticsRequest;
    expect(request).toMatchObject({
      startDate: CURRENT_START,
      endDate: '2026-11-11',
      dimensions: ['query', 'device'],
      type: 'web',
      dataState: 'all',
      rowLimit: 10,
      startRow: 0,
      dimensionFilterGroups: [
        {
          groupType: 'and',
          filters: [
            { dimension: 'device', operator: 'equals', expression: 'MOBILE' },
            { dimension: 'page', operator: 'contains', expression: '/blog/' },
          ],
        },
      ],
    });
    expect(result.site).toBe('sc-domain:example.com');
    expect(result.period).toEqual({ start_date: CURRENT_START, end_date: '2026-11-11', days: 28 });
    expect(result.rows).toEqual({
      columns: ['query', 'device', 'clicks', 'impressions', 'ctr_pct', 'position'],
      rows: [
        ['seo guide', 'MOBILE', 12, 400, 3, 4.3],
        ['seo tips', 'MOBILE', 3, 90, 3.33, 8],
      ],
    });
    expect(result.has_more).toBe(false);
  });

  it('pages with start_row and reports where to continue', async () => {
    const all = Array.from({ length: 30 }, (_, index) => row([`q${index}`], 30 - index, 100, 5));
    const { call } = await start({ api: { analytics: () => all } });
    const result = await call('search_analytics', { dimensions: ['query'], row_limit: 10, start_row: 10 });
    expect(result.rows.rows[0][0]).toBe('q10');
    expect(result.row_count).toBe(10);
    expect(result).toMatchObject({ has_more: true, next_start_row: 20 });
  });

  it('sorts locally when asked for something other than clicks', async () => {
    const { call } = await start({
      api: { analytics: () => [row(['a'], 50, 100, 2), row(['b'], 10, 9000, 9), row(['c'], 5, 500, 1.2)] },
    });
    const byImpressions = await call('search_analytics', { dimensions: ['query'], order_by: 'impressions', row_limit: 2 });
    expect(byImpressions.rows.rows.map((cells: unknown[]) => cells[0])).toEqual(['b', 'c']);
    const byPosition = await call('search_analytics', { dimensions: ['query'], order_by: 'position' });
    expect(byPosition.rows.rows.map((cells: unknown[]) => cells[0])).toEqual(['c', 'a', 'b']);
  });

  it('switches to hourly data for the hour dimension and ends today', async () => {
    const { call, calls } = await start();
    const result = await call('search_analytics', { dimensions: ['hour'] });
    const request = calls.at(-1)?.body as SearchAnalyticsRequest;
    expect(request).toMatchObject({ dataState: 'hourly_all', startDate: '2026-11-12', endDate: '2026-11-14' });
    expect(result.notes.join(' ')).toMatch(/hourly_all/);
  });

  it('rejects invalid input before calling Google', async () => {
    const { raw, calls } = await start();
    const result = await raw('search_analytics', { dimensions: ['keyword'] });
    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('rejects a misspelled parameter instead of quietly ignoring it', async () => {
    const { raw, calls, client } = await start();
    const result = await raw('search_analytics', {
      dimensions: ['query'],
      filter: [{ dimension: 'page', operator: 'contains', expression: '/blog/' }],
    });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/filter/);
    expect(calls).toHaveLength(0);
    const { tools } = await client.listTools();
    expect(tools.every((tool) => tool.inputSchema.additionalProperties === false)).toBe(true);
  });
});

describe('get_performance_overview and compare_periods', () => {
  const dataset: Dataset = {
    [CURRENT_START]: {
      '': [row([], 1200, 40_000, 8.4)],
      date: [row(['2026-10-15'], 40, 1400, 8.5), row(['2026-10-16'], 44, 1500, 8.3)],
      query: [row(['stayed'], 30, 300, 4), row(['appeared'], 5, 100, 9)],
      page: [row(['https://example.com/a'], 700, 20_000, 6)],
      country: [row(['usa'], 600, 20_000, 7)],
      device: [row(['MOBILE'], 800, 30_000, 9), row(['DESKTOP'], 400, 10_000, 6)],
      searchAppearance: [row(['REVIEW_SNIPPET'], 90, 2_000, 5)],
    },
    [PREVIOUS_START]: {
      '': [row([], 1000, 50_000, 9.1)],
      query: [row(['stayed'], 50, 400, 3), row(['vanished'], 20, 200, 6)],
    },
  };

  it('summarises a property against the previous period', async () => {
    const { call } = await start({ api: { analytics: byPeriod(dataset) } });
    const result = await call('get_performance_overview');
    expect(result.totals).toEqual({ clicks: 1200, impressions: 40_000, ctr_pct: 3, position: 8.4 });
    expect(result.compared_to).toMatchObject({ start_date: PREVIOUS_START, end_date: '2026-10-14', mode: 'previous_period' });
    expect(result.change).toEqual({
      clicks: 200,
      clicks_pct: 20,
      impressions: -10_000,
      impressions_pct: -20,
      ctr_pct_points: 1,
      position: -0.7,
    });
    expect(result.trend.columns[0]).toBe('date');
    expect(result.trend.rows).toHaveLength(2);
    expect(result.devices.rows[0]).toEqual(['MOBILE', 800, 30_000, 2.67, 9]);
    expect(result.search_appearance.rows[0][0]).toBe('REVIEW_SNIPPET');
  });

  it('can skip the comparison', async () => {
    const { call } = await start({ api: { analytics: byPeriod(dataset) } });
    const result = await call('get_performance_overview', { compare_to: 'none' });
    expect(result.change).toBeUndefined();
    expect(result.previous_totals).toBeUndefined();
  });

  it('lists gainers, decliners, new and lost rows', async () => {
    const { call } = await start({ api: { analytics: byPeriod(dataset) } });
    const result = await call('compare_periods', { dimension: 'query' });
    expect(records(result.decliners)).toEqual([
      expect.objectContaining({ query: 'stayed', clicks: 30, clicks_before: 50, clicks_change: -20, position_change: 1 }),
    ]);
    expect(result.gainers.rows).toEqual([]);
    expect(result.new.rows).toEqual([['appeared', 5, 100, 5, 9]]);
    expect(result.lost.rows).toEqual([['vanished', 20, 200, 10, 6]]);
    expect(result.change.clicks).toBe(200);
  });

  it('needs both dates for a custom comparison', async () => {
    const { raw } = await start();
    const result = await raw('compare_periods', { compare_to: 'custom', compare_start_date: '2026-01-01' });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/compare_start_date and compare_end_date/);
  });
});

describe('opportunity tools', () => {
  const queryPages = [
    row(['running shoes', 'https://example.com/shoes'], 20, 2000, 6.2),
    row(['example brand', 'https://example.com/'], 500, 800, 1.1),
    row(['trail shoes', 'https://example.com/trail#sizes'], 1, 400, 11),
    row(['trail shoes', 'https://example.com/trail'], 1, 500, 12),
  ];

  it('find_quick_wins ranks striking-distance keywords by estimated gain', async () => {
    const { call, calls } = await start({ api: { analytics: () => queryPages } });
    const result = await call('find_quick_wins', { brand_terms: ['Example Brand'] });
    expect(result.opportunities).toEqual({
      columns: ['query', 'page', 'clicks', 'impressions', 'ctr_pct', 'position', 'est_extra_clicks'],
      rows: [
        // Both queries are clicked less than their positions normally earn, so the estimates are
        // well below the plain "impressions times position-3 CTR" (200 and 97).
        ['running shoes', 'https://example.com/shoes', 20, 2000, 1, 6.2, 92],
        // The "#sizes" jump link is folded into its page before analysis.
        ['trail shoes', 'https://example.com/trail', 2, 900, 0.22, 11.6, 36],
      ],
    });
    expect(result.estimated_extra_clicks_total).toBe(128);
    expect(result.pages_with_most_potential.rows[0]).toEqual(['https://example.com/shoes', 1, 2000, 92]);
    expect(result.notes.join(' ')).toContain('example brand');
    const request = calls.at(-1)?.body as SearchAnalyticsRequest;
    expect(request).toMatchObject({ dimensions: ['query', 'page'], rowLimit: 25_000 });
  });

  it('find_quick_wins uses GSC_BRAND_TERMS when no terms are passed', async () => {
    const { call } = await start({ api: { analytics: () => queryPages }, config: { brandTerms: ['example brand'] } });
    const withEnv = await call('find_quick_wins', { min_position: 1 });
    expect(withEnv.opportunities.rows.map((cells: unknown[]) => cells[0])).not.toContain('example brand');
  });

  it('find_ctr_opportunities reports weak snippets per page and per query', async () => {
    const { call } = await start({
      api: {
        analytics: () => [
          row(['weak snippet', 'https://example.com/a'], 10, 1000, 2),
          row(['healthy', 'https://example.com/b'], 150, 1000, 2),
        ],
      },
    });
    const result = await call('find_ctr_opportunities');
    expect(records(result.query_page_pairs)).toEqual([
      expect.objectContaining({ query: 'weak snippet', page: 'https://example.com/a', ctr_pct: 1 }),
    ]);
    expect(records(result.pages)).toEqual([expect.objectContaining({ page: 'https://example.com/a', queries: 1, clicks: 10 })]);
    expect(result.ctr_model.expected_ctr_pct_positions_1_to_10).toHaveLength(10);
  });

  it('find_keyword_cannibalization lists the competing pages with their share', async () => {
    const { call } = await start({
      api: {
        analytics: () => [
          row(['pricing', 'https://example.com/pricing'], 5, 600, 3),
          row(['pricing', 'https://example.com/plans'], 5, 400, 4),
          row(['owned', 'https://example.com/a'], 10, 950, 1),
          row(['owned', 'https://example.com/b'], 0, 50, 20),
        ],
      },
    });
    const result = await call('find_keyword_cannibalization');
    expect(result.queries_found).toBe(1);
    expect(result.competing_pages.rows).toEqual([
      ['pricing', 'https://example.com/pricing', null, 60, 5, 600, 0.83, 3],
      ['pricing', 'https://example.com/plans', null, 40, 5, 400, 1.25, 4],
    ]);
    expect(result.notes.join(' ')).not.toMatch(/language versions/);
  });

  it('find_keyword_cannibalization points out pages that are translations of each other', async () => {
    const { call } = await start({
      api: {
        analytics: () => [
          row(['desk height guide', 'https://example.com/guides/desk-height'], 10, 430, 7.6),
          row(['desk height guide', 'https://example.com/es/guias/altura-escritorio'], 3, 70, 3.1),
        ],
      },
    });
    const result = await call('find_keyword_cannibalization');
    expect(result.competing_pages.rows.map((cells: unknown[]) => cells[2])).toEqual([null, 'es']);
    expect(result.notes[0]).toMatch(/different language versions/);
  });

  it('find_content_gaps separates weak rankings from question queries', async () => {
    const { call } = await start({
      api: {
        analytics: () => [
          row(['how to clean running shoes'], 2, 300, 14),
          row(['waterproof hiking boots'], 0, 900, 38),
          row(['shoes'], 40, 2000, 6),
          row(['πώς καθαρίζω παπούτσια'], 1, 120, 9),
        ],
      },
    });
    const english = await call('find_content_gaps');
    expect(english.weakly_served_queries.rows).toEqual([['waterproof hiking boots', 0, 900, 0, 38]]);
    expect(english.question_queries.rows.map((cells: unknown[]) => cells[0])).toEqual(['how to clean running shoes']);

    const greek = await call('find_content_gaps', { question_pattern: '^(πώς|τι|πού|γιατί|πότε)' });
    expect(greek.question_queries.rows.map((cells: unknown[]) => cells[0])).toEqual(['πώς καθαρίζω παπούτσια']);

    const invalid = await open?.raw('find_content_gaps', { question_pattern: '(' });
    expect(invalid?.isError).toBe(true);
  });
});

describe('find_declining_pages', () => {
  const A = 'https://example.com/a';
  const analytics = (request: SearchAnalyticsRequest) => {
    const current = request.startDate === CURRENT_START;
    const page = filterValue(request, 'page');
    if (page === A) {
      return current
        ? [row(['kept query'], 30, 500, 7), row(['other'], 10, 500, 8)]
        : [row(['kept query'], 80, 600, 3), row(['other'], 12, 300, 3), row(['dropped query'], 8, 100, 5)];
    }
    if (page) return [];
    return current
      ? [row([A], 40, 1000, 7.5), row(['https://example.com/b'], 95, 950, 3)]
      : [row([A], 100, 1000, 3), row(['https://example.com/b'], 100, 1000, 3), row(['https://example.com/gone'], 50, 500, 4)];
  };

  it('finds the biggest losers, reads the likely cause and breaks the worst ones down', async () => {
    const { call } = await start({ api: { analytics } });
    const result = await call('find_declining_pages');
    expect(result.declining_found).toBe(2);
    expect(result.clicks_lost_total).toBe(110);
    expect(records(result.declining)).toEqual([
      expect.objectContaining({ page: A, clicks: 40, clicks_before: 100, clicks_change: -60, clicks_change_pct: -60, likely_cause: 'ranking_loss' }),
      expect.objectContaining({ page: 'https://example.com/gone', clicks: 0, clicks_change: -50, position: null, likely_cause: 'no_longer_shown' }),
    ]);
    expect(Object.keys(result.likely_causes).sort()).toEqual(['no_longer_shown', 'ranking_loss']);
    expect(result.breakdowns[0].page).toBe(A);
    expect(result.breakdowns[0].biggest_losses.rows).toEqual([
      ['kept query', 30, 80, -50, 7, 3],
      ['dropped query', 0, 8, -8, null, 5],
      ['other', 10, 12, -2, 8, 3],
    ]);
  });

  it('can skip the breakdowns to save API calls', async () => {
    const { call, calls } = await start({ api: { analytics } });
    const result = await call('find_declining_pages', { explain_top: 0 });
    expect(result.breakdowns).toBeUndefined();
    expect(calls.filter((item) => item.url.endsWith('/searchAnalytics/query'))).toHaveLength(2);
  });
});

describe('get_brand_split', () => {
  it('asks for brand terms when none are known', async () => {
    const { raw } = await start();
    const result = await raw('get_brand_split');
    expect(result.isError).toBe(true);
    expect(result.text).toContain('No brand terms were given.');
    expect(result.text).toContain('How to fix: Pass brand_terms');
  });

  it('splits totals into branded, non-branded and anonymised', async () => {
    const analytics = (request: SearchAnalyticsRequest) => {
      const filter = request.dimensionFilterGroups?.[0]?.filters[0];
      const current = request.startDate === CURRENT_START;
      if (filter?.operator === 'includingRegex') return [row([], current ? 300 : 280, 1000, 1.4)];
      if (filter?.operator === 'excludingRegex') return [row([], current ? 600 : 400, 30_000, 11)];
      return [row([], current ? 1000 : 800, 40_000, 9)];
    };
    const { call, calls } = await start({ api: { analytics } });
    const result = await call('get_brand_split', { brand_terms: ['Acme', 'acme.io'] });

    expect(records(result.segments)).toEqual([
      { segment: 'branded', clicks: 300, share_of_clicks_pct: 30, impressions: 1000, ctr_pct: 30, position: 1.4, clicks_before: 280, clicks_change_pct: 7.1 },
      { segment: 'non_branded', clicks: 600, share_of_clicks_pct: 60, impressions: 30_000, ctr_pct: 2, position: 11, clicks_before: 400, clicks_change_pct: 50 },
      { segment: 'anonymised', clicks: 100, share_of_clicks_pct: 10, impressions: 9000, ctr_pct: 1.11, position: null, clicks_before: 120, clicks_change_pct: -16.7 },
      { segment: 'total', clicks: 1000, share_of_clicks_pct: 100, impressions: 40_000, ctr_pct: 2.5, position: 9, clicks_before: 800, clicks_change_pct: 25 },
    ]);
    expect(result.non_branded_change.clicks_pct).toBe(50);
    const expressions = calls
      .map((item) => (item.body as SearchAnalyticsRequest | undefined)?.dimensionFilterGroups?.[0]?.filters[0]?.expression)
      .filter(Boolean);
    expect(new Set(expressions)).toEqual(new Set(['acme|acme\\.io']));
  });
});

describe('detect_traffic_anomalies', () => {
  it('finds the unusual day in a seasonal series and compares the latest week', async () => {
    // 90 days ending 2026-11-11, weekdays 100 clicks and weekends 40, with one collapsed Tuesday.
    const analytics = (request: SearchAnalyticsRequest) => {
      const rows: SearchAnalyticsRow[] = [];
      for (let date = new Date(`${request.startDate}T00:00:00Z`); date.toISOString().slice(0, 10) <= request.endDate; date.setUTCDate(date.getUTCDate() + 1)) {
        const day = date.toISOString().slice(0, 10);
        const weekend = date.getUTCDay() === 0 || date.getUTCDay() === 6;
        rows.push(row([day], day === '2026-11-03' ? 20 : weekend ? 40 : 100, 2000, 8));
      }
      return rows;
    };
    const { call } = await start({ api: { analytics } });
    const result = await call('detect_traffic_anomalies');
    expect(result.period.days).toBe(90);
    expect(result.anomalies.rows).toEqual([['2026-11-03', 'Tue', 20, 100, -80, 'drop']]);
    expect(result.latest_7_days).toEqual({ value: 580, typical_week: 560, change_pct: 3.6 });
  });
});

describe('indexing tools', () => {
  const indexed = {
    inspectionResultLink: 'https://search.google.com/search-console/inspect?id=1',
    indexStatusResult: {
      verdict: 'PASS',
      coverageState: 'Submitted and indexed',
      pageFetchState: 'SUCCESSFUL',
      lastCrawlTime: '2026-11-02T08:00:00Z',
      googleCanonical: 'https://example.com/a',
      userCanonical: 'https://example.com/a',
    },
  };
  const notIndexed = {
    indexStatusResult: { verdict: 'NEUTRAL', coverageState: 'Crawled - currently not indexed', pageFetchState: 'SUCCESSFUL' },
  };

  it('inspect_url returns a flat summary and works out the property from the URL', async () => {
    const { call } = await start({ api: { inspections: { 'https://example.com/a': indexed } } });
    const result = await call('inspect_url', { url: 'https://example.com/a' });
    expect(result).toMatchObject({
      site: 'sc-domain:example.com',
      url: 'https://example.com/a',
      indexed: true,
      coverage_state: 'Submitted and indexed',
      issues: [],
    });
  });

  it('inspect_url refuses a URL outside the property without spending quota', async () => {
    const { raw, calls } = await start();
    const result = await raw('inspect_url', { site_url: 'example.com', url: 'https://other.org/page' });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/not part of the property sc-domain:example\.com/);
    expect(calls.some((item) => item.url.includes('urlInspection'))).toBe(false);
  });

  it('inspect_urls summarises a batch and keeps going past a failure', async () => {
    const { call } = await start({
      api: { inspections: { 'https://example.com/a': indexed, 'https://example.com/b': notIndexed } },
    });
    const result = await call('inspect_urls', {
      urls: ['https://example.com/a', 'https://example.com/b', 'https://example.com/unknown', 'https://example.com/a'],
    });
    expect(result).toMatchObject({ inspected: 2, indexed: 1, not_indexed: 1, failed: 1 });
    expect(result.results.rows).toHaveLength(3);
    expect(result.results.rows[1][6]).toBe('Not indexed: Crawled - currently not indexed.');
    expect(result.results.rows[2][6]).toMatch(/^Inspection failed:/);
  });

  it('audit_sitemap_indexing reads the submitted sitemaps and inspects a sample', async () => {
    const sitemapFetch = (async (input: string | URL | Request) =>
      String(input) === 'https://example.com/sitemap.xml'
        ? new Response(
            '<urlset><url><loc>https://example.com/a</loc></url><url><loc>https://example.com/b</loc></url><url><loc>https://elsewhere.net/x</loc></url><url><loc>https://example.com/c</loc></url></urlset>',
          )
        : new Response('nope', { status: 404 })) as typeof fetch;
    const { call } = await start({
      api: {
        sitemaps: [{ path: 'https://example.com/sitemap.xml' }],
        inspections: { 'https://example.com/a': indexed, 'https://example.com/b': notIndexed },
      },
      deps: { fetch: sitemapFetch },
    });
    const result = await call('audit_sitemap_indexing', { max_urls: 2 });
    expect(result).toMatchObject({
      sitemaps_read: ['https://example.com/sitemap.xml'],
      urls_in_sitemaps: 4,
      urls_outside_property: 1,
      urls_inspected: 2,
      indexed: 1,
      not_indexed: 1,
      indexed_pct: 50,
    });
    expect(result.by_coverage_state.rows).toEqual(
      expect.arrayContaining([
        ['Submitted and indexed', 1],
        ['Crawled - currently not indexed', 1],
      ]),
    );
    expect(result.problems.rows).toEqual([
      ['https://example.com/b', 'Crawled - currently not indexed', null, 'Not indexed: Crawled - currently not indexed.'],
    ]);
    expect(result.notes[0]).toMatch(/random sample of 2 out of 3 URLs/);
  });

  it('audit_sitemap_indexing explains what to do when nothing is submitted', async () => {
    const { raw } = await start();
    const result = await raw('audit_sitemap_indexing');
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/No sitemaps are submitted/);
  });

  it('list_sitemaps reports state and submitted URL counts', async () => {
    const { call } = await start({
      api: {
        sitemaps: [
          {
            path: 'https://example.com/sitemap.xml',
            type: 'sitemap',
            lastSubmitted: '2026-10-01T00:00:00Z',
            lastDownloaded: '2026-11-10T00:00:00Z',
            errors: '2',
            warnings: '0',
            contents: [
              { type: 'web', submitted: '120' },
              { type: 'image', submitted: '30' },
            ],
          },
        ],
      },
    });
    const result = await call('list_sitemaps');
    expect(records(result.sitemaps)[0]).toMatchObject({
      sitemap: 'https://example.com/sitemap.xml',
      errors: 2,
      warnings: 0,
      submitted_urls: 150,
      contents: 'web: 120, image: 30',
      pending: false,
    });
    expect(result.notes.join(' ')).toMatch(/1 sitemap\(s\) have errors/);
  });

  it('submits and removes sitemaps when writing is switched on', async () => {
    const { call, raw, state } = await start({ config: { allowWrite: true } });
    const submitted = await call('submit_sitemap', { sitemap_url: 'https://example.com/new.xml' });
    expect(submitted.submitted).toBe('https://example.com/new.xml');
    expect(state.sitemaps.map((sitemap) => sitemap.path)).toEqual(['https://example.com/new.xml']);

    const outside = await raw('submit_sitemap', { site_url: 'example.com', sitemap_url: 'https://other.org/s.xml' });
    expect(outside.isError).toBe(true);

    // Google reports success when asked to remove a sitemap that was never submitted, so the tool
    // checks first instead of claiming a removal that did not happen.
    const missing = await raw('delete_sitemap', { sitemap_url: 'https://example.com/never-submitted.xml' });
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain('is not a sitemap submitted for sc-domain:example.com');
    expect(missing.text).toContain('https://example.com/new.xml');
    expect(state.sitemaps).toHaveLength(1);

    await call('delete_sitemap', { sitemap_url: 'https://example.com/new.xml' });
    expect(state.sitemaps).toEqual([]);

    const nothing = await raw('delete_sitemap', { sitemap_url: 'https://example.com/new.xml' });
    expect(nothing.text).toContain('No sitemaps are submitted for this property.');
  });
});

describe('analyze_page', () => {
  const PAGE = 'https://example.com/guide';
  const analytics = (request: SearchAnalyticsRequest) => {
    if (filterValue(request, 'page') !== PAGE) return [];
    const current = request.startDate === CURRENT_START;
    const dimension = (request.dimensions ?? [])[0];
    if (!dimension) return [row([], current ? 90 : 120, 3000, 6)];
    if (dimension === 'query') {
      return current
        ? [row(['seo guide'], 60, 1000, 2.4), row(['seo checklist'], 20, 1500, 8.7), row(['what is seo'], 10, 500, 14)]
        : [row(['seo guide'], 100, 1100, 1.9)];
    }
    if (dimension === 'device') return [row(['MOBILE'], 50, 2000, 7)];
    if (dimension === 'country') return [row(['grc'], 70, 2000, 5)];
    return [row(['2026-10-15'], 3, 100, 6)];
  };

  it('gathers totals, queries, optimisation targets and index status for one URL', async () => {
    const { call } = await start({
      api: { analytics, inspections: { [PAGE]: { indexStatusResult: { verdict: 'PASS', coverageState: 'Submitted and indexed' } } } },
    });
    const result = await call('analyze_page', { page_url: PAGE });
    expect(result.totals.clicks).toBe(90);
    expect(result.change.clicks).toBe(-30);
    expect(result.top_queries.columns).toEqual(['query', 'clicks', 'impressions', 'ctr_pct', 'position', 'clicks_before', 'position_before']);
    expect(result.top_queries.rows[0]).toEqual(['seo guide', 60, 1000, 6, 2.4, 100, 1.9]);
    expect(result.top_queries.rows[1].slice(-2)).toEqual([0, null]);
    expect(result.optimisation_targets.rows.map((cells: unknown[]) => cells[0])).toEqual(['seo checklist', 'what is seo']);
    expect(result.index_status).toMatchObject({ indexed: true });
  });

  it('keeps going when the inspection fails, and flags a URL with no data', async () => {
    const { call } = await start({ api: { analytics: () => [] } });
    const result = await call('analyze_page', { page_url: 'https://example.com/missing' });
    expect(result.index_status.error).toMatch(/404/);
    expect(result.notes[0]).toMatch(/No data for this exact URL/);
  });
});

describe('failures', () => {
  it('turns missing credentials into a tool error that says how to fix it', async () => {
    const client = new GscClient({
      getAccessToken: async () => {
        throw new AuthSetupError('No Google credentials are configured.', 'Set GSC_SERVICE_ACCOUNT_KEY.');
      },
    });
    const { raw } = await start({ deps: { client } });
    const result = await raw('get_performance_overview', { site_url: 'example.com' });
    expect(result.isError).toBe(true);
    expect(result.text).toBe('No Google credentials are configured.\n\nHow to fix: Set GSC_SERVICE_ACCOUNT_KEY.');
  });

  it('lists the available properties when the name does not match', async () => {
    const { raw } = await start();
    const result = await raw('search_analytics', { site_url: 'unknown.io' });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('No Search Console property matches "unknown.io".');
    expect(result.text).toContain('sc-domain:example.com');
  });
});
