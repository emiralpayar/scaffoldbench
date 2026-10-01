import { describe, expect, it } from 'vitest';
import {
  aggregate,
  bootstrapCI,
  comparisonVerdict,
  holmAdjust,
  logGamma,
  makeRng,
  mean,
  median,
  normalCdf,
  normalQuantile,
  paretoFrontier,
  stdDev,
  studentTCdf,
  studentTQuantile,
  variance,
  wilsonInterval,
} from '@arena/core';

describe('descriptive statistics', () => {
  it('handles empty input without throwing', () => {
    expect(mean([])).toBe(0);
    expect(median([])).toBe(0);
    expect(stdDev([])).toBe(0);
  });

  it('computes mean and median', () => {
    expect(mean([1, 2, 3, 4])).toBe(2.5);
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  it('uses the sample standard deviation', () => {
    expect(stdDev([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(2.138, 3);
    expect(stdDev([5])).toBe(0);
  });

  it('computes the sample variance', () => {
    expect(variance([1, 2, 3, 4])).toBeCloseTo(5 / 3, 12);
    expect(variance([7])).toBe(0);
  });
});

describe('makeRng', () => {
  it('is deterministic for a given seed', () => {
    const a = makeRng(42);
    const b = makeRng(42);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });

  it('produces values in [0, 1)', () => {
    const rng = makeRng(7);
    for (let i = 0; i < 500; i++) {
      const v = rng();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe('bootstrapCI', () => {
  it('is reproducible across calls', () => {
    const values = [0.1, 0.4, 0.8, 0.3, 0.9];
    expect(bootstrapCI(values)).toEqual(bootstrapCI(values));
  });

  it('collapses to the value itself for n = 1', () => {
    expect(bootstrapCI([0.7])).toEqual({ low: 0.7, high: 0.7 });
  });

  it('brackets the sample mean', () => {
    const values = [0.2, 0.5, 0.6, 0.4, 0.55, 0.45];
    const ci = bootstrapCI(values);
    const m = mean(values);
    expect(ci.low).toBeLessThanOrEqual(m);
    expect(ci.high).toBeGreaterThanOrEqual(m);
  });

  it('narrows as the sample grows', () => {
    const small = bootstrapCI([0.2, 0.8]);
    const large = bootstrapCI(Array.from({ length: 200 }, (_, i) => (i % 2 === 0 ? 0.2 : 0.8)));
    expect(large.high - large.low).toBeLessThan(small.high - small.low);
  });

  it('gives a zero-width interval for constant data', () => {
    const ci = bootstrapCI([0.5, 0.5, 0.5, 0.5]);
    expect(ci.low).toBeCloseTo(0.5);
    expect(ci.high).toBeCloseTo(0.5);
  });
});

describe('aggregate', () => {
  it('reports n, extremes and the interval', () => {
    const a = aggregate([0.1, 0.5, 0.9]);
    expect(a.n).toBe(3);
    expect(a.min).toBe(0.1);
    expect(a.max).toBe(0.9);
    expect(a.mean).toBeCloseTo(0.5);
    expect(a.ciLow).toBeLessThanOrEqual(a.ciHigh);
  });

  it('is safe on empty input', () => {
    expect(aggregate([]).n).toBe(0);
  });
});

describe('comparisonVerdict', () => {
  it('refuses to call a winner when intervals overlap', () => {
    const a = aggregate([0.5, 0.6, 0.55]);
    const b = aggregate([0.52, 0.58, 0.54]);
    expect(comparisonVerdict(a, b)).toBe('inconclusive');
  });

  it('calls a winner when intervals are cleanly separated', () => {
    const a = aggregate([0.9, 0.92, 0.91, 0.93]);
    const b = aggregate([0.1, 0.12, 0.11, 0.13]);
    expect(comparisonVerdict(a, b)).toBe('a-better');
    expect(comparisonVerdict(b, a)).toBe('b-better');
  });

  it('is inconclusive when either side has no runs', () => {
    expect(comparisonVerdict(aggregate([]), aggregate([0.5]))).toBe('inconclusive');
  });

  it('never calls a winner from a single run per side', () => {
    // Two one-run "intervals" are points; before this guard 0.9 vs 0.7 was a-better.
    expect(comparisonVerdict(aggregate([0.9]), aggregate([0.7]))).toBe('inconclusive');
    expect(comparisonVerdict(aggregate([0.9]), aggregate([0.1, 0.12, 0.11]))).toBe('inconclusive');
  });
});

describe('paretoFrontier', () => {
  const score = (p: { s: number; c: number }) => p.s;
  const cost = (p: { s: number; c: number }) => p.c;

  it('drops strictly dominated points', () => {
    const cheapGood = { s: 0.8, c: 0.1 };
    const dominated = { s: 0.6, c: 0.3 };
    const expensiveBest = { s: 0.95, c: 0.9 };
    const frontier = paretoFrontier([cheapGood, dominated, expensiveBest], score, cost);
    expect(frontier).toContain(cheapGood);
    expect(frontier).toContain(expensiveBest);
    expect(frontier).not.toContain(dominated);
  });

  it('keeps everything when nothing dominates', () => {
    const points = [
      { s: 0.5, c: 0.1 },
      { s: 0.7, c: 0.3 },
      { s: 0.9, c: 0.8 },
    ];
    expect(paretoFrontier(points, score, cost)).toHaveLength(3);
  });

  it('handles a single point and an empty list', () => {
    expect(paretoFrontier([{ s: 1, c: 1 }], score, cost)).toHaveLength(1);
    expect(paretoFrontier([], score, cost)).toHaveLength(0);
  });
});

// Reference values were checked independently: Python's statistics.NormalDist
// and math.erfc for the normal; closed forms for t with 1 and 2 degrees of
// freedom; Simpson integration of the t density for the rest.
describe('normal distribution', () => {
  it('matches reference CDF values, far into the tails', () => {
    expect(normalCdf(1.96)).toBeCloseTo(0.9750021048517795, 14);
    expect(normalCdf(-1.96)).toBeCloseTo(0.024997895148220435, 14);
    expect(normalCdf(0.5)).toBeCloseTo(0.6914624612740131, 14);
    expect(normalCdf(0)).toBe(0.5);
    expect(normalCdf(-8) / 6.22096057427178e-16).toBeCloseTo(1, 10);
    expect(normalCdf(Number.POSITIVE_INFINITY)).toBe(1);
  });

  it('inverts the CDF to full precision', () => {
    expect(normalQuantile(0.975)).toBeCloseTo(1.959963984540054, 13);
    expect(normalQuantile(0.8)).toBeCloseTo(0.8416212335729143, 13);
    expect(normalQuantile(1e-10)).toBeCloseTo(-6.361340902404056, 12);
    for (const p of [1e-12, 0.001, 0.02425, 0.3, 0.5, 0.97575, 0.999999]) {
      expect(normalCdf(normalQuantile(p)) / p).toBeCloseTo(1, 12);
    }
    expect(normalQuantile(0)).toBe(Number.NEGATIVE_INFINITY);
    expect(Number.isNaN(normalQuantile(1.5))).toBe(true);
  });
});

describe('Student t distribution', () => {
  it('matches reference CDF values', () => {
    expect(studentTCdf(1, 1)).toBeCloseTo(0.75, 14);
    expect(studentTCdf(-2, 2)).toBeCloseTo(0.09175170953613698, 14);
    expect(studentTCdf(2.306004135204166, 8)).toBeCloseTo(0.975, 12);
    expect(studentTCdf(1.5, Number.POSITIVE_INFINITY)).toBeCloseTo(normalCdf(1.5), 14);
  });

  it('matches reference quantiles', () => {
    expect(studentTQuantile(0.975, 1)).toBeCloseTo(12.70620473617471, 10);
    expect(studentTQuantile(0.975, 8)).toBeCloseTo(2.306004135204166, 10);
    expect(studentTQuantile(0.95, 4)).toBeCloseTo(2.131846786326649, 10);
    expect(studentTQuantile(0.025, 59)).toBeCloseTo(-2.000995378, 8);
    expect(studentTQuantile(0.5, 3)).toBe(0);
  });

  it('computes log-gamma', () => {
    expect(logGamma(0.5)).toBeCloseTo(Math.log(Math.sqrt(Math.PI)), 13);
    expect(logGamma(10)).toBeCloseTo(Math.log(362_880), 12);
    expect(logGamma(1)).toBeCloseTo(0, 13);
  });
});

describe('wilsonInterval', () => {
  it('never collapses at the boundary', () => {
    // 18/18 is the published run set's debate-select; the percentile bootstrap said [1, 1].
    const all = wilsonInterval(18, 18);
    expect(all.low).toBeCloseTo(0.8241, 4);
    expect(all.high).toBe(1);
    const none = wilsonInterval(0, 10);
    expect(none.low).toBe(0);
    expect(none.high).toBeCloseTo(0.2775, 4);
  });

  it('matches the textbook interior case', () => {
    const half = wilsonInterval(5, 10);
    expect(half.low).toBeCloseTo(0.2366, 4);
    expect(half.high).toBeCloseTo(0.7634, 4);
  });

  it('accepts a fractional effective sample size', () => {
    const wide = wilsonInterval(4.5, 9);
    const narrow = wilsonInterval(9, 18);
    expect(wide.high - wide.low).toBeGreaterThan(narrow.high - narrow.low);
  });

  it('returns the uninformative interval for n = 0', () => {
    expect(wilsonInterval(0, 0)).toEqual({ low: 0, high: 1 });
  });
});

describe('holmAdjust', () => {
  it('multiplies the k-th smallest p by (m - k + 1) and keeps the result monotone', () => {
    // Sorted: 0.005·4 = 0.02, 0.01·3 = 0.03, 0.03·2 = 0.06, max(0.04·1, 0.06) = 0.06.
    expect(holmAdjust([0.01, 0.04, 0.03, 0.005])).toEqual([0.03, 0.06, 0.06, 0.02]);
  });

  it('caps at 1 and handles empty input', () => {
    expect(holmAdjust([0.6, 0.7])).toEqual([1, 1]);
    expect(holmAdjust([])).toEqual([]);
  });
});
