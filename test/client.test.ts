import { describe, expect, it } from 'vitest';
import { GscApiError } from '../src/errors.js';
import { GscClient } from '../src/gsc/client.js';
import { jsonResponse, row } from './helpers.js';

function client(responses: (() => Response | Promise<Response>)[]) {
  const requests: { url: string; init: RequestInit }[] = [];
  const sleeps: number[] = [];
  let index = 0;
  const gsc = new GscClient({
    getAccessToken: async () => 'token-123',
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(input), init: init ?? {} });
      const next = responses[Math.min(index, responses.length - 1)];
      index += 1;
      if (!next) throw new Error('no response configured');
      return next();
    }) as typeof fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    baseDelayMs: 100,
  });
  return { gsc, requests, sleeps };
}

const RANGE = { startDate: '2026-10-01', endDate: '2026-10-28' };

describe('GscClient requests', () => {
  it('sends the bearer token and encodes the property in the path', async () => {
    const { gsc, requests } = client([() => jsonResponse({ rows: [row(['a'], 1, 10, 3)] })]);
    await gsc.querySearchAnalytics('sc-domain:example.com', { ...RANGE, dimensions: ['query'] });
    expect(requests[0]?.url).toBe(
      'https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Aexample.com/searchAnalytics/query',
    );
    const headers = requests[0]?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer token-123');
    expect(JSON.parse(requests[0]?.init.body as string)).toEqual({ ...RANGE, dimensions: ['query'] });
  });

  it('encodes URL-prefix properties and sitemap paths', async () => {
    const { gsc, requests } = client([() => new Response(null, { status: 204 })]);
    await gsc.submitSitemap('https://example.com/', 'https://example.com/sitemap.xml');
    expect(requests[0]?.init.method).toBe('PUT');
    expect(requests[0]?.url).toBe(
      'https://www.googleapis.com/webmasters/v3/sites/https%3A%2F%2Fexample.com%2F/sitemaps/https%3A%2F%2Fexample.com%2Fsitemap.xml',
    );
  });

  it('returns an empty list when the account has no properties', async () => {
    const { gsc } = client([() => jsonResponse({})]);
    expect(await gsc.listSites()).toEqual([]);
  });

  it('posts URL inspections to the v1 endpoint', async () => {
    const { gsc, requests } = client([() => jsonResponse({ inspectionResult: { indexStatusResult: { verdict: 'PASS' } } })]);
    const result = await gsc.inspectUrl('sc-domain:example.com', 'https://example.com/a', 'el');
    expect(result.indexStatusResult?.verdict).toBe('PASS');
    expect(requests[0]?.url).toBe('https://searchconsole.googleapis.com/v1/urlInspection/index:inspect');
    expect(JSON.parse(requests[0]?.init.body as string)).toEqual({
      inspectionUrl: 'https://example.com/a',
      siteUrl: 'sc-domain:example.com',
      languageCode: 'el',
    });
  });
});

describe('GscClient paging', () => {
  const page = (count: number, offset: number) => Array.from({ length: count }, (_, index) => row([`q${offset + index}`], 1, 1, 1));

  it('keeps asking until Google runs out of rows', async () => {
    const { gsc, requests } = client([
      () => jsonResponse({ rows: page(25_000, 0) }),
      () => jsonResponse({ rows: page(1_200, 25_000) }),
    ]);
    const result = await gsc.queryAllRows('sc-domain:example.com', RANGE, 60_000);
    expect(result.rows).toHaveLength(26_200);
    expect(result.truncated).toBe(false);
    const bodies = requests.map((request) => JSON.parse(request.init.body as string));
    expect(bodies.map((body) => [body.startRow, body.rowLimit])).toEqual([
      [0, 25_000],
      [25_000, 25_000],
    ]);
  });

  it('stops at the cap and says more rows may exist', async () => {
    const { gsc, requests } = client([() => jsonResponse({ rows: page(100, 0) })]);
    const result = await gsc.queryAllRows('sc-domain:example.com', RANGE, 100);
    expect(result.rows).toHaveLength(100);
    expect(result.truncated).toBe(true);
    expect(requests).toHaveLength(1);
  });

  it('handles a response with no rows', async () => {
    const { gsc } = client([() => jsonResponse({})]);
    expect(await gsc.queryAllRows('sc-domain:example.com', RANGE, 100)).toMatchObject({ rows: [], truncated: false });
  });
});

