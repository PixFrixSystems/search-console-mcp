// Runs the built server against a REAL Search Console property and checks that every read-only
// tool answers and that the numbers agree with each other.
//
//   npm run live-check -- --site example.com
//
// It needs working credentials (see docs/authentication.md). It only reads data, and it uses
// about 60 API calls and at most 7 of the 2,000 daily URL inspections.
//
// Keep this honest: it has already caught things the unit tests could not, because those only know
// what Google's documentation says. Add a check here whenever real data surprises you.
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const argv = process.argv.slice(2);
const option = (name) => {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
};
const entry = option('--server') ?? fileURLToPath(new URL('../dist/index.js', import.meta.url));
const wantedSite = option('--site') ?? process.env.GSC_SITE_URL;

const env = Object.fromEntries(Object.entries(process.env).filter(([, value]) => typeof value === 'string'));
const client = new Client({ name: 'live-check', version: '1.0.0' });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [entry], env, stderr: 'inherit' }));

const results = [];

async function call(name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content?.[0]?.text ?? '';
  if (result.isError) throw new Error(text.replace(/\s*\n\s*/g, ' '));
  return JSON.parse(text);
}

/** Runs one check. The function returns a short detail string, or { warn } for something worth a look. */
async function check(name, run) {
  const started = Date.now();
  try {
    const outcome = await run();
    const warn = typeof outcome === 'object' && outcome !== null ? outcome.warn : undefined;
    results.push({ name, status: warn ? 'WARN' : 'PASS', detail: warn ?? outcome ?? '', ms: Date.now() - started });
  } catch (error) {
    results.push({ name, status: 'FAIL', detail: error.message, ms: Date.now() - started });
  }
}

const records = (table) => table.rows.map((cells) => Object.fromEntries(table.columns.map((column, index) => [column, cells[index]])));
const sum = (rows, key) => rows.reduce((total, row) => total + (row[key] ?? 0), 0);
const near = (a, b, tolerance = 0.01) => Math.abs(a - b) <= Math.max(1, Math.abs(b) * tolerance);
const expect = (condition, message) => {
  if (!condition) throw new Error(message);
};

function report() {
  const width = Math.max(...results.map((result) => result.name.length));
  console.log('');
  for (const result of results) {
    console.log(`${result.status}  ${result.name.padEnd(width)}  ${String(result.ms).padStart(5)} ms  ${result.detail}`);
  }
  const failed = results.filter((result) => result.status === 'FAIL').length;
  const warned = results.filter((result) => result.status === 'WARN').length;
  console.log('');
  console.log(`${results.length - failed - warned} passed, ${warned} to look at, ${failed} failed.`);
  return failed;
}

// --- Which property? -------------------------------------------------------------------------

let site;
await check('list_sites', async () => {
  const listed = await call('list_sites');
  const verified = records(listed.properties).filter((property) => property.permission !== 'siteUnverifiedUser');
  expect(verified.length > 0, 'The account cannot read any verified property. Run "doctor" for the fix.');
  site = wantedSite ?? verified[0].site_url;
  const who = listed.account.email ?? listed.account.method;
  return `${verified.length} properties as ${who}; testing ${site}${wantedSite ? '' : ' (pass --site to choose another)'}`;
});

if (!site) {
  report();
  await client.close();
  process.exit(1);
}

// --- Performance data and its internal consistency --------------------------------------------

let overview;
await check('get_performance_overview', async () => {
  overview = await call('get_performance_overview', { site_url: site });
  site = overview.site;
  const { clicks, impressions } = overview.totals;
  if (impressions === 0) return { warn: 'The property has no impressions in the period, so most checks below prove little. Try a busier property.' };
  return `${clicks} clicks, ${impressions} impressions, ${overview.trend.rows.length} days of trend`;
});

if (overview) {
  await check('totals agree across tools', async () => {
    const raw = await call('search_analytics', { site_url: site });
    const [clicks, impressions] = raw.rows.rows[0] ?? [0, 0];
    expect(clicks === overview.totals.clicks, `search_analytics says ${clicks} clicks, the overview says ${overview.totals.clicks}`);
    expect(impressions === overview.totals.impressions, `impressions differ: ${impressions} against ${overview.totals.impressions}`);
    return 'search_analytics totals equal the overview totals';
  });

  await check('daily rows add up to the total', async () => {
    const daily = records(overview.trend);
    const clicks = sum(daily, 'clicks');
    const impressions = sum(daily, 'impressions');
    expect(near(clicks, overview.totals.clicks), `days sum to ${clicks} clicks, total is ${overview.totals.clicks}`);
    expect(near(impressions, overview.totals.impressions), `days sum to ${impressions} impressions, total is ${overview.totals.impressions}`);
    return `${daily.length} days sum to ${clicks} clicks`;
  });

  await check('query rows stay within the total', async () => {
    const byQuery = await call('search_analytics', { site_url: site, dimensions: ['query'], row_limit: 25000 });
    const clicks = sum(records(byQuery.rows), 'clicks');
    expect(clicks <= overview.totals.clicks * 1.01 + 1, `query rows sum to ${clicks} clicks, more than the total ${overview.totals.clicks}`);
    const share = overview.totals.clicks ? Math.round((clicks / overview.totals.clicks) * 100) : 0;
    return `${byQuery.row_count} queries carry ${share}% of clicks; the rest is anonymised`;
  });

  await check('device rows add up to the total', async () => {
    const clicks = sum(records(overview.devices), 'clicks');
    expect(near(clicks, overview.totals.clicks), `devices sum to ${clicks} clicks, total is ${overview.totals.clicks}`);
    return `${overview.devices.rows.length} devices sum to ${clicks} clicks`;
  });
}

