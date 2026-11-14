import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { mapLimit, summariseInspection } from '../src/analysis/inspection.js';
import { collectSitemapUrls, decodeXmlEntities, parseSitemap, sample } from '../src/analysis/sitemapXml.js';
import { urlBelongsToSite } from '../src/sites.js';

const URL_A = 'https://example.com/a';

describe('summariseInspection', () => {
  it('reports a healthy indexed page with no issues', () => {
    const summary = summariseInspection(URL_A, {
      inspectionResultLink: 'https://search.google.com/search-console/inspect?x',
      indexStatusResult: {
        verdict: 'PASS',
        coverageState: 'Submitted and indexed',
        robotsTxtState: 'ALLOWED',
        indexingState: 'INDEXING_ALLOWED',
        pageFetchState: 'SUCCESSFUL',
        lastCrawlTime: '2026-11-01T10:00:00Z',
        crawledAs: 'MOBILE',
        googleCanonical: 'https://example.com/a/',
        userCanonical: URL_A,
        sitemap: ['https://example.com/sitemap.xml'],
      },
    });
    expect(summary).toMatchObject({
      indexed: true,
      coverage_state: 'Submitted and indexed',
      crawled_as: 'MOBILE',
      canonical_mismatch: false,
      in_sitemaps: ['https://example.com/sitemap.xml'],
      issues: [],
    });
  });

  it('explains a page blocked by noindex', () => {
    const summary = summariseInspection(URL_A, {
      indexStatusResult: {
        verdict: 'NEUTRAL',
        coverageState: "Excluded by 'noindex' tag",
        indexingState: 'BLOCKED_BY_META_TAG',
        robotsTxtState: 'ALLOWED',
        pageFetchState: 'SUCCESSFUL',
      },
    });
    expect(summary.indexed).toBe(false);
    expect(summary.issues).toEqual([
      "Not indexed: Excluded by 'noindex' tag.",
      'A "noindex" robots meta tag blocks indexing.',
    ]);
  });

  it('reports a robots.txt block once, not twice', () => {
    const summary = summariseInspection(URL_A, {
      indexStatusResult: {
        verdict: 'NEUTRAL',
        coverageState: 'Blocked by robots.txt',
        robotsTxtState: 'DISALLOWED',
        pageFetchState: 'BLOCKED_ROBOTS_TXT',
      },
    });
    expect(summary.issues.filter((issue) => /robots\.txt/.test(issue))).toHaveLength(2); // coverage state + cause
    expect(summary.issues).not.toContain('Googlebot could not fetch the page because robots.txt blocks it.');
  });

  it('flags a canonical that Google overrode, and fetch errors', () => {
    const summary = summariseInspection(URL_A, {
      indexStatusResult: {
        verdict: 'NEUTRAL',
        coverageState: 'Duplicate, Google chose different canonical than user',
        pageFetchState: 'SOFT_404',
        googleCanonical: 'https://example.com/b',
        userCanonical: URL_A,
      },
    });
    expect(summary.canonical_mismatch).toBe(true);
    expect(summary.issues.join(' ')).toMatch(/soft 404/);
    expect(summary.issues.join(' ')).toMatch(/different canonical \(https:\/\/example\.com\/b\)/);
  });

  it('hides unspecified enum values and handles an empty answer', () => {
    const summary = summariseInspection(URL_A, {
      indexStatusResult: { verdict: 'VERDICT_UNSPECIFIED', robotsTxtState: 'ROBOTS_TXT_STATE_UNSPECIFIED' },
    });
    expect(summary.robots_txt).toBeNull();
    expect(summary.indexed).toBe(false);
    expect(summariseInspection(URL_A, {}).issues[0]).toMatch(/gave no coverage state/);
  });

  it('counts structured data errors and warnings per type', () => {
    const summary = summariseInspection(URL_A, {
      indexStatusResult: { verdict: 'PASS', googleCanonical: URL_A },
      richResultsResult: {
        verdict: 'FAIL',
        detectedItems: [
          {
            richResultType: 'Product snippets',
            items: [
              { name: 'Shoe', issues: [{ issueMessage: 'Missing field "price"', severity: 'ERROR' }] },
              { name: 'Boot', issues: [{ issueMessage: 'Missing field "review"', severity: 'WARNING' }] },
            ],
          },
          { richResultType: 'Breadcrumbs', items: [{ name: 'Trail' }] },
        ],
      },
    });
    expect(summary.rich_results).toEqual([
      { type: 'Product snippets', items: 2, errors: 1, warnings: 1, issues: ['Missing field "price"', 'Missing field "review"'] },
      { type: 'Breadcrumbs', items: 1, errors: 0, warnings: 0, issues: [] },
    ]);
    expect(summary.issues).toEqual(['Structured data errors in Product snippets: Missing field "price"; Missing field "review".']);
  });
});

describe('mapLimit', () => {
  it('keeps order and never exceeds the concurrency limit', async () => {
    let running = 0;
    let peak = 0;
    const results = await mapLimit([5, 1, 4, 2, 3, 0], 2, async (value) => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, value));
      running -= 1;
      return value * 10;
    });
    expect(results).toEqual([50, 10, 40, 20, 30, 0]);
    expect(peak).toBe(2);
  });
});

