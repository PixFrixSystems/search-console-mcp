import { afterEach, describe, expect, it } from 'vitest';
import { resolveDateRange } from '../src/dates.js';
import { DataFreshness } from '../src/freshness.js';
import type { SearchAnalyticsRequest, SearchAnalyticsResponse } from '../src/gsc/types.js';
import { type Harness, harness, row, TEST_NOW } from './helpers.js';

// Everything here came out of running against a real property: Google's marker for incomplete data
// is spelled differently from its documentation, the delay is not a fixed three days, a brand-new
// property has no comparison period, and URL inspections are slow.

function probe(response: SearchAnalyticsResponse, clock: { now: Date } = { now: TEST_NOW }) {
  const requests: SearchAnalyticsRequest[] = [];
  const freshness = new DataFreshness(
    {
      querySearchAnalytics: async (_site, request) => {
        requests.push(request);
        return response;
      },
    },
    () => clock.now,
  );
  return { freshness, requests, clock };
}

describe('DataFreshness', () => {
  it('reads the camelCase marker the live API sends', async () => {
    const { freshness, requests } = probe({ metadata: { firstIncompleteDate: '2026-11-11' } });
    expect(await freshness.lastCompleteDate('sc-domain:example.com')).toBe('2026-11-10');
    expect(requests[0]).toMatchObject({
      startDate: '2026-11-04',
      endDate: '2026-11-14',
      dimensions: ['date'],
      dataState: 'all',
    });
  });

  it('also reads the snake_case marker from Google\'s documentation', async () => {
    const { freshness } = probe({ metadata: { first_incomplete_date: '2026-11-12' } });
    expect(await freshness.lastCompleteDate('sc-domain:example.com')).toBe('2026-11-11');
  });

  it('falls back to three days ago when Google sends no marker', async () => {
    const { freshness } = probe({ rows: [] });
    expect(await freshness.lastCompleteDate('sc-domain:example.com')).toBe('2026-11-11');
    const garbled = probe({ metadata: { firstIncompleteDate: 'soon' } });
    expect(await garbled.freshness.lastCompleteDate('sc-domain:example.com')).toBe('2026-11-11');
  });

  it('asks once per property and again after half an hour', async () => {
    const { freshness, requests, clock } = probe({ metadata: { firstIncompleteDate: '2026-11-11' } });
    await freshness.lastCompleteDate('sc-domain:a.com');
    await freshness.lastCompleteDate('sc-domain:a.com');
    expect(requests).toHaveLength(1);
    await freshness.lastCompleteDate('sc-domain:b.com');
    expect(requests).toHaveLength(2);
    clock.now = new Date(TEST_NOW.getTime() + 31 * 60_000);
    await freshness.lastCompleteDate('sc-domain:a.com');
    expect(requests).toHaveLength(3);
  });
});

describe('date words', () => {
  it('accepts "today" and "yesterday" in Pacific Time', () => {
    expect(resolveDateRange({ end_date: 'today', days: 2 }, TEST_NOW)).toEqual({ startDate: '2026-11-13', endDate: '2026-11-14' });
    expect(resolveDateRange({ start_date: 'Yesterday', end_date: 'TODAY' }, TEST_NOW)).toEqual({
      startDate: '2026-11-13',
      endDate: '2026-11-14',
    });
    expect(() => resolveDateRange({ end_date: 'tomorrow' }, TEST_NOW)).toThrow(/"today" \/ "yesterday"/);
  });
});

let open: Harness | undefined;
afterEach(async () => {
  await open?.close();
  open = undefined;
});

describe('periods follow what Google has finished collecting', () => {
  // Google says data is incomplete from the 11th, so the last whole day is the 10th.
  const api = {
    metadata: (request: SearchAnalyticsRequest) =>
      request.dataState === 'all' && request.endDate >= '2026-11-11' ? { firstIncompleteDate: '2026-11-11' } : undefined,
    analytics: (request: SearchAnalyticsRequest) => ((request.dimensions ?? []).length ? [] : [row([], 100, 1000, 5)]),
  };

  it('ends the default period on the last complete day, not on a guess', async () => {
    open = await harness({ api, deps: { freshness: undefined } });
    const result = await open.call('get_performance_overview');
    expect(result.period).toEqual({ start_date: '2026-10-14', end_date: '2026-11-10', days: 28 });
    expect(result.compared_to).toMatchObject({ start_date: '2026-09-16', end_date: '2026-10-13' });
    expect(result.notes.join(' ')).not.toMatch(/still collecting/);
  });

  it('includes recent days when asked, and says they are partial', async () => {
    open = await harness({ api, deps: { freshness: undefined } });
    const result = await open.call('get_performance_overview', { end_date: 'today', days: 7 });
    expect(result.period).toEqual({ start_date: '2026-11-08', end_date: '2026-11-14', days: 7 });
    expect(result.notes[0]).toMatch(/still collecting data from 2026-11-11 onwards/);
    const totals = open.calls.find(
      (call) => (call.body as SearchAnalyticsRequest | undefined)?.startDate === '2026-11-08' && !(call.body as SearchAnalyticsRequest).dimensions,
    );
    expect((totals?.body as SearchAnalyticsRequest).dataState).toBe('all');
  });

  it('explains what "final" leaves out when the period reaches too far', async () => {
    open = await harness({ api, deps: { freshness: undefined } });
    const result = await open.call('search_analytics', { end_date: 'yesterday', days: 5, data_state: 'final' });
    expect(result.notes.join(' ')).toMatch(/nothing after 2026-11-10 is included/);
  });

  it('reports incomplete hours for hourly data', async () => {
    open = await harness({
      api: { metadata: () => ({ firstIncompleteHour: '2026-11-13T21:00:00-08:00' }), analytics: () => [row(['2026-11-13T20:00:00-08:00'], 1, 20, 6)] },
    });
    const result = await open.call('search_analytics', { dimensions: ['hour'] });
    expect(result.notes.join(' ')).toMatch(/Hours from 2026-11-13T21:00:00-08:00 onwards are still incomplete/);
  });
});

