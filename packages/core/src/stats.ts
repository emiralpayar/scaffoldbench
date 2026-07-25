/**
 * Statistics for comparing strategies.
 *
 * A benchmark that reports a single mean per cell invites over-reading noise.
 * Every aggregate here carries a bootstrap confidence interval, and
 * `comparisonVerdict` refuses to call a winner when the intervals overlap.
 */

export interface Aggregate {
  n: number;
  mean: number;
  median: number;
  stdDev: number;
  min: number;
  max: number;
  /** Bootstrap confidence interval for the mean. */
  ciLow: number;
  ciHigh: number;
}

export function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  let total = 0;
  for (const v of values) total += v;
  return total / values.length;
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  if (sorted.length % 2 === 1) return sorted[mid] as number;
  return ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

export function stdDev(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  const variance = values.reduce((acc, v) => acc + (v - m) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

/**
 * Deterministic PRNG (mulberry32) so bootstrap intervals are reproducible.
 * A benchmark whose confidence intervals move between report runs is not a
 * benchmark anyone can cite.
 */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface BootstrapOptions {
  iterations?: number;
  confidence?: number;
  seed?: number;
}

/** Percentile bootstrap CI for the mean. */
export function bootstrapCI(
  values: readonly number[],
  options: BootstrapOptions = {},
): { low: number; high: number } {
  const { iterations = 2_000, confidence = 0.95, seed = 0xa11ce } = options;
  if (values.length === 0) return { low: 0, high: 0 };
  if (values.length === 1) {
    const only = values[0] as number;
    return { low: only, high: only };
  }

  const rng = makeRng(seed);
  const means: number[] = new Array(iterations);
  const n = values.length;

  for (let i = 0; i < iterations; i++) {
    let total = 0;
    for (let j = 0; j < n; j++) {
      total += values[Math.floor(rng() * n)] as number;
    }
    means[i] = total / n;
  }

  means.sort((a, b) => a - b);
  const alpha = (1 - confidence) / 2;
  const lowIdx = Math.max(0, Math.floor(alpha * iterations));
  const highIdx = Math.min(iterations - 1, Math.ceil((1 - alpha) * iterations) - 1);
  return { low: means[lowIdx] as number, high: means[highIdx] as number };
}

export function aggregate(values: readonly number[], options: BootstrapOptions = {}): Aggregate {
  if (values.length === 0) {
    return { n: 0, mean: 0, median: 0, stdDev: 0, min: 0, max: 0, ciLow: 0, ciHigh: 0 };
  }
  const ci = bootstrapCI(values, options);
  return {
    n: values.length,
    mean: mean(values),
    median: median(values),
    stdDev: stdDev(values),
    min: Math.min(...values),
    max: Math.max(...values),
    ciLow: ci.low,
    ciHigh: ci.high,
  };
}

export type Verdict = 'a-better' | 'b-better' | 'inconclusive';

/**
 * Compare two aggregates. Returns `inconclusive` whenever the confidence
 * intervals overlap — the honest answer with a handful of repeats.
 */
export function comparisonVerdict(a: Aggregate, b: Aggregate): Verdict {
  if (a.n === 0 || b.n === 0) return 'inconclusive';
  const overlap = a.ciLow <= b.ciHigh && b.ciLow <= a.ciHigh;
  if (overlap) return 'inconclusive';
  return a.mean > b.mean ? 'a-better' : 'b-better';
}

/** Points on the lower-cost/higher-score Pareto frontier. */
export function paretoFrontier<T>(
  items: readonly T[],
  getScore: (item: T) => number,
  getCost: (item: T) => number,
): T[] {
  return items.filter((candidate) => {
    const cScore = getScore(candidate);
    const cCost = getCost(candidate);
    return !items.some((other) => {
      if (other === candidate) return false;
      const oScore = getScore(other);
      const oCost = getCost(other);
      // `other` dominates when it is at least as good on both axes and
      // strictly better on one.
      const atLeastAsGood = oScore >= cScore && oCost <= cCost;
      const strictlyBetter = oScore > cScore || oCost < cCost;
      return atLeastAsGood && strictlyBetter;
    });
  });
}
