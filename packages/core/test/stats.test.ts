import { describe, expect, it } from 'vitest';
import {
  aggregate,
  bootstrapCI,
  comparisonVerdict,
  makeRng,
  mean,
  median,
  paretoFrontier,
  stdDev,
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
