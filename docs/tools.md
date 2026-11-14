# Tool reference

Generated from the server by `npm run docs:tools`. Do not edit by hand.

Every tool returns a JSON document. Tables inside it have the shape `{"columns": [...], "rows": [[...], ...]}`.
CTR values are percentages, position is the average topmost position (lower is better), and dates are Pacific Time.

## Parameters shared by most tools

- `site_url`: the property. An exact name (`sc-domain:example.com`, `https://www.example.com/`), a bare domain or any page URL on the site. Optional when `GSC_SITE_URL` is set or the account has one property.
- `start_date`, `end_date`, `days`: the period. With none given, the 28 days ending on the last day Google has complete data for. `end_date` also accepts `today` and `yesterday`.
- `filters`: a list of `{"dimension", "operator", "expression"}` objects that must all match. Dimensions: `query`, `page`, `country`, `device`, `searchAppearance`. Operators: `equals` (default), `notEquals`, `contains`, `notContains`, `includingRegex`, `excludingRegex`.
- `search_type`: `web` (default), `image`, `video`, `news`, `discover` or `googleNews`.

## Tools

- [`list_sites`](#list_sites)
- [`search_analytics`](#search_analytics)
- [`get_performance_overview`](#get_performance_overview)
- [`compare_periods`](#compare_periods)
- [`find_quick_wins`](#find_quick_wins)
- [`find_ctr_opportunities`](#find_ctr_opportunities)
- [`find_keyword_cannibalization`](#find_keyword_cannibalization)
- [`find_declining_pages`](#find_declining_pages)
- [`find_content_gaps`](#find_content_gaps)
- [`get_brand_split`](#get_brand_split)
- [`detect_traffic_anomalies`](#detect_traffic_anomalies)
- [`analyze_page`](#analyze_page)
- [`inspect_url`](#inspect_url)
- [`inspect_urls`](#inspect_urls)
- [`audit_sitemap_indexing`](#audit_sitemap_indexing)
- [`list_sitemaps`](#list_sitemaps)
- [`submit_sitemap`](#submit_sitemap)
- [`delete_sitemap`](#delete_sitemap)

### list_sites

**List Search Console properties.** Lists every Search Console property the connected Google account can read, with its type and permission level. Call this first when you do not know the exact property name.

Read-only.

No parameters.

### search_analytics

**Query search performance data.** Runs a raw Search Console performance query: clicks, impressions, CTR and average position, broken down by any mix of query, page, country, device, date, hour and search appearance, with filters. Use it for anything the specialised tools do not cover. Rows come back sorted by clicks unless order_by says otherwise.

Read-only.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `site_url` | string |  | Search Console property, for example "sc-domain:example.com" or "https://www.example.com/". A bare domain or any page URL on the site also works. Optional when GSC_SITE_URL is set or the account has exactly one property. |
| `start_date` | string |  | First day of the period, YYYY-MM-DD in Pacific Time. Defaults to `days` before end_date. |
| `end_date` | string |  | Last day of the period, YYYY-MM-DD in Pacific Time, or "today" / "yesterday". Defaults to the latest day Google has complete data for, usually 3 to 4 days ago. A later date includes days that are still incomplete. |
| `days` | integer (min 1, max 500) |  | Length of the period in days, used when start_date is not given. Default 28. |
| `dimensions` | list of `query`, `page`, `country`, `device`, `searchAppearance`, `date`, `hour` (up to 4) | `[]` | How to break the numbers down, in order. Empty returns one row of totals. "searchAppearance" cannot be combined with other dimensions. "hour" needs data_state "hourly_all" and only covers the last few days. |
| `filters` | list of filters (up to 25) |  | Filters; a row must match all of them. Example: [{"dimension":"page","operator":"contains","expression":"/blog/"},{"dimension":"country","operator":"equals","expression":"usa"}]. Countries are ISO 3166-1 alpha-3 codes, devices are DESKTOP, MOBILE or TABLET, and the regex operators use RE2 syntax. |
| `search_type` | `web`, `image`, `video`, `news`, `discover`, `googleNews` | `"web"` | Which Google surface: web (default), image, video, news (the News tab), discover or googleNews. |
| `data_state` | `final`, `all`, `hourly_all` | `"all"` | "all" (default) matches the Search Console website: complete days, plus partial numbers for recent days if the period reaches that far. "final" leaves out any day that is not final yet. "hourly_all" is for the hour dimension. |
| `aggregation_type` | `auto`, `byPage`, `byProperty`, `byNewsShowcasePanel` |  | How impressions are counted: "byProperty" counts a search once however many of your pages appear, "byPage" counts each page. Leave unset for Google's default. |
| `order_by` | `clicks`, `impressions`, `ctr`, `position` |  | Sort by this metric instead of clicks. The tool then reads up to 25,000 rows and sorts them locally, so "top by impressions" is correct within that scan. |
| `order` | `asc`, `desc` |  | Sort direction. Default desc, or asc for position (best first). |
| `row_limit` | integer (min 1, max 100000) | `100` | Maximum number of rows to return. |
| `start_row` | integer (min 0, max 9007199254740991) | `0` | Zero-based offset, for paging through results. |

### get_performance_overview

**Performance overview.** One-call snapshot of a property: total clicks, impressions, CTR and position against a comparison period, the trend over time, and the top queries, pages, countries, devices and search appearances. The best starting point for a report or before digging into a specific question.

Read-only.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `site_url` | string |  | Search Console property, for example "sc-domain:example.com" or "https://www.example.com/". A bare domain or any page URL on the site also works. Optional when GSC_SITE_URL is set or the account has exactly one property. |
| `start_date` | string |  | First day of the period, YYYY-MM-DD in Pacific Time. Defaults to `days` before end_date. |
| `end_date` | string |  | Last day of the period, YYYY-MM-DD in Pacific Time, or "today" / "yesterday". Defaults to the latest day Google has complete data for, usually 3 to 4 days ago. A later date includes days that are still incomplete. |
| `days` | integer (min 1, max 500) |  | Length of the period in days, used when start_date is not given. Default 28. |
| `compare_to` | `previous_period`, `previous_year`, `custom`, `none` | `"previous_period"` | What to compare against: the same number of days immediately before, the same period 52 weeks earlier, a custom range (set compare_start_date and compare_end_date), or nothing. |
| `compare_start_date` | string |  | First day of the comparison period when compare_to is "custom". |
| `compare_end_date` | string |  | Last day of the comparison period when compare_to is "custom". |
| `filters` | list of filters (up to 25) |  | Filters; a row must match all of them. Example: [{"dimension":"page","operator":"contains","expression":"/blog/"},{"dimension":"country","operator":"equals","expression":"usa"}]. Countries are ISO 3166-1 alpha-3 codes, devices are DESKTOP, MOBILE or TABLET, and the regex operators use RE2 syntax. |
| `search_type` | `web`, `image`, `video`, `news`, `discover`, `googleNews` | `"web"` | Which Google surface: web (default), image, video, news (the News tab), discover or googleNews. |
| `top` | integer (min 1, max 50) | `10` | Maximum number of rows in each top list to return. |

### compare_periods

**Compare two periods.** Compares two periods row by row for one dimension (queries, pages, countries, devices or search appearances) and returns the biggest gainers and decliners plus what is new and what disappeared. Use it to explain why traffic moved.

Read-only.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `site_url` | string |  | Search Console property, for example "sc-domain:example.com" or "https://www.example.com/". A bare domain or any page URL on the site also works. Optional when GSC_SITE_URL is set or the account has exactly one property. |
| `start_date` | string |  | First day of the period, YYYY-MM-DD in Pacific Time. Defaults to `days` before end_date. |
| `end_date` | string |  | Last day of the period, YYYY-MM-DD in Pacific Time, or "today" / "yesterday". Defaults to the latest day Google has complete data for, usually 3 to 4 days ago. A later date includes days that are still incomplete. |
| `days` | integer (min 1, max 500) |  | Length of the period in days, used when start_date is not given. Default 28. |
| `compare_to` | `previous_period`, `previous_year`, `custom` | `"previous_period"` | What to compare against: the same number of days immediately before (default), the same period 52 weeks earlier, or a custom range (set compare_start_date and compare_end_date). |
| `compare_start_date` | string |  | First day of the comparison period when compare_to is "custom". |
| `compare_end_date` | string |  | Last day of the comparison period when compare_to is "custom". |
| `dimension` | `query`, `page`, `country`, `device`, `searchAppearance` | `"query"` | What to compare. |
| `filters` | list of filters (up to 25) |  | Filters; a row must match all of them. Example: [{"dimension":"page","operator":"contains","expression":"/blog/"},{"dimension":"country","operator":"equals","expression":"usa"}]. Countries are ISO 3166-1 alpha-3 codes, devices are DESKTOP, MOBILE or TABLET, and the regex operators use RE2 syntax. |
| `search_type` | `web`, `image`, `video`, `news`, `discover`, `googleNews` | `"web"` | Which Google surface: web (default), image, video, news (the News tab), discover or googleNews. |
| `sort_by` | `clicks`, `impressions` | `"clicks"` | Rank gainers and decliners by change in this metric. |
| `limit` | integer (min 1, max 200) | `25` | Maximum number of rows in each list to return. |
| `scan_rows` | integer (min 100, max 100000) | `25000` | How many rows to read from Search Console before analysing. Google returns rows sorted by clicks, so a larger scan reaches further into low-click, high-impression rows. Each 25,000 rows is one API call. |

### find_quick_wins

**Find quick-win keywords.** Finds "striking distance" keywords: queries where a page already ranks just below the top results (positions 4 to 20 by default) and is being seen. These are the cheapest rankings to improve. Returns each query with its page and an estimate of the extra clicks from reaching the target position, plus the pages with the most combined potential.

Read-only.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `site_url` | string |  | Search Console property, for example "sc-domain:example.com" or "https://www.example.com/". A bare domain or any page URL on the site also works. Optional when GSC_SITE_URL is set or the account has exactly one property. |
| `start_date` | string |  | First day of the period, YYYY-MM-DD in Pacific Time. Defaults to `days` before end_date. |
| `end_date` | string |  | Last day of the period, YYYY-MM-DD in Pacific Time, or "today" / "yesterday". Defaults to the latest day Google has complete data for, usually 3 to 4 days ago. A later date includes days that are still incomplete. |
| `days` | integer (min 1, max 500) |  | Length of the period in days, used when start_date is not given. Default 28. |
| `filters` | list of filters (up to 25) |  | Filters; a row must match all of them. Example: [{"dimension":"page","operator":"contains","expression":"/blog/"},{"dimension":"country","operator":"equals","expression":"usa"}]. Countries are ISO 3166-1 alpha-3 codes, devices are DESKTOP, MOBILE or TABLET, and the regex operators use RE2 syntax. |
| `search_type` | `web`, `image`, `video`, `news`, `discover`, `googleNews` | `"web"` | Which Google surface: web (default), image, video, news (the News tab), discover or googleNews. |
| `min_position` | number (min 1, max 100) | `4` | Best (lowest) average position to include. |
| `max_position` | number (min 1, max 100) | `20` | Worst (highest) average position to include. |
| `min_impressions` | integer (min 0, max 9007199254740991) | `30` | Ignore rows with fewer impressions than this in the period. |
| `target_position` | number (min 1, max 10) | `3` | The position the click estimate assumes the page reaches. |
| `brand_terms` | list of string (up to 50) |  | Brand names and their common spellings, for example ["acme", "acme corp"]. Defaults to GSC_BRAND_TERMS. |
| `limit` | integer (min 1, max 500) | `50` | Maximum number of opportunities to return. |
| `scan_rows` | integer (min 100, max 100000) | `25000` | How many rows to read from Search Console before analysing. Google returns rows sorted by clicks, so a larger scan reaches further into low-click, high-impression rows. Each 25,000 rows is one API call. |

### find_ctr_opportunities

**Find pages with weak click-through.** Finds results that rank well but are clicked much less than their position should earn, judged against the site's own CTR-by-position curve. These are candidates for a better title, meta description or structured data. Returns the underperforming pages (rolled up across their queries) and the individual query and page pairs, each with the clicks being missed.

Read-only.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `site_url` | string |  | Search Console property, for example "sc-domain:example.com" or "https://www.example.com/". A bare domain or any page URL on the site also works. Optional when GSC_SITE_URL is set or the account has exactly one property. |
| `start_date` | string |  | First day of the period, YYYY-MM-DD in Pacific Time. Defaults to `days` before end_date. |
| `end_date` | string |  | Last day of the period, YYYY-MM-DD in Pacific Time, or "today" / "yesterday". Defaults to the latest day Google has complete data for, usually 3 to 4 days ago. A later date includes days that are still incomplete. |
| `days` | integer (min 1, max 500) |  | Length of the period in days, used when start_date is not given. Default 28. |
| `filters` | list of filters (up to 25) |  | Filters; a row must match all of them. Example: [{"dimension":"page","operator":"contains","expression":"/blog/"},{"dimension":"country","operator":"equals","expression":"usa"}]. Countries are ISO 3166-1 alpha-3 codes, devices are DESKTOP, MOBILE or TABLET, and the regex operators use RE2 syntax. |
| `search_type` | `web`, `image`, `video`, `news`, `discover`, `googleNews` | `"web"` | Which Google surface: web (default), image, video, news (the News tab), discover or googleNews. |
| `max_position` | number (min 1, max 20) | `10` | Only consider rankings at this average position or better. |
| `min_impressions` | integer (min 0, max 9007199254740991) | `50` | Ignore rows with fewer impressions than this in the period. |
| `max_ctr_ratio` | number (min 0.05, max 1) | `0.6` | Flag a row when its CTR is at most this fraction of the expected CTR. 0.6 means at least 40% below expected. |
| `brand_terms` | list of string (up to 50) |  | Brand names and their common spellings, for example ["acme", "acme corp"]. Defaults to GSC_BRAND_TERMS. |
| `limit` | integer (min 1, max 300) | `30` | Maximum number of rows in each list to return. |
| `scan_rows` | integer (min 100, max 100000) | `25000` | How many rows to read from Search Console before analysing. Google returns rows sorted by clicks, so a larger scan reaches further into low-click, high-impression rows. Each 25,000 rows is one API call. |

### find_keyword_cannibalization

**Find keyword cannibalization.** Finds queries for which two or more pages of the site each take a meaningful share of the impressions, which often means the pages compete with each other. Returns each query with the competing pages, their share of impressions and their positions, ordered by how many impressions are split away from the strongest page.

Read-only.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `site_url` | string |  | Search Console property, for example "sc-domain:example.com" or "https://www.example.com/". A bare domain or any page URL on the site also works. Optional when GSC_SITE_URL is set or the account has exactly one property. |
| `start_date` | string |  | First day of the period, YYYY-MM-DD in Pacific Time. Defaults to `days` before end_date. |
| `end_date` | string |  | Last day of the period, YYYY-MM-DD in Pacific Time, or "today" / "yesterday". Defaults to the latest day Google has complete data for, usually 3 to 4 days ago. A later date includes days that are still incomplete. |
| `days` | integer (min 1, max 500) |  | Length of the period in days, used when start_date is not given. Default 28. |
| `filters` | list of filters (up to 25) |  | Filters; a row must match all of them. Example: [{"dimension":"page","operator":"contains","expression":"/blog/"},{"dimension":"country","operator":"equals","expression":"usa"}]. Countries are ISO 3166-1 alpha-3 codes, devices are DESKTOP, MOBILE or TABLET, and the regex operators use RE2 syntax. |
| `search_type` | `web`, `image`, `video`, `news`, `discover`, `googleNews` | `"web"` | Which Google surface: web (default), image, video, news (the News tab), discover or googleNews. |
| `min_impressions` | integer (min 0, max 9007199254740991) | `50` | Ignore queries with fewer total impressions than this. |
| `min_share_pct` | number (min 1, max 50) | `10` | A page counts as competing when it holds at least this percentage of the query's impressions. |
| `brand_terms` | list of string (up to 50) |  | Brand names and their common spellings, for example ["acme", "acme corp"]. Defaults to GSC_BRAND_TERMS. |
| `limit` | integer (min 1, max 200) | `25` | Maximum number of queries to return. |
| `scan_rows` | integer (min 100, max 100000) | `25000` | How many rows to read from Search Console before analysing. Google returns rows sorted by clicks, so a larger scan reaches further into low-click, high-impression rows. Each 25,000 rows is one API call. |

### find_declining_pages

**Find declining pages.** Finds the pages (or queries) that lost the most clicks against a comparison period and gives a first reading of why: a ranking loss, fewer impressions, or a lower click-through rate. For the worst cases it also lists what lost the most underneath (the queries of a page, or the pages of a query). Use it to plan content refreshes and to investigate traffic drops.

Read-only.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `site_url` | string |  | Search Console property, for example "sc-domain:example.com" or "https://www.example.com/". A bare domain or any page URL on the site also works. Optional when GSC_SITE_URL is set or the account has exactly one property. |
| `start_date` | string |  | First day of the period, YYYY-MM-DD in Pacific Time. Defaults to `days` before end_date. |
| `end_date` | string |  | Last day of the period, YYYY-MM-DD in Pacific Time, or "today" / "yesterday". Defaults to the latest day Google has complete data for, usually 3 to 4 days ago. A later date includes days that are still incomplete. |
| `days` | integer (min 1, max 500) |  | Length of the period in days, used when start_date is not given. Default 28. |
| `compare_to` | `previous_period`, `previous_year`, `custom` | `"previous_period"` | What to compare against: the same number of days immediately before (default), the same period 52 weeks earlier, or a custom range (set compare_start_date and compare_end_date). |
| `compare_start_date` | string |  | First day of the comparison period when compare_to is "custom". |
| `compare_end_date` | string |  | Last day of the comparison period when compare_to is "custom". |
| `dimension` | `page`, `query` | `"page"` | Look for declining pages or declining queries. |
| `filters` | list of filters (up to 25) |  | Filters; a row must match all of them. Example: [{"dimension":"page","operator":"contains","expression":"/blog/"},{"dimension":"country","operator":"equals","expression":"usa"}]. Countries are ISO 3166-1 alpha-3 codes, devices are DESKTOP, MOBILE or TABLET, and the regex operators use RE2 syntax. |
| `search_type` | `web`, `image`, `video`, `news`, `discover`, `googleNews` | `"web"` | Which Google surface: web (default), image, video, news (the News tab), discover or googleNews. |
| `min_previous_clicks` | integer (min 1, max 9007199254740991) | `10` | Only consider rows that had at least this many clicks in the comparison period. |
| `min_drop_pct` | number (min 1, max 100) | `20` | Only report rows whose clicks fell by at least this percentage. |
| `limit` | integer (min 1, max 200) | `25` | Maximum number of rows to return. |
| `explain_top` | integer (min 0, max 10) | `3` | For this many of the worst rows, also fetch the breakdown underneath. Each costs two API calls; 0 turns it off. |
| `scan_rows` | integer (min 100, max 100000) | `25000` | How many rows to read from Search Console before analysing. Google returns rows sorted by clicks, so a larger scan reaches further into low-click, high-impression rows. Each 25,000 rows is one API call. |

### find_content_gaps

**Find content gaps and question keywords.** Finds topics the site is visible for but does not serve well: queries with real impressions where the best page ranks beyond the second results page, and question-style queries (who, what, how ...) that suit FAQ sections, how-to content or new articles. Use it to plan new content.

Read-only.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `site_url` | string |  | Search Console property, for example "sc-domain:example.com" or "https://www.example.com/". A bare domain or any page URL on the site also works. Optional when GSC_SITE_URL is set or the account has exactly one property. |
| `start_date` | string |  | First day of the period, YYYY-MM-DD in Pacific Time. Defaults to `days` before end_date. |
| `end_date` | string |  | Last day of the period, YYYY-MM-DD in Pacific Time, or "today" / "yesterday". Defaults to the latest day Google has complete data for, usually 3 to 4 days ago. A later date includes days that are still incomplete. |
| `days` | integer (min 1, max 500) |  | Length of the period in days, used when start_date is not given. Default 28. |
| `filters` | list of filters (up to 25) |  | Filters; a row must match all of them. Example: [{"dimension":"page","operator":"contains","expression":"/blog/"},{"dimension":"country","operator":"equals","expression":"usa"}]. Countries are ISO 3166-1 alpha-3 codes, devices are DESKTOP, MOBILE or TABLET, and the regex operators use RE2 syntax. |
| `search_type` | `web`, `image`, `video`, `news`, `discover`, `googleNews` | `"web"` | Which Google surface: web (default), image, video, news (the News tab), discover or googleNews. |
| `min_impressions` | integer (min 0, max 9007199254740991) | `30` | Ignore queries with fewer impressions than this in the period. |
| `weak_position` | number (min 5, max 100) | `20` | A query counts as weakly served when the site's average position is worse than this. |
| `question_pattern` | string |  | Regular expression (JavaScript syntax, case-insensitive) that marks a query as a question. The default matches English question words at the start of the query; pass your own for other languages, for example "^(qué\|cómo\|dónde\|cuándo\|por qué\|cuál)\\b". |
| `brand_terms` | list of string (up to 50) |  | Brand names and their common spellings, for example ["acme", "acme corp"]. Defaults to GSC_BRAND_TERMS. |
| `limit` | integer (min 1, max 300) | `40` | Maximum number of rows in each list to return. |
| `scan_rows` | integer (min 100, max 100000) | `25000` | How many rows to read from Search Console before analysing. Google returns rows sorted by clicks, so a larger scan reaches further into low-click, high-impression rows. Each 25,000 rows is one API call. |

### get_brand_split

**Branded versus non-branded search.** Splits search performance into branded queries (containing the brand name), non-branded queries and anonymised queries, with the change against a comparison period. Non-branded traffic is the part SEO work actually wins, so this separates real organic growth from brand demand.

Read-only.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `site_url` | string |  | Search Console property, for example "sc-domain:example.com" or "https://www.example.com/". A bare domain or any page URL on the site also works. Optional when GSC_SITE_URL is set or the account has exactly one property. |
| `start_date` | string |  | First day of the period, YYYY-MM-DD in Pacific Time. Defaults to `days` before end_date. |
| `end_date` | string |  | Last day of the period, YYYY-MM-DD in Pacific Time, or "today" / "yesterday". Defaults to the latest day Google has complete data for, usually 3 to 4 days ago. A later date includes days that are still incomplete. |
| `days` | integer (min 1, max 500) |  | Length of the period in days, used when start_date is not given. Default 28. |
| `compare_to` | `previous_period`, `previous_year`, `custom`, `none` | `"previous_period"` | What to compare against: the same number of days immediately before, the same period 52 weeks earlier, a custom range (set compare_start_date and compare_end_date), or nothing. |
| `compare_start_date` | string |  | First day of the comparison period when compare_to is "custom". |
| `compare_end_date` | string |  | Last day of the comparison period when compare_to is "custom". |
| `brand_terms` | list of string (up to 50) |  | Brand names and their common spellings, for example ["acme", "acme corp"]. Defaults to GSC_BRAND_TERMS. |
| `filters` | list of filters (up to 25) |  | Filters; a row must match all of them. Example: [{"dimension":"page","operator":"contains","expression":"/blog/"},{"dimension":"country","operator":"equals","expression":"usa"}]. Countries are ISO 3166-1 alpha-3 codes, devices are DESKTOP, MOBILE or TABLET, and the regex operators use RE2 syntax. |
| `search_type` | `web`, `image`, `video`, `news`, `discover`, `googleNews` | `"web"` | Which Google surface: web (default), image, video, news (the News tab), discover or googleNews. |

### detect_traffic_anomalies

**Detect traffic drops and spikes.** Scans the daily trend for days that differ sharply from the same weekday in the preceding weeks, so the weekly rhythm does not trigger false alarms. Returns the unusual days with the expected value and how the latest week compares with a typical one. Use it for monitoring and as the first step when someone asks "did our traffic drop?".

Read-only.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `site_url` | string |  | Search Console property, for example "sc-domain:example.com" or "https://www.example.com/". A bare domain or any page URL on the site also works. Optional when GSC_SITE_URL is set or the account has exactly one property. |
| `end_date` | string |  | Last day of the period, YYYY-MM-DD in Pacific Time, or "today" / "yesterday". Defaults to the latest day Google has complete data for, usually 3 to 4 days ago. A later date includes days that are still incomplete. |
| `days` | integer (min 35, max 480) | `90` | How many days of history to examine. At least 35 are needed to form a baseline. |
| `metric` | `clicks`, `impressions` | `"clicks"` | Which metric to watch. |
| `min_deviation_pct` | number (min 5, max 95) | `30` | Smallest deviation from the expected value, in percent, worth reporting. |
| `filters` | list of filters (up to 25) |  | Filters; a row must match all of them. Example: [{"dimension":"page","operator":"contains","expression":"/blog/"},{"dimension":"country","operator":"equals","expression":"usa"}]. Countries are ISO 3166-1 alpha-3 codes, devices are DESKTOP, MOBILE or TABLET, and the regex operators use RE2 syntax. |
| `search_type` | `web`, `image`, `video`, `news`, `discover`, `googleNews` | `"web"` | Which Google surface: web (default), image, video, news (the News tab), discover or googleNews. |

### analyze_page

**Analyse one page.** Everything Search Console knows about a single page: its totals against a comparison period, the queries it ranks for with their change, the queries worth optimising for (ranked 4 to 20 with the most impressions), devices, countries, the trend, and its index status. Use it before rewriting or refreshing a page.

Read-only.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `site_url` | string |  | Search Console property, for example "sc-domain:example.com" or "https://www.example.com/". A bare domain or any page URL on the site also works. Optional when GSC_SITE_URL is set or the account has exactly one property. |
| `page_url` | string | **required** | Full URL of the page, exactly as it appears in Search Console. |
| `start_date` | string |  | First day of the period, YYYY-MM-DD in Pacific Time. Defaults to `days` before end_date. |
| `end_date` | string |  | Last day of the period, YYYY-MM-DD in Pacific Time, or "today" / "yesterday". Defaults to the latest day Google has complete data for, usually 3 to 4 days ago. A later date includes days that are still incomplete. |
| `days` | integer (min 1, max 500) |  | Length of the period in days, used when start_date is not given. Default 28. |
| `compare_to` | `previous_period`, `previous_year`, `custom`, `none` | `"previous_period"` | What to compare against: the same number of days immediately before, the same period 52 weeks earlier, a custom range (set compare_start_date and compare_end_date), or nothing. |
| `compare_start_date` | string |  | First day of the comparison period when compare_to is "custom". |
| `compare_end_date` | string |  | Last day of the comparison period when compare_to is "custom". |
| `search_type` | `web`, `image`, `video`, `news`, `discover`, `googleNews` | `"web"` | Which Google surface: web (default), image, video, news (the News tab), discover or googleNews. |
| `top_queries` | integer (min 1, max 200) | `25` | Maximum number of queries to return. |
| `include_index_status` | boolean | `true` | Also run a URL inspection for the page (one call against the daily inspection quota). |

### inspect_url

**Inspect a URL.** Asks Google how it sees one URL: whether it is indexed and why not, the canonical Google chose against the declared one, when it was last crawled and as which device, robots.txt and noindex state, the sitemaps and pages that point to it, and structured data problems. It reports the indexed version, not a live test. Counts against a quota of 2,000 inspections per day per property.

Read-only.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `site_url` | string |  | Search Console property, for example "sc-domain:example.com" or "https://www.example.com/". A bare domain or any page URL on the site also works. Optional when GSC_SITE_URL is set or the account has exactly one property. |
| `url` | string | **required** | The full URL to inspect. It must belong to the property. |
| `language_code` | string |  | BCP-47 language for Google's issue messages, for example "en-US" (default) or "el". |

### inspect_urls

**Inspect several URLs.** Runs URL inspection for up to 50 URLs of one property and returns a compact table of which are indexed, their coverage state, last crawl and the problems found. Each URL uses one of the 2,000 daily inspections per property.

Read-only.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `site_url` | string |  | Search Console property, for example "sc-domain:example.com" or "https://www.example.com/". A bare domain or any page URL on the site also works. Optional when GSC_SITE_URL is set or the account has exactly one property. |
| `urls` | list of string (up to 50) | **required** | The full URLs to inspect, all on the same property. |
| `language_code` | string |  | BCP-47 language for Google's issue messages, for example "en-US" (default) or "el". |

### audit_sitemap_indexing

**Audit how much of a sitemap is indexed.** Reads the URLs listed in the property's sitemaps, inspects a sample of them and reports how many are indexed, the reasons the others are not, and the affected URLs. This is the closest the API gets to the Page indexing report. Each inspected URL uses one of the 2,000 daily inspections per property, so the sample is small by default.

Read-only.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `site_url` | string |  | Search Console property, for example "sc-domain:example.com" or "https://www.example.com/". A bare domain or any page URL on the site also works. Optional when GSC_SITE_URL is set or the account has exactly one property. |
| `sitemap_url` | string |  | A specific sitemap or sitemap index to audit. Defaults to every sitemap submitted in Search Console. |
| `max_urls` | integer (min 1, max 50) | `25` | How many URLs to inspect. Google takes about six seconds per inspection, so 25 takes around 25 seconds and 50 is the most one call can finish. Call again for a second sample. |
| `sampling` | `random`, `first` | `"random"` | "random" picks a representative sample; "first" takes the URLs in sitemap order. |
| `language_code` | string |  | BCP-47 language for Google's issue messages, for example "en-US" (default) or "el". |

### list_sitemaps

**List sitemaps.** Lists the sitemaps submitted for a property with their processing state, when Google last read them, error and warning counts, and how many URLs each one submits.

Read-only.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `site_url` | string |  | Search Console property, for example "sc-domain:example.com" or "https://www.example.com/". A bare domain or any page URL on the site also works. Optional when GSC_SITE_URL is set or the account has exactly one property. |
| `sitemap_index` | string |  | Only list the sitemaps contained in this sitemap index. |

### submit_sitemap

**Submit a sitemap.** Submits a sitemap to Search Console, or resubmits one so Google reads it again. The sitemap must already be live at the given URL.

Changes data. Available only with `GSC_ALLOW_WRITE=true`.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `site_url` | string |  | Search Console property, for example "sc-domain:example.com" or "https://www.example.com/". A bare domain or any page URL on the site also works. Optional when GSC_SITE_URL is set or the account has exactly one property. |
| `sitemap_url` | string | **required** | Full URL of the sitemap or sitemap index. |

### delete_sitemap

**Remove a sitemap.** Removes a sitemap from Search Console. It does not delete the file from the website and does not remove pages from Google's index.

Removes data. Available only with `GSC_ALLOW_WRITE=true`.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `site_url` | string |  | Search Console property, for example "sc-domain:example.com" or "https://www.example.com/". A bare domain or any page URL on the site also works. Optional when GSC_SITE_URL is set or the account has exactly one property. |
| `sitemap_url` | string | **required** | Full URL of the sitemap to remove, as shown by list_sitemaps. |

## Prompts

### seo_weekly_report

**Weekly SEO report.** A short report on how search performance moved in the last 7 days and what caused it.

Arguments: `site`, `brand_terms`.

### seo_opportunity_audit

**SEO opportunity audit.** Finds the highest-value improvements available right now and turns them into a prioritised plan.

Arguments: `site`.

### diagnose_traffic_drop

**Diagnose a traffic drop.** Works out when search traffic dropped, which pages and queries caused it, and the most likely reason.

Arguments: `site`, `around_date`.

### content_refresh_plan

**Content refresh plan.** Picks the existing pages most worth updating and says what to change on each.

Arguments: `site`, `section`.

### indexing_health_check

**Indexing health check.** Checks sitemaps and a sample of URLs for indexing problems.

Arguments: `site`.

### optimize_page

**Optimise one page.** A data-backed brief for improving a single page.

Arguments: `page_url` (required).
