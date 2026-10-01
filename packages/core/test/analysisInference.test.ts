import { describe, expect, it } from 'vitest';
import {
  aggregate,
  bootstrapMeans,
  bootstrapPValues,
  clusterBootstrap,
  clusterMeanEstimate,
  comparisonVerdict,
  expandedAlpha,
  expandedPercentileInterval,
  normalQuantile,
  pairedTest,
  quantileSorted,
  resolveVerdicts,
  signFlipTest,
  studentTCdf,
} from '@arena/core';
import type { InferenceSettings, PairedTest } from '@arena/core';

const settings: InferenceSettings = { iterations: 4_000, seed: 0xa11ce, alpha: 0.05, minClusters: 5 };

// Golden values below were computed independently (Python: statistics.NormalDist,
// itertools enumeration of sign vectors, math.comb).

describe('expandedAlpha', () => {
  it('widens the percentile levels at small n (Hesterberg 2015)', () => {
    // z = sqrt(9/8) * t_{8, 0.975} = 2.44589; alpha' = 2 * Phi(-z).
    expect(expandedAlpha(0.05, 9)).toBeCloseTo(0.01444963836630797, 10);
  });

  it('approaches the nominal level as n grows', () => {
    expect(expandedAlpha(0.05, 10_000)).toBeCloseTo(0.05, 3);
    expect(expandedAlpha(0.05, 60)).toBeLessThan(0.05);
  });

  it('uses the extremes of the bootstrap distribution for two clusters', () => {
    expect(expandedAlpha(0.05, 2)).toBeLessThan(1e-12);
    expect(Number.isNaN(expandedAlpha(0.05, 1))).toBe(true);
  });
});

