import { createTokenProvider, type TokenProvider } from '../auth.js';
import { type Config, SCOPE_READWRITE } from '../config.js';
import { describeError } from '../errors.js';
import { GscClient } from '../gsc/client.js';
import type { SiteEntry } from '../gsc/types.js';
import { matchSite } from '../sites.js';
import { VERSION } from '../version.js';

const METHOD_LABELS = {
  service_account: 'service account',
  oauth: 'your Google account (OAuth sign-in)',
  application_default: 'Application Default Credentials',
} as const;

function indent(text: string): string {
  return text
    .split('\n')
    .map((line) => `    ${line}`)
    .join('\n');
}

/** Checks the whole chain (credentials, token, API access, properties) and explains the first thing that fails. */
export async function doctor(config: Config, log: (line: string) => void): Promise<number> {
  log(`search-console-mcp ${VERSION}`);
  log('');

  let provider: TokenProvider;
  try {
    provider = await createTokenProvider(config);
  } catch (error) {
    log('[fail] Credentials');
    log(indent(describeError(error)));
    return 1;
  }
  const { identity } = provider;
  // Nothing was configured explicitly, so the only hope is a gcloud login or a cloud runtime identity.
  const implicit = identity.method === 'application_default' && !config.googleApplicationCredentials;
  if (!implicit) {
    log(`[ ok ] Credentials: ${METHOD_LABELS[identity.method]}${identity.email ? ` (${identity.email})` : ''}`);
    log(`       Found in: ${identity.source}`);
  }

  try {
    await provider.getAccessToken();
  } catch (error) {
    log(implicit ? '[fail] Credentials' : '[fail] Google sign-in');
    log(indent(describeError(error)));
    return 1;
  }
  if (implicit) log('[ ok ] Credentials: Application Default Credentials (found automatically)');
  log('[ ok ] Google sign-in');

  const client = new GscClient({ getAccessToken: () => provider.getAccessToken(), maxRetries: 1 });
  let sites: SiteEntry[];
  try {
    sites = await client.listSites();
  } catch (error) {
    log('[fail] Search Console API');
    log(indent(describeError(error)));
    return 1;
  }
  log('[ ok ] Search Console API');

  const verified = sites.filter((site) => site.permissionLevel !== 'siteUnverifiedUser');
  if (verified.length === 0) {
    log('[fail] Properties: this account cannot read any verified property');
    log(
      indent(
        identity.email
          ? `In Search Console open Settings > Users and permissions for each property and add ${identity.email} as a user.`
          : 'Sign in with a Google account that has access to Search Console, or add this account as a user on a property.',
      ),
    );
    return 1;
  }
  log(`[ ok ] Properties (${verified.length}):`);
  for (const site of verified) log(`         ${site.siteUrl}  [${site.permissionLevel}]`);

  let warnings = 0;
  if (config.defaultSite) {
    const match = matchSite(config.defaultSite, sites);
    if (!match) warnings += 1;
    log(
      match
        ? `[ ok ] Default property (GSC_SITE_URL): ${match.siteUrl}`
        : `[warn] GSC_SITE_URL is "${config.defaultSite}", which matches none of the properties above`,
    );
  }

  if (!config.allowWrite) {
    log('[info] Write tools are off. Set GSC_ALLOW_WRITE=true to enable submit_sitemap and delete_sitemap.');
  } else if (identity.method === 'oauth' && !identity.scopes.includes(SCOPE_READWRITE)) {
    warnings += 1;
    log('[warn] GSC_ALLOW_WRITE is on, but the saved sign-in is read-only. Run "auth login --write" to change that.');
  } else {
    log('[ ok ] Write tools are on (submit_sitemap, delete_sitemap)');
  }

  log('');
  log(
    warnings
      ? 'Reading data works. Fix the warning above to finish the setup.'
      : 'Everything needed is in place.',
  );
  return 0;
}