describe('parseSitemap', () => {
  it('reads page URLs, decoding entities and CDATA, and skips image entries', () => {
    const parsed = parseSitemap(`<?xml version="1.0" encoding="UTF-8"?>
      <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
        <url><loc>https://example.com/a?x=1&amp;y=2</loc>
          <image:image><image:loc>https://cdn.example.com/a.jpg</image:loc></image:image></url>
        <url><loc><![CDATA[ https://example.com/b ]]></loc></url>
        <url><loc>
          https://example.com/c
        </loc></url>
      </urlset>`);
    expect(parsed).toEqual({
      kind: 'urlset',
      locations: ['https://example.com/a?x=1&y=2', 'https://example.com/b', 'https://example.com/c'],
    });
  });

  it('recognises a sitemap index and a plain-text sitemap', () => {
    expect(
      parseSitemap('<sitemapindex><sitemap><loc>https://example.com/s1.xml</loc></sitemap></sitemapindex>'),
    ).toEqual({ kind: 'index', locations: ['https://example.com/s1.xml'] });
    expect(parseSitemap('https://example.com/a\r\n\r\nnot a url\nhttps://example.com/b\n')).toEqual({
      kind: 'urlset',
      locations: ['https://example.com/a', 'https://example.com/b'],
    });
  });

  it('decodes numeric entities', () => {
    expect(decodeXmlEntities('caf&#233; &#x26; bar &unknown;')).toBe('café & bar &unknown;');
  });
});

describe('collectSitemapUrls', () => {
  const site = 'sc-domain:example.com';
  const isAllowed = (url: string) => urlBelongsToSite(url, site);
  const urlset = (...urls: string[]) => `<urlset>${urls.map((url) => `<url><loc>${url}</loc></url>`).join('')}</urlset>`;

  function fakeWeb(pages: Record<string, () => Response>) {
    const requested: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      requested.push(url);
      return pages[url]?.() ?? new Response('missing', { status: 404 });
    }) as typeof fetch;
    return { fetchImpl, requested };
  }

  it('follows a sitemap index, reads gzip files and de-duplicates URLs', async () => {
    const web = fakeWeb({
      'https://example.com/sitemap.xml': () =>
        new Response(
          '<sitemapindex><sitemap><loc>https://example.com/pages.xml</loc></sitemap><sitemap><loc>https://example.com/posts.xml.gz</loc></sitemap></sitemapindex>',
        ),
      'https://example.com/pages.xml': () => new Response(urlset('https://example.com/', 'https://example.com/about')),
      'https://example.com/posts.xml.gz': () =>
        new Response(gzipSync(urlset('https://example.com/blog/1', 'https://example.com/about'))),
    });
    const crawl = await collectSitemapUrls(['https://example.com/sitemap.xml'], {
      fetch: web.fetchImpl,
      isAllowed,
      maxUrls: 100,
      maxSitemaps: 10,
    });
    expect(crawl.urls).toEqual(['https://example.com/', 'https://example.com/about', 'https://example.com/blog/1']);
    expect(crawl.sitemapsRead).toHaveLength(3);
    expect(crawl.truncated).toBe(false);
    expect(crawl.skipped).toEqual([]);
  });

  it('never requests an address outside the property, even through a redirect', async () => {
    const web = fakeWeb({
      'https://example.com/sitemap.xml': () =>
        new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } }),
    });
    const crawl = await collectSitemapUrls(['https://example.com/sitemap.xml', 'https://evil.test/sitemap.xml'], {
      fetch: web.fetchImpl,
      isAllowed,
      maxUrls: 100,
      maxSitemaps: 10,
    });
    expect(web.requested).toEqual(['https://example.com/sitemap.xml']);
    expect(crawl.urls).toEqual([]);
    expect(crawl.skipped.map((item) => item.reason)).toEqual([
      expect.stringContaining('outside this Search Console property'),
      expect.stringContaining('outside this Search Console property'),
    ]);
  });

  it('follows redirects that stay on the property', async () => {
    const web = fakeWeb({
      'https://example.com/sitemap.xml': () => new Response(null, { status: 301, headers: { location: '/sitemap_index.xml' } }),
      'https://example.com/sitemap_index.xml': () => new Response(urlset('https://example.com/x')),
    });
    const crawl = await collectSitemapUrls(['https://example.com/sitemap.xml'], {
      fetch: web.fetchImpl,
      isAllowed,
      maxUrls: 100,
      maxSitemaps: 10,
    });
    expect(crawl.urls).toEqual(['https://example.com/x']);
  });

  it('reports unreadable sitemaps and respects its limits', async () => {
    const web = fakeWeb({
      'https://example.com/a.xml': () => new Response(urlset('https://example.com/1', 'https://example.com/2', 'https://example.com/3')),
      'https://example.com/b.xml': () => new Response(urlset('https://example.com/4')),
    });
    const crawl = await collectSitemapUrls(
      ['https://example.com/missing.xml', 'https://example.com/a.xml', 'https://example.com/b.xml'],
      { fetch: web.fetchImpl, isAllowed, maxUrls: 2, maxSitemaps: 10 },
    );
    expect(crawl.skipped).toEqual([{ sitemap: 'https://example.com/missing.xml', reason: 'https://example.com/missing.xml returned HTTP 404.' }]);
    expect(crawl.urls).toEqual(['https://example.com/1', 'https://example.com/2']);
    expect(crawl.truncated).toBe(true);
  });
});

describe('sample', () => {
  it('picks distinct items and never more than exist', () => {
    const items = ['a', 'b', 'c', 'd', 'e'];
    const picked = sample(items, 3);
    expect(picked).toHaveLength(3);
    expect(new Set(picked).size).toBe(3);
    expect(sample(items, 99).sort()).toEqual(items);
    expect(items).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('is deterministic with a supplied random source', () => {
    expect(sample(['a', 'b', 'c', 'd'], 2, () => 0)).toEqual(['a', 'b']);
    expect(sample(['a', 'b', 'c', 'd'], 2, () => 0.99)).toEqual(['d', 'a']);
  });
});
