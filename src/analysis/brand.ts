import { UserError } from '../errors.js';

/** Search Console rejects filter expressions longer than this. */
const MAX_EXPRESSION_LENGTH = 4096;

function escapeRegex(term: string): string {
  return term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Lower-cased, de-duplicated brand terms. Search Console reports queries in lower case. */
export function normaliseBrandTerms(terms: string[]): string[] {
  return [...new Set(terms.map((term) => term.trim().toLowerCase()).filter(Boolean))];
}

/** An RE2 pattern for the includingRegex / excludingRegex filter operators. */
export function brandPattern(terms: string[]): string {
  const cleaned = normaliseBrandTerms(terms);
  if (cleaned.length === 0) throw new UserError('At least one brand term is required.');
  const pattern = cleaned.map(escapeRegex).join('|');
  if (pattern.length > MAX_EXPRESSION_LENGTH) {
    throw new UserError('The brand terms are too long for a Search Console filter (4,096 characters at most).');
  }
  return pattern;
}

/** The same test applied locally to a query string. */
export function brandMatcher(terms: string[]): (query: string) => boolean {
  const cleaned = normaliseBrandTerms(terms);
  if (cleaned.length === 0) return () => false;
  const pattern = new RegExp(cleaned.map(escapeRegex).join('|'), 'i');
  return (query) => pattern.test(query);
}
