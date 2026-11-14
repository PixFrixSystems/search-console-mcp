import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { GoogleAuth, JWT, OAuth2Client } from 'google-auth-library';
import { type Config, scopesFor } from './config.js';
import { AuthSetupError } from './errors.js';

export type AuthMethod = 'service_account' | 'oauth' | 'application_default';

export interface AuthIdentity {
  method: AuthMethod;
  /** The service account's client_email, when the method is a service account. */
  email?: string;
  /** Where the credentials were found, for troubleshooting output. */
  source: string;
  scopes: string[];
}

export interface TokenProvider {
  identity: AuthIdentity;
  getAccessToken(): Promise<string>;
}

/** What `auth login` writes to disk. The shape matches Google's "authorized_user" credentials. */
export interface StoredToken {
  type: 'authorized_user';
  client_id: string;
  client_secret: string;
  refresh_token: string;
  scopes: string[];
  created_at: string;
}

export const NO_CREDENTIALS_HINT = [
  'Pick one of these:',
  '- Service account: set GSC_SERVICE_ACCOUNT_KEY to the path of its JSON key, then add its client_email as a user on each Search Console property.',
  '- Your own Google account: set GSC_OAUTH_CLIENT_FILE to an OAuth "Desktop app" client secret file and run "npx -y @pixfrixsystems/search-console-mcp auth login" once.',
  'Run "npx -y @pixfrixsystems/search-console-mcp doctor" to check the result.',
].join('\n');

export function expandHome(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2));
  return path;
}

async function readJsonFile(path: string, label: string): Promise<unknown> {
  let raw: string;
  try {
    raw = await readFile(expandHome(path), 'utf8');
  } catch {
    throw new AuthSetupError(
      `Cannot read the ${label} at "${path}".`,
      'Check that the path is correct and that the file is readable by this process.',
    );
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new AuthSetupError(`The ${label} at "${path}" is not valid JSON.`);
  }
}

function explainTokenFailure(cause: unknown, method: AuthMethod): AuthSetupError {
  const detail = cause instanceof Error ? cause.message : String(cause);
  if (/invalid_grant/i.test(detail)) {
    return new AuthSetupError(
      `Google rejected the saved credentials (${detail}).`,
      method === 'oauth'
        ? 'The sign-in has expired or was revoked. Run "auth login" again. If this happens every week, your OAuth consent screen is in "Testing" status: publish it in Google Cloud (Google Auth Platform > Audience) so the sign-in stops expiring.'
        : 'Check that the service account key has not been deleted or disabled in Google Cloud, and that this computer\'s clock is correct.',
    );
  }
  if (/could not load the default credentials/i.test(detail)) {
    return new AuthSetupError('No Google credentials are configured.', NO_CREDENTIALS_HINT);
  }
  return new AuthSetupError(`Could not get a Google access token: ${detail}`, NO_CREDENTIALS_HINT);
}

interface AccessTokenSource {
  getAccessToken(): Promise<string | null | undefined | { token?: string | null }>;
}

function provider(identity: AuthIdentity, source: AccessTokenSource): TokenProvider {
  return {
    identity,
    async getAccessToken() {
      let result: Awaited<ReturnType<AccessTokenSource['getAccessToken']>>;
      try {
        result = await source.getAccessToken();
      } catch (cause) {
        throw explainTokenFailure(cause, identity.method);
      }
      const token = typeof result === 'string' ? result : result?.token;
      if (!token) throw new AuthSetupError('Google returned an empty access token.', NO_CREDENTIALS_HINT);
      return token;
    },
  };
}

function serviceAccountProvider(key: unknown, source: string, scopes: string[]): TokenProvider {
  const parsed = (key ?? {}) as { type?: string; client_email?: string; private_key?: string };
  if (parsed.type !== 'service_account' || !parsed.client_email || !parsed.private_key) {
    throw new AuthSetupError(
      `${source} does not contain a service account key.`,
      'Download a JSON key from Google Cloud (IAM & Admin > Service Accounts > your account > Keys). An OAuth client secret file goes in GSC_OAUTH_CLIENT_FILE instead.',
    );
  }
  const client = new JWT({ email: parsed.client_email, key: parsed.private_key, scopes });
  return provider({ method: 'service_account', email: parsed.client_email, source, scopes }, client);
}

function defaultCredentialsProvider(source: string, scopes: string[]): TokenProvider {
  const auth = new GoogleAuth({ scopes });
  return provider({ method: 'application_default', source, scopes }, auth);
}

export async function readStoredToken(tokenFile: string): Promise<StoredToken | undefined> {
  let raw: string;
  try {
    raw = await readFile(expandHome(tokenFile), 'utf8');
  } catch {
    return undefined;
  }
  try {
    const token = JSON.parse(raw) as Partial<StoredToken>;
    if (token.client_id && token.client_secret && token.refresh_token) {
      return {
        type: 'authorized_user',
        client_id: token.client_id,
        client_secret: token.client_secret,
        refresh_token: token.refresh_token,
        scopes: Array.isArray(token.scopes) ? token.scopes : [],
        created_at: token.created_at ?? '',
      };
    }
  } catch {
    // Fall through to the error below.
  }
  throw new AuthSetupError(
    `The saved sign-in at "${tokenFile}" is damaged.`,
    'Run "auth logout" and then "auth login" to create it again.',
  );
}

export async function saveStoredToken(tokenFile: string, token: StoredToken): Promise<void> {
  const path = expandHome(tokenFile);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(token, null, 2)}\n`, { mode: 0o600 });
}

export async function deleteStoredToken(tokenFile: string): Promise<boolean> {
  try {
    await rm(expandHome(tokenFile));
    return true;
  } catch {
    return false;
  }
}

/**
 * Finds credentials in this order: an inline or file service account key, the standard
 * GOOGLE_APPLICATION_CREDENTIALS variable, a saved OAuth sign-in, then Application Default Credentials.
 */
export async function createTokenProvider(config: Config): Promise<TokenProvider> {
  const scopes = scopesFor(config);

  if (config.serviceAccountJson) {
    let key: unknown;
    try {
      key = JSON.parse(config.serviceAccountJson);
    } catch {
      throw new AuthSetupError('GSC_SERVICE_ACCOUNT_JSON is not valid JSON.');
    }
    return serviceAccountProvider(key, 'GSC_SERVICE_ACCOUNT_JSON', scopes);
  }

  if (config.serviceAccountKeyFile) {
    const key = await readJsonFile(config.serviceAccountKeyFile, 'service account key');
    return serviceAccountProvider(key, `GSC_SERVICE_ACCOUNT_KEY (${config.serviceAccountKeyFile})`, scopes);
  }

  if (config.googleApplicationCredentials) {
    const key = await readJsonFile(config.googleApplicationCredentials, 'credentials file');
    const source = `GOOGLE_APPLICATION_CREDENTIALS (${config.googleApplicationCredentials})`;
    if ((key as { type?: string } | null)?.type === 'service_account') {
      return serviceAccountProvider(key, source, scopes);
    }
    return defaultCredentialsProvider(source, scopes);
  }

  const stored = await readStoredToken(config.tokenFile);
  if (stored) {
    const client = new OAuth2Client({ clientId: stored.client_id, clientSecret: stored.client_secret });
    client.setCredentials({ refresh_token: stored.refresh_token });
    return provider(
      { method: 'oauth', source: `OAuth sign-in (${config.tokenFile})`, scopes: stored.scopes },
      client,
    );
  }

  return defaultCredentialsProvider('Application Default Credentials', scopes);
}
