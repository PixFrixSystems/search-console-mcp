import { GscApiError } from '../errors.js';
import type {
  SearchAnalyticsMetadata,
  SearchAnalyticsRequest,
  SearchAnalyticsResponse,
  SearchAnalyticsRow,
  SiteEntry,
  Sitemap,
  UrlInspectionResult,
} from './types.js';

const WEBMASTERS_BASE = 'https://www.googleapis.com/webmasters/v3';
const INSPECTION_ENDPOINT = 'https://searchconsole.googleapis.com/v1/urlInspection/index:inspect';

/** The API returns at most this many rows per searchAnalytics.query call. */
export const MAX_ROWS_PER_REQUEST = 25_000;

export interface GscClientOptions {
  getAccessToken: () => Promise<string>;
  fetch?: typeof fetch;
  /** Extra attempts after the first one, for rate limits, 5xx answers and network failures. */
  maxRetries?: number;
  baseDelayMs?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  userAgent?: string;
}

export interface QueryAllResult {
  rows: SearchAnalyticsRow[];
  /** True when the row cap was reached and Google may hold more rows. */
  truncated: boolean;
  responseAggregationType?: string;
  metadata?: SearchAnalyticsMetadata;
}

interface GoogleErrorBody {
  error?: {
    code?: number;
    message?: string;
    status?: string;
    errors?: { reason?: string; message?: string }[];
    details?: { reason?: string }[];
  };
}

const RATE_LIMIT_REASONS = new Set([
  'rateLimitExceeded',
  'userRateLimitExceeded',
  'RATE_LIMIT_EXCEEDED',
  'RESOURCE_EXHAUSTED',
]);
const DAILY_QUOTA_REASONS = new Set(['quotaExceeded', 'dailyLimitExceeded']);

function isDailyQuota(reason: string | undefined, message: string): boolean {
  return (reason !== undefined && DAILY_QUOTA_REASONS.has(reason)) || /per day/i.test(message);
}

function hintFor(status: number, reason: string | undefined, message: string): string | undefined {
  const text = message.toLowerCase();
  if (status === 401) {
    return 'The credentials were rejected. Run "npx -y @pixfrixsystems/search-console-mcp doctor" to see which credentials are in use, then sign in again with "auth login" or check the service account key.';
  }
  if (status === 403) {
    if (
      reason === 'SERVICE_DISABLED' ||
      reason === 'accessNotConfigured' ||
      text.includes('has not been used in project') ||
      text.includes('is disabled')
    ) {
      return 'Enable the "Google Search Console API" in your Google Cloud project (APIs & Services > Library), wait a minute and try again.';
    }
    if (
      reason === 'insufficientPermissions' ||
      reason === 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' ||
      text.includes('insufficient authentication scopes')
    ) {
      return 'This action needs the read/write scope. Set GSC_ALLOW_WRITE=true and, when you signed in with OAuth, run "auth login --write" again.';
    }
    if (isDailyQuota(reason, message) || (reason !== undefined && RATE_LIMIT_REASONS.has(reason))) {
      return 'A Search Console quota was reached. URL inspection allows 2,000 calls per day and 600 per minute per property. Wait and retry later.';
    }
    return 'The signed-in account cannot read this property. In Search Console open Settings > Users and permissions and add the account (for a service account, its client_email) as a user. Call list_sites to see what this account can reach.';
  }
  if (status === 404) {
    return 'Check the property name with list_sites. URL-prefix properties need the exact URL including the trailing slash; domain properties look like "sc-domain:example.com".';
  }
  if (status === 429) {
    return isDailyQuota(reason, message)
      ? 'The daily quota for this property is used up. It resets at midnight Pacific Time.'
      : 'Search Console rate limit reached. Wait a few minutes. If it keeps happening, shorten the date range or drop the page and query dimensions, which are the most expensive to compute.';
  }
  return undefined;
}

async function toApiError(response: Response): Promise<GscApiError> {
  const raw = await response.text().catch(() => '');
  let message = raw.slice(0, 500) || response.statusText || `HTTP ${response.status}`;
  let reason: string | undefined;
  try {
    const body = JSON.parse(raw) as GoogleErrorBody;
    if (body.error) {
      message = body.error.message ?? message;
      reason =
        body.error.errors?.[0]?.reason ??
        body.error.details?.find((detail) => detail.reason)?.reason ??
        body.error.status;
    }
  } catch {
    // Not JSON: keep the raw text.
  }
  return new GscApiError(response.status, `Search Console API error ${response.status}: ${message}`, {
    reason,
    hint: hintFor(response.status, reason, message),
  });
}

function isRetryable(error: GscApiError): boolean {
  if (isDailyQuota(error.reason, error.message)) return false;
  if (error.status === 429 || error.status >= 500) return true;
  return error.status === 403 && error.reason !== undefined && RATE_LIMIT_REASONS.has(error.reason);
}

