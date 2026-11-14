import { median } from './rows.js';

export interface DailyPoint {
  date: string;
  value: number;
}

export interface Anomaly {
  date: string;
  value: number;
  /** Median of the same weekday over the preceding weeks. */
  expected: number;
  /** Deviation from expected as a fraction (-0.4 is 40% below). */
  deviation: number;
  direction: 'drop' | 'spike';
}

export interface AnomalyOptions {
  /** Smallest deviation (0..1) worth reporting. */
  minDeviation: number;
  /** How many previous same-weekday values form the baseline. */
  lookbackWeeks: number;
  /** Skip days whose baseline is below this, where percentages mean little. */
  minBaseline: number;
}

/**
 * Flags days that differ sharply from the same weekday in the weeks before.
 *
 * Comparing like weekdays removes the weekly rhythm most sites have. A day is flagged only when it
 * clears three bars at once:
 * - the percentage threshold;
 * - three robust standard deviations of that weekday's own recent noise, so a site that swings a
 *   lot does not light up every day;
 * - three times the square root of the expected value. Clicks and impressions are counts, and a
 *   count that averages 10 a day lands anywhere from 4 to 16 by chance alone. Four past values are
 *   too few to see that, so without this bar a small site gets flagged for ordinary noise.
 * `series` must be contiguous, one point per day, oldest first.
 */
export function detectAnomalies(series: DailyPoint[], options: AnomalyOptions): Anomaly[] {
  const anomalies: Anomaly[] = [];
  series.forEach((point, index) => {
    const history: number[] = [];
    for (let week = 1; week <= options.lookbackWeeks; week += 1) {
      const earlier = series[index - 7 * week];
      if (earlier) history.push(earlier.value);
    }
    if (history.length < 3) return;

    const expected = median(history);
    if (expected < options.minBaseline) return;

    const spread = 1.4826 * median(history.map((value) => Math.abs(value - expected)));
    const threshold = Math.max(expected * options.minDeviation, 3 * spread, 3 * Math.sqrt(expected));
    const difference = point.value - expected;
    if (Math.abs(difference) < threshold) return;

    anomalies.push({
      date: point.date,
      value: point.value,
      expected,
      deviation: difference / expected,
      direction: difference < 0 ? 'drop' : 'spike',
    });
  });
  return anomalies;
}

export interface Episode {
  start: string;
  end: string;
  direction: 'drop' | 'spike';
  flaggedDays: number;
  /** The deviation furthest from zero among the flagged days (as a fraction). */
  largestDeviation: number;
}

function daysApart(earlier: string, later: string): number {
  return Math.round((Date.parse(`${later}T00:00:00Z`) - Date.parse(`${earlier}T00:00:00Z`)) / 86_400_000);
}

/**
 * Groups flagged days into episodes. When traffic moves to a new level and stays there, the days
 * after the change keep getting flagged until the baseline catches up; reported one by one they
 * read as many separate incidents. Flagged days in the same direction no more than a week apart
 * are one episode, and an episode with several days is a sustained shift, not a blip.
 */
export function groupEpisodes(anomalies: Anomaly[]): Episode[] {
  const episodes: Episode[] = [];
  for (const anomaly of [...anomalies].sort((a, b) => a.date.localeCompare(b.date))) {
    const current = episodes[episodes.length - 1];
    if (current && current.direction === anomaly.direction && daysApart(current.end, anomaly.date) <= 7) {
      current.end = anomaly.date;
      current.flaggedDays += 1;
      if (Math.abs(anomaly.deviation) > Math.abs(current.largestDeviation)) current.largestDeviation = anomaly.deviation;
    } else {
      episodes.push({
        start: anomaly.date,
        end: anomaly.date,
        direction: anomaly.direction,
        flaggedDays: 1,
        largestDeviation: anomaly.deviation,
      });
    }
  }
  return episodes;
}
