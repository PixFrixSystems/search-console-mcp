import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import type { Config } from '../src/config.js';
import { GscClient } from '../src/gsc/client.js';
import type {
  SearchAnalyticsMetadata,
  SearchAnalyticsRequest,
  SearchAnalyticsRow,
  SiteEntry,
  Sitemap,
  UrlInspectionResult,
} from '../src/gsc/types.js';
import { createDeps, createServer } from '../src/server.js';
import type { ToolDeps } from '../src/tools/shared.js';

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

export function row(keys: string[], clicks: number, impressions: number, position: number): SearchAnalyticsRow {
  return { keys, clicks, impressions, ctr: impressions > 0 ? clicks / impressions : 0, position };
}

export interface RecordedCall {
  method: string;
  url: string;
  body: unknown;
}

export interface FakeSearchConsole {
  sites: SiteEntry[];
  sitemaps: Sitemap[];
  inspections: Record<string, UrlInspectionResult>;
  /** Returns the full, unpaged row set for a request; paging is applied by the fake. */
  analytics: (request: SearchAnalyticsRequest, siteUrl: string) => SearchAnalyticsRow[];
  /** The "data is incomplete from here" marker Google adds to fresh-data responses. */
  metadata: (request: SearchAnalyticsRequest) => SearchAnalyticsMetadata | undefined;
  /** How long a URL inspection takes, to imitate the real API's slowness. */
  inspectionDelayMs: number;
}

/** A stand-in for the Search Console REST API, wired in through the client's fetch option. */
export function fakeSearchConsole(overrides: Partial<FakeSearchConsole> = {}) {
  const state: FakeSearchConsole = {
    sites: [{ siteUrl: 'sc-domain:example.com', permissionLevel: 'siteOwner' }],
    sitemaps: [],
    inspections: {},
    analytics: () => [],
    metadata: () => undefined,
    inspectionDelayMs: 0,
    ...overrides,
  };
  const calls: RecordedCall[] = [];

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ method, url: url.toString(), body });
    const path = decodeURIComponent(url.pathname);

    if (path.endsWith('/urlInspection/index:inspect')) {
      if (state.inspectionDelayMs) await new Promise((resolve) => setTimeout(resolve, state.inspectionDelayMs));
      const result = state.inspections[body.inspectionUrl];
      return result
        ? jsonResponse({ inspectionResult: result })
        : jsonResponse({ error: { code: 404, message: 'URL is unknown to Google' } }, 404);
    }
    if (path.endsWith('/webmasters/v3/sites')) return jsonResponse({ siteEntry: state.sites });

    const match = /\/webmasters\/v3\/sites\/(.+?)\/(searchAnalytics\/query|sitemaps)(?:\/(.+))?$/.exec(path);
    if (!match) return jsonResponse({ error: { code: 404, message: `No fake route for ${path}` } }, 404);
    const [, siteUrl, resource, feedpath] = match as unknown as [string, string, string, string | undefined];

    if (resource === 'searchAnalytics/query') {
      const request = body as SearchAnalyticsRequest;
      const rows = state.analytics(request, siteUrl);
      const start = request.startRow ?? 0;
      const metadata = state.metadata(request);
      return jsonResponse({
        rows: rows.slice(start, start + (request.rowLimit ?? 1000)),
        ...(metadata ? { metadata } : {}),
      });
    }
    if (method === 'GET' && !feedpath) return jsonResponse({ sitemap: state.sitemaps });
    if (method === 'GET') {
      const found = state.sitemaps.find((sitemap) => sitemap.path === feedpath);
      return found ? jsonResponse(found) : jsonResponse({ error: { code: 404, message: 'Not found' } }, 404);
    }
    if (method === 'PUT') {
      state.sitemaps.push({ path: feedpath as string, isPending: true });
      return new Response(null, { status: 204 });
    }
    if (method === 'DELETE') {
      state.sitemaps = state.sitemaps.filter((sitemap) => sitemap.path !== feedpath);
      return new Response(null, { status: 204 });
    }
    return jsonResponse({ error: { code: 405, message: 'Unsupported' } }, 405);
  }) as typeof fetch;

  return { state, calls, fetch: fetchImpl };
}

export const TEST_NOW = new Date('2026-11-14T12:00:00Z');
/** The last complete day the stubbed freshness check reports: default periods end here. */
export const LAST_COMPLETE = '2026-11-11';

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    tokenFile: '/nonexistent/token.json',
    configDir: '/nonexistent',
    allowWrite: false,
    brandTerms: [],
    ...overrides,
  };
}

export interface Harness {
  client: Client;
  calls: RecordedCall[];
  state: FakeSearchConsole;
  /** Calls a tool and parses its JSON result. */
  call: (name: string, args?: Record<string, unknown>) => Promise<any>;
  /** Calls a tool and returns the raw result, for asserting on errors. */
  raw: (name: string, args?: Record<string, unknown>) => Promise<{ isError?: boolean; text: string }>;
  close: () => Promise<void>;
}

export async function harness(
  options: {
    api?: Partial<FakeSearchConsole>;
    config?: Partial<Config>;
    deps?: Partial<ToolDeps>;
  } = {},
): Promise<Harness> {
  const api = fakeSearchConsole(options.api);
  const config = testConfig(options.config);
  const gsc = new GscClient({
    getAccessToken: async () => 'test-token',
    fetch: api.fetch,
    sleep: async () => undefined,
  });
  const deps = createDeps(config, {
    client: gsc,
    identity: async () => ({
      method: 'service_account',
      email: 'bot@project.iam.gserviceaccount.com',
      source: 'test',
      scopes: [],
    }),
    // Fixed, so default periods are stable and tests that count API calls are not thrown off by
    // the freshness probe. Pass `deps: { freshness: undefined }` to exercise the real one.
    freshness: { lastCompleteDate: async () => LAST_COMPLETE },
    now: () => TEST_NOW,
    random: () => 0,
    ...options.deps,
  });

  const server = createServer(deps);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const raw = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    const first = (result.content as { type: string; text?: string }[])[0];
    return { isError: Boolean(result.isError), text: first?.text ?? '' };
  };

  return {
    client,
    calls: api.calls,
    state: api.state,
    raw,
    call: async (name, args) => {
      const result = await raw(name, args);
      if (result.isError) throw new Error(`Tool ${name} failed: ${result.text}`);
      return JSON.parse(result.text);
    },
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

/** Turns a {columns, rows} table back into objects, which reads better in assertions. */
export function records(tableValue: { columns: string[]; rows: unknown[][] }): Record<string, unknown>[] {
  return tableValue.rows.map((cells) => Object.fromEntries(tableValue.columns.map((column, index) => [column, cells[index]])));
}
