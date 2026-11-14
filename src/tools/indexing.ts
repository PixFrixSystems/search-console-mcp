import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { type InspectionSummary, mapLimit, summariseInspection } from '../analysis/inspection.js';
import { collectSitemapUrls, sample } from '../analysis/sitemapXml.js';
import { describeError, UserError } from '../errors.js';
import { type Cell, round } from '../format.js';
import type { Sitemap } from '../gsc/types.js';
import { urlBelongsToSite } from '../sites.js';
import { defineTool, siteUrlField, table, type ToolDeps } from './shared.js';

/**
 * Parallel URL inspections. Measured against the live API, one inspection takes about six seconds,
 * so eight at a time is roughly 80 per minute, far below the limit of 600 per minute per property.
 */
const INSPECTION_CONCURRENCY = 8;

/**
 * Stop starting new inspections after this long and return what is done. Many MCP clients give a
 * tool call 60 seconds, and a call that times out loses every result it had already collected.
 */
const DEFAULT_INSPECTION_BUDGET_MS = 45_000;

const TIME_LIMIT_NOTE =
  'Google takes about six seconds per URL inspection, so this call stopped after roughly 45 seconds to stay inside the time most MCP clients allow.';

const languageField = z
  .string()
  .optional()
  .describe('BCP-47 language for Google\'s issue messages, for example "en-US" (default) or "el".');

type InspectionOutcome = InspectionSummary | { url: string; error: string };

function hasError(outcome: InspectionOutcome): outcome is { url: string; error: string } {
  return 'error' in outcome;
}

function assertInProperty(url: string, siteUrl: string): void {
  if (!urlBelongsToSite(url, siteUrl)) {
    throw new UserError(
      `${url} is not part of the property ${siteUrl}.`,
      'Use a URL on this property, or pass the site_url of the property that contains it (see list_sites).',
    );
  }
}

interface InspectionBatch {
  outcomes: InspectionOutcome[];
  /** URLs that were not reached before the time budget ran out. */
  notInspected: string[];
}

async function inspectAll(
  deps: ToolDeps,
  siteUrl: string,
  urls: string[],
  languageCode: string | undefined,
): Promise<InspectionBatch> {
  const deadline = Date.now() + (deps.inspectionBudgetMs ?? DEFAULT_INSPECTION_BUDGET_MS);
  const results = await mapLimit(urls, INSPECTION_CONCURRENCY, async (url): Promise<InspectionOutcome | undefined> => {
    if (Date.now() >= deadline) return undefined;
    try {
      return summariseInspection(url, await deps.client.inspectUrl(siteUrl, url, languageCode));
    } catch (error) {
      return { url, error: describeError(error) };
    }
  });
  return {
    outcomes: results.filter((result): result is InspectionOutcome => result !== undefined),
    notInspected: urls.filter((_, index) => results[index] === undefined),
  };
}

function sitemapCells(sitemap: Sitemap): Cell[] {
  const contents = sitemap.contents ?? [];
  const submitted = contents.reduce((sum, item) => sum + Number(item.submitted ?? 0), 0);
  return [
    sitemap.path,
    sitemap.type ?? null,
    Boolean(sitemap.isSitemapsIndex),
    Boolean(sitemap.isPending),
    sitemap.lastSubmitted ?? null,
    sitemap.lastDownloaded ?? null,
    Number(sitemap.errors ?? 0),
    Number(sitemap.warnings ?? 0),
    submitted,
    contents.map((item) => `${item.type}: ${Number(item.submitted ?? 0)}`).join(', ') || null,
  ];
}

const SITEMAP_COLUMNS = [
  'sitemap',
  'type',
  'is_index',
  'pending',
  'last_submitted',
  'last_downloaded',
  'errors',
  'warnings',
  'submitted_urls',
  'contents',
];

