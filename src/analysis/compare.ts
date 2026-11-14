import type { Metrics } from '../format.js';
import type { KeyedRow } from './rows.js';

export type ChangeStatus = 'both' | 'new' | 'lost';

export interface ComparedRow {
  keys: string[];
  status: ChangeStatus;
  /** Zeros when the row is absent from that period. */
  current: Metrics;
  previous: Metrics;
  clicksChange: number;
  impressionsChange: number;
  /** Change in CTR as a fraction (0.01 is one percentage point). */
  ctrChange: number;
  /** Negative means the average position improved. Null unless the row exists in both periods. */
  positionChange: number | null;
}

const ZERO: Metrics = { clicks: 0, impressions: 0, ctr: 0, position: 0 };

function idOf(keys: string[]): string {
  return keys.join('\u0000');
}

/** Joins two periods on their dimension keys and computes the change for each row. */
export function compareRows(current: KeyedRow[], previous: KeyedRow[]): ComparedRow[] {
  const before = new Map(previous.map((row) => [idOf(row.keys), row]));
  const compared: ComparedRow[] = [];

  for (const row of current) {
    const id = idOf(row.keys);
    const earlier = before.get(id);
    before.delete(id);
    compared.push({
      keys: row.keys,
      status: earlier ? 'both' : 'new',
      current: row,
      previous: earlier ?? ZERO,
      clicksChange: row.clicks - (earlier?.clicks ?? 0),
      impressionsChange: row.impressions - (earlier?.impressions ?? 0),
      ctrChange: row.ctr - (earlier?.ctr ?? 0),
      positionChange: earlier ? row.position - earlier.position : null,
    });
  }

  for (const earlier of before.values()) {
    compared.push({
      keys: earlier.keys,
      status: 'lost',
      current: ZERO,
      previous: earlier,
      clicksChange: -earlier.clicks,
      impressionsChange: -earlier.impressions,
      ctrChange: -earlier.ctr,
      positionChange: null,
    });
  }
  return compared;
}

export type DeclineCause = 'ranking_loss' | 'fewer_impressions' | 'lower_ctr' | 'mixed';

export const DECLINE_CAUSES: Record<DeclineCause, string> = {
  ranking_loss: 'The average position got worse. Look at what changed on the page and who now outranks it.',
  fewer_impressions:
    'Position held but the page was shown less often: seasonal demand, queries it no longer appears for, or a lost search feature.',
  lower_ctr:
    'Position and impressions held but fewer searchers clicked: the snippet, or a results page that now answers the query itself (AI Overviews, ads, featured snippets).',
  mixed: 'No single factor explains the drop.',
};

/** A first reading of why a row lost clicks, from how position, impressions and CTR moved. */
export function diagnoseDecline(current: Metrics, previous: Metrics): DeclineCause {
  const positionDrop = current.position - previous.position;
  const impressionChange =
    previous.impressions > 0 ? (current.impressions - previous.impressions) / previous.impressions : 0;
  const ctrChange = previous.ctr > 0 ? (current.ctr - previous.ctr) / previous.ctr : 0;

  if (current.impressions > 0 && previous.position > 0) {
    if (positionDrop >= 1 || (positionDrop >= 0.5 && positionDrop / previous.position >= 0.15)) return 'ranking_loss';
  }
  if (impressionChange <= -0.15) return 'fewer_impressions';
  if (ctrChange <= -0.15) return 'lower_ctr';
  return 'mixed';
}
