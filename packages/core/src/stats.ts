/**
 * Statistical primitives.
 *
 * A benchmark that reports a single mean per cell invites over-reading noise.
 * This module holds the dependency-free building blocks: descriptive
 * statistics, a seeded PRNG, the normal and Student t distributions, Wilson
 * intervals and Holm's step-down adjustment. The inference that the
 * leaderboard actually relies on — paired, task-clustered contrasts — lives in
 * `analysis.ts` and is documented in `docs/STATISTICS.md`.
 *
 * `bootstrapCI`, `aggregate` and `comparisonVerdict` predate that analysis.
 * They treat runs as independent and compare marginal intervals, which the
 * benchmark's design does not justify; they are kept for descriptive display
 * and for callers that have not moved to `analyzeRunSet` yet.
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

/** A two-sided confidence interval. */
export interface Interval {
  low: number;
  high: number;
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

/** Sample variance (n − 1 divisor); 0 below two values. */
export function variance(values: readonly number[]): number {
  return stdDev(values) ** 2;
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

/**
 * Percentile bootstrap CI for the mean of independent values.
 *
 * Descriptive only: it treats every value as an independent draw, and for a
 * single value (or a constant sample) it returns a zero-width interval that
 * says nothing about uncertainty. `analyzeRunSet` replaces it for inference.
 */
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
 * Compare two aggregates by whether their marginal intervals overlap.
 *
 * Returns `inconclusive` when either side has fewer than two runs (one run
 * has no spread to measure) or when the intervals overlap.
 *
 * @deprecated The overlap rule is unpaired, so between-task variance drowns
 * real effects, and next to a zero-width interval at the ceiling it is
 * anti-conservative. Use the paired contrasts from `analyzeRunSet`.
 */
export function comparisonVerdict(a: Aggregate, b: Aggregate): Verdict {
  if (a.n < 2 || b.n < 2) return 'inconclusive';
  const overlap = a.ciLow <= b.ciHigh && b.ciLow <= a.ciHigh;
  if (overlap) return 'inconclusive';
  return a.mean > b.mean ? 'a-better' : 'b-better';
}

/** Points on the lower-cost/higher-score Pareto frontier, on point estimates alone. */
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

// ---------------------------------------------------------------------------
// Distributions
//
// Implemented here rather than pulled from a package: the site and the CLI
// both import @arena/core, and a few special functions are not worth a
// dependency. Accuracy is ~1e-14 relative in the range the analysis uses,
// which the tests pin against published values; only the normal quantile
// beyond about 37.5 standard deviations falls back to ~1e-9.
// ---------------------------------------------------------------------------

const EPS = 1e-15;
const TINY = 1e-300;
const MAX_ITER = 500;

const LANCZOS = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
  -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
  1.5056327351493116e-7,
];

/** ln Γ(x) for x > 0 (Lanczos approximation, g = 7). */
export function logGamma(x: number): number {
  if (x < 0.5) {
    // Reflection keeps the approximation in its accurate range.
    return Math.log(Math.PI / Math.abs(Math.sin(Math.PI * x))) - logGamma(1 - x);
  }
  const z = x - 1;
  let sum = LANCZOS[0] as number;
  for (let i = 1; i < LANCZOS.length; i++) sum += (LANCZOS[i] as number) / (z + i);
  const t = z + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(sum);
}

/** Upper regularized incomplete gamma Q(a, x) = Γ(a, x) / Γ(a). */
function upperRegularizedGamma(a: number, x: number): number {
  if (x <= 0) return 1;
  const prefix = Math.exp(-x + a * Math.log(x) - logGamma(a));
  if (x < a + 1) {
    // Series for the lower function P, then Q = 1 − P.
    let term = 1 / a;
    let sum = term;
    for (let n = 1; n < MAX_ITER; n++) {
      term *= x / (a + n);
      sum += term;
      if (Math.abs(term) < Math.abs(sum) * EPS) break;
    }
    return 1 - sum * prefix;
  }
  // Continued fraction for Q (modified Lentz).
  let b = x + 1 - a;
  let c = 1 / TINY;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i < MAX_ITER; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < TINY) d = TINY;
    c = b + an / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < EPS) break;
  }
  return prefix * h;
}

/** Standard normal CDF Φ(z), accurate far into both tails. */
export function normalCdf(z: number): number {
  if (Number.isNaN(z)) return Number.NaN;
  if (z === Number.POSITIVE_INFINITY) return 1;
  if (z === Number.NEGATIVE_INFINITY) return 0;
  // Φ(z) = ½·erfc(−z/√2) and erfc(u) = Q(½, u²) for u ≥ 0.
  const tail = 0.5 * upperRegularizedGamma(0.5, (z * z) / 2);
  return z < 0 ? tail : 1 - tail;
}

