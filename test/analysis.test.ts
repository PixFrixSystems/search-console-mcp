import { describe, expect, it } from 'vitest';
import { detectAnomalies, groupEpisodes } from '../src/analysis/anomalies.js';
import { brandMatcher, brandPattern } from '../src/analysis/brand.js';
import { findCannibalization } from '../src/analysis/cannibalization.js';
import { compareRows, diagnoseDecline } from '../src/analysis/compare.js';
import { BENCHMARK_CTR, buildCtrCurve, describeCurve, expectedCtr } from '../src/analysis/ctrCurve.js';
import {
  estimateExtraClicks,
  findCtrGaps,
  findPageCtrGaps,
  findStrikingDistance,
  type QueryPageRow,
} from '../src/analysis/opportunities.js';
import { type KeyedRow, median, mergePageFragments, stripFragment } from '../src/analysis/rows.js';
import { addDays } from '../src/dates.js';
import { UserError } from '../src/errors.js';

function metrics(clicks: number, impressions: number, position: number) {
  return { clicks, impressions, ctr: impressions > 0 ? clicks / impressions : 0, position };
}

function pair(query: string, page: string, clicks: number, impressions: number, position: number): QueryPageRow {
  return { query, page, ...metrics(clicks, impressions, position) };
}

function keyed(key: string, clicks: number, impressions: number, position: number): KeyedRow {
  return { keys: [key], ...metrics(clicks, impressions, position) };
}

describe('rows', () => {
  it('folds jump-link variants into their page', () => {
    expect(stripFragment('https://example.com/guide#step-2')).toBe('https://example.com/guide');
    const merged = mergePageFragments(
      [
        { keys: ['seo', 'https://example.com/guide'], ...metrics(10, 100, 2) },
        { keys: ['seo', 'https://example.com/guide#faq'], ...metrics(5, 300, 6) },
        { keys: ['seo', 'https://example.com/other'], ...metrics(1, 50, 9) },
      ],
      1,
    );
    expect(merged).toHaveLength(2);
    const guide = merged.find((item) => item.keys[1] === 'https://example.com/guide');
    expect(guide).toMatchObject({ clicks: 15, impressions: 400, ctr: 15 / 400 });
    // Position is averaged by impressions: (2*100 + 6*300) / 400.
    expect(guide?.position).toBeCloseTo(5);
  });

  it('computes medians', () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBe(0);
  });
});

describe('CTR curve', () => {
  it('falls back to the benchmark when the site has no data', () => {
    const curve = buildCtrCurve([]);
    expect(curve.ctr).toEqual([...BENCHMARK_CTR]);
    expect(describeCurve(curve).based_on_site_data_pct).toBe(0);
  });

  it('follows the site when it has plenty of impressions', () => {
    const curve = buildCtrCurve([metrics(4000, 10_000, 1), metrics(1000, 10_000, 2), metrics(500, 10_000, 3)]);
    expect(curve.ctr[0]).toBeCloseTo(0.4);
    expect(curve.ctr[1]).toBeCloseTo(0.1);
    expect(curve.ctr[2]).toBeCloseTo(0.05);
    expect(curve.siteWeight.slice(0, 3)).toEqual([1, 1, 1]);
  });

  it('blends thin site data with the benchmark instead of trusting it', () => {
    // 100 impressions at position 1 with zero clicks must not drag the expectation to zero.
    const curve = buildCtrCurve([metrics(0, 100, 1)]);
    expect(curve.ctr[0]).toBeCloseTo(0.9 * (BENCHMARK_CTR[0] as number));
  });

  it('never expects a worse position to be clicked more', () => {
    const curve = buildCtrCurve([metrics(100, 10_000, 1), metrics(3000, 10_000, 2), metrics(200, 10_000, 3)]);
    for (let index = 1; index < curve.ctr.length; index += 1) {
      expect(curve.ctr[index] as number).toBeLessThanOrEqual((curve.ctr[index - 1] as number) + 1e-12);
    }
  });

  it('interpolates fractional positions and decays past position 20', () => {
    const curve = buildCtrCurve([]);
    expect(expectedCtr(curve, 1)).toBe(BENCHMARK_CTR[0]);
    expect(expectedCtr(curve, 1.5)).toBeCloseTo(((BENCHMARK_CTR[0] as number) + (BENCHMARK_CTR[1] as number)) / 2);
    expect(expectedCtr(curve, 40)).toBeCloseTo((BENCHMARK_CTR[19] as number) / 2);
    expect(expectedCtr(curve, 0)).toBe(BENCHMARK_CTR[0]);
  });
});