function retryAfterMs(response: Response): number | undefined {
  const header = response.headers.get('retry-after');
  if (!header) return undefined;
  const seconds = Number(header);
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return Math.min(seconds * 1000, 30_000);
}

export class GscClient {
  private readonly getAccessToken: () => Promise<string>;
  private readonly fetchImpl: typeof fetch;
  private readonly maxRetries: number;
  private readonly baseDelayMs: number;
  private readonly timeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly userAgent: string;

  constructor(options: GscClientOptions) {
    this.getAccessToken = options.getAccessToken;
    this.fetchImpl = options.fetch ?? fetch;
    this.maxRetries = options.maxRetries ?? 3;
    this.baseDelayMs = options.baseDelayMs ?? 800;
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.userAgent = options.userAgent ?? 'search-console-mcp';
  }

  private backoff(attempt: number): number {
    return this.baseDelayMs * 2 ** attempt + Math.random() * this.baseDelayMs;
  }

  private async request<T>(method: string, url: string, body?: unknown): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      const token = await this.getAccessToken();
      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            accept: 'application/json',
            'user-agent': this.userAgent,
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (cause) {
        if (attempt < this.maxRetries) {
          await this.sleep(this.backoff(attempt));
          continue;
        }
        const detail = cause instanceof Error ? cause.message : String(cause);
        throw new GscApiError(0, `Could not reach the Search Console API: ${detail}`, {
          hint: 'Check the network connection and any proxy or firewall, then try again.',
        });
      }

      if (response.ok) {
        const text = await response.text();
        return (text ? JSON.parse(text) : undefined) as T;
      }

      const error = await toApiError(response);
      if (isRetryable(error) && attempt < this.maxRetries) {
        await this.sleep(retryAfterMs(response) ?? this.backoff(attempt));
        continue;
      }
      throw error;
    }
  }

  private siteBase(siteUrl: string): string {
    return `${WEBMASTERS_BASE}/sites/${encodeURIComponent(siteUrl)}`;
  }

  async listSites(): Promise<SiteEntry[]> {
    const result = await this.request<{ siteEntry?: SiteEntry[] }>('GET', `${WEBMASTERS_BASE}/sites`);
    return result?.siteEntry ?? [];
  }

  async querySearchAnalytics(siteUrl: string, request: SearchAnalyticsRequest): Promise<SearchAnalyticsResponse> {
    const result = await this.request<SearchAnalyticsResponse>(
      'POST',
      `${this.siteBase(siteUrl)}/searchAnalytics/query`,
      request,
    );
    return result ?? {};
  }

  /** Pages through searchAnalytics.query until Google runs out of rows or `maxRows` is reached. */
  async queryAllRows(siteUrl: string, request: SearchAnalyticsRequest, maxRows: number): Promise<QueryAllResult> {
    const rows: SearchAnalyticsRow[] = [];
    let startRow = request.startRow ?? 0;
    let last: SearchAnalyticsResponse | undefined;
    let exhausted = false;

    while (rows.length < maxRows) {
      const rowLimit = Math.min(MAX_ROWS_PER_REQUEST, maxRows - rows.length);
      last = await this.querySearchAnalytics(siteUrl, { ...request, rowLimit, startRow });
      const page = last.rows ?? [];
      for (const row of page) rows.push(row);
      startRow += page.length;
      if (page.length < rowLimit) {
        exhausted = true;
        break;
      }
    }

    return {
      rows,
      truncated: !exhausted,
      responseAggregationType: last?.responseAggregationType,
      metadata: last?.metadata,
    };
  }

  async inspectUrl(siteUrl: string, inspectionUrl: string, languageCode?: string): Promise<UrlInspectionResult> {
    const result = await this.request<{ inspectionResult?: UrlInspectionResult }>('POST', INSPECTION_ENDPOINT, {
      inspectionUrl,
      siteUrl,
      ...(languageCode ? { languageCode } : {}),
    });
    return result?.inspectionResult ?? {};
  }

  async listSitemaps(siteUrl: string, sitemapIndex?: string): Promise<Sitemap[]> {
    const query = sitemapIndex ? `?sitemapIndex=${encodeURIComponent(sitemapIndex)}` : '';
    const result = await this.request<{ sitemap?: Sitemap[] }>('GET', `${this.siteBase(siteUrl)}/sitemaps${query}`);
    return result?.sitemap ?? [];
  }

  async getSitemap(siteUrl: string, feedpath: string): Promise<Sitemap> {
    return this.request<Sitemap>('GET', `${this.siteBase(siteUrl)}/sitemaps/${encodeURIComponent(feedpath)}`);
  }

  async submitSitemap(siteUrl: string, feedpath: string): Promise<void> {
    await this.request<void>('PUT', `${this.siteBase(siteUrl)}/sitemaps/${encodeURIComponent(feedpath)}`);
  }

  async deleteSitemap(siteUrl: string, feedpath: string): Promise<void> {
    await this.request<void>('DELETE', `${this.siteBase(siteUrl)}/sitemaps/${encodeURIComponent(feedpath)}`);
  }
}
