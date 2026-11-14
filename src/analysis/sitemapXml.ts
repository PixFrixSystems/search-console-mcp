import { gunzipSync } from 'node:zlib';
import { UserError } from '../errors.js';

export interface ParsedSitemap {
  kind: 'index' | 'urlset';
  locations: string[];
}

const NAMED_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

export function decodeXmlEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (match, entity: string) => {
    const lower = entity.toLowerCase();
    if (lower.startsWith('#x')) return String.fromCodePoint(Number.parseInt(lower.slice(2), 16));
    if (lower.startsWith('#')) return String.fromCodePoint(Number.parseInt(lower.slice(1), 10));
    return NAMED_ENTITIES[lower] ?? match;
  });
}

/**
 * Reads the <loc> entries of an XML sitemap or sitemap index, or the lines of a plain-text sitemap.
 * Namespaced entries such as <image:loc> are ignored on purpose: they are assets, not pages.
 */
export function parseSitemap(content: string): ParsedSitemap {
  if (!content.includes('<')) {
    const lines = content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => /^https?:\/\//i.test(line));
    return { kind: 'urlset', locations: lines };
  }
  const kind = /<sitemapindex[\s>]/i.test(content) ? 'index' : 'urlset';
  const locations: string[] = [];
  const pattern = /<loc>\s*(?:<!\[CDATA\[)?\s*([\s\S]*?)\s*(?:\]\]>)?\s*<\/loc>/gi;
  for (const match of content.matchAll(pattern)) {
    const location = decodeXmlEntities((match[1] ?? '').trim());
    if (location) locations.push(location);
  }
  return { kind, locations };
}

export interface SitemapFetchOptions {
  fetch?: typeof fetch;
  /** Checked before every request, redirects included, so the server only talks to the user's own site. */
  isAllowed: (url: string) => boolean;
  /** Stop collecting page URLs once this many are known. */
  maxUrls: number;
  /** Stop after downloading this many sitemap files. */
  maxSitemaps: number;
  maxBytes?: number;
  timeoutMs?: number;
}

export interface SitemapCrawl {
  urls: string[];
  sitemapsRead: string[];
  skipped: { sitemap: string; reason: string }[];
  /** True when a limit stopped the crawl before every sitemap was read. */
  truncated: boolean;
}

const MAX_REDIRECTS = 5;

async function download(url: string, options: SitemapFetchOptions): Promise<string> {
  const fetchImpl = options.fetch ?? fetch;
  const maxBytes = options.maxBytes ?? 50 * 1024 * 1024;
  let current = url;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    if (!options.isAllowed(current)) {
      throw new UserError(`${current} is outside this Search Console property, so it was not fetched.`);
    }
    const response = await fetchImpl(current, {
      redirect: 'manual',
      headers: { accept: 'application/xml, text/xml, text/plain, */*', 'user-agent': 'search-console-mcp' },
      signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) throw new UserError(`${current} redirected without a Location header.`);
      current = new URL(location, current).toString();
      continue;
    }
    if (!response.ok) throw new UserError(`${current} returned HTTP ${response.status}.`);

    const declared = Number(response.headers.get('content-length') ?? 0);
    if (declared > maxBytes) throw new UserError(`${current} is larger than the 50 MB sitemap limit.`);
    const raw = Buffer.from(await response.arrayBuffer());
    if (raw.byteLength > maxBytes) throw new UserError(`${current} is larger than the 50 MB sitemap limit.`);

    const isGzip = raw[0] === 0x1f && raw[1] === 0x8b;
    return (isGzip ? gunzipSync(raw, { maxOutputLength: maxBytes }) : raw).toString('utf8');
  }
  throw new UserError(`${url} redirects too many times.`);
}

/** Downloads the given sitemaps, follows sitemap indexes, and returns the page URLs they list. */
export async function collectSitemapUrls(start: string[], options: SitemapFetchOptions): Promise<SitemapCrawl> {
  const queue = [...start];
  const seen = new Set<string>();
  const urls = new Set<string>();
  const sitemapsRead: string[] = [];
  const skipped: SitemapCrawl['skipped'] = [];

  while (queue.length > 0 && sitemapsRead.length < options.maxSitemaps && urls.size < options.maxUrls) {
    const sitemap = queue.shift() as string;
    if (seen.has(sitemap)) continue;
    seen.add(sitemap);

    let parsed: ParsedSitemap;
    try {
      parsed = parseSitemap(await download(sitemap, options));
    } catch (error) {
      skipped.push({ sitemap, reason: error instanceof Error ? error.message : String(error) });
      continue;
    }
    sitemapsRead.push(sitemap);

    if (parsed.kind === 'index') {
      queue.push(...parsed.locations);
    } else {
      for (const location of parsed.locations) {
        if (urls.size >= options.maxUrls) break;
        urls.add(location);
      }
    }
  }

  return {
    urls: [...urls],
    sitemapsRead,
    skipped,
    truncated: queue.some((sitemap) => !seen.has(sitemap)) || urls.size >= options.maxUrls,
  };
}

/** Picks `count` items at random without replacement (a partial Fisher-Yates shuffle). */
export function sample<T>(items: T[], count: number, random: () => number = Math.random): T[] {
  const pool = [...items];
  const size = Math.min(count, pool.length);
  for (let index = 0; index < size; index += 1) {
    const swap = index + Math.floor(random() * (pool.length - index));
    [pool[index], pool[swap]] = [pool[swap] as T, pool[index] as T];
  }
  return pool.slice(0, size);
}
