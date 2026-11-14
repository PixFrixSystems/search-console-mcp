import type { UrlInspectionResult } from '../gsc/types.js';

export interface RichResultSummary {
  type: string;
  items: number;
  errors: number;
  warnings: number;
  issues: string[];
}

export interface InspectionSummary {
  url: string;
  indexed: boolean;
  verdict: string;
  coverage_state: string | null;
  robots_txt: string | null;
  indexing: string | null;
  page_fetch: string | null;
  last_crawl: string | null;
  crawled_as: string | null;
  google_canonical: string | null;
  declared_canonical: string | null;
  canonical_mismatch: boolean;
  in_sitemaps: string[];
  referring_urls: string[];
  rich_results: RichResultSummary[];
  amp: { verdict: string; issues: string[] } | null;
  /** Plain-language problems, most important first. Empty when nothing is wrong. */
  issues: string[];
  search_console_link: string | null;
}

const UNSPECIFIED = /_UNSPECIFIED$/;

function known(value: string | undefined): string | null {
  return value && !UNSPECIFIED.test(value) ? value : null;
}

function sameUrl(a: string, b: string): boolean {
  const normalise = (value: string) => {
    try {
      const url = new URL(value);
      return `${url.protocol}//${url.host.toLowerCase()}${url.pathname.replace(/\/+$/, '')}${url.search}`;
    } catch {
      return value.trim().replace(/\/+$/, '');
    }
  };
  return normalise(a) === normalise(b);
}

const FETCH_PROBLEMS: Record<string, string> = {
  SOFT_404: 'Google treats the page as a soft 404 (it loads, but looks like an error or empty page).',
  BLOCKED_ROBOTS_TXT: 'Googlebot could not fetch the page because robots.txt blocks it.',
  NOT_FOUND: 'The page returned 404 Not Found to Googlebot.',
  ACCESS_DENIED: 'The page returned 401 Unauthorized to Googlebot.',
  SERVER_ERROR: 'The server returned a 5xx error to Googlebot.',
  REDIRECT_ERROR: 'Googlebot hit a redirect error (a loop, a chain that is too long or a bad target).',
  ACCESS_FORBIDDEN: 'The page returned 403 Forbidden to Googlebot.',
  BLOCKED_4XX: 'The page returned a 4xx error to Googlebot.',
  INTERNAL_CRAWL_ERROR: 'Google had an internal error while crawling the page.',
  INVALID_URL: 'Google considers the URL invalid.',
};

/** Turns the raw URL Inspection answer into a flat record plus a list of concrete problems. */
export function summariseInspection(url: string, result: UrlInspectionResult): InspectionSummary {
  const index = result.indexStatusResult ?? {};
  const verdict = index.verdict ?? 'VERDICT_UNSPECIFIED';
  const indexed = verdict === 'PASS';
  const issues: string[] = [];

  if (!indexed) {
    issues.push(
      index.coverageState
        ? `Not indexed: ${index.coverageState}.`
        : 'Not indexed, and Google gave no coverage state (the URL may be unknown to Google).',
    );
  }
  if (index.robotsTxtState === 'DISALLOWED') issues.push('Crawling is blocked by robots.txt.');
  if (index.indexingState === 'BLOCKED_BY_META_TAG') issues.push('A "noindex" robots meta tag blocks indexing.');
  if (index.indexingState === 'BLOCKED_BY_HTTP_HEADER') {
    issues.push('A "noindex" X-Robots-Tag HTTP header blocks indexing.');
  }
  const fetchProblem = index.pageFetchState ? FETCH_PROBLEMS[index.pageFetchState] : undefined;
  if (fetchProblem && !(index.pageFetchState === 'BLOCKED_ROBOTS_TXT' && index.robotsTxtState === 'DISALLOWED')) {
    issues.push(fetchProblem);
  }

  const canonicalMismatch = Boolean(
    index.googleCanonical && index.userCanonical && !sameUrl(index.googleCanonical, index.userCanonical),
  );
  if (canonicalMismatch) {
    issues.push(
      `Google chose a different canonical (${index.googleCanonical}) than the one the page declares (${index.userCanonical}).`,
    );
  } else if (index.googleCanonical && !sameUrl(index.googleCanonical, url)) {
    issues.push(`Google indexes this content under another URL: ${index.googleCanonical}.`);
  }

  const richResults: RichResultSummary[] = (result.richResultsResult?.detectedItems ?? []).map((detected) => {
    const found = (detected.items ?? []).flatMap((item) => item.issues ?? []);
    return {
      type: detected.richResultType ?? 'Unknown',
      items: detected.items?.length ?? 0,
      errors: found.filter((issue) => issue.severity === 'ERROR').length,
      warnings: found.filter((issue) => issue.severity === 'WARNING').length,
      issues: [...new Set(found.map((issue) => issue.issueMessage).filter((message): message is string => !!message))],
    };
  });
  for (const rich of richResults) {
    if (rich.errors > 0) {
      issues.push(`Structured data errors in ${rich.type}: ${rich.issues.slice(0, 3).join('; ')}.`);
    }
  }

  const amp = result.ampResult
    ? {
        verdict: result.ampResult.verdict ?? 'VERDICT_UNSPECIFIED',
        issues: (result.ampResult.issues ?? [])
          .map((issue) => issue.issueMessage)
          .filter((message): message is string => !!message),
      }
    : null;
  if (amp && amp.verdict === 'FAIL') issues.push(`The AMP version is invalid: ${amp.issues.slice(0, 3).join('; ')}.`);

  return {
    url,
    indexed,
    verdict,
    coverage_state: index.coverageState ?? null,
    robots_txt: known(index.robotsTxtState),
    indexing: known(index.indexingState),
    page_fetch: known(index.pageFetchState),
    last_crawl: index.lastCrawlTime ?? null,
    crawled_as: known(index.crawledAs),
    google_canonical: index.googleCanonical ?? null,
    declared_canonical: index.userCanonical ?? null,
    canonical_mismatch: canonicalMismatch,
    in_sitemaps: index.sitemap ?? [],
    referring_urls: (index.referringUrls ?? []).slice(0, 10),
    rich_results: richResults,
    amp,
    issues,
    search_console_link: result.inspectionResultLink ?? null,
  };
}

/** Runs `task` over `items` with at most `limit` in flight, keeping the input order. */
export async function mapLimit<T, R>(items: T[], limit: number, task: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await task(items[index] as T, index);
    }
  });
  await Promise.all(workers);
  return results;
}
