import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTokenProvider, deleteStoredToken, readStoredToken } from '../src/auth.js';
import { login } from '../src/cli/login.js';
import { SCOPE_READONLY, SCOPE_READWRITE } from '../src/config.js';
import { AuthSetupError } from '../src/errors.js';
import { jsonResponse, testConfig } from './helpers.js';

const realFetch = globalThis.fetch;

async function setup(clientJson: unknown = { installed: { client_id: 'id-123.apps.googleusercontent.com', client_secret: 'shh' } }) {
  const dir = await mkdtemp(join(tmpdir(), 'search-console-mcp-login-'));
  const clientFile = join(dir, 'client_secret.json');
  await writeFile(clientFile, JSON.stringify(clientJson));
  const config = testConfig({ configDir: dir, tokenFile: join(dir, 'nested', 'token.json') });
  return { config, clientFile };
}

/** Starts the login and returns once it has printed the Google sign-in address. */
async function begin(config: ReturnType<typeof testConfig>, clientFile: string, write = false, google?: typeof fetch) {
  const lines: string[] = [];
  const pending = login(config, {
    clientFile,
    write,
    openBrowser: false,
    log: (line) => lines.push(line),
    timeoutMs: 5_000,
    // Without a stand-in, a test that reaches the token exchange would call Google for real.
    fetch: google ?? ((async () => jsonResponse({ error: 'invalid_client' }, 401)) as typeof fetch),
  });
  pending.catch(() => undefined);
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const address = lines.find((line) => line.startsWith('https://accounts.google.com/'));
    if (address) return { pending, authUrl: new URL(address) };
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('login never printed a sign-in address');
}

describe('auth login', () => {
  it('signs in over a loopback address with PKCE and saves the refresh token', async () => {
    const { config, clientFile } = await setup();
    let tokenRequest: URLSearchParams | undefined;
    let tokenEndpoint = '';
    const google = (async (input: string | URL | Request, init?: RequestInit) => {
      tokenEndpoint = input instanceof Request ? input.url : String(input);
      const body = input instanceof Request ? await input.text() : String(init?.body ?? '');
      tokenRequest = new URLSearchParams(body);
      return jsonResponse({ access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 3600, token_type: 'Bearer' });
    }) as typeof fetch;

    const { pending, authUrl } = await begin(config, clientFile, false, google);
    const redirect = authUrl.searchParams.get('redirect_uri') as string;
    const state = authUrl.searchParams.get('state') as string;
    expect(redirect).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/oauth2callback$/);
    expect(authUrl.searchParams.get('scope')).toBe(SCOPE_READONLY);
    expect(authUrl.searchParams.get('access_type')).toBe('offline');
    expect(authUrl.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authUrl.searchParams.get('code_challenge')).toBeTruthy();
    expect(state).toMatch(/^[0-9a-f]{32}$/);

    // A callback with the wrong state is refused and does not end the flow.
    expect((await realFetch(`${redirect}?state=forged&code=stolen`)).status).toBe(400);
    expect((await realFetch(redirect.replace('/oauth2callback', '/elsewhere'))).status).toBe(404);

    const answer = await realFetch(`${redirect}?state=${state}&code=auth-code-1`);
    expect(answer.status).toBe(200);
    expect(await answer.text()).toContain('Signed in to Search Console');

    const stored = await pending;
    expect(stored).toMatchObject({ type: 'authorized_user', refresh_token: 'refresh-1', scopes: [SCOPE_READONLY] });
    expect(tokenEndpoint).toBe('https://oauth2.googleapis.com/token');
    expect(tokenRequest?.get('code')).toBe('auth-code-1');
    expect(tokenRequest?.get('code_verifier')).toBeTruthy();
    expect(tokenRequest?.get('redirect_uri')).toBe(redirect);

    // The saved file is what the server reads on its next start.
    expect(JSON.parse(await readFile(config.tokenFile, 'utf8')).refresh_token).toBe('refresh-1');
    const provider = await createTokenProvider(config);
    expect(provider.identity).toMatchObject({ method: 'oauth', scopes: [SCOPE_READONLY] });

    expect(await deleteStoredToken(config.tokenFile)).toBe(true);
    expect(await readStoredToken(config.tokenFile)).toBeUndefined();
    expect(await deleteStoredToken(config.tokenFile)).toBe(false);
  });

  it('turns a rejected token exchange into advice and saves nothing', async () => {
    const { config, clientFile } = await setup();
    const { pending, authUrl } = await begin(config, clientFile);
    await realFetch(`${authUrl.searchParams.get('redirect_uri')}?state=${authUrl.searchParams.get('state')}&code=x`);
    await expect(pending).rejects.toMatchObject({
      message: expect.stringContaining('Google did not accept the sign-in'),
      hint: expect.stringContaining('Desktop app'),
    });
    expect(await readStoredToken(config.tokenFile)).toBeUndefined();
  });

  it('asks for the write scope with --write', async () => {
    const { config, clientFile } = await setup();
    const { pending, authUrl } = await begin(config, clientFile, true);
    expect(authUrl.searchParams.get('scope')).toBe(SCOPE_READWRITE);
    await realFetch(`${authUrl.searchParams.get('redirect_uri')}?error=access_denied`);
    await expect(pending).rejects.toThrow(/cancelled or refused \(access_denied\)/);
  });

  it('explains why a "Web application" client cannot be used', async () => {
    const { config, clientFile } = await setup({ web: { client_id: 'x', client_secret: 'y' } });
    await expect(login(config, { clientFile, write: false, openBrowser: false, log: () => undefined })).rejects.toMatchObject({
      message: expect.stringContaining('"Web application" OAuth client'),
      hint: expect.stringContaining('Desktop app'),
    });
  });

  it('says what is missing when no client is configured', async () => {
    await expect(
      login(testConfig(), { write: false, openBrowser: false, log: () => undefined }),
    ).rejects.toBeInstanceOf(AuthSetupError);
  });
});

