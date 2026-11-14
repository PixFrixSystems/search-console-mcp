import { describe, expect, it } from 'vitest';
import { defaultConfigDir, loadConfig, scopesFor, SCOPE_READONLY, SCOPE_READWRITE } from '../src/config.js';
import { UserError } from '../src/errors.js';
import { compactJson, pct, pctChange, round } from '../src/format.js';
import type { SiteEntry } from '../src/gsc/types.js';
import { matchSite, SiteResolver, urlBelongsToSite } from '../src/sites.js';

describe('number formatting', () => {
  it('rounds without floating point surprises', () => {
    expect(round(1.005, 2)).toBe(1.01);
    expect(round(12.345, 1)).toBe(12.3);
    expect(pct(0.03456)).toBe(3.46);
  });

  it('reports percentage change and refuses to divide by zero', () => {
    expect(pctChange(150, 100)).toBe(50);
    expect(pctChange(80, 100)).toBe(-20);
    expect(pctChange(10, 0)).toBeNull();
  });
});

describe('compactJson', () => {
  const value = {
    site: 'sc-domain:example.com',
    table: { columns: ['query', 'clicks'], rows: [['a "quoted" query', 3], ['other', null]] },
    empty: [],
    skipped: undefined,
  };

  it('produces valid JSON that parses back to the same data', () => {
    expect(JSON.parse(compactJson(value))).toEqual({
      site: 'sc-domain:example.com',
      table: { columns: ['query', 'clicks'], rows: [['a "quoted" query', 3], ['other', null]] },
      empty: [],
    });
  });

  it('keeps every table row on one line', () => {
    const lines = compactJson(value).split('\n');
    expect(lines).toContain('   ["a \\"quoted\\" query",3],');
    expect(lines).toContain('  "columns": ["query","clicks"],');
  });
});

describe('config', () => {
  it('reads the environment and defaults to read-only', () => {
    const config = loadConfig({ GSC_SITE_URL: ' sc-domain:example.com ', GSC_BRAND_TERMS: 'Acme, acme corp ,', APPDATA: '' });
    expect(config.defaultSite).toBe('sc-domain:example.com');
    expect(config.brandTerms).toEqual(['Acme', 'acme corp']);
    expect(config.allowWrite).toBe(false);
    expect(scopesFor(config)).toEqual([SCOPE_READONLY]);
  });

  it('asks for the write scope only when writing is switched on', () => {
    expect(scopesFor(loadConfig({ GSC_ALLOW_WRITE: 'true' }))).toEqual([SCOPE_READWRITE]);
    expect(scopesFor(loadConfig({ GSC_ALLOW_WRITE: 'no' }))).toEqual([SCOPE_READONLY]);
  });

  it('places the config directory per platform', () => {
    expect(defaultConfigDir({ GSC_CONFIG_DIR: '/custom' }, 'linux')).toBe('/custom');
    expect(defaultConfigDir({ APPDATA: 'C:\\Users\\me\\AppData\\Roaming' }, 'win32')).toMatch(/Roaming.search-console-mcp$/);
    expect(defaultConfigDir({ XDG_CONFIG_HOME: '/home/me/.cfg' }, 'linux')).toMatch(/\.cfg.search-console-mcp$/);
  });
});

const SITES: SiteEntry[] = [
  { siteUrl: 'sc-domain:example.com', permissionLevel: 'siteOwner' },
  { siteUrl: 'https://www.example.com/', permissionLevel: 'siteFullUser' },
  { siteUrl: 'https://www.example.com/blog/', permissionLevel: 'siteFullUser' },
  { siteUrl: 'https://shop.other.org/', permissionLevel: 'siteRestrictedUser' },
  { siteUrl: 'https://unverified.net/', permissionLevel: 'siteUnverifiedUser' },
];

