import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { CodeChallengeMethod, OAuth2Client } from 'google-auth-library';
import { expandHome, saveStoredToken, type StoredToken } from '../auth.js';
import { type Config, SCOPE_READONLY, SCOPE_READWRITE } from '../config.js';
import { AuthSetupError } from '../errors.js';

export interface LoginOptions {
  /** Overrides GSC_OAUTH_CLIENT_FILE. */
  clientFile?: string;
  /** Ask for the read/write scope, needed to submit or delete sitemaps. */
  write: boolean;
  openBrowser: boolean;
  log: (line: string) => void;
  timeoutMs?: number;
  /** Replaces the HTTP layer used to reach Google, for tests. */
  fetch?: typeof fetch;
}

const CALLBACK_PATH = '/oauth2callback';

const CLIENT_HINT =
  'In Google Cloud open Google Auth Platform > Clients, create a client of type "Desktop app", download its JSON and point GSC_OAUTH_CLIENT_FILE (or --client-file) at it.';

async function loadOAuthClient(
  config: Config,
  clientFile: string | undefined,
): Promise<{ clientId: string; clientSecret: string }> {
  const path = clientFile ?? config.oauthClientFile;
  if (path) {
    let parsed: { installed?: { client_id?: string; client_secret?: string }; web?: unknown };
    try {
      parsed = JSON.parse(await readFile(expandHome(path), 'utf8'));
    } catch {
      throw new AuthSetupError(`Cannot read the OAuth client file at "${path}".`, CLIENT_HINT);
    }
    if (parsed.installed?.client_id && parsed.installed.client_secret) {
      return { clientId: parsed.installed.client_id, clientSecret: parsed.installed.client_secret };
    }
    if (parsed.web) {
      throw new AuthSetupError(
        `"${path}" is a "Web application" OAuth client, which cannot sign in from a local tool.`,
        CLIENT_HINT,
      );
    }
    throw new AuthSetupError(`"${path}" is not an OAuth client secret file.`, CLIENT_HINT);
  }
  if (config.oauthClientId && config.oauthClientSecret) {
    return { clientId: config.oauthClientId, clientSecret: config.oauthClientSecret };
  }
  throw new AuthSetupError('No OAuth client is configured.', CLIENT_HINT);
}

function openInBrowser(url: string): void {
  const [command, args]: [string, string[]] =
    process.platform === 'win32'
      ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true });
    child.on('error', () => undefined);
    child.unref();
  } catch {
    // The URL is printed as well, so a failed launch is not fatal.
  }
}

function page(title: string, message: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:18vh auto;padding:0 1.5rem;color:#1c1f23}h1{font-size:1.4rem;margin:0 0 .5rem}p{margin:0;color:#4a5158}</style></head><body><h1>${title}</h1><p>${message}</p></body></html>`;
}

function waitForCode(server: Server, expectedState: string, timeoutMs: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new AuthSetupError('Timed out waiting for the Google sign-in to finish.', 'Run "auth login" again.')),
      timeoutMs,
    );
    server.on('request', (request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== CALLBACK_PATH) {
        response.writeHead(404).end();
        return;
      }
      const send = (status: number, title: string, message: string) => {
        response.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
        response.end(page(title, message));
      };
      const error = url.searchParams.get('error');
      const code = url.searchParams.get('code');
      if (error) {
        send(400, 'Sign-in was not completed', 'You can close this tab and try again from the terminal.');
        clearTimeout(timer);
        reject(new AuthSetupError(`Google sign-in was cancelled or refused (${error}).`));
        return;
      }
      if (url.searchParams.get('state') !== expectedState || !code) {
        send(400, 'Sign-in could not be verified', 'Close this tab and run the login command again.');
        return;
      }
      send(200, 'Signed in to Search Console', 'You can close this tab and go back to the terminal.');
      clearTimeout(timer);
      resolve(code);
    });
  });
}

/** Runs the browser sign-in on a loopback address with PKCE and stores the refresh token. */
export async function login(config: Config, options: LoginOptions): Promise<StoredToken> {
  const { clientId, clientSecret } = await loadOAuthClient(config, options.clientFile);
  const scopes = [options.write ? SCOPE_READWRITE : SCOPE_READONLY];
  const state = randomBytes(16).toString('hex');

  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  try {
    const { port } = server.address() as AddressInfo;
    const redirectUri = `http://127.0.0.1:${port}${CALLBACK_PATH}`;
    const client = new OAuth2Client({
      clientId,
      clientSecret,
      redirectUri,
      ...(options.fetch ? { transporterOptions: { fetchImplementation: options.fetch } } : {}),
    });
    const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();
    const authUrl = client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: scopes,
      state,
      code_challenge: codeChallenge,
      code_challenge_method: CodeChallengeMethod.S256,
    });

    options.log('Open this address in your browser to sign in with the Google account that can see your Search Console properties:');
    options.log('');
    options.log(authUrl);
    options.log('');
    const pending = waitForCode(server, state, options.timeoutMs ?? 5 * 60_000);
    if (options.openBrowser) openInBrowser(authUrl);

    const code = await pending;
    const { tokens } = await client
      .getToken({ code, codeVerifier, redirect_uri: redirectUri })
      .catch((cause: unknown) => {
        const detail = cause instanceof Error ? cause.message : String(cause);
        throw new AuthSetupError(
          `Google did not accept the sign-in (${detail}).`,
          'Check that the OAuth client file is a "Desktop app" client that still exists in Google Cloud, then run "auth login" again.',
        );
      });
    if (!tokens.refresh_token) {
      throw new AuthSetupError(
        'Google did not return a refresh token.',
        'Remove this app at https://myaccount.google.com/connections and run "auth login" again.',
      );
    }

    const stored: StoredToken = {
      type: 'authorized_user',
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: tokens.refresh_token,
      scopes,
      created_at: new Date().toISOString(),
    };
    await saveStoredToken(config.tokenFile, stored);
    return stored;
  } finally {
    server.close();
    server.closeAllConnections();
  }
}