describe('quick wins', () => {
  const curve = buildCtrCurve([]);
  const rows = [
    pair('running shoes', '/shoes', 20, 2000, 6.2),
    pair('trail shoes', '/trail', 2, 900, 11.4),
    pair('brand name', '/', 500, 800, 1.1),
    pair('rare query', '/rare', 0, 5, 8),
    pair('far away', '/far', 1, 4000, 45),
  ];
  const options = { minPosition: 4, maxPosition: 20, minImpressions: 30, targetPosition: 3 };

  it('keeps rows in the position band with enough impressions', () => {
    const found = findStrikingDistance(rows, curve, options);
    expect(found.map((row) => row.query)).toEqual(['running shoes', 'trail shoes']);
  });

  it('estimates the extra clicks from reaching the target position', () => {
    const [first] = findStrikingDistance(rows, curve, options);
    // At position 6.2 the curve expects 4.52% of 2000 impressions, about 90 clicks. The query got 20,
    // so it is clicked far less than usual; with three pseudo-clicks its propensity is 23 / 93.4.
    const propensity = (20 + 3) / (2000 * 0.0452 + 3);
    expect(first?.estimatedExtraClicks).toBeCloseTo(2000 * 0.11 * propensity - 20);
  });

  it('credits a query that is clicked more than its position suggests', () => {
    // 20% CTR at position 7.6, where about 3.5% is normal: reaching position 3 is worth real clicks.
    const eager = { clicks: 10, impressions: 49, ctr: 10 / 49, position: 7.6 };
    const average = { clicks: 2, impressions: 49, ctr: 2 / 49, position: 7.6 };
    expect(estimateExtraClicks(eager, curve, 3)).toBeGreaterThan(estimateExtraClicks(average, curve, 3));
    expect(estimateExtraClicks(eager, curve, 3)).toBeGreaterThan(4);
  });

  it('treats a row with almost no data as average instead of hopeless', () => {
    const tiny = { clicks: 0, impressions: 10, ctr: 0, position: 8 };
    // Ten impressions without a click say nothing; the estimate stays close to the plain curve value.
    expect(estimateExtraClicks(tiny, curve, 3)).toBeCloseTo(10 * 0.11, 0);
    expect(estimateExtraClicks(tiny, curve, 3)).toBeGreaterThan(0.9);
  });

  it('gives nothing to a row already at or above the target, and caps implausible CTRs', () => {
    expect(estimateExtraClicks({ clicks: 5, impressions: 100, ctr: 0.05, position: 2.5 }, curve, 3)).toBe(0);
    // Whatever the propensity, no more than half the impressions are assumed to click.
    const runaway = { clicks: 40, impressions: 100, ctr: 0.4, position: 15 };
    expect(estimateExtraClicks(runaway, curve, 3)).toBeCloseTo(100 * 0.5 - 40);
  });

  it('never reports a negative gain', () => {
    const found = findStrikingDistance([pair('already clicked a lot', '/x', 900, 1000, 5)], curve, options);
    expect(found[0]?.estimatedExtraClicks).toBe(0);
  });
});

describe('CTR opportunities', () => {
  const curve = buildCtrCurve([]);
  const options = { maxPosition: 10, minImpressions: 50, maxRatio: 0.6 };
  const rows = [
    pair('weak snippet', '/a', 10, 1000, 2), // 1% against an expected 15.5%
    pair('healthy', '/a', 150, 1000, 2), // 15%
    pair('also weak', '/b', 2, 400, 4.5),
    pair('too deep', '/c', 0, 5000, 15),
    pair('too small', '/d', 0, 10, 1),
  ];

  it('flags rows far below the expected CTR for their position', () => {
    const gaps = findCtrGaps(rows, curve, options);
    expect(gaps.map((row) => row.query)).toEqual(['weak snippet', 'also weak']);
    expect(gaps[0]?.missedClicks).toBeCloseTo(1000 * 0.155 - 10);
    expect(gaps[0]?.ratio).toBeCloseTo(0.01 / 0.155);
  });

  it('rolls expectations up per page across its queries', () => {
    const pages = findPageCtrGaps(rows, curve, { ...options, maxRatio: 1 });
    const pageA = pages.find((page) => page.page === '/a');
    expect(pageA).toMatchObject({ queries: 2, clicks: 160, impressions: 2000 });
    expect(pageA?.expectedClicks).toBeCloseTo(2 * 1000 * 0.155);
    // The deep and tiny pages are excluded by position and impressions.
    expect(pages.map((page) => page.page).sort()).toEqual(['/a', '/b']);
  });
});

