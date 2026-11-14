# How it works

## The flow

1. You ask your assistant a question.
2. The assistant picks a tool and fills in its parameters (property, dates, filters).
3. The server, running on your machine, calls the Search Console API with your credentials.
4. It analyses the rows locally and returns a compact table, with notes on what the numbers do and do not show.
5. The assistant reads that and answers you.

The server keeps nothing on disk except a saved sign-in, if you used `auth login`. In memory it remembers the property list for 5 minutes and the last complete day for 30.

## What it can and cannot see

It reads what the Search Console API offers:

- **Search performance:** clicks, impressions, CTR and position by query, page, country, device, date, hour and search appearance, for web, image, video, news, Discover and Google News, up to 16 months back.
- **URL inspection:** how Google has indexed a URL.
- **Sitemaps:** what is submitted and how Google processed it.
- **Properties:** which sites the account can read.

These exist only on the Search Console website, so no MCP server can offer them:

- The complete Page indexing report (`audit_sitemap_indexing` gives a sampled view)
- Core Web Vitals, links, manual actions, security issues and removals
- Requesting indexing for a URL
- Live URL tests. Inspection reports the last crawled version

## Properties and dates

**Property.** Pass an exact name (`sc-domain:example.com`), a bare domain or any page URL, and the server picks the matching property, preferring the domain property because it holds the complete data.

**Default period.** Search Console reports in Pacific Time and needs three to four days to finish collecting a day. The delay is not fixed, so the server asks Google which day is the last complete one and ends the default period there: the 28 days up to that day, compared with the 28 days before. Twenty-eight days keeps weekdays aligned between the two periods.

**Recent days.** Ask for a period that reaches further (`end_date` accepts `today` and `yesterday`) and you get the same partial numbers the website shows, with a note saying from which day they are incomplete.

**Comparisons.** Against the previous period, the same period 52 weeks earlier, or any custom range.

## What comes back

Every tool returns one JSON document:

```json
{
 "site": "sc-domain:example.com",
 "period": { "start_date": "2026-10-15", "end_date": "2026-11-11", "days": 28 },
 "rows": {
  "columns": ["query","clicks","impressions","ctr_pct","position"],
  "rows": [
   ["standing desk height",26,808,3.22,5.2],
   ["desk for small room",3,323,0.93,6.8]
  ]
 },
 "notes": ["Rows broken down by query leave out anonymised queries ..."]
}
```

- Tables are `columns` plus `rows`, one row per line. That is about half the size of an array of objects, which matters inside a model's context window, and it is still valid JSON for scripts.
- `ctr_pct` is a percentage. `position` is the average topmost position; lower is better.
- `notes` carries the caveats that apply to this result: a row cap that was reached, a sample, incomplete days, an empty comparison period.

## How each analysis decides

The tools make judgement calls. These are the rules, so you can decide how far to trust them.

| Analysis | Rule |
|---|---|
| Expected CTR | A CTR-by-position curve for positions 1 to 20, built from your own query data. Each position blends your observed CTR with a cross-industry benchmark and trusts your data fully from 1,000 impressions. The curve never rises as position gets worse. Results report the curve and how much of it is your data |
| Click estimates | Today's impressions times the expected CTR at the target position, adjusted for the query: one that is clicked twice as often as its position normally earns keeps that edge, one that is rarely clicked stays that way. Queries with little data are pulled toward average. For page-two rankings it understates the gain, because impressions also rise on page one |
| Weak click-through | Flagged when CTR is at most 60% of the expected CTR at that position, in the top 10. Pages are judged across all their queries, not by one blended average |
| Cannibalization | Flagged when at least two pages each hold 10% or more of a query's impressions. Jump-link URLs (`/page#section`) are folded into their page first. Each page's language prefix is shown, since translations often look like competitors |
| Why a page declined | Position worse by a full place or more: ranking loss. Position steady, impressions down 15% or more: fewer impressions. Both steady, CTR down 15% or more: lower click-through |
| Anomalies | Each day against the median of the same weekday over the previous four weeks. Flagged only when it clears a percentage threshold (30% by default), three robust standard deviations of that weekday's noise, and the chance variation any count has. Flagged days close together become one episode, so a move to a new level reads as one sustained shift with a start date |
| Content gaps | Queries with real impressions where your best position is worse than 20, and queries that start with a question word |
| Brand split | Queries containing your brand terms, the rest, and the anonymised remainder that cannot be classified |
| Sitemap audit | A random sample of the URLs in your sitemaps (25 by default, 50 at most per call), inspected one by one and grouped by Google's coverage state |

Two cases get special handling so the assistant does not draw the wrong conclusion:

- **New properties.** When the comparison period has no data, the change in CTR and position is left empty and the result says there is nothing to compare against. A site that launched last week is not described as having grown.
- **Little history.** Anomaly detection needs about five weeks of data. Before that it says so, and reports no percentage.

Brand queries distort the CTR curve (they sit at position one with a very high click rate), so set `GSC_BRAND_TERMS`.

## Limits

| Limit | Value | What the server does |
|---|---|---|
| Rows per request | 25,000, sorted by clicks | Pages automatically (up to 100,000 with `scan_rows`) and says when a cap was reached |
| History | 16 months | Nothing; older data does not exist in the API |
| Data delay | 3 to 4 days | Asks Google for the last complete day; flags partial days |
| Anonymised queries | Rare searches are hidden | Notes that query rows add up to less than the totals |
| URL inspection quota | 2,000 per day and 600 per minute, per property | Samples in audits; reports quota errors plainly |
| URL inspection speed | About 6 seconds each | Runs 8 at a time, stops after about 45 seconds and returns what it has plus the URLs not reached, since many clients allow a tool call one minute |
| Rate limits | 1,200 performance queries per minute per site | Retries with backoff |

## Safety

- **Read-only by default.** The server requests the read-only scope. `submit_sitemap` and `delete_sitemap` exist only with `GSC_ALLOW_WRITE=true`, and neither can remove a page from Google.
- **Local.** It runs as a child process of your MCP client and contacts only Google's API, plus your own site when it reads a sitemap. No telemetry.
- **Sitemap downloads are fenced.** The audit only fetches addresses inside the Search Console property and re-checks every redirect, so a prompt cannot steer it to another host.
- **Misspelled parameters are errors.** A tool call with an unknown parameter fails instead of quietly returning unfiltered data.

More in [SECURITY.md](../SECURITY.md).
