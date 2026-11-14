# Search Console MCP

[![npm](https://img.shields.io/npm/v/@pixfrixsystems/search-console-mcp)](https://www.npmjs.com/package/@pixfrixsystems/search-console-mcp)
[![CI](https://github.com/PixFrixSystems/search-console-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/PixFrixSystems/search-console-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

An [MCP](https://modelcontextprotocol.io) server that connects Claude, Cursor and other AI assistants to **Google Search Console**.

It gives the assistant the raw data (search performance, URL inspection, sitemaps) and does the analysis on top: which keywords are one push from page one, which pages rank but are not clicked, which pages compete with each other, what lost traffic and why, and how much of your sitemap is indexed.

It runs on your machine, talks only to Google's API, and is read-only unless you switch writing on.

## What you can ask

- "How did organic search do in the last 28 days compared with the month before?"
- "Which keywords are we close to ranking on page one for?"
- "Which pages rank in the top 10 but hardly get clicked? Suggest better titles."
- "Traffic dropped last week. What happened?"
- "Are any of our pages competing for the same keyword?"
- "Is https://example.com/pricing indexed? If not, why not?"
- "How much of our sitemap is indexed, and what is wrong with the rest?"
- "Pick the five blog posts most worth refreshing and write a brief for each."

[What to use it for](docs/use-cases.md) goes through each of these: what runs, what comes back and what to do with it.

## Why this one

- **It analyses, not only fetches.** The opportunity tools return a ranked list of things to act on, with the numbers behind each.
- **Estimates come from your own site.** Expected click-through is measured on your data, not taken from a generic table.
- **It says what the numbers do not show.** Row caps, samples, hidden queries, incomplete days and empty comparison periods are stated in every result.
- **Forgiving inputs.** Say `example.com` or paste a page URL. Leave out the dates and you get the last 28 complete days.
- **Read-only by default,** with errors that tell you how to fix them and a `doctor` command that checks the setup.

## Quick start

You need Node.js 22 or newer and a Google account with access to the Search Console properties you want to use.

### 1. Get Google credentials

Both ways are free. The [authentication guide](docs/authentication.md) has every click.

| | Service account | Your own Google account (OAuth) |
|---|---|---|
| Best for | Agencies, servers, automation | One person with many properties |
| Sees | Only properties you add it to | Everything your account can see |
| Setup | Create a key, add its email as a user on each property | Create a "Desktop app" client, sign in once in the browser |

**Service account:** in Google Cloud enable the *Google Search Console API*, create a service account, download a JSON key, then in Search Console add the service account's email under *Settings > Users and permissions* for each property.

**Your own account:** in Google Cloud enable the *Google Search Console API*, create an OAuth client of type *Desktop app*, download its JSON, then run:

```bash
GSC_OAUTH_CLIENT_FILE=/path/to/client_secret.json npx -y @pixfrixsystems/search-console-mcp auth login
```

### 2. Add the server to your assistant

<details open>
<summary><b>Claude Code</b></summary>

```bash
claude mcp add search-console \
  --env GSC_SERVICE_ACCOUNT_KEY=/path/to/service-account.json \
  -- npx -y @pixfrixsystems/search-console-mcp
```

If you signed in with `auth login`, leave out the `--env` line.
</details>

<details>
<summary><b>Claude Desktop</b></summary>

Open *Settings > Developer > Edit Config* and add:

```json
{
  "mcpServers": {
    "search-console": {
      "command": "npx",
      "args": ["-y", "@pixfrixsystems/search-console-mcp"],
      "env": {
        "GSC_SERVICE_ACCOUNT_KEY": "/path/to/service-account.json"
      }
    }
  }
}
```

Restart Claude Desktop afterwards.
</details>

<details>
<summary><b>Cursor</b></summary>

Add to `~/.cursor/mcp.json` (or `.cursor/mcp.json` in a project):

```json
{
  "mcpServers": {
    "search-console": {
      "command": "npx",
      "args": ["-y", "@pixfrixsystems/search-console-mcp"],
      "env": {
        "GSC_SERVICE_ACCOUNT_KEY": "/path/to/service-account.json"
      }
    }
  }
}
```
</details>

<details>
<summary><b>VS Code</b></summary>

Add to `.vscode/mcp.json`:

```json
{
  "servers": {
    "search-console": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@pixfrixsystems/search-console-mcp"],
      "env": {
        "GSC_SERVICE_ACCOUNT_KEY": "/path/to/service-account.json"
      }
    }
  }
}
```
</details>

<details>
<summary><b>Any other MCP client</b></summary>

The server speaks MCP over stdio. Run `npx -y @pixfrixsystems/search-console-mcp` as the command and pass the environment variables from [Configuration](#configuration).
</details>

On Windows, use forward slashes or doubled backslashes in JSON paths (`C:/keys/gsc.json`). If your client cannot start `npx` directly, use `"command": "cmd"` with `"args": ["/c", "npx", "-y", "@pixfrixsystems/search-console-mcp"]`.

### 3. Check that it works

```bash
GSC_SERVICE_ACCOUNT_KEY=/path/to/service-account.json npx -y @pixfrixsystems/search-console-mcp doctor
```

```
[ ok ] Credentials: service account (seo-bot@my-project.iam.gserviceaccount.com)
[ ok ] Google sign-in
[ ok ] Search Console API
[ ok ] Properties (2):
         sc-domain:example.com  [siteFullUser]
         https://shop.example.com/  [siteRestrictedUser]
```

If a step fails, `doctor` says what to change. Then ask your assistant: *"List my Search Console properties."*

## Documentation

| Guide | What is in it |
|---|---|
| [What to use it for](docs/use-cases.md) | Each job with the question to ask, what comes back and what to do next |
| [How it works](docs/how-it-works.md) | Where the numbers come from, the rules behind each analysis, limits and safety |
| [Authentication](docs/authentication.md) | Service account and browser sign-in, step by step |
| [Tool reference](docs/tools.md) | Every tool and parameter |

## Tools

### Performance

| Tool | What it answers |
|---|---|
| `list_sites` | Which properties can this account read? |
| `get_performance_overview` | How is the site doing? Totals against a comparison period, the trend, and the top queries, pages, countries, devices and search appearances, in one call |
| `search_analytics` | Any custom question: every dimension (including hourly data), regex filters, every search type, paging to any depth, sorting by any metric |
| `compare_periods` | What changed? Gainers, decliners, new and lost rows against the previous period, the previous year or a custom range |
| `detect_traffic_anomalies` | Did traffic drop or spike, and was it one day or a lasting shift? |
| `get_brand_split` | How much of the traffic is people searching for the brand, and how is the rest doing? |

### Opportunities

| Tool | What it answers |
|---|---|
| `find_quick_wins` | Which keywords rank just below the top results and would pay off fastest? |
| `find_ctr_opportunities` | Which results rank well but get clicked far less than their position should earn? |
| `find_keyword_cannibalization` | Which queries are split between several of my pages? |
| `find_declining_pages` | Which pages or queries lost the most clicks, and was it rankings, impressions or click-through? |
| `find_content_gaps` | Where does the site show up without a page that serves the search, and which questions are people asking? |
| `analyze_page` | Everything about one URL: its queries, which to target, devices, countries, trend and index status |

### Indexing and sitemaps

| Tool | What it answers |
|---|---|
| `inspect_url` | Is this URL indexed, and if not, why? |
| `inspect_urls` | The same for up to 50 URLs, as one table |
| `audit_sitemap_indexing` | How much of my sitemap is indexed, and what is wrong with the rest? |
| `list_sitemaps` | Which sitemaps are submitted, when were they last read, and do they have errors? |
| `submit_sitemap` | Submit or resubmit a sitemap. Only with `GSC_ALLOW_WRITE=true` |
| `delete_sitemap` | Remove a sitemap from Search Console. Only with `GSC_ALLOW_WRITE=true` |

## Prompts

Clients that support MCP prompts (Claude Desktop and Claude Code show them as slash commands) get six ready-made workflows:

| Prompt | What it produces |
|---|---|
| `seo_weekly_report` | What moved in the last seven days and why |
| `seo_opportunity_audit` | A prioritised action plan across every opportunity tool |
| `diagnose_traffic_drop` | When a drop started, where it is concentrated and the likely cause |
| `content_refresh_plan` | The existing pages most worth updating, with what to change |
| `indexing_health_check` | Sitemap and indexing problems, by importance |
| `optimize_page` | A data-backed brief for one URL |

## Configuration

Everything is set through environment variables. Only credentials are required.

| Variable | Purpose |
|---|---|
| `GSC_SERVICE_ACCOUNT_KEY` | Path to a service account JSON key |
| `GSC_SERVICE_ACCOUNT_JSON` | The key itself as a JSON string, for hosts without a file system |
| `GOOGLE_APPLICATION_CREDENTIALS` | Google's standard variable, honoured when the two above are not set |
| `GSC_OAUTH_CLIENT_FILE` | Path to an OAuth "Desktop app" client secret file, used by `auth login` |
| `GSC_SITE_URL` | Default property, so you do not have to name it. Example: `sc-domain:example.com` |
| `GSC_BRAND_TERMS` | Comma-separated brand names, to keep brand searches out of opportunity lists and to split branded from non-branded traffic |
| `GSC_ALLOW_WRITE` | `true` enables `submit_sitemap` and `delete_sitemap` and requests the read/write scope |
| `GSC_CONFIG_DIR` | Where the saved sign-in lives. Default: `~/.config/search-console-mcp`, or `%APPDATA%\search-console-mcp` on Windows |

Credentials are looked up in this order: `GSC_SERVICE_ACCOUNT_JSON`, `GSC_SERVICE_ACCOUNT_KEY`, `GOOGLE_APPLICATION_CREDENTIALS`, a saved `auth login`, then Google's Application Default Credentials.

```
search-console-mcp                 Start the MCP server (what your client runs)
search-console-mcp doctor          Check credentials and list the properties you can read
search-console-mcp auth login      Sign in with your own Google account (--write for sitemap changes)
search-console-mcp auth logout     Forget the saved sign-in
```

## Troubleshooting

Run `doctor` first: it tests credentials, sign-in, API access and property permissions in order and explains the first failure.

| Symptom | Cause and fix |
|---|---|
| "The signed-in account cannot read this property" | The account is not a user of the property. In Search Console open *Settings > Users and permissions* and add it. For a service account, add its `client_email` |
| "Enable the Google Search Console API" | The API is off in your Google Cloud project. Enable it under *APIs & Services > Library* |
| Sign-in expires every week | Your OAuth consent screen is in *Testing*. Publish it under *Google Auth Platform > Audience* |
| "No Search Console property matches" | Call `list_sites`, or pass the bare domain and let the server match it |
| No data for a page | Search Console matches page URLs exactly, including `www` and the trailing slash. Use a `contains` filter to find the form it reports |
| Rows by query do not add up to the total | Expected. Google hides rare queries for privacy |
| Numbers differ from the Search Console website | Compare the same dates. The website's default range runs up to today and includes incomplete days; the server's default stops at the last complete day |
| The server does not appear in the client | Check the client's MCP log. On Windows try the `cmd /c npx` form shown above |

## Privacy and security

- The server runs locally as a child process of your MCP client. It contacts `googleapis.com`, and your own site when `audit_sitemap_indexing` reads a sitemap. There is no telemetry.
- Credentials stay on your machine. A browser sign-in is stored as a refresh token in `GSC_CONFIG_DIR`. Delete it with `auth logout`.
- The default scope is read-only. Search data returned by the tools becomes part of your conversation with the AI assistant, under that assistant's own privacy terms.

See [SECURITY.md](SECURITY.md) to report a vulnerability.

## Development

```bash
git clone https://github.com/PixFrixSystems/search-console-mcp.git
cd search-console-mcp
npm install
npm run build
npm test
```

The tests run against a stand-in for Google's API, so they need no credentials. With credentials, `npm run live-check -- --site example.com` runs every read-only tool against a real property and checks that the numbers agree with each other.

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)

Built and maintained by [PixFrix](https://pixfrix.gr). This project is not affiliated with or endorsed by Google. Google Search Console is a trademark of Google LLC.