describe('a property with little history', () => {
  // Data exists only in the current period, as for a site that launched two weeks ago.
  const young = (request: SearchAnalyticsRequest) => {
    if (request.startDate < '2026-10-15' && request.endDate < '2026-10-15') return [];
    const dimension = (request.dimensions ?? [])[0];
    if (!dimension) return [row([], 495, 6448, 8.3)];
    if (dimension === 'date') {
      return ['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08', '2026-11-09', '2026-11-10', '2026-11-11'].map(
        (date, index) => row([date], 45, 586 + index, 8),
      );
    }
    return [row(['some key'], 100, 900, 6)];
  };

  it('does not present "no earlier data" as a change in CTR or position', async () => {
    open = await harness({ api: { analytics: young } });
    const result = await open.call('get_performance_overview');
    expect(result.previous_totals).toEqual({ clicks: 0, impressions: 0, ctr_pct: null, position: null });
    expect(result.change).toEqual({
      clicks: 495,
      clicks_pct: null,
      impressions: 6448,
      impressions_pct: null,
      ctr_pct_points: null,
      position: null,
    });
    expect(result.notes[0]).toMatch(/comparison period \(2026-09-17 to 2026-10-14\) has no data at all/);
    expect(result.notes[1]).toBe('Only 11 of the 28 days in the period have any impressions; the first is 2026-11-01.');
  });

  it('says so in compare_periods and find_declining_pages too', async () => {
    open = await harness({ api: { analytics: young } });
    const compared = await open.call('compare_periods');
    expect(compared.notes[0]).toMatch(/has no data at all/);
    const declining = await open.call('find_declining_pages');
    expect(declining.declining_found).toBe(0);
    expect(declining.notes[0]).toMatch(/nothing can have declined/);
  });

  it('withholds the "typical week" comparison until there is a baseline', async () => {
    open = await harness({ api: { analytics: young } });
    const result = await open.call('detect_traffic_anomalies');
    expect(result.history_days).toBe(11);
    expect(result.latest_7_days).toEqual({ value: 315, typical_week: null, change_pct: null });
    expect(result.anomalies.rows).toEqual([]);
    expect(result.notes[0]).toMatch(/only has data from 2026-11-01 \(11 days\)/);
  });
});

describe('slow URL inspections', () => {
  const urls = Array.from({ length: 24 }, (_, index) => `https://example.com/page-${index}`);
  const inspections = Object.fromEntries(
    urls.map((url) => [url, { indexStatusResult: { verdict: 'PASS', coverageState: 'Submitted and indexed' } }]),
  );

  it('returns what it finished and lists the rest, instead of running past a client timeout', async () => {
    // Eight run at a time. At 100 ms each with a 150 ms budget, two rounds start and the third does not.
    open = await harness({ api: { inspections, inspectionDelayMs: 100 }, deps: { inspectionBudgetMs: 150 } });
    const result = await open.call('inspect_urls', { urls });
    expect(result.inspected).toBe(16);
    expect(result.not_inspected).toEqual(urls.slice(16));
    expect(result.results.rows).toHaveLength(16);
    expect(result.notes[0]).toMatch(/Call inspect_urls again with the URLs in not_inspected/);
  });

  it('finishes normally inside the budget', async () => {
    open = await harness({ api: { inspections, inspectionDelayMs: 5 } });
    const result = await open.call('inspect_urls', { urls });
    expect(result.inspected).toBe(24);
    expect(result.not_inspected).toBeUndefined();
    expect(result.notes).toBeUndefined();
  });

  it('keeps the sitemap audit honest about a shortened sample', async () => {
    const sitemapFetch = (async () =>
      new Response(`<urlset>${urls.map((url) => `<url><loc>${url}</loc></url>`).join('')}</urlset>`)) as typeof fetch;
    open = await harness({
      api: { inspections, inspectionDelayMs: 100, sitemaps: [{ path: 'https://example.com/sitemap.xml' }] },
      deps: { inspectionBudgetMs: 150, fetch: sitemapFetch },
    });
    const result = await open.call('audit_sitemap_indexing', { max_urls: 24 });
    expect(result.urls_inspected).toBe(16);
    expect(result.indexed_pct).toBe(100);
    expect(result.notes.join(' ')).toMatch(/8 of the 24 chosen URLs were not reached/);
  });
});