describe('credential discovery', () => {
  it('reads a service account key from a file or inline, and reports its email', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'search-console-mcp-key-'));
    const key = { type: 'service_account', client_email: 'bot@project.iam.gserviceaccount.com', private_key: 'not-a-real-key' };
    const keyFile = join(dir, 'key.json');
    await writeFile(keyFile, JSON.stringify(key));

    const fromFile = await createTokenProvider(testConfig({ serviceAccountKeyFile: keyFile }));
    expect(fromFile.identity).toMatchObject({ method: 'service_account', email: key.client_email, scopes: [SCOPE_READONLY] });

    const inline = await createTokenProvider(testConfig({ serviceAccountJson: JSON.stringify(key), allowWrite: true }));
    expect(inline.identity).toMatchObject({ source: 'GSC_SERVICE_ACCOUNT_JSON', scopes: [SCOPE_READWRITE] });

    const standard = await createTokenProvider(testConfig({ googleApplicationCredentials: keyFile }));
    expect(standard.identity.email).toBe(key.client_email);
  });

  it('rejects the wrong kind of file with a pointer to the right variable', async () => {
    const { clientFile } = await setup();
    await expect(createTokenProvider(testConfig({ serviceAccountKeyFile: clientFile }))).rejects.toMatchObject({
      message: expect.stringContaining('does not contain a service account key'),
      hint: expect.stringContaining('GSC_OAUTH_CLIENT_FILE'),
    });
    await expect(createTokenProvider(testConfig({ serviceAccountJson: '{not json' }))).rejects.toThrow(/not valid JSON/);
    await expect(createTokenProvider(testConfig({ serviceAccountKeyFile: '/no/such/key.json' }))).rejects.toThrow(/Cannot read/);
  });

  it('reports a damaged saved sign-in instead of ignoring it', async () => {
    const { config } = await setup();
    await writeFile(join(config.configDir, 'token.json'), '{"refresh_token": "only-this"}');
    await expect(readStoredToken(join(config.configDir, 'token.json'))).rejects.toThrow(/damaged/);
  });
});