describe('matchSite', () => {
  it('returns exact property names as they are', () => {
    expect(matchSite('https://www.example.com/blog/', SITES)?.siteUrl).toBe('https://www.example.com/blog/');
    expect(matchSite('sc-domain:example.com', SITES)?.siteUrl).toBe('sc-domain:example.com');
  });

  it('forgives a missing trailing slash and different casing', () => {
    expect(matchSite('HTTPS://WWW.EXAMPLE.COM', SITES)?.siteUrl).toBe('https://www.example.com/');
  });

  it('prefers the domain property for a bare domain or a page URL', () => {
    expect(matchSite('example.com', SITES)?.siteUrl).toBe('sc-domain:example.com');
    expect(matchSite('https://www.example.com/pricing', SITES)?.siteUrl).toBe('sc-domain:example.com');
  });

  it('finds a URL-prefix property from a bare host or a page on it', () => {
    expect(matchSite('shop.other.org', SITES)?.siteUrl).toBe('https://shop.other.org/');
    expect(matchSite('https://shop.other.org/cart?x=1', SITES)?.siteUrl).toBe('https://shop.other.org/');
  });

  it('picks the most specific URL-prefix property when there is no domain property', () => {
    const prefixes = SITES.filter((site) => !site.siteUrl.startsWith('sc-domain:'));
    expect(matchSite('https://www.example.com/blog/post', prefixes)?.siteUrl).toBe('https://www.example.com/blog/');
    expect(matchSite('https://www.example.com/about', prefixes)?.siteUrl).toBe('https://www.example.com/');
  });

  it('ignores unverified properties and unknown sites', () => {
    expect(matchSite('unverified.net', SITES)).toBeUndefined();
    expect(matchSite('nowhere.io', SITES)).toBeUndefined();
  });
});

describe('urlBelongsToSite', () => {
  it('covers every protocol and subdomain of a domain property', () => {
    expect(urlBelongsToSite('http://blog.example.com/x', 'sc-domain:example.com')).toBe(true);
    expect(urlBelongsToSite('https://example.com/', 'sc-domain:example.com')).toBe(true);
    expect(urlBelongsToSite('https://notexample.com/', 'sc-domain:example.com')).toBe(false);
    expect(urlBelongsToSite('https://example.com.evil.io/', 'sc-domain:example.com')).toBe(false);
  });

  it('requires the exact protocol, host and path prefix of a URL-prefix property', () => {
    expect(urlBelongsToSite('https://www.example.com/blog/post', 'https://www.example.com/blog/')).toBe(true);
    expect(urlBelongsToSite('https://www.example.com/about', 'https://www.example.com/blog/')).toBe(false);
    expect(urlBelongsToSite('http://www.example.com/blog/post', 'https://www.example.com/blog/')).toBe(false);
    expect(urlBelongsToSite('https://example.com/blog/post', 'https://www.example.com/blog/')).toBe(false);
  });

  it('rejects non-web and malformed addresses', () => {
    expect(urlBelongsToSite('file:///etc/passwd', 'sc-domain:example.com')).toBe(false);
    expect(urlBelongsToSite('not a url', 'sc-domain:example.com')).toBe(false);
  });
});

describe('SiteResolver', () => {
  it('uses the only verified property when none is named', async () => {
    const resolver = new SiteResolver(async () => [SITES[3] as SiteEntry, SITES[4] as SiteEntry]);
    expect((await resolver.resolve()).siteUrl).toBe('https://shop.other.org/');
  });

  it('falls back to the configured default', async () => {
    const resolver = new SiteResolver(async () => SITES, 'other.org');
    await expect(resolver.resolve()).rejects.toThrow(UserError);
    const withDefault = new SiteResolver(async () => SITES, 'shop.other.org');
    expect((await withDefault.resolve()).siteUrl).toBe('https://shop.other.org/');
  });

  it('asks for a property when several are available, and lists them', async () => {
    const resolver = new SiteResolver(async () => SITES);
    await expect(resolver.resolve()).rejects.toMatchObject({
      message: expect.stringContaining('site_url is required'),
      hint: expect.stringContaining('sc-domain:example.com'),
    });
  });

  it('caches the property list but refreshes once before giving up on a name', async () => {
    let fetches = 0;
    const resolver = new SiteResolver(async () => {
      fetches += 1;
      return fetches === 1 ? [SITES[0] as SiteEntry] : SITES;
    });
    await resolver.resolve('example.com');
    await resolver.resolve('example.com');
    expect(fetches).toBe(1);
    // A property added after the first listing is found thanks to the refresh.
    expect((await resolver.resolve('shop.other.org')).siteUrl).toBe('https://shop.other.org/');
    expect(fetches).toBe(2);
  });
});