describe('cannibalization', () => {
  const options = { minImpressions: 50, minShare: 0.1, maxPages: 5 };

  it('reports queries split between pages and ranks them by the size of the split', () => {
    const found = findCannibalization(
      [
        pair('seo guide', '/guide', 30, 600, 4),
        pair('seo guide', '/blog/seo', 10, 400, 7),
        pair('seo tools', '/tools', 50, 900, 2),
        pair('seo tools', '/blog/tools', 0, 30, 30), // only 3% of impressions
        pair('small', '/x', 0, 10, 5),
        pair('small', '/y', 0, 10, 6),
        pair('pricing', '/pricing', 5, 500, 3),
        pair('pricing', '/plans', 5, 500, 4),
      ],
      options,
    );
    expect(found.map((item) => item.query)).toEqual(['pricing', 'seo guide']);
    expect(found[0]).toMatchObject({ impressions: 1000, competingPages: 2, splitImpressions: 500 });
    expect(found[1]?.pages[0]).toMatchObject({ page: '/guide', share: 0.6 });
  });

  it('does not flag a query that one page clearly owns', () => {
    expect(findCannibalization([pair('q', '/a', 10, 950, 1), pair('q', '/b', 0, 50, 20)], options)).toEqual([]);
  });
});

describe('period comparison', () => {
  it('joins rows and labels what is new and what is gone', () => {
    const compared = compareRows(
      [keyed('stayed', 30, 300, 4), keyed('appeared', 5, 100, 9)],
      [keyed('stayed', 50, 400, 3), keyed('vanished', 20, 200, 6)],
    );
    const byKey = Object.fromEntries(compared.map((row) => [row.keys[0], row]));
    expect(byKey.stayed).toMatchObject({ status: 'both', clicksChange: -20, impressionsChange: -100, positionChange: 1 });
    expect(byKey.appeared).toMatchObject({ status: 'new', clicksChange: 5, positionChange: null });
    expect(byKey.vanished).toMatchObject({ status: 'lost', clicksChange: -20, positionChange: null });
    expect(byKey.vanished?.current.clicks).toBe(0);
  });

  it('reads the likely cause of a decline from which metric moved', () => {
    expect(diagnoseDecline(metrics(40, 1000, 7.5), metrics(100, 1000, 3))).toBe('ranking_loss');
    expect(diagnoseDecline(metrics(50, 500, 3.1), metrics(100, 1000, 3))).toBe('fewer_impressions');
    expect(diagnoseDecline(metrics(60, 1000, 3.1), metrics(100, 1000, 3))).toBe('lower_ctr');
    expect(diagnoseDecline(metrics(95, 950, 3), metrics(100, 1000, 3))).toBe('mixed');
  });
});