export function registerIndexingTools(server: McpServer, deps: ToolDeps): void {
  defineTool(server, {
    name: 'inspect_url',
    title: 'Inspect a URL',
    description:
      'Asks Google how it sees one URL: whether it is indexed and why not, the canonical Google chose against the declared one, when it was last crawled and as which device, robots.txt and noindex state, the sitemaps and pages that point to it, and structured data problems. It reports the indexed version, not a live test. Counts against a quota of 2,000 inspections per day per property.',
    input: {
      site_url: siteUrlField,
      url: z.string().url().describe('The full URL to inspect. It must belong to the property.'),
      language_code: languageField,
    },
    run: async (args) => {
      const site = await deps.sites.resolve(args.site_url ?? args.url);
      assertInProperty(args.url, site.siteUrl);
      const result = await deps.client.inspectUrl(site.siteUrl, args.url, args.language_code);
      return { site: site.siteUrl, ...summariseInspection(args.url, result) };
    },
  });

  defineTool(server, {
    name: 'inspect_urls',
    title: 'Inspect several URLs',
    description:
      'Runs URL inspection for up to 50 URLs of one property and returns a compact table of which are indexed, their coverage state, last crawl and the problems found. Each URL uses one of the 2,000 daily inspections per property.',
    input: {
      site_url: siteUrlField,
      urls: z.array(z.string().url()).min(1).max(50).describe('The full URLs to inspect, all on the same property.'),
      language_code: languageField,
    },
    run: async (args) => {
      const urls = [...new Set(args.urls)];
      const site = await deps.sites.resolve(args.site_url ?? urls[0]);
      for (const url of urls) assertInProperty(url, site.siteUrl);
      const { outcomes, notInspected } = await inspectAll(deps, site.siteUrl, urls, args.language_code);
      const inspected = outcomes.filter((outcome): outcome is InspectionSummary => !hasError(outcome));

      return {
        site: site.siteUrl,
        inspected: inspected.length,
        indexed: inspected.filter((item) => item.indexed).length,
        not_indexed: inspected.filter((item) => !item.indexed).length,
        failed: outcomes.length - inspected.length,
        ...(notInspected.length
          ? {
              not_inspected: notInspected,
              notes: [`${TIME_LIMIT_NOTE} Call inspect_urls again with the URLs in not_inspected to finish.`],
            }
          : {}),
        results: table(
          ['url', 'indexed', 'coverage_state', 'page_fetch', 'last_crawl', 'google_canonical', 'issues'],
          outcomes.map((outcome) =>
            hasError(outcome)
              ? [outcome.url, null, null, null, null, null, `Inspection failed: ${outcome.error}`]
              : [
                  outcome.url,
                  outcome.indexed,
                  outcome.coverage_state,
                  outcome.page_fetch,
                  outcome.last_crawl,
                  outcome.google_canonical,
                  outcome.issues.join(' ') || null,
                ],
          ),
        ),
      };
    },
  });

  defineTool(server, {
    name: 'audit_sitemap_indexing',
    title: 'Audit how much of a sitemap is indexed',
    description:
      'Reads the URLs listed in the property\'s sitemaps, inspects a sample of them and reports how many are indexed, the reasons the others are not, and the affected URLs. This is the closest the API gets to the Page indexing report. Each inspected URL uses one of the 2,000 daily inspections per property, so the sample is small by default.',
    input: {
      site_url: siteUrlField,
      sitemap_url: z
        .string()
        .url()
        .optional()
        .describe('A specific sitemap or sitemap index to audit. Defaults to every sitemap submitted in Search Console.'),
      max_urls: z
        .number()
        .int()
        .min(1)
        .max(50)
        .default(25)
        .describe(
          'How many URLs to inspect. Google takes about six seconds per inspection, so 25 takes around 25 seconds and 50 is the most one call can finish. Call again for a second sample.',
        ),
      sampling: z
        .enum(['random', 'first'])
        .default('random')
        .describe('"random" picks a representative sample; "first" takes the URLs in sitemap order.'),
      language_code: languageField,
    },
    run: async (args) => {
      const site = await deps.sites.resolve(args.site_url ?? args.sitemap_url);
      let sitemaps: string[];
      if (args.sitemap_url) {
        sitemaps = [args.sitemap_url];
      } else {
        sitemaps = (await deps.client.listSitemaps(site.siteUrl)).map((sitemap) => sitemap.path);
        if (sitemaps.length === 0) {
          throw new UserError(
            `No sitemaps are submitted for ${site.siteUrl}.`,
            'Pass sitemap_url to audit a sitemap directly, or submit one in Search Console first.',
          );
        }
      }

      const crawl = await collectSitemapUrls(sitemaps, {
        fetch: deps.fetch,
        isAllowed: (url) => urlBelongsToSite(url, site.siteUrl),
        maxUrls: 50_000,
        maxSitemaps: 25,
      });
      const inProperty = crawl.urls.filter((url) => urlBelongsToSite(url, site.siteUrl));
      if (inProperty.length === 0) {
        throw new UserError(
          'No inspectable URLs were found in the sitemaps.',
          crawl.skipped.length
            ? `Sitemaps that could not be read: ${crawl.skipped.map((item) => `${item.sitemap} (${item.reason})`).join('; ')}`
            : 'The sitemaps list no URLs that belong to this property.',
        );
      }

      const chosen = args.sampling === 'first' ? inProperty.slice(0, args.max_urls) : sample(inProperty, args.max_urls, deps.random);
      const { outcomes, notInspected } = await inspectAll(deps, site.siteUrl, chosen, args.language_code);
      const inspected = outcomes.filter((outcome): outcome is InspectionSummary => !hasError(outcome));
      const failed = outcomes.filter(hasError);
      const indexed = inspected.filter((item) => item.indexed);

      const states = new Map<string, number>();
      for (const item of inspected) {
        const state = item.coverage_state ?? 'Unknown';
        states.set(state, (states.get(state) ?? 0) + 1);
      }

      const notes: string[] = [];
      if (inspected.length < inProperty.length) {
        notes.push(
          `This is a ${args.sampling === 'random' ? 'random sample' : 'slice'} of ${inspected.length} out of ${inProperty.length} URLs. Read the percentages as an estimate, and run the audit again for a second sample if you need more certainty.`,
        );
      }
      if (notInspected.length) {
        notes.push(`${TIME_LIMIT_NOTE} ${notInspected.length} of the ${chosen.length} chosen URLs were not reached.`);
      }
      if (crawl.truncated) notes.push('Not every sitemap was read: the crawl stopped at 25 sitemap files or 50,000 URLs.');
      if (failed.length) notes.push(`${failed.length} inspections failed, usually because the daily quota ran out: ${failed[0]?.error}`);
      notes.push('A URL in a sitemap that is not indexed is a signal, not always a fault: check whether it should be in the sitemap at all (redirects, noindex pages and duplicates should not be).');

      return {
        site: site.siteUrl,
        sitemaps_read: crawl.sitemapsRead,
        ...(crawl.skipped.length ? { sitemaps_skipped: crawl.skipped } : {}),
        urls_in_sitemaps: crawl.urls.length,
        urls_outside_property: crawl.urls.length - inProperty.length,
        urls_inspected: inspected.length,
        indexed: indexed.length,
        not_indexed: inspected.length - indexed.length,
        indexed_pct: inspected.length ? round((indexed.length / inspected.length) * 100, 1) : null,
        by_coverage_state: table(
          ['coverage_state', 'urls'],
          [...states.entries()].sort((a, b) => b[1] - a[1]),
        ),
        problems: table(
          ['url', 'coverage_state', 'last_crawl', 'issues'],
          inspected
            .filter((item) => item.issues.length > 0)
            .map((item) => [item.url, item.coverage_state, item.last_crawl, item.issues.join(' ')]),
        ),
        notes,
      };
    },
  });

  defineTool(server, {
    name: 'list_sitemaps',
    title: 'List sitemaps',
    description:
      'Lists the sitemaps submitted for a property with their processing state, when Google last read them, error and warning counts, and how many URLs each one submits.',
    input: {
      site_url: siteUrlField,
      sitemap_index: z.string().url().optional().describe('Only list the sitemaps contained in this sitemap index.'),
    },
    run: async (args) => {
      const site = await deps.sites.resolve(args.site_url);
      const sitemaps = await deps.client.listSitemaps(site.siteUrl, args.sitemap_index);
      const withProblems = sitemaps.filter((sitemap) => Number(sitemap.errors ?? 0) > 0);
      return {
        site: site.siteUrl,
        sitemap_count: sitemaps.length,
        sitemaps: table(SITEMAP_COLUMNS, sitemaps.map(sitemapCells)),
        notes: [
          ...(sitemaps.length === 0 ? ['No sitemaps are submitted for this property.'] : []),
          ...(withProblems.length
            ? [`${withProblems.length} sitemap(s) have errors. Open them in Search Console (Indexing > Sitemaps) to read the messages.`]
            : []),
          'The API reports how many URLs were submitted, not how many are indexed. Use audit_sitemap_indexing for that.',
        ],
      };
    },
  });

  if (!deps.config.allowWrite) return;

  defineTool(server, {
    name: 'submit_sitemap',
    title: 'Submit a sitemap',
    kind: 'write',
    description:
      'Submits a sitemap to Search Console, or resubmits one so Google reads it again. The sitemap must already be live at the given URL.',
    input: {
      site_url: siteUrlField,
      sitemap_url: z.string().url().describe('Full URL of the sitemap or sitemap index.'),
    },
    run: async (args) => {
      const site = await deps.sites.resolve(args.site_url ?? args.sitemap_url);
      assertInProperty(args.sitemap_url, site.siteUrl);
      await deps.client.submitSitemap(site.siteUrl, args.sitemap_url);
      const status = await deps.client.getSitemap(site.siteUrl, args.sitemap_url).catch(() => undefined);
      return {
        site: site.siteUrl,
        submitted: args.sitemap_url,
        ...(status ? { status: table(SITEMAP_COLUMNS, [sitemapCells(status)]) } : {}),
        notes: ['Google processes sitemaps on its own schedule. Check list_sitemaps later for the result.'],
      };
    },
  });

  defineTool(server, {
    name: 'delete_sitemap',
    title: 'Remove a sitemap',
    kind: 'destructive',
    description:
      'Removes a sitemap from Search Console. It does not delete the file from the website and does not remove pages from Google\'s index.',
    input: {
      site_url: siteUrlField,
      sitemap_url: z.string().url().describe('Full URL of the sitemap to remove, as shown by list_sitemaps.'),
    },
    run: async (args) => {
      const site = await deps.sites.resolve(args.site_url ?? args.sitemap_url);
      // Google answers "done" when asked to remove a sitemap that was never submitted, which would
      // let this tool report a removal that did not happen. So look before deleting.
      const submitted = (await deps.client.listSitemaps(site.siteUrl)).map((sitemap) => sitemap.path);
      if (!submitted.includes(args.sitemap_url)) {
        throw new UserError(
          `${args.sitemap_url} is not a sitemap submitted for ${site.siteUrl}, so there is nothing to remove.`,
          submitted.length
            ? `Use the exact address of a submitted sitemap: ${submitted.join(', ')}.`
            : 'No sitemaps are submitted for this property.',
        );
      }
      await deps.client.deleteSitemap(site.siteUrl, args.sitemap_url);
      return { site: site.siteUrl, removed: args.sitemap_url };
    },
  });
}
