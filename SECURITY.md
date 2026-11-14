# Security

## Reporting a vulnerability

Please do not open a public issue for a security problem. Report it privately through GitHub: on the repository page choose **Security > Report a vulnerability**.

Include what you found, how to reproduce it and what an attacker could do with it. You will get a reply within a few working days, and credit in the release notes if you would like it.

## What the server can reach

- It runs as a local process started by your MCP client and holds whatever Google credentials you configured.
- It calls `www.googleapis.com` and `searchconsole.googleapis.com`. During `auth login` it also calls `accounts.google.com` and `oauth2.googleapis.com`.
- `audit_sitemap_indexing` downloads sitemap files. It only requests addresses that belong to the Search Console property being audited, and it re-checks every redirect against that rule, so a prompt cannot steer it to another host or to an internal network address.
- It sends no telemetry and has no other outbound connections.

## What to keep in mind

- **Tool output is untrusted text.** Search queries and page URLs come from the open web and are passed to the AI model as data. A model could be influenced by text inside them, as with any tool that returns external content.
- **Read-only is the default.** The server requests the `webmasters.readonly` scope. `submit_sitemap` and `delete_sitemap` are registered only with `GSC_ALLOW_WRITE=true`, and neither can remove pages from Google or change a site.
- **Credentials are files on your disk.** A service account key and the saved OAuth refresh token are as sensitive as a password to your search data. Keep them out of repositories and shared folders. See [docs/authentication.md](docs/authentication.md#keeping-credentials-safe).
- **Prefer a service account for shared or unattended use.** It can read only the properties you added it to, and removing it from a property cuts access at once.

## Supported versions

Security fixes go into the latest release.