describe('anomaly detection', () => {
  // Eight weeks with a strong weekly rhythm: weekdays 100, weekends 40.
  function series(overrides: Record<number, number> = {}) {
    return Array.from({ length: 56 }, (_, index) => ({
      date: addDays('2026-09-07', index), // a Monday
      value: overrides[index] ?? (index % 7 >= 5 ? 40 : 100),
    }));
  }
  const options = { minDeviation: 0.3, lookbackWeeks: 4, minBaseline: 10 };

  it('stays quiet on a normal weekly pattern', () => {
    expect(detectAnomalies(series(), options)).toEqual([]);
  });

  it('flags a drop against the same weekday, not against yesterday', () => {
    const found = detectAnomalies(series({ 44: 45 }), options); // a Wednesday falls to weekend level
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ date: addDays('2026-09-07', 44), value: 45, expected: 100, direction: 'drop' });
    expect(found[0]?.deviation).toBeCloseTo(-0.55);
  });

  it('flags spikes too', () => {
    const found = detectAnomalies(series({ 40: 90 }), options); // a Saturday at weekday level
    expect(found[0]).toMatchObject({ direction: 'spike', expected: 40 });
  });

  it('ignores days without enough history or with tiny baselines', () => {
    expect(detectAnomalies(series({ 10: 1 }), options)).toEqual([]);
    const tiny = Array.from({ length: 56 }, (_, index) => ({ date: addDays('2026-09-07', index), value: index === 50 ? 0 : 3 }));
    expect(detectAnomalies(tiny, options)).toEqual([]);
  });

  describe('on a real series with a level shift', () => {
    // Ninety days of daily clicks from a live property (2026-08-14 onwards): about 10 a day,
    // then roughly triple from 16 October and staying there.
    const clicks = [
      4, 5, 5, 9, 15, 10, 10, 15, 6, 4, 11, 2, 10, 9, 9, 22, 9, 3, 7, 12, 4, 5, 10, 10, 7, 6, 15, 3, 6, 5, 10, 9, 11, 7,
      9, 10, 6, 15, 8, 11, 12, 4, 10, 4, 5, 11, 13, 7, 10, 5, 10, 15, 10, 6, 9, 9, 10, 10, 6, 10, 9, 18, 10, 20, 23, 17,
      30, 21, 20, 14, 32, 23, 30, 37, 26, 32, 25, 36, 23, 25, 26, 24, 29, 29, 22, 27, 30, 46, 47, 38,
    ];
    const real = clicks.map((value, index) => ({ date: addDays('2026-08-14', index), value }));
    const found = detectAnomalies(real, options);

    it('ignores the day-to-day noise of a small site', () => {
      // Before the shift, days of 2 to 22 clicks around a level of 10 are chance, not events.
      expect(found.filter((item) => item.date < '2026-10-16')).toEqual([]);
    });

    it('flags the shift and reports it as one sustained episode', () => {
      expect(found.length).toBeGreaterThanOrEqual(5);
      expect(found.every((item) => item.direction === 'spike')).toBe(true);
      const episodes = groupEpisodes(found);
      expect(episodes).toHaveLength(1);
      expect(episodes[0]).toMatchObject({ start: '2026-10-16', direction: 'spike' });
      expect(episodes[0]?.flaggedDays).toBe(found.length);
    });
  });

  it('keeps unrelated events apart when grouping', () => {
    const day = (date: string, deviation: number) => ({
      date,
      value: 0,
      expected: 0,
      deviation,
      direction: deviation < 0 ? ('drop' as const) : ('spike' as const),
    });
    const episodes = groupEpisodes([
      day('2026-03-02', -0.5),
      day('2026-03-05', -0.8),
      day('2026-03-06', 0.6), // opposite direction: its own episode
      day('2026-03-20', -0.4), // same direction as the first, but more than a week later
    ]);
    expect(episodes).toEqual([
      { start: '2026-03-02', end: '2026-03-05', direction: 'drop', flaggedDays: 2, largestDeviation: -0.8 },
      { start: '2026-03-06', end: '2026-03-06', direction: 'spike', flaggedDays: 1, largestDeviation: 0.6 },
      { start: '2026-03-20', end: '2026-03-20', direction: 'drop', flaggedDays: 1, largestDeviation: -0.4 },
    ]);
  });

  it('does not flag normal swings on a noisy site', () => {
    // Wednesdays swing between 60 and 140; a value of 65 is within that noise.
    const noisy = series({ 2: 60, 9: 140, 16: 60, 23: 140, 30: 65 });
    expect(detectAnomalies(noisy, options).map((item) => item.date)).not.toContain(addDays('2026-09-07', 30));
  });
});

describe('brand terms', () => {
  it('builds an RE2 pattern with special characters escaped', () => {
    expect(brandPattern(['Acme', ' acme.io ', 'ACME'])).toBe('acme|acme\\.io');
  });

  it('matches queries regardless of case', () => {
    const isBrand = brandMatcher(['Acme', 'acme.io']);
    expect(isBrand('ACME login')).toBe(true);
    expect(isBrand('best acme.io alternatives')).toBe(true);
    expect(isBrand('running shoes')).toBe(false);
    // The dot is literal, so it does not act as a wildcard.
    expect(brandMatcher(['acme.io'])('acmexio')).toBe(false);
    expect(brandMatcher([])('anything')).toBe(false);
  });

  it('refuses an empty or oversized list', () => {
    expect(() => brandPattern([' '])).toThrow(UserError);
    expect(() => brandPattern(Array.from({ length: 500 }, (_, index) => `brand-number-${index}`))).toThrow(/4,096/);
  });
});
