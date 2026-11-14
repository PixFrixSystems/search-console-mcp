#!/usr/bin/env node
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { deleteStoredToken } from './auth.js';
import { doctor } from './cli/doctor.js';
import { login } from './cli/login.js';
import { loadConfig } from './config.js';
import { describeError } from './errors.js';
import { createDeps, createServer } from './server.js';
import { VERSION } from './version.js';

const HELP = `search-console-mcp ${VERSION}
MCP server for Google Search Console.

Usage:
  search-console-mcp                 Start the MCP server on stdio (what MCP clients run)
  search-console-mcp doctor          Check credentials and list the properties you can read
  search-console-mcp auth login      Sign in with your own Google account
      --client-file <path>           OAuth "Desktop app" client secret file (or set GSC_OAUTH_CLIENT_FILE)
      --write                        Also allow submitting and removing sitemaps
      --no-browser                   Print the sign-in address instead of opening it
  search-console-mcp auth logout     Forget the saved sign-in
  search-console-mcp --version
  search-console-mcp --help

Environment:
  GSC_SERVICE_ACCOUNT_KEY    Path to a service account JSON key
  GSC_SERVICE_ACCOUNT_JSON   The service account JSON key itself, inline
  GSC_OAUTH_CLIENT_FILE      Path to an OAuth client secret file, for "auth login"
  GSC_SITE_URL               Default property, for example sc-domain:example.com
  GSC_BRAND_TERMS            Comma-separated brand names, for branded and non-branded splits
  GSC_ALLOW_WRITE            "true" enables submit_sitemap and delete_sitemap
  GSC_CONFIG_DIR             Where the saved sign-in lives

Docs: https://github.com/PixFrixSystems/search-console-mcp
`;

function print(line: string): void {
  process.stdout.write(`${line}\n`);
}

function optionValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

async function runAuth(args: string[]): Promise<number> {
  const config = loadConfig();
  const [action, ...rest] = args;

  if (action === 'login') {
    const write = rest.includes('--write');
    await login(config, {
      clientFile: optionValue(rest, '--client-file'),
      write,
      openBrowser: !rest.includes('--no-browser'),
      log: print,
    });
    print(`Signed in. The sign-in is saved in ${config.tokenFile}`);
    print(write ? 'Access: read and write.' : 'Access: read-only.');
    print('Run "search-console-mcp doctor" to see the properties this account can read.');
    return 0;
  }

  if (action === 'logout') {
    const removed = await deleteStoredToken(config.tokenFile);
    print(removed ? `Removed the saved sign-in at ${config.tokenFile}` : 'There was no saved sign-in to remove.');
    return 0;
  }

  if (action === 'status') return doctor(config, print);

  process.stderr.write('Usage: search-console-mcp auth <login|logout|status>\n');
  return 2;
}

function serve(): void {
  // In server mode stdout carries the protocol, so everything human-readable goes to stderr.
  const deps = createDeps(loadConfig());
  const handle = serveStdio(() => createServer(deps), {
    onerror: (error) => process.stderr.write(`[search-console-mcp] ${error.message}\n`),
  });
  const shutdown = () => {
    void handle.close().finally(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

async function main(argv: string[]): Promise<number | undefined> {
  const [command, ...rest] = argv;
  switch (command) {
    case undefined:
    case 'serve':
      serve();
      return undefined;
    case 'doctor':
      return doctor(loadConfig(), print);
    case 'auth':
      return runAuth(rest);
    case '--version':
    case '-v':
      print(VERSION);
      return 0;
    case '--help':
    case '-h':
    case 'help':
      print(HELP);
      return 0;
    default:
      process.stderr.write(`Unknown command "${command}".\n\n${HELP}`);
      return 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    if (code !== undefined) process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`${describeError(error)}\n`);
    process.exitCode = 1;
  },
);