describe('quantileSorted', () => {
  it('interpolates linearly between order statistics', () => {
    expect(quantileSorted([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(quantileSorted([1, 2, 3, 4], 0.25)).toBe(1.75);
    expect(quantileSorted([1, 2, 3, 4], 0)).toBe(1);
    expect(quantileSorted([1, 2, 3, 4], 1)).toBe(4);
  });

  it('keeps an unbounded upper tail unbounded instead of producing NaN', () => {
    const inf = Number.POSITIVE_INFINITY;
    expect(quantileSorted([1, inf, inf], 0.9)).toBe(inf);
    expect(quantileSorted([1, 2, inf], 0.5)).toBe(2);
  });
});

describe('clusterBootstrap', () => {
  it('is reproducible for a seed and sorted ascending', () => {
    const a = bootstrapMeans([0.1, 0.5, 0.9, 0.3], 500, 7);
    const b = bootstrapMeans([0.1, 0.5, 0.9, 0.3], 500, 7);
    expect([...a]).toEqual([...b]);
    for (let i = 1; i < a.length; i++) expect(a[i] as number).toBeGreaterThanOrEqual(a[i - 1] as number);
  });

  it('resamples whole clusters, so the statistic sees only original indices', () => {
    const seen = new Set<number>();
    clusterBootstrap(3, 200, 1, (idx) => {
      for (const i of idx) seen.add(i);
      return 0;
    });
    expect([...seen].sort()).toEqual([0, 1, 2]);
  });
});

describe('expandedPercentileInterval', () => {
  it('is wider than the plain percentile interval at small n', () => {
    const values = [0.2, 0.5, 0.35, 0.6, 0.1, 0.45, 0.3, 0.55, 0.4];
    const sorted = bootstrapMeans(values, 4_000, 3);
    const expanded = expandedPercentileInterval(sorted, values.length, 0.95);
    const plain = { low: quantileSorted(sorted, 0.025), high: quantileSorted(sorted, 0.975) };
    expect(expanded).not.toBeNull();
    expect(expanded!.low).toBeLessThan(plain.low);
    expect(expanded!.high).toBeGreaterThan(plain.high);
  });

  it('returns null below two clusters', () => {
    expect(expandedPercentileInterval(new Float64Array([1, 1]), 1, 0.95)).toBeNull();
  });
});

describe('bootstrapPValues', () => {
  it('is about one half at the centre of the distribution', () => {
    const sorted = new Float64Array(Array.from({ length: 1_001 }, (_, i) => i / 1_000 - 0.5));
    const p = bootstrapPValues(sorted, 0, 50, 1e-12);
    expect(p.greater).toBeCloseTo(0.5, 2);
    expect(p.less).toBeCloseTo(0.5, 2);
  });

  it('agrees with the interval: p below alpha/2 exactly when the bound excludes the value', () => {
    const values = [0.08, 0.12, 0.05, 0.1, 0.15, 0.02, 0.09, 0.11, 0.07, 0.13];
    const sorted = bootstrapMeans(values, 20_000, 11);
    const ci = expandedPercentileInterval(sorted, values.length, 0.95)!;
    const justInside = bootstrapPValues(sorted, ci.low + 1e-3, values.length, 1e-12);
    const justOutside = bootstrapPValues(sorted, ci.low - 1e-3, values.length, 1e-12);
    expect(justInside.greater).toBeGreaterThan(0.025);
    expect(justOutside.greater).toBeLessThan(0.025);
  });

  it('resolves p-values below 1/B in a deep tail instead of flooring them', () => {
    // No replicate is anywhere near 0, so the empirical tail is empty; the
    // normal fit still orders "far" from "very far", which Holm needs.
    const values = Array.from({ length: 20 }, (_, i) => 0.1 + ((i % 5) - 2) * 0.01);
    const sorted = bootstrapMeans(values, 2_000, 9);
    const far = bootstrapPValues(sorted, 0.08, values.length, 1e-12).greater;
    const farther = bootstrapPValues(sorted, 0.07, values.length, 1e-12).greater;
    expect(far).toBeLessThan(1 / 2_000);
    expect(farther).toBeLessThan(far);
    expect(farther).toBeGreaterThan(0);
  });

  it('stays a number when the value is dozens of standard errors away', () => {
    // Replicates with mean 0 and SD 1; 38 SDs out the normal tail area is
    // subnormal. A NaN here used to reach Holm and void the whole family.
    const sorted = new Float64Array(Array.from({ length: 999 }, (_, i) => normalQuantile((i + 1) / 1_000)));
    for (const theta0 of [-38, 38, 1e6]) {
      const p = bootstrapPValues(sorted, theta0, 70, 1e-12);
      expect(Number.isNaN(p.greater) || Number.isNaN(p.less)).toBe(false);
      expect(Math.min(p.greater, p.less)).toBeLessThan(1e-20);
    }
  });

  it('reads the empirical tail where enough replicates lie beyond the value', () => {
    // Exactly 50 of 1,000 replicates at or below 0.05 -> q = (50 + 0.5) / 1001.
    const sorted = new Float64Array(Array.from({ length: 1_000 }, (_, i) => (i < 50 ? 0.04 : 0.2)));
    const p = bootstrapPValues(sorted, 0.05, 10, 1e-12).greater;
    const q = 50.5 / 1_001;
    expect(p).toBeCloseTo(studentTCdf(normalQuantile(q) / Math.sqrt(10 / 9), 9), 12);
  });
});

describe('signFlipTest', () => {
  it('enumerates every sign vector exactly for small n', () => {
    // 8 sign vectors; |sum| >= 6 for +++ and ---.
    expect(signFlipTest([1, 2, 3], 0, 1_000, 1)).toEqual({
      twoSided: 0.25,
      aboveLower: 0.125,
      belowUpper: 1,
    });
  });

  it('shifts by the margin for the two halves of a TOST', () => {
    expect(signFlipTest([0.1, -0.05, 0.2, 0.15, 0.3, 0.05], 0.1, 1_000, 1)).toEqual({
      twoSided: 0.09375,
      aboveLower: 0.015625,
      belowUpper: 0.75,
    });
    // All tasks tied: each one-sided shifted test can only reject with 1/2^5.
    expect(signFlipTest([0, 0, 0, 0, 0], 0.1, 1_000, 1)).toEqual({
      twoSided: 1,
      aboveLower: 0.03125,
      belowUpper: 0.03125,
    });
  });

  it('cannot reach p < 0.05 two-sided with five or fewer tasks', () => {
    expect(signFlipTest([1, 2, 3, 4, 5], 0, 1_000, 1).twoSided).toBe(2 / 32);
  });

  it('samples sign vectors above the exact limit, with the +1 correction', () => {
    const values = Array.from({ length: 30 }, (_, i) => 0.1 + (i % 3) * 0.01);
    const p = signFlipTest(values, 0, 2_000, 5);
    expect(p.twoSided).toBe(1 / 2_001);
  });
});

describe('pairedTest', () => {
  it('refuses a verdict below the minimum task count but still reports an interval', () => {
    const test = pairedTest([0.1, 0.2, 0.15], 0.05, settings);
    expect(test.caveat).toBe('too-few-tasks');
    expect(test.pDifference).toBeNull();
    expect(test.ci).not.toBeNull();
  });

  it('reports no interval for a single task', () => {
    const test = pairedTest([0.3], 0.05, settings);
    expect(test.ci).toBeNull();
    expect(test.estimate).toBeCloseTo(0.3);
  });

  it('refuses both a winner and equivalence when every task moved by the same amount', () => {
    for (const diffs of [Array(9).fill(0), Array(9).fill(0.1)]) {
      const test = pairedTest(diffs, 0.05, settings);
      expect(test.caveat).toBe('no-variation');
      expect(test.pDifference).toBe(1);
      expect(test.pEquivalence).toBe(1);
    }
  });

  it('detects a consistent paired effect that marginal intervals miss', () => {
    // Tasks of very different difficulty; A beats B by ~0.1 on each of them.
    const base = [0.1, 0.25, 0.4, 0.55, 0.7, 0.85, 0.2, 0.6, 0.35, 0.5, 0.15, 0.75];
    const jitter = [0.01, -0.01, 0.02, 0, -0.02, 0.01, 0, 0.015, -0.005, 0.005, -0.01, 0.02];
    const a = base.map((b, i) => b + 0.1 + (jitter[i] as number));
    const diffs = a.map((x, i) => x - (base[i] as number));

    expect(comparisonVerdict(aggregate(a), aggregate(base))).toBe('inconclusive');
    const test = pairedTest(diffs, 0.05, settings);
    expect(test.ci!.low).toBeGreaterThan(0.09);
    // Exact sign-flip: 2 of 2^12 sign vectors are as extreme.
    expect(test.pDifference).toBeCloseTo(2 / 4096, 12);
  });

  it('shows equivalence when the interval sits well inside the margin', () => {
    const diffs = [0.01, -0.01, 0.005, 0, -0.005, 0.01, -0.01, 0.005, 0, -0.005, 0.002, -0.002];
    const test = pairedTest(diffs, 0.05, settings);
    expect(test.pDifference).toBeGreaterThan(0.5);
    expect(test.pEquivalence).toBeLessThan(0.01);
  });

  it('needs enough tasks that differed at all before it calls equivalence', () => {
    // Nine tasks, one of which differed (the published run set's score
    // contrasts look like this). Its spread comes from one value.
    const cellDiffs = Array.from({ length: 9 }, (_, i) => (i === 0 ? [0.18, 0] : [0, 0]));
    const diffs = cellDiffs.map((c) => (c[0]! + c[1]!) / 2);
    const test = pairedTest(diffs, 0.05, settings, { cellDiffs });
    expect(test.caveat).toBe('few-informative-tasks');
    expect(test.pEquivalence).toBe(1);
    // A task whose repeats cancel out still counts as having differed.
    const cancelling = Array.from({ length: 6 }, () => [0.1, -0.1]);
    const counted = pairedTest([0, 0, 0, 0, 0, 0.01], 0.05, settings, { cellDiffs: [...cancelling.slice(0, 5), [0.02, 0]] });
    expect(counted.caveat).toBeUndefined();
  });

  it('holds a pass/fail equivalence test to the binary variance floor', () => {
    // 60 tasks x 3 repeats, five discordant runs. The bootstrap reads that as
    // equivalence within 5 points; but a true 5-point gap would give
    // SE >= sqrt(0.05 * 0.95 / 3 / 60) = 0.0162, and
    // (0.0278 - 0.05) / 0.0162 = -1.37 is not far enough below the margin.
    const cellDiffs = Array.from({ length: 60 }, (_, i) => (i < 5 ? [1, 0, 0] : [0, 0, 0]));
    const diffs = cellDiffs.map((c) => (c[0]! + c[1]! + c[2]!) / 3);
    const free = pairedTest(diffs, 0.05, settings, { cellDiffs });
    const floored = pairedTest(diffs, 0.05, settings, { cellDiffs, binary: true });
    expect(free.pEquivalence).toBeLessThan(0.05);
    expect(floored.pEquivalence).toBeGreaterThan(0.05);
    expect(floored.pEquivalence).toBeCloseTo(0.0883, 3);
    expect(floored.pDifference).toBe(free.pDifference);
  });

  it('lets a pass/fail equivalence through when the floor is cleared', () => {
    // 100 tasks x 3: a true 5-point gap would show about 15 discordant runs;
    // five is evidence of equivalence, floor or not.
    const cellDiffs = Array.from({ length: 100 }, (_, i) => (i < 5 ? [1, 0, 0] : [0, 0, 0]));
    const diffs = cellDiffs.map((c) => (c[0]! + c[1]! + c[2]!) / 3);
    const floored = pairedTest(diffs, 0.05, settings, { cellDiffs, binary: true });
    expect(floored.pEquivalence).toBeLessThan(0.05);
  });

  it('is deterministic for a seed', () => {
    const diffs = [0.1, -0.2, 0.05, 0.3, 0, 0.15, -0.05];
    expect(pairedTest(diffs, 0.05, settings)).toEqual(pairedTest(diffs, 0.05, settings));
  });
});

describe('resolveVerdicts', () => {
  const test = (estimate: number, pDifference: number | null, pEquivalence: number | null): PairedTest => ({
    tasks: 10,
    estimate,
    ci: null,
    pDifference,
    pEquivalence,
  });

  it('applies Holm to each test and picks difference first, then equivalence', () => {
    // Difference p 0.01, 0.04, 0.5 -> Holm 0.03, 0.08, 0.5.
    // Equivalence p 0.9, 0.9, 0.01 -> Holm 1, 1, 0.03.
    const out = resolveVerdicts([test(0.2, 0.01, 0.9), test(0.1, 0.04, 0.9), test(0.01, 0.5, 0.01)], 0.05, true);
    expect(out.map((o) => o.verdict)).toEqual(['better', 'inconclusive', 'equivalent']);
    expect(out[0]?.pAdjusted).toBeCloseTo(0.03, 12);
    expect(out[1]?.pAdjusted).toBeCloseTo(0.08, 12);
    expect(out[2]?.pEquivalenceAdjusted).toBeCloseTo(0.03, 12);
  });

  it('orients by the metric: a positive cost difference is worse', () => {
    const out = resolveVerdicts([test(0.4, 0.001, 0.9), test(-0.4, 0.001, 0.9)], 0.05, false);
    expect(out.map((o) => o.verdict)).toEqual(['worse', 'better']);
  });

  it('leaves untestable contrasts out of the family size', () => {
    // Alone, 0.03 rejects; an untestable neighbour must not double it.
    const out = resolveVerdicts([test(0.2, 0.03, 0.9), test(0.2, null, null)], 0.05, true);
    expect(out[0]?.verdict).toBe('better');
    expect(out[0]?.pAdjusted).toBeCloseTo(0.03, 12);
    expect(out[1]).toEqual({ verdict: 'inconclusive', pAdjusted: null, pEquivalenceAdjusted: null });
  });
});

describe('clusterMeanEstimate', () => {
  it('bootstraps the mean of task values', () => {
    const est = clusterMeanEstimate([0.2, 0.4, 0.6, 0.8, 0.5], settings);
    expect(est.value).toBeCloseTo(0.5);
    expect(est.ciMethod).toBe('bootstrap');
    expect(est.ci!.low).toBeLessThan(0.5);
    expect(est.ci!.high).toBeGreaterThan(0.5);
  });

  it('falls back to Wilson over the tasks for a bounded metric stuck at 1 or 0', () => {
    // Nine tasks: Wilson(9, 9), however many runs each task had.
    const top = clusterMeanEstimate([1, 1, 1, 1, 1, 1, 1, 1, 1], settings, true);
    expect(top.ciMethod).toBe('wilson');
    expect(top.ci!.low).toBeCloseTo(0.7009, 4);
    expect(top.ci!.high).toBe(1);
    const bottom = clusterMeanEstimate([0, 0, 0], settings, true);
    expect(bottom.ci!.low).toBe(0);
    expect(bottom.ci!.high).toBeCloseTo(0.5615, 4);
  });

  it('reports no interval rather than a zero-width one', () => {
    expect(clusterMeanEstimate([0.82, 0.82, 0.82], settings, true)).toEqual({
      value: 0.82,
      ci: null,
      ciMethod: 'none',
    });
    expect(clusterMeanEstimate([0.05, 0.05], settings).ci).toBeNull();
    expect(clusterMeanEstimate([0.4], settings).ci).toBeNull();
  });
});
