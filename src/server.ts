import { McpServer } from '@modelcontextprotocol/server';
import { createTokenProvider, type TokenProvider } from './auth.js';
import { type Config, SERVER_NAME } from './config.js';
import { DataFreshness } from './freshness.js';
import { GscClient } from './gsc/client.js';
import { registerPrompts } from './prompts.js';
import { SiteResolver } from './sites.js';
import { registerAnalyticsTools } from './tools/analytics.js';
import { registerIndexingTools } from './tools/indexing.js';
import { registerInsightTools } from './tools/insights.js';
import type { ToolDeps } from './tools/shared.js';
import { VERSION } from './version.js';

const INSTRUCTIONS = [
  'Google Search Console data and SEO analysis for the properties the connected Google account can read.',
  '',
  'Getting started: call list_sites if you do not know the property. Every tool accepts site_url as an exact property name, a bare domain or any page URL on the site.',
  '',
  'Choosing a tool: get_performance_overview for the big picture; compare_periods, find_declining_pages and detect_traffic_anomalies to explain change; find_quick_wins, find_ctr_opportunities, find_keyword_cannibalization and find_content_gaps to find work worth doing; analyze_page before editing a page; inspect_url, inspect_urls and audit_sitemap_indexing for indexing questions; search_analytics for any custom query.',
  '',
  'Reading the data:',
  '- Dates are in Pacific Time. Without dates, tools use the 28 days ending on the latest day Google has complete data for (usually 3 to 4 days ago). end_date accepts "today" and "yesterday"; a period that reaches past the last complete day returns partial numbers for those days and says so.',
  '- position is the average topmost position; lower is better.',
  '- ctr_pct values are percentages (3.2 means 3.2%).',
  '- Rows broken down by query exclude anonymised queries, so they sum to less than the totals.',
  '- Results are JSON. Tables are {"columns": [...], "rows": [[...], ...]}.',
  '- URL inspection is limited to 2,000 calls per day per property; prefer the sampling tools over inspecting everything.',
].join('\n');

/**
 * Builds the pieces every tool shares. Credentials are resolved on first use, so the server starts
 * (and can explain what is missing) even when nothing is configured yet.
 */
export function createDeps(config: Config, overrides: Partial<ToolDeps> = {}): ToolDeps {
  let pending: Promise<TokenProvider> | undefined;
  const provider = (): Promise<TokenProvider> => {
    pending ??= createTokenProvider(config).catch((error: unknown) => {
      pending = undefined;
      throw error;
    });
    return pending;
  };

  const client =
    overrides.client ??
    new GscClient({
      getAccessToken: async () => (await provider()).getAccessToken(),
      userAgent: `${SERVER_NAME}/${VERSION}`,
    });

  const now = overrides.now ?? (() => new Date());
  return {
    config,
    client,
    sites: overrides.sites ?? new SiteResolver(() => client.listSites(), config.defaultSite),
    identity: overrides.identity ?? (async () => (await provider()).identity),
    freshness: overrides.freshness ?? new DataFreshness(client, now),
    now,
    fetch: overrides.fetch,
    random: overrides.random,
    inspectionBudgetMs: overrides.inspectionBudgetMs,
  };
}

export function createServer(deps: ToolDeps): McpServer {
  const server = new McpServer(
    {
      name: SERVER_NAME,
      title: 'Google Search Console',
      version: VERSION,
      websiteUrl: 'https://github.com/PixFrixSystems/search-console-mcp',
    },
    { capabilities: { tools: {}, prompts: {} }, instructions: INSTRUCTIONS },
  );

  registerAnalyticsTools(server, deps);
  registerInsightTools(server, deps);
  registerIndexingTools(server, deps);
  registerPrompts(server);
  return server;
}
