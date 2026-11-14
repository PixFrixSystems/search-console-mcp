import { homedir } from 'node:os';
import { join } from 'node:path';

export const SERVER_NAME = 'search-console-mcp';

export const SCOPE_READONLY = 'https://www.googleapis.com/auth/webmasters.readonly';
export const SCOPE_READWRITE = 'https://www.googleapis.com/auth/webmasters';

export interface Config {
  /** Path to a service account JSON key (GSC_SERVICE_ACCOUNT_KEY). */
  serviceAccountKeyFile?: string;
  /** The service account JSON key itself, inline (GSC_SERVICE_ACCOUNT_JSON). */
  serviceAccountJson?: string;
  /** Standard Google variable; honoured when the GSC specific ones are absent. */
  googleApplicationCredentials?: string;
  /** Path to an OAuth "Desktop app" client secret JSON (GSC_OAUTH_CLIENT_FILE). */
  oauthClientFile?: string;
  oauthClientId?: string;
  oauthClientSecret?: string;
  /** Where the OAuth refresh token is stored after `auth login`. */
  tokenFile: string;
  configDir: string;
  /** Property used when a tool call does not name one (GSC_SITE_URL). */
  defaultSite?: string;
  /** Registers the tools that change data and requests the read/write scope. */
  allowWrite: boolean;
  /** Brand names used to split branded from non-branded queries (GSC_BRAND_TERMS). */
  brandTerms: string[];
}

type Env = Record<string, string | undefined>;

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function isTruthy(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test(value?.trim() ?? '');
}

export function defaultConfigDir(env: Env = process.env, platform: string = process.platform): string {
  const explicit = clean(env.GSC_CONFIG_DIR);
  if (explicit) return explicit;
  if (platform === 'win32' && clean(env.APPDATA)) return join(env.APPDATA as string, SERVER_NAME);
  const xdg = clean(env.XDG_CONFIG_HOME);
  return join(xdg ?? join(homedir(), '.config'), SERVER_NAME);
}

export function parseList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

export function loadConfig(env: Env = process.env): Config {
  const configDir = defaultConfigDir(env);
  return {
    serviceAccountKeyFile: clean(env.GSC_SERVICE_ACCOUNT_KEY),
    serviceAccountJson: clean(env.GSC_SERVICE_ACCOUNT_JSON),
    googleApplicationCredentials: clean(env.GOOGLE_APPLICATION_CREDENTIALS),
    oauthClientFile: clean(env.GSC_OAUTH_CLIENT_FILE),
    oauthClientId: clean(env.GSC_OAUTH_CLIENT_ID),
    oauthClientSecret: clean(env.GSC_OAUTH_CLIENT_SECRET),
    tokenFile: clean(env.GSC_TOKEN_FILE) ?? join(configDir, 'token.json'),
    configDir,
    defaultSite: clean(env.GSC_SITE_URL),
    allowWrite: isTruthy(env.GSC_ALLOW_WRITE),
    brandTerms: parseList(env.GSC_BRAND_TERMS),
  };
}

export function scopesFor(config: Pick<Config, 'allowWrite'>): string[] {
  return [config.allowWrite ? SCOPE_READWRITE : SCOPE_READONLY];
}
