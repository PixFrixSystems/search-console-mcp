# What to use it for

Each job below gives the question to ask, the tool that answers it, what comes back and what to do with it. You do not have to name tools: the assistant picks them from your question. Name one when you want that exact result.

## Who gets what

| You are | What you get |
|---|---|
| A site owner | Answers about your search traffic without learning Search Console's reports |
| An SEO or content marketer | The spreadsheet work done for you: opportunities ranked by estimated clicks |
| A writer | A brief per page: which queries to cover, what is missing, whether the title underperforms |
| An agency | The same checks across every client property, in one conversation |
| A developer | Indexing problems (noindex, canonical, robots.txt, structured data) checked from your editor after a release |

## See where the site stands

**Ask:** "How did organic search do in the last 28 days?"
**Runs:** `get_performance_overview`
**You get:** clicks, impressions, CTR and position against the previous 28 days, the daily trend, and the top queries, pages, countries and devices.
**Then:** follow whichever number moved, using the jobs below.

## Find keywords one push from page one

**Ask:** "Which keywords are we close to ranking on page one for?"
**Runs:** `find_quick_wins`
**You get:** queries where a page already ranks 4 to 20 and is being seen, each with an estimate of the clicks a top-3 position would add, plus the pages holding the most combined potential.

```json
"opportunities": {
 "columns": ["query","page","clicks","impressions","ctr_pct","position","est_extra_clicks"],
 "rows": [
  ["standing desk height","https://example.com/guides/desk-height",26,808,3.22,5.2,93],
  ["desk for small room","https://example.com/guides/small-rooms",3,323,0.93,6.8,28]
 ]
}
```

**Then:** work on the page, not the keyword. Cover the query properly in the content, put it in the title if it belongs there, and link to the page from related pages.

## Fix pages that rank but are not clicked

**Ask:** "Which pages rank in the top 10 but hardly get clicked? Suggest better titles."
**Runs:** `find_ctr_opportunities`
**You get:** pages and query-page pairs whose click-through rate is far below what their position normally earns on your site, with the clicks being missed.
**Then:** rewrite the title and meta description to match what the searcher wants, and add structured data where it applies. If the results page is full of ads or an AI answer, a better snippet will not recover those clicks, and the tool says so.

## Stop pages competing with each other

**Ask:** "Are any of our pages competing for the same keyword?"
**Runs:** `find_keyword_cannibalization`
**You get:** queries split between two or more of your pages, with each page's share of impressions and position.
**Then:** if the pages serve the same intent, merge them or point one at the other with a redirect or canonical. If they are translations of each other (the `locale` column shows it), check hreflang instead of merging.

## Decide what to refresh

**Ask:** "Which pages lost the most traffic in the last three months, and why?"
**Runs:** `find_declining_pages`
**You get:** pages ranked by clicks lost, each labelled with the likely cause (ranking loss, fewer impressions, lower CTR, no longer shown), and the queries behind the worst drops.
**Then:** a ranking loss calls for updating the content; fewer impressions with a steady position is usually seasonal; a lower CTR points at the snippet or at a changed results page.

## Plan new content

**Ask:** "What should we write next, based on what people already search for?"
**Runs:** `find_content_gaps`
**You get:** queries where the site appears but no page ranks well, and question-style queries ("how", "what", "why") people ask where you show up.
**Then:** write a page for a cluster of weakly served queries, or add a direct answer or FAQ block to an existing page. For other languages pass your own question words with `question_pattern`.

## Explain a traffic drop

**Ask:** "Traffic dropped last week. What happened?" or use the `diagnose_traffic_drop` prompt.
**Runs:** `detect_traffic_anomalies`, then `compare_periods`, `find_declining_pages` and `inspect_url` on the pages that lost most.
**You get:** when it started and whether it is one bad day or a sustained shift, which pages, queries, devices or countries carry it, and whether an indexing problem is behind it.
**Then:** match the start date against your own releases and against [Google's update history](https://status.search.google.com/summary).

## Check that pages are indexed

**Ask:** "Is https://example.com/pricing indexed? If not, why not?"
**Runs:** `inspect_url`, or `inspect_urls` for up to 50 at once
**You get:** indexed or not, with the reason in plain words (noindex tag, blocked by robots.txt, soft 404, Google chose another canonical), the last crawl date and structured data errors.

**Ask:** "How much of our sitemap is indexed?"
**Runs:** `audit_sitemap_indexing`
**You get:** the share of a random sample that is indexed, the rest grouped by reason, and the affected URLs.
**Then:** fix the reason, not the URL. One template with a stray noindex usually explains a whole group.

## Measure SEO growth without the brand

**Ask:** "How much of our traffic is people searching for our name?"
**Runs:** `get_brand_split`
**You get:** branded, non-branded and anonymised traffic with their change. Non-branded is the part SEO work wins; brand searches follow your marketing.
**Then:** set `GSC_BRAND_TERMS` once so every tool leaves brand queries out of its opportunity lists.

## Improve one page

**Ask:** "Give me a brief for improving https://example.com/guides/desk-height."
**Runs:** `analyze_page`, or the `optimize_page` prompt
**You get:** the page's queries and how they moved, the queries worth targeting (ranked 4 to 20 with the most impressions), devices, countries, trend and index status.
**Then:** if your assistant can read web pages, let it open the page and compare the content with those queries.

## Report every week

**Ask:** use the `seo_weekly_report` prompt, or "Write this week's SEO report for example.com."
**You get:** the headline numbers with their change, the three biggest gains and losses with a likely reason each, and what to do next week.
**Then:** run it on a schedule if your client supports scheduled tasks, so the report is waiting on Monday.

## Run it across many sites

Add one service account to every client property, then ask across them: "For each of my properties, list the three biggest click losses this month." `list_sites` gives the assistant the property list, and every tool takes any of them.

Keep in mind that Google limits URL inspection to 2,000 calls per day per property, so audits sample by default.

## Check after a release

**Ask:** "Inspect the ten URLs I changed today and tell me if any has an indexing problem."
**Runs:** `inspect_urls`
**You get:** one table with index state, canonical and problems per URL.

Google re-crawls on its own schedule, so inspection shows the last crawled version. With `GSC_ALLOW_WRITE=true` the assistant can also resubmit the sitemap after a deploy (`submit_sitemap`).

## Getting better answers

- **Set `GSC_SITE_URL`** if you work on one site, so you never have to name it.
- **Set `GSC_BRAND_TERMS`.** Brand queries sit at position one with a very high click rate and distort every estimate.
- **Ask for 90 days** when deciding what to rewrite. Twenty-eight days is right for "what changed", too short for content decisions.
- **On a small site, lower the thresholds:** "use a minimum of 10 impressions". The defaults suit sites with a few thousand impressions a month.
- **Ask for the evidence:** "show the numbers behind each recommendation". Every tool returns them.