describe('GscClient errors and retries', () => {
  it('retries rate limits and server errors, then succeeds', async () => {
    const { gsc, requests, sleeps } = client([
      () => jsonResponse({ error: { code: 429, message: 'Rate limit exceeded' } }, 429),
      () => jsonResponse({ error: { code: 503, message: 'Backend error' } }, 503),
      () => jsonResponse({ siteEntry: [{ siteUrl: 'sc-domain:example.com', permissionLevel: 'siteOwner' }] }),
    ]);
    expect(await gsc.listSites()).toHaveLength(1);
    expect(requests).toHaveLength(3);
    expect(sleeps).toHaveLength(2);
  });

  it('honours Retry-After', async () => {
    const { gsc, sleeps } = client([
      () => jsonResponse({ error: { code: 429, message: 'Slow down' } }, 429, { 'retry-after': '2' }),
      () => jsonResponse({ siteEntry: [] }),
    ]);
    await gsc.listSites();
    expect(sleeps).toEqual([2000]);
  });

  it('does not retry an exhausted daily quota', async () => {
    const { gsc, requests } = client([
      () =>
        jsonResponse(
          { error: { code: 429, message: "Quota exceeded for quota metric 'Queries' and limit 'Queries per day'" } },
          429,
        ),
    ]);
    await expect(gsc.inspectUrl('sc-domain:example.com', 'https://example.com/')).rejects.toMatchObject({
      status: 429,
      hint: expect.stringContaining('daily quota'),
    });
    expect(requests).toHaveLength(1);
  });

  it('explains a permission error in terms the user can act on', async () => {
    const { gsc, requests } = client([
      () =>
        jsonResponse(
          {
            error: {
              code: 403,
              message: "User does not have sufficient permission for site 'sc-domain:example.com'.",
              errors: [{ reason: 'forbidden' }],
            },
          },
          403,
        ),
    ]);
    const failure = await gsc.querySearchAnalytics('sc-domain:example.com', RANGE).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(GscApiError);
    expect(failure).toMatchObject({ status: 403, reason: 'forbidden' });
    expect((failure as GscApiError).hint).toMatch(/Users and permissions/);
    expect(requests).toHaveLength(1);
  });

  it('recognises a disabled API and a missing write scope', async () => {
    const disabled = client([
      () =>
        jsonResponse(
          {
            error: {
              code: 403,
              message: 'Google Search Console API has not been used in project 123 before or it is disabled.',
              status: 'PERMISSION_DENIED',
              details: [{ reason: 'SERVICE_DISABLED' }],
            },
          },
          403,
        ),
    ]);
    await expect(disabled.gsc.listSites()).rejects.toMatchObject({ hint: expect.stringContaining('Enable the') });

    const scope = client([
      () => jsonResponse({ error: { code: 403, message: 'Request had insufficient authentication scopes.' } }, 403),
    ]);
    await expect(scope.gsc.submitSitemap('sc-domain:example.com', 'https://example.com/s.xml')).rejects.toMatchObject({
      hint: expect.stringContaining('GSC_ALLOW_WRITE'),
    });
  });

  it('gives up on a network failure after its retries', async () => {
    const { gsc, requests } = client([
      () => {
        throw new TypeError('fetch failed');
      },
    ]);
    await expect(gsc.listSites()).rejects.toMatchObject({ status: 0, message: expect.stringContaining('fetch failed') });
    expect(requests).toHaveLength(4);
  });

  it('survives an error body that is not JSON', async () => {
    const { gsc } = client([() => new Response('<html>Bad Gateway</html>', { status: 400 })]);
    await expect(gsc.listSites()).rejects.toMatchObject({ status: 400, message: expect.stringContaining('Bad Gateway') });
  });
});