await check('default period ends on the last complete day', async () => {
  // Ask for the last ten days up to today. If Google is still collecting some of them, the tool
  // says from which day, and the default period must stop the day before.
  const recent = await call('search_analytics', { site_url: site, dimensions: ['date'], end_date: 'today', days: 10 });
  const match = /still collecting data from (\d{4}-\d{2}-\d{2})/.exec((recent.notes ?? []).join(' '));
  if (!match) return { warn: 'Google reported no incomplete days in the last ten, so this could not be checked.' };
  const boundary = new Date(`${match[1]}T00:00:00Z`);
  boundary.setUTCDate(boundary.getUTCDate() - 1);
  const lastComplete = boundary.toISOString().slice(0, 10);
  expect(
    overview?.period.end_date === lastComplete,
    `the default period ends ${overview?.period.end_date}, but the last complete day is ${lastComplete}`,
  );
  return `Google is still collecting from ${match[1]}; the default period ends ${lastComplete}`;
});

await check('compare_periods', async () => {
  const compared = await call('compare_periods', { site_url: site, dimension: 'query' });
  if (overview) {
    expect(compared.change.clicks === overview.change.clicks, 'the change in clicks differs from the overview');
  }
  return `${compared.gainers.rows.length} gainers, ${compared.decliners.rows.length} decliners, ${compared.new.rows.length} new, ${compared.lost.rows.length} lost`;
});

// --- The parts of the API that are easiest to get wrong ----------------------------------------

await check('hourly data', async () => {
  const hourly = await call('search_analytics', { site_url: site, dimensions: ['hour'] });
  return hourly.row_count ? `${hourly.row_count} hours, first ${hourly.rows.rows[0][0]}` : { warn: 'No hourly rows came back.' };
});

await check('recent, still incomplete days on request', async () => {
  const fresh = await call('search_analytics', { site_url: site, dimensions: ['date'], end_date: 'today', days: 7 });
  const latest = fresh.rows.rows.at(-1)?.[0];
  if (overview && latest && latest <= overview.period.end_date) {
    return { warn: `asked for data up to today but the newest day returned is ${latest}` };
  }
  return `${fresh.row_count} days up to ${latest ?? 'none'}, flagged as partial`;
});

await check('data_state final drops unfinished days', async () => {
  const settled = await call('search_analytics', { site_url: site, dimensions: ['date'], end_date: 'today', days: 7, data_state: 'final' });
  const latest = settled.rows.rows.at(-1)?.[0];
  expect(!overview || !latest || latest <= overview.period.end_date, `"final" returned ${latest}, after the last complete day ${overview?.period.end_date}`);
  return `newest final day ${latest ?? 'none'}`;
});

for (const type of ['image', 'video', 'news', 'discover', 'googleNews']) {
  await check(`search type ${type}`, async () => {
    const result = await call('search_analytics', { site_url: site, search_type: type });
    return result.row_count ? `${result.rows.rows[0][0]} clicks` : 'no data, which is normal for many sites';
  });
}

await check('regex filter', async () => {
  const filtered = await call('search_analytics', {
    site_url: site,
    dimensions: ['query'],
    filters: [{ dimension: 'query', operator: 'includingRegex', expression: '^(how|what|why|who|when|where)\\b' }],
    row_limit: 5,
  });
  return `${filtered.row_count} question queries`;
});

await check('sort by impressions', async () => {
  const sorted = records((await call('search_analytics', { site_url: site, dimensions: ['page'], order_by: 'impressions', row_limit: 5 })).rows);
  for (let index = 1; index < sorted.length; index += 1) {
    expect(sorted[index].impressions <= sorted[index - 1].impressions, 'rows are not in descending order of impressions');
  }
  return `${sorted.length} pages, top has ${sorted[0]?.impressions ?? 0} impressions`;
});

// --- Analysis tools ---------------------------------------------------------------------------

await check('find_quick_wins', async () => {
  const wins = await call('find_quick_wins', { site_url: site });
  for (const row of records(wins.opportunities)) {
    expect(row.position >= 4 && row.position <= 20, `a row at position ${row.position} is outside 4 to 20`);
  }
  const model = wins.ctr_model;
  return `${wins.opportunities_found} keywords, about ${wins.estimated_extra_clicks_total} extra clicks; CTR curve ${model.based_on_site_data_pct}% from this site, position 1 at ${model.expected_ctr_pct_positions_1_to_10[0]}%`;
});

