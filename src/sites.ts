import { UserError } from './errors.js';
import type { SiteEntry } from './gsc/types.js';

export type PropertyType = 'domain' | 'url_prefix';

const DOMAIN_PREFIX = 'sc-domain:';

export function propertyType(siteUrl: string): PropertyType {
  return siteUrl.startsWith(DOMAIN_PREFIX) ? 'domain' : 'url_prefix';
}

function isVerified(site: SiteEntry): boolean {
  return site.permissionLevel !== 'siteUnverifiedUser';
}

/** True when `url` is a page covered by the Search Console property `siteUrl`. */
export function urlBelongsToSite(url: string, siteUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  const host = parsed.hostname.toLowerCase();

  if (propertyType(siteUrl) === 'domain') {
    const domain = siteUrl.slice(DOMAIN_PREFIX.length).toLowerCase();
    return host === domain || host.endsWith(`.${domain}`);
  }

  let property: URL;
  try {
    property = new URL(siteUrl);
  } catch {
    return false;
  }
  return (
    parsed.protocol === property.protocol &&
    parsed.host.toLowerCase() === property.host.toLowerCase() &&
    parsed.pathname.startsWith(property.pathname)
  );
}

function loosely(value: string): string {
  return value.trim().toLowerCase().replace(/\/+$/, '');
}

function parseInput(input: string): URL | undefined {
  const trimmed = input.trim();
  const withoutPrefix = trimmed.toLowerCase().startsWith(DOMAIN_PREFIX) ? trimmed.slice(DOMAIN_PREFIX.length) : trimmed;
  try {
    return new URL(/^https?:\/\//i.test(withoutPrefix) ? withoutPrefix : `https://${withoutPrefix}`);
  } catch {
    return undefined;
  }
}

/**
 * Finds the property a person most likely means by "example.com", a page URL or an exact property name.
 * Domain properties win over URL-prefix ones because they hold the complete data for the site.
 */
export function matchSite(input: string, sites: SiteEntry[]): SiteEntry | undefined {
  const verified = sites.filter(isVerified);
  const exact =
    verified.find((site) => site.siteUrl === input.trim()) ??
    verified.find((site) => loosely(site.siteUrl) === loosely(input));
  if (exact) return exact;

  const wanted = parseInput(input);
  if (!wanted) return undefined;
  const host = wanted.hostname.toLowerCase();
  const bareHost = host.replace(/^www\./, '');
  const hadScheme = /^https?:\/\//i.test(input.trim());

  let best: { site: SiteEntry; score: number } | undefined;
  for (const site of verified) {
    let score: number;
    if (propertyType(site.siteUrl) === 'domain') {
      const domain = site.siteUrl.slice(DOMAIN_PREFIX.length).toLowerCase();
      if (host !== domain && !host.endsWith(`.${domain}`)) continue;
      score = 10_000 + domain.length;
    } else {
      let property: URL;
      try {
        property = new URL(site.siteUrl);
      } catch {
        continue;
      }
      const propertyHost = property.hostname.toLowerCase();
      if (propertyHost.replace(/^www\./, '') !== bareHost) continue;
      if (!wanted.pathname.startsWith(property.pathname)) continue;
      if (hadScheme && property.protocol !== wanted.protocol && wanted.pathname !== '/') continue;
      score =
        property.pathname.length * 10 + (property.protocol === 'https:' ? 2 : 0) + (propertyHost === host ? 1 : 0);
    }
    if (!best || score > best.score) best = { site, score };
  }
  return best?.site;
}

function describeSites(sites: SiteEntry[]): string {
  const verified = sites.filter(isVerified);
  if (verified.length === 0) {
    return 'This account cannot read any verified Search Console property yet. Add the account as a user under Settings > Users and permissions in Search Console.';
  }
  const shown = verified.slice(0, 40).map((site) => site.siteUrl);
  const more = verified.length > shown.length ? ` and ${verified.length - shown.length} more` : '';
  return `Available properties: ${shown.join(', ')}${more}.`;
}

export class SiteResolver {
  private cache: { sites: SiteEntry[]; at: number } | undefined;

  constructor(
    private readonly fetchSites: () => Promise<SiteEntry[]>,
    private readonly defaultSite?: string,
    private readonly ttlMs: number = 5 * 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  async list(refresh = false): Promise<SiteEntry[]> {
    if (!refresh && this.cache && this.now() - this.cache.at < this.ttlMs) return this.cache.sites;
    const sites = await this.fetchSites();
    this.cache = { sites, at: this.now() };
    return sites;
  }

  /** Resolves the property for a tool call, falling back to GSC_SITE_URL or the only property the account has. */
  async resolve(input?: string): Promise<SiteEntry> {
    const wanted = input?.trim() || this.defaultSite;
    let sites = await this.list();

    if (!wanted) {
      const verified = sites.filter(isVerified);
      if (verified.length === 1) return verified[0] as SiteEntry;
      throw new UserError(
        verified.length === 0
          ? 'No Search Console property is available.'
          : 'This account can read several properties, so site_url is required.',
        describeSites(sites),
      );
    }

    let match = matchSite(wanted, sites);
    if (!match) {
      sites = await this.list(true);
      match = matchSite(wanted, sites);
    }
    if (!match) {
      throw new UserError(`No Search Console property matches "${wanted}".`, describeSites(sites));
    }
    return match;
  }
}