/** Inverse of `normalCdf`. Acklam's rational approximation, then two Halley steps. */
export function normalQuantile(p: number): number {
  if (Number.isNaN(p) || p < 0 || p > 1) return Number.NaN;
  if (p === 0) return Number.NEGATIVE_INFINITY;
  if (p === 1) return Number.POSITIVE_INFINITY;

  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const at = (xs: number[], i: number) => xs[i] as number;

  const pLow = 0.02425;
  let x: number;
  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p));
    x =
      (((((at(c, 0) * q + at(c, 1)) * q + at(c, 2)) * q + at(c, 3)) * q + at(c, 4)) * q + at(c, 5)) /
      ((((at(d, 0) * q + at(d, 1)) * q + at(d, 2)) * q + at(d, 3)) * q + 1);
  } else if (p <= 1 - pLow) {
    const q = p - 0.5;
    const r = q * q;
    x =
      ((((((at(a, 0) * r + at(a, 1)) * r + at(a, 2)) * r + at(a, 3)) * r + at(a, 4)) * r + at(a, 5)) * q) /
      (((((at(b, 0) * r + at(b, 1)) * r + at(b, 2)) * r + at(b, 3)) * r + at(b, 4)) * r + 1);
  } else {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    x =
      -(((((at(c, 0) * q + at(c, 1)) * q + at(c, 2)) * q + at(c, 3)) * q + at(c, 4)) * q + at(c, 5)) /
      ((((at(d, 0) * q + at(d, 1)) * q + at(d, 2)) * q + at(d, 3)) * q + 1);
  }

  // Halley refinement against the accurate CDF takes ~1e-9 to full precision.
  // Beyond about 37.5 standard deviations exp(x²/2) overflows (and the CDF
  // itself is subnormal), so the step is skipped there rather than turning
  // the answer into NaN; Acklam's ~1e-9 relative error is what remains.
  for (let i = 0; i < 2; i++) {
    const e = normalCdf(x) - p;
    const u = e * Math.sqrt(2 * Math.PI) * Math.exp((x * x) / 2);
    if (!Number.isFinite(u)) break;
    x -= u / (1 + (x * u) / 2);
  }
  return x;
}

/** Regularized incomplete beta I_x(a, b). */
function regularizedBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const front = Math.exp(
    logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x),
  );
  // The continued fraction converges fast only on one side of the mean.
  if (x < (a + 1) / (a + b + 2)) return (front * betaContinuedFraction(x, a, b)) / a;
  return 1 - (front * betaContinuedFraction(1 - x, b, a)) / b;
}

function betaContinuedFraction(x: number, a: number, b: number): number {
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < TINY) d = TINY;
  d = 1 / d;
  let h = d;
  for (let m = 1; m < MAX_ITER; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < EPS) break;
  }
  return h;
}

/** CDF of Student's t with `df` degrees of freedom (`Infinity` gives the normal). */
export function studentTCdf(t: number, df: number): number {
  if (Number.isNaN(t) || !(df > 0)) return Number.NaN;
  if (df === Number.POSITIVE_INFINITY) return normalCdf(t);
  if (t === Number.POSITIVE_INFINITY) return 1;
  if (t === Number.NEGATIVE_INFINITY) return 0;
  const tail = 0.5 * regularizedBeta(df / (df + t * t), df / 2, 0.5);
  return t > 0 ? 1 - tail : tail;
}

/** Inverse of `studentTCdf`, by bracketing and bisection on the CDF. */
export function studentTQuantile(p: number, df: number): number {
  if (Number.isNaN(p) || p < 0 || p > 1 || !(df > 0)) return Number.NaN;
  if (df === Number.POSITIVE_INFINITY) return normalQuantile(p);
  if (p === 0) return Number.NEGATIVE_INFINITY;
  if (p === 1) return Number.POSITIVE_INFINITY;
  if (p === 0.5) return 0;

  // The t quantile is always further out than the normal one; widen until bracketed.
  const z = normalQuantile(p);
  let lo = z < 0 ? z * 2 - 1 : z;
  let hi = z < 0 ? z : z * 2 + 1;
  while (studentTCdf(lo, df) > p) lo *= 2;
  while (studentTCdf(hi, df) < p) hi *= 2;
  for (let i = 0; i < 200 && hi - lo > 1e-13 * Math.max(1, Math.abs(lo)); i++) {
    const mid = (lo + hi) / 2;
    if (studentTCdf(mid, df) < p) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

// ---------------------------------------------------------------------------
// Proportions and multiplicity
// ---------------------------------------------------------------------------

/**
 * Wilson score interval for a proportion (Wilson, 1927).
 *
 * Never zero-width for n > 0: 18 passes out of 18 gives [0.824, 1], not the
 * [1, 1] a percentile bootstrap reports. `n` may be fractional, which is how
 * an effective sample size for clustered data is passed in.
 */
export function wilsonInterval(successes: number, n: number, confidence = 0.95): Interval {
  if (!(n > 0)) return { low: 0, high: 1 };
  const z = normalQuantile(1 - (1 - confidence) / 2);
  const p = Math.min(1, Math.max(0, successes / n));
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  // At p = 0 or 1 the bound is exactly 0 or 1; rounding would leave 1e-17.
  return {
    low: p === 0 ? 0 : Math.max(0, center - half),
    high: p === 1 ? 1 : Math.min(1, center + half),
  };
}

/**
 * Holm's step-down adjustment (Holm, 1979). Returns adjusted p-values in the
 * input order; rejecting every hypothesis whose adjusted p is ≤ α controls
 * the familywise error rate at α under any dependence between the tests.
 */
export function holmAdjust(pValues: readonly number[]): number[] {
  const m = pValues.length;
  const order = pValues.map((p, i) => ({ p, i })).sort((x, y) => x.p - y.p || x.i - y.i);
  const adjusted = new Array<number>(m);
  let running = 0;
  order.forEach(({ p, i }, rank) => {
    running = Math.max(running, Math.min(1, (m - rank) * p));
    adjusted[i] = running;
  });
  return adjusted;
}
