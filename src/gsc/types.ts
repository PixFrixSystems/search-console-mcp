export const DIMENSIONS = ['query', 'page', 'country', 'device', 'searchAppearance', 'date', 'hour'] as const;
export type Dimension = (typeof DIMENSIONS)[number];

export const FILTER_DIMENSIONS = ['query', 'page', 'country', 'device', 'searchAppearance'] as const;
export type FilterDimension = (typeof FILTER_DIMENSIONS)[number];

export const FILTER_OPERATORS = [
  'contains',
  'equals',
  'notContains',
  'notEquals',
  'includingRegex',
  'excludingRegex',
] as const;
export type FilterOperator = (typeof FILTER_OPERATORS)[number];

export const SEARCH_TYPES = ['web', 'image', 'video', 'news', 'discover', 'googleNews'] as const;
export type SearchType = (typeof SEARCH_TYPES)[number];

export const DATA_STATES = ['final', 'all', 'hourly_all'] as const;
export type DataState = (typeof DATA_STATES)[number];

export const AGGREGATION_TYPES = ['auto', 'byPage', 'byProperty', 'byNewsShowcasePanel'] as const;
export type AggregationType = (typeof AGGREGATION_TYPES)[number];

export interface DimensionFilter {
  dimension: FilterDimension;
  operator?: FilterOperator;
  expression: string;
}

export interface SearchAnalyticsRequest {
  startDate: string;
  endDate: string;
  dimensions?: Dimension[];
  type?: SearchType;
  dimensionFilterGroups?: { groupType?: 'and'; filters: DimensionFilter[] }[];
  aggregationType?: AggregationType;
  rowLimit?: number;
  startRow?: number;
  dataState?: DataState;
}

export interface SearchAnalyticsRow {
  keys?: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

/**
 * Returned with dataState "all" or "hourly_all" when the range reaches into data Google is still
 * collecting. The live API sends camelCase names; Google's reference page documents snake_case.
 * Both are read so a change on either side does not break freshness detection.
 */
export interface SearchAnalyticsMetadata {
  firstIncompleteDate?: string;
  firstIncompleteHour?: string;
  first_incomplete_date?: string;
  first_incomplete_hour?: string;
}

export function firstIncompleteDate(metadata: SearchAnalyticsMetadata | undefined): string | undefined {
  return metadata?.firstIncompleteDate ?? metadata?.first_incomplete_date;
}

export function firstIncompleteHour(metadata: SearchAnalyticsMetadata | undefined): string | undefined {
  return metadata?.firstIncompleteHour ?? metadata?.first_incomplete_hour;
}

export interface SearchAnalyticsResponse {
  rows?: SearchAnalyticsRow[];
  responseAggregationType?: string;
  metadata?: SearchAnalyticsMetadata;
}

export type PermissionLevel = 'siteOwner' | 'siteFullUser' | 'siteRestrictedUser' | 'siteUnverifiedUser';

export interface SiteEntry {
  siteUrl: string;
  permissionLevel: PermissionLevel | string;
}

export interface SitemapContent {
  type: string;
  submitted?: string | number;
}

export interface Sitemap {
  path: string;
  lastSubmitted?: string;
  isPending?: boolean;
  isSitemapsIndex?: boolean;
  type?: string;
  lastDownloaded?: string;
  warnings?: string | number;
  errors?: string | number;
  contents?: SitemapContent[];
}

export interface RichResultsIssue {
  issueMessage?: string;
  severity?: string;
}

export interface UrlInspectionResult {
  inspectionResultLink?: string;
  indexStatusResult?: {
    sitemap?: string[];
    referringUrls?: string[];
    verdict?: string;
    coverageState?: string;
    robotsTxtState?: string;
    indexingState?: string;
    lastCrawlTime?: string;
    pageFetchState?: string;
    googleCanonical?: string;
    userCanonical?: string;
    crawledAs?: string;
  };
  ampResult?: {
    issues?: RichResultsIssue[];
    verdict?: string;
    ampUrl?: string;
    robotsTxtState?: string;
    indexingState?: string;
    ampIndexStatusVerdict?: string;
    lastCrawlTime?: string;
    pageFetchState?: string;
  };
  richResultsResult?: {
    verdict?: string;
    detectedItems?: {
      richResultType?: string;
      items?: { name?: string; issues?: RichResultsIssue[] }[];
    }[];
  };
}