await check('find_ctr_opportunities', async () => {
  const gaps = await call('find_ctr_opportunities', { site_url: site });
  return `${gaps.pages_found} pages, ${gaps.query_page_pairs_found} query and page pairs`;
});

await check('find_keyword_cannibalization', async () => {
  const found = await call('find_keyword_cannibalization', { site_url: site });
  return `${found.queries_found} queries split between pages`;
});

await check('find_declining_pages', async () => {
  const declining = await call('find_declining_pages', { site_url: site, explain_top: 1 });
  const causes = Object.keys(declining.likely_causes).join(', ') || 'none';
  return `${declining.declining_found} pages lost ${declining.clicks_lost_total} clicks; causes seen: ${causes}`;
});

await check('find_content_gaps', async () => {
  const gaps = await call('find_content_gaps', { site_url: site });
  return `${gaps.weakly_served_found} weakly served queries, ${gaps.question_queries_found} question queries`;
});

await check('detect_traffic_anomalies', async () => {
  const scan = await call('detect_traffic_anomalies', { site_url: site });
  const week =
    scan.latest_7_days.change_pct === null
      ? 'no baseline yet'
      : `latest week ${scan.latest_7_days.change_pct}% against a typical one`;
  return `${scan.anomalies_found} unusual days; ${scan.history_days} days of history; ${week}`;
});

await check('get_brand_split', async () => {
  const host = site.replace(/^sc-domain:/, '').replace(/^https?:\/\//, '').replace(/^www\./, '');
  const brand = host.split(/[./]/)[0];
  const split = await call('get_brand_split', { site_url: site, brand_terms: [brand] });
  const rows = Object.fromEntries(records(split.segments).map((row) => [row.segment, row]));
  const parts = rows.branded.clicks + rows.non_branded.clicks + rows.anonymised.clicks;
  expect(near(parts, rows.total.clicks), `segments sum to ${parts} clicks, total is ${rows.total.clicks}`);
  return `brand term "${brand}": ${rows.branded.share_of_clicks_pct}% branded, ${rows.non_branded.share_of_clicks_pct}% non-branded, ${rows.anonymised.share_of_clicks_pct}% anonymised`;
});

// --- One page, indexing and sitemaps ----------------------------------------------------------

const topPage = overview?.top_pages.rows[0]?.[0];
if (topPage) {
  await check('analyze_page', async () => {
    const page = await call('analyze_page', { site_url: site, page_url: topPage });
    expect(page.totals.clicks > 0, 'the top page by clicks reports zero clicks when analysed on its own');
    if (page.index_status?.error) return { warn: `performance data is fine, but the inspection failed: ${page.index_status.error}` };
    return `${topPage}: ${page.totals.clicks} clicks, ${page.queries_found} queries, ${page.optimisation_targets.rows.length} optimisation targets`;
  });

  await check('inspect_url', async () => {
    const inspection = await call('inspect_url', { site_url: site, url: topPage });
    if (!inspection.indexed) return { warn: `Google reports the top page as not indexed: ${inspection.issues.join(' ')}` };
    return `indexed, ${inspection.coverage_state}, last crawled ${inspection.last_crawl}`;
  });
} else {
  results.push({ name: 'analyze_page / inspect_url', status: 'WARN', detail: 'Skipped: the property has no page with clicks.', ms: 0 });
}

let sitemapCount = 0;
await check('list_sitemaps', async () => {
  const listed = await call('list_sitemaps', { site_url: site });
  sitemapCount = listed.sitemap_count;
  return sitemapCount ? `${sitemapCount} sitemaps` : { warn: 'No sitemaps are submitted, so the sitemap audit is skipped.' };
});

if (sitemapCount > 0) {
  await check('audit_sitemap_indexing', async () => {
    const audit = await call('audit_sitemap_indexing', { site_url: site, max_urls: 5 });
    expect(audit.urls_inspected > 0, 'no URL could be inspected');
    return `${audit.urls_in_sitemaps} URLs in ${audit.sitemaps_read.length} sitemaps; ${audit.indexed} of ${audit.urls_inspected} sampled are indexed`;
  });
}

const failed = report();

if (overview) {
  const { period, totals } = overview;
  console.log('');
  console.log('Last step, by eye: open Search Console > Performance > Search results for this property,');
  console.log(`set the date filter to a custom range of ${period.start_date} to ${period.end_date}, search type Web, and compare:`);
  console.log(`  Total clicks        ${totals.clicks}`);
  console.log(`  Total impressions   ${totals.impressions}`);
  console.log(`  Average CTR         ${totals.ctr_pct}%`);
  console.log(`  Average position    ${totals.position}`);
  const queries = overview.top_queries.rows.slice(0, 3);
  if (queries.length) {
    console.log('  Top queries         ' + queries.map((row) => `${row[0]} (${row[1]} clicks)`).join(', '));
  }
}

await client.close();
process.exit(failed ? 1 : 0);
