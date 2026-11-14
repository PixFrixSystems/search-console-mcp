import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';

const siteArg = z
  .string()
  .optional()
  .describe('Search Console property or domain, for example "example.com". Leave empty to use the default property.');

function siteClause(site: string | undefined): string {
  return site ? `the Search Console property "${site}"` : 'my Search Console property (use the default one, or ask me which if there are several)';
}

function userMessage(text: string) {
  return { messages: [{ role: 'user' as const, content: { type: 'text' as const, text } }] };
}

const REPORTING_RULES = [
  'Rules for the write-up:',
  '- Lead with the conclusion, then the evidence. Quote the actual numbers from the tools.',
  '- Say what to do, on which URL, and why. Skip generic SEO advice that the data does not support.',
  '- Keep estimates labelled as estimates.',
  '- If a tool returns an error, tell me what it said and how to fix it, then continue with the rest.',
].join('\n');

/** Ready-made workflows that show up as slash commands or prompt templates in MCP clients. */
export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    'seo_weekly_report',
    {
      title: 'Weekly SEO report',
      description: 'A short report on how search performance moved in the last 7 days and what caused it.',
      argsSchema: z.object({
        site: siteArg,
        brand_terms: z.string().optional().describe('Comma-separated brand names, to separate branded from non-branded search.'),
      }),
    },
    ({ site, brand_terms }) =>
      userMessage(
        [
          `Write a weekly SEO report for ${siteClause(site)}.`,
          '',
          'Steps:',
          '1. Call get_performance_overview with days 7 and compare_to "previous_period".',
          '2. Call compare_periods for dimension "page" and again for dimension "query", both with days 7, to find what moved.',
          '3. Call detect_traffic_anomalies to see whether any day was unusual.',
          brand_terms
            ? `4. Call get_brand_split with days 7 and brand_terms [${brand_terms.split(',').map((term) => `"${term.trim()}"`).join(', ')}].`
            : '4. If you know the brand name, call get_brand_split with it to separate branded from non-branded search.',
          '',
          'Then write: a two-sentence summary, a small table of the headline numbers with their change, the three biggest gains and the three biggest losses with the likely reason for each, and up to three things to do next week.',
          '',
          REPORTING_RULES,
        ].join('\n'),
      ),
  );

  server.registerPrompt(
    'seo_opportunity_audit',
    {
      title: 'SEO opportunity audit',
      description: 'Finds the highest-value improvements available right now and turns them into a prioritised plan.',
      argsSchema: z.object({ site: siteArg }),
    },
    ({ site }) =>
      userMessage(
        [
          `Audit ${siteClause(site)} for SEO opportunities and give me a prioritised action plan.`,
          '',
          'Steps:',
          '1. get_performance_overview for the last 28 days, for context.',
          '2. find_quick_wins: keywords close to the top results.',
          '3. find_ctr_opportunities: pages that rank well but are rarely clicked.',
          '4. find_keyword_cannibalization: pages competing with each other.',
          '5. find_declining_pages: content that is losing traffic.',
          '6. find_content_gaps: topics with demand and no strong page.',
          '7. For the three pages that come up most often, call analyze_page to confirm the picture.',
          '',
          'Then write the plan as a table with one row per action: the action, the page, the evidence (numbers), the estimated gain in clicks, and the effort (low, medium, high). Order it by gain against effort, and put the five actions you would do first at the top.',
          '',
          REPORTING_RULES,
        ].join('\n'),
      ),
  );

  server.registerPrompt(
    'diagnose_traffic_drop',
    {
      title: 'Diagnose a traffic drop',
      description: 'Works out when search traffic dropped, which pages and queries caused it, and the most likely reason.',
      argsSchema: z.object({
        site: siteArg,
        around_date: z.string().optional().describe('Roughly when the drop happened, YYYY-MM-DD, if known.'),
      }),
    },
    ({ site, around_date }) =>
      userMessage(
        [
          `Search traffic for ${siteClause(site)} seems to have dropped${around_date ? ` around ${around_date}` : ''}. Find out what happened.`,
          '',
          'Steps:',
          '1. detect_traffic_anomalies over the last 90 days to pin down the date and size of the drop. If nothing unusual shows up, say so plainly.',
          '2. compare_periods for the weeks after the drop against the same number of weeks before it, once by page and once by query. Use start_date and end_date so the two periods sit on either side of the drop.',
          '3. find_declining_pages over the same periods and read the likely_cause column.',
          '4. compare_periods by device and by country to see whether the drop is concentrated.',
          '5. For the two or three pages that lost the most, call inspect_url to rule out indexing problems (noindex, canonical changes, crawl errors).',
          '',
          'Then tell me: when it started, how large it is, whether it is site-wide or concentrated in a section, device, country or query group, the most likely cause with the evidence for it, what you ruled out, and what to do. Mention when the timing matches a known Google update only if I can check it at https://status.search.google.com/summary.',
          '',
          REPORTING_RULES,
        ].join('\n'),
      ),
  );

  server.registerPrompt(
    'content_refresh_plan',
    {
      title: 'Content refresh plan',
      description: 'Picks the existing pages most worth updating and says what to change on each.',
      argsSchema: z.object({
        site: siteArg,
        section: z.string().optional().describe('Limit the plan to URLs containing this text, for example "/blog/".'),
      }),
    },
    ({ site, section }) => {
      const filter = section
        ? ` Pass filters [{"dimension":"page","operator":"contains","expression":"${section}"}] to every tool.`
        : '';
      return userMessage(
        [
          `Build a content refresh plan for ${siteClause(site)}.${filter}`,
          '',
          'Steps:',
          '1. find_declining_pages with days 90 and compare_to "previous_period", to find content that is fading.',
          '2. find_quick_wins with days 90, and look at pages_with_most_potential.',
          '3. find_ctr_opportunities with days 90.',
          '4. Choose up to eight pages that appear in more than one list or carry the largest numbers, and call analyze_page on each.',
          '',
          'For each chosen page give: why it was picked (numbers), the queries to strengthen, what to add or rewrite, whether the title and description need work, and whether another page competes with it. Finish with the order in which to do them.',
          '',
          REPORTING_RULES,
        ].join('\n'),
      );
    },
  );

  server.registerPrompt(
    'indexing_health_check',
    {
      title: 'Indexing health check',
      description: 'Checks sitemaps and a sample of URLs for indexing problems.',
      argsSchema: z.object({ site: siteArg }),
    },
    ({ site }) =>
      userMessage(
        [
          `Check the indexing health of ${siteClause(site)}.`,
          '',
          'Steps:',
          '1. list_sitemaps: note any with errors, warnings, or that Google has not read recently.',
          '2. audit_sitemap_indexing with max_urls 40 to estimate how much of the sitemap is indexed and why the rest is not.',
          '3. get_performance_overview for the last 28 days, then inspect_urls on the top ten pages by clicks to confirm the pages that matter most are healthy.',
          '',
          'Then report: the share of sampled URLs that is indexed, the reasons for the rest grouped by coverage state with example URLs, any canonical mismatches, any structured data errors, and the fixes in order of importance. Be clear that the audit is a sample.',
          '',
          REPORTING_RULES,
        ].join('\n'),
      ),
  );

  server.registerPrompt(
    'optimize_page',
    {
      title: 'Optimise one page',
      description: 'A data-backed brief for improving a single page.',
      argsSchema: z.object({ page_url: z.string().describe('Full URL of the page to improve.') }),
    },
    ({ page_url }) =>
      userMessage(
        [
          `Prepare an optimisation brief for ${page_url}.`,
          '',
          'Steps:',
          '1. analyze_page for this URL with days 90.',
          '2. find_keyword_cannibalization with a page filter for this URL, to see whether another page competes for its queries.',
          '3. If you can read web pages, open the page and compare its title, headings and content with the queries it ranks for.',
          '',
          'Then give me: the queries this page should own (those it ranks 4 to 20 for with real impressions), what is missing from the page for those queries, a suggested title and meta description if the click-through rate is weak, any indexing or canonical problem, and the three changes most likely to bring more clicks.',
          '',
          REPORTING_RULES,
        ].join('\n'),
      ),
  );
}
