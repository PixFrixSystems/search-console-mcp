# Changelog

All notable changes to this project are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## 0.1.0

First release.

### Added

- Performance tools: `list_sites`, `get_performance_overview`, `search_analytics`, `compare_periods`, `detect_traffic_anomalies`, `get_brand_split`.
- Opportunity tools: `find_quick_wins`, `find_ctr_opportunities`, `find_keyword_cannibalization`, `find_declining_pages`, `find_content_gaps`, `analyze_page`.
- Indexing and sitemap tools: `inspect_url`, `inspect_urls`, `audit_sitemap_indexing`, `list_sitemaps`, plus `submit_sitemap` and `delete_sitemap` behind `GSC_ALLOW_WRITE`.
- Six prompts: `seo_weekly_report`, `seo_opportunity_audit`, `diagnose_traffic_drop`, `content_refresh_plan`, `indexing_health_check`, `optimize_page`.
- Authentication with a service account, a browser sign-in (`auth login`, loopback redirect with PKCE) or Application Default Credentials.
- `doctor` command that checks credentials, API access and property permissions.
- Works with MCP clients on the 2026-07-28 protocol revision and with clients that still use the earlier `initialize` handshake.
- Default periods end on the last day Google reports as complete, so a period never silently loses or half-counts its newest day.
- `npm run live-check` verifies a build against a real property.
