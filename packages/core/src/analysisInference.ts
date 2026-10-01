/**
 * Paired, task-clustered inference: the engine under `analyzeRunSet`.
 *
 * Every strategy runs the same (task, repeat) grid, so two arms are compared
 * on paired differences, and the task — not the run — is the unit that is
 * resampled, because tasks are what the benchmark generalizes over. The
 * formulas and the reasons behind each choice are in `docs/STATISTICS.md`;
 * the comments here say what each function computes.
 */

import {
  holmAdjust,
  makeRng,
  normalCdf,
  normalQuantile,
  studentTCdf,
  studentTQuantile,
  wilsonInterval,
} from './stats';
import type { Interval } from './stats';

export interface InferenceSettings {
  /** Bootstrap replicates (and Monte Carlo sign flips above the exact limit). */
  iterations: number;
  seed: number;
  /** Familywise error rate; intervals are reported at 1 − alpha. */
  alpha: number;
  /** Fewer tasks than this and no verdict is attempted. */
  minClusters: number;
}

export type ContrastVerdict = 'better' | 'worse' | 'equivalent' | 'inconclusive';

/**
 * What the data withheld from a contrast. `too-few-tasks`: fewer tasks than
 * the minimum, so no verdict. `no-variation`: every task moved by the same
 * amount, so there is no interval and no equivalence; a difference can
 * still be shown if that amount is not zero. `few-informative-tasks`: too
 * few tasks carry the spread of the difference to show equivalence
 * (`analyzeRunSet` drops it from a contrast that shows a difference).
 */
export type ContrastCaveat = 'too-few-tasks' | 'no-variation' | 'few-informative-tasks';

/** A point estimate with its interval and how the interval was obtained. */
export interface Estimate {
  value: number;
  /** Null when the data cannot support an interval (one task, or no variation off a boundary). */
  ci: Interval | null;
  ciMethod: 'bootstrap' | 'wilson' | 'none';
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

/**
 * Resampling draws depend only on (n, iterations, seed), and a run set runs
 * hundreds of paired tests over the same task count, so the draws are made
 * once and shared. Results are identical with or without the cache; it is
 * small and bounded so a long-lived process does not grow with it.
 */
const DRAW_CACHE_ENTRIES = 4;
const DRAW_CACHE_MAX_LENGTH = 2_000_000;
const drawCache = new Map<string, Int32Array | Int8Array>();

function cachedDraws<T extends Int32Array | Int8Array>(key: string, length: number, make: () => T): T {
  const hit = drawCache.get(key);
  if (hit) {
    drawCache.delete(key);
    drawCache.set(key, hit);
    return hit as T;
  }
  const fresh = make();
  if (length <= DRAW_CACHE_MAX_LENGTH) {
    drawCache.set(key, fresh);
    if (drawCache.size > DRAW_CACHE_ENTRIES) drawCache.delete(drawCache.keys().next().value as string);
  }
  return fresh;
}

/** `iterations` rows of `n` cluster indices drawn with replacement, row-major. */
function resampleIndices(n: number, iterations: number, seed: number): Int32Array {
  const length = n * iterations;
  return cachedDraws(`index:${n}:${iterations}:${seed}`, length, () => {
    const rng = makeRng(seed);
    const draws = new Int32Array(length);
    for (let k = 0; k < length; k++) draws[k] = Math.floor(rng() * n);
    return draws;
  });
}

/** `iterations` rows of `n` random signs, row-major. */
function randomSigns(n: number, iterations: number, seed: number): Int8Array {
  const length = n * iterations;
  return cachedDraws(`sign:${n}:${iterations}:${seed}`, length, () => {
    const rng = makeRng(seed ^ 0x5f1b);
    const signs = new Int8Array(length);
    for (let k = 0; k < length; k++) signs[k] = rng() < 0.5 ? -1 : 1;
    return signs;
  });
}

/**
 * Replicates of `statistic` over `n` clusters resampled with replacement,
 * sorted ascending.
 *
 * Only the top level is resampled: a task's repeats travel together. Also
 * resampling repeats within each task adds their variance a second time and
 * makes the interval too wide (see STATISTICS.md, "Why one-stage").
 */
export function clusterBootstrap(
  n: number,
  iterations: number,
  seed: number,
  statistic: (indices: Int32Array) => number,
): Float64Array {
  const draws = resampleIndices(n, iterations, seed);
  const replicates = new Float64Array(iterations);
  for (let b = 0; b < iterations; b++) replicates[b] = statistic(draws.subarray(b * n, (b + 1) * n));
  return replicates.sort();
}

/** Bootstrap replicates of the mean of `values`, sorted ascending. */
export function bootstrapMeans(
  values: readonly number[],
  iterations: number,
  seed: number,
): Float64Array {
  const n = values.length;
  const draws = resampleIndices(n, iterations, seed);
  const data = Float64Array.from(values);
  const replicates = new Float64Array(iterations);
  let k = 0;
  for (let b = 0; b < iterations; b++) {
    let total = 0;
    for (let i = 0; i < n; i++) total += data[draws[k++] as number] as number;
    replicates[b] = total / n;
  }
  return replicates.sort();
}

/**
 * The tail level α′ of Hesterberg's expanded percentile interval.
 *
 * A percentile interval is too narrow at small n: it uses the plug-in
 * standard deviation (divisor n) and normal rather than t quantiles. Taking
 * the percentiles at α′/2 and 1 − α′/2, where
 *   Φ⁻¹(1 − α′/2) = √(n / (n − 1)) · t_{n−1, 1 − α/2},
 * corrects both (Hesterberg, 2015). Here α is the two-sided level.
 */
export function expandedAlpha(alpha: number, n: number): number {
  if (n < 2) return Number.NaN;
  const t = studentTQuantile(1 - alpha / 2, n - 1);
  return 2 * normalCdf(-Math.sqrt(n / (n - 1)) * t);
}

/** Linear-interpolation quantile (type 7) of an ascending array. */
export function quantileSorted(sorted: Float64Array | readonly number[], p: number): number {
  const n = sorted.length;
  if (n === 0) return Number.NaN;
  const h = (n - 1) * Math.min(1, Math.max(0, p));
  const lo = Math.floor(h);
  const hi = Math.min(n - 1, lo + 1);
  const a = sorted[lo] as number;
  const b = sorted[hi] as number;
  // Avoid ∞ − ∞ when the upper tail is unbounded (cost per solved task).
  return h === lo || a === b ? a : a + (h - lo) * (b - a);
}

/** Two-sided expanded percentile interval at level `confidence` from sorted replicates. */
export function expandedPercentileInterval(
  sorted: Float64Array,
  clusters: number,
  confidence: number,
): Interval | null {
  if (clusters < 2 || sorted.length === 0) return null;
  const tail = expandedAlpha(1 - confidence, clusters) / 2;
  return { low: quantileSorted(sorted, tail), high: quantileSorted(sorted, 1 - tail) };
}

/** Fewer replicates than this beyond θ₀ and the empirical tail is too coarse to read. */
const MIN_TAIL_REPLICATES = 20;

/**
 * One-sided p-values from a bootstrap distribution by inverting the expanded
 * percentile interval, so that p ≤ α/2 exactly when the (1 − α) interval
 * excludes θ₀ on that side (up to Monte Carlo resolution).
 *
 * `greater` tests H₁: θ > θ₀; `less` tests H₁: θ < θ₀. Ties count half.
 *
 * Deep in a tail the replicate count says only "fewer than 1 in B", which
 * would floor every p-value near 1/B and make a large Holm family impossible
 * to reject. With fewer than `MIN_TAIL_REPLICATES` replicates beyond θ₀ the
 * tail area is read from a normal fit to the replicates instead; through the
 * expansion that is the one-sample t-test. With the default 10,000
 * replicates the 95% endpoints sit at least 24 replicates in from six tasks
 * up (the fewest at which the sign-flip guard allows a difference verdict),
 * and the 90% endpoints a TOST reads at least 85 in from five, so where a
 * verdict is possible the endpoints are read empirically and the interval
 * and the verdict agree.
 */
export function bootstrapPValues(
  sorted: Float64Array,
  theta0: number,
  clusters: number,
  tolerance: number,
): { greater: number; less: number } {
  const total = sorted.length;
  const below = lowerBound(sorted, theta0 - tolerance);
  const atOrBelow = lowerBound(sorted, theta0 + tolerance + Number.EPSILON);
  const ties = atOrBelow - below;
  const tailLe = below + ties / 2;
  const tailGe = total - atOrBelow + ties / 2;
  let qLe = (tailLe + 0.5) / (total + 1);
  let qGe = (tailGe + 0.5) / (total + 1);

  if (Math.min(tailLe, tailGe) < MIN_TAIL_REPLICATES) {
    let mean = 0;
    for (const x of sorted) mean += x;
    mean /= total;
    let ss = 0;
    for (const x of sorted) ss += (x - mean) ** 2;
    const sd = Math.sqrt(ss / Math.max(1, total - 1));
    if (sd > 0) {
      const z = (theta0 - mean) / sd;
      if (tailLe < MIN_TAIL_REPLICATES) qLe = normalCdf(z);
      if (tailGe < MIN_TAIL_REPLICATES) qGe = normalCdf(-z);
    }
  }

  const scale = Math.sqrt(clusters / (clusters - 1));
  const df = clusters - 1;
  return {
    greater: studentTCdf(normalQuantile(qLe) / scale, df),
    less: studentTCdf(normalQuantile(qGe) / scale, df),
  };
}

/** Index of the first element ≥ x (binary search). */
function lowerBound(sorted: Float64Array, x: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((sorted[mid] as number) < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// ---------------------------------------------------------------------------
// Sign-flip permutation test
// ---------------------------------------------------------------------------

/** Up to 2^16 sign vectors are enumerated exactly; beyond that they are sampled. */
const EXACT_SIGN_FLIP_LIMIT = 16;

export interface SignFlipPValues {
  /** H₀: mean = 0, two-sided. */
  twoSided: number;
  /** H₀: mean ≤ −margin against H₁: mean > −margin. */
  aboveLower: number;
  /** H₀: mean ≥ +margin against H₁: mean < +margin. */
  belowUpper: number;
}

/**
 * Sign-flip permutation tests over task-level differences (Fisher's
 * randomization test for paired data). Under H₀ each task's difference is as
 * likely to have either sign, so the observed sum is compared with the sums
 * of every sign assignment. Exact when the task count allows enumeration;
 * otherwise `iterations` random assignments with the +1 correction of
 * Phipson & Smyth (2010). The two shifted tests are the halves of a TOST.
 */
export function signFlipTest(
  values: readonly number[],
  margin: number,
  iterations: number,
  seed: number,
): SignFlipPValues {
  const n = values.length;
  let observed = 0;
  let scale = 0;
  for (const v of values) {
    observed += v;
    scale += Math.abs(v);
  }
  const tol = 1e-9 * (scale + Math.abs(margin) * n) + 1e-15;
  const obsTwo = Math.abs(observed);
  const obsLower = observed + margin * n;
  const obsUpper = observed - margin * n;

  let two = 0;
  let lower = 0;
  let upper = 0;
  // `sum` is Σ sᵢxᵢ and `signs` is Σ sᵢ, so the shifted statistics are
  // Σ sᵢ(xᵢ ± m) = sum ± m·signs.
  const tally = (sum: number, signs: number) => {
    if (Math.abs(sum) >= obsTwo - tol) two += 1;
    if (sum + margin * signs >= obsLower - tol) lower += 1;
    if (sum - margin * signs <= obsUpper + tol) upper += 1;
  };

  if (n <= EXACT_SIGN_FLIP_LIMIT) {
    // Gray-code walk: each step flips exactly one sign.
    const sign = new Int8Array(n).fill(1);
    let sum = observed;
    let signs = n;
    tally(sum, signs);
    const count = 2 ** n;
    for (let g = 1; g < count; g++) {
      const bit = 31 - Math.clz32(g & -g);
      const s = -(sign[bit] as number);
      sign[bit] = s;
      sum += 2 * s * (values[bit] as number);
      signs += 2 * s;
      tally(sum, signs);
    }
    return { twoSided: two / count, aboveLower: lower / count, belowUpper: upper / count };
  }

  const draws = randomSigns(n, iterations, seed);
  tally(observed, n);
  let k = 0;
  for (let b = 0; b < iterations; b++) {
    let sum = 0;
    let signs = 0;
    for (let i = 0; i < n; i++) {
      const s = draws[k++] as number;
      sum += s * (values[i] as number);
      signs += s;
    }
    tally(sum, signs);
  }
  const total = iterations + 1;
  return { twoSided: two / total, aboveLower: lower / total, belowUpper: upper / total };
}

// ---------------------------------------------------------------------------
// Paired test
// ---------------------------------------------------------------------------

export interface PairedTest {
  /** Number of tasks (clusters) with at least one complete pair. */
  tasks: number;
  /** Mean over tasks of the task-level difference. */
  estimate: number;
  /** Two-sided (1 − α) expanded percentile interval; null for one task or when every task moved alike. */
  ci: Interval | null;
  /** Two-sided p for H₀: no difference; the larger of bootstrap and sign-flip. Null when untestable. */
  pDifference: number | null;
  /** TOST p for H₀: |difference| ≥ margin; the largest of its guards. Null when untestable. */
  pEquivalence: number | null;
  caveat?: ContrastCaveat;
}

export interface PairedTestOptions {
  /**
   * The paired cell differences behind each task's difference, in the order
   * of `taskDiffs`. Used to count tasks where any repeat differed, and the
   * repeats per task for the binary floor. Without them a task counts as
   * differing when its mean difference is non-zero.
   */
  cellDiffs?: readonly (readonly number[])[];
  /**
   * The metric is pass/fail. A run-level difference of two pass/fail outcomes
   * lies in {−1, 0, 1}, so if the true mean difference were ±m its variance
   * would be at least m(1 − m), and Var(estimate) ≥ m(1 − m)·mean(1/rₜ)/T.
   * The equivalence test then also has to pass a t-test whose variance is
   * held at that floor — which stops a run set that happened to see almost no
   * failures from being read as proof that failures are rare.
   */
  binary?: boolean;
}

/**
 * Test the mean of task-level paired differences against zero and against
 * the equivalence margin ±`margin` (same scale as the differences).
 *
 * Each p-value is the larger of a bootstrap p (consistent with the reported
 * interval) and a sign-flip p. The sign-flip test of "no difference" is exact
 * under exchangeability; requiring it as well guards the bootstrap where it
 * is weakest — few tasks, most of them tied. Taking the larger of valid
 * p-values keeps the test valid; it only costs power.
 *
 * Equivalence also needs the spread of the difference to rest on at least
 * `minClusters` tasks. From a handful of lumpy differences the bootstrap
 * understates the spread and calls equivalence too readily, so two counts
 * must reach the minimum: the tasks on which the arms differed in some
 * repeat, and the effective number of tasks carrying the spread,
 * (Σ eₜ²)² / Σ eₜ⁴ with eₜ the deviation of task t's difference from the
 * mean (Kish's effective sample size, weighting each task by its squared
 * deviation). The second counts k large differences among many tiny ones as
 * about k, however many tiny ones there are. The difference test needs no
 * such rule: with k tasks that differ the sign-flip p is at least 2/2^k, so
 * it cannot reject below six of them at α = 0.05.
 */
export function pairedTest(
  taskDiffs: readonly number[],
  margin: number,
  settings: InferenceSettings,
  options: PairedTestOptions = {},
): PairedTest {
  const tasks = taskDiffs.length;
  const estimate = tasks === 0 ? Number.NaN : taskDiffs.reduce((a, d) => a + d, 0) / tasks;
  if (tasks < 2) {
    return { tasks, estimate, ci: null, pDifference: null, pEquivalence: null, caveat: 'too-few-tasks' };
  }

  const replicates = bootstrapMeans(taskDiffs, settings.iterations, settings.seed);
  const ci = expandedPercentileInterval(replicates, tasks, 1 - settings.alpha);
  const minClusters = Math.max(2, settings.minClusters);
  if (tasks < minClusters) {
    return { tasks, estimate, ci, pDifference: null, pEquivalence: null, caveat: 'too-few-tasks' };
  }

  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  let scale = 0;
  for (const d of taskDiffs) {
    lo = Math.min(lo, d);
    hi = Math.max(hi, d);
    scale = Math.max(scale, Math.abs(d));
  }
  const tolerance = 1e-9 * Math.max(scale, Math.abs(margin), 1e-12);
  if (hi - lo <= tolerance) {
    // Every task moved by the same amount (often: every task tied). The
    // bootstrap distribution is a point, which says nothing about spread, so
    // there is no interval and no equivalence. Whether that amount is zero is
    // still a fair question for the sign-flip test, which needs no spread:
    // with every task moving the same non-zero way, only the all-plus and
    // all-minus sign vectors reach the observed sum, so p = 2/2^T exactly.
    // The test stays in its family either way, so leaving it out cannot help
    // the others.
    const pDifference = Math.abs(estimate) > tolerance ? Math.min(1, 2 ** (1 - tasks)) : 1;
    return { tasks, estimate, ci: null, pDifference, pEquivalence: 1, caveat: 'no-variation' };
  }

  const cells = options.cellDiffs?.length === tasks ? options.cellDiffs : undefined;
  const differing = cells
    ? cells.filter((c) => c.some((d) => Math.abs(d) > tolerance)).length
    : taskDiffs.filter((d) => Math.abs(d) > tolerance).length;
  let ss = 0;
  let ss2 = 0;
  for (const d of taskDiffs) {
    const w = (d - estimate) ** 2;
    ss += w;
    ss2 += w * w;
  }
  const carrying = ss2 > 0 ? (ss * ss) / ss2 : 0;
  const informative = Math.min(differing, carrying);

  const flips = signFlipTest(taskDiffs, margin, settings.iterations, settings.seed);
  const atZero = bootstrapPValues(replicates, 0, tasks, tolerance);
  const pBootstrapDiff = Math.min(1, 2 * Math.min(atZero.greater, atZero.less));
  const pDifference = Math.max(pBootstrapDiff, flips.twoSided);
  if (informative < minClusters) {
    return { tasks, estimate, ci, pDifference, pEquivalence: 1, caveat: 'few-informative-tasks' };
  }

  const atLower = bootstrapPValues(replicates, -margin, tasks, tolerance);
  const atUpper = bootstrapPValues(replicates, margin, tasks, tolerance);
  let pAboveLower = Math.max(atLower.greater, flips.aboveLower);
  let pBelowUpper = Math.max(atUpper.less, flips.belowUpper);

  if (options.binary) {
    const repeats = cells ? cells.map((c) => c.length) : taskDiffs.map(() => 1);
    const meanInverseRepeats = repeats.reduce((acc, r) => acc + 1 / Math.max(1, r), 0) / tasks;
    const floor = (margin * (1 - margin) * meanInverseRepeats) / tasks;
    const se = Math.sqrt(Math.max(ss / (tasks - 1) / tasks, floor));
    pAboveLower = Math.max(pAboveLower, 1 - studentTCdf((estimate + margin) / se, tasks - 1));
    pBelowUpper = Math.max(pBelowUpper, studentTCdf((estimate - margin) / se, tasks - 1));
  }

  return { tasks, estimate, ci, pDifference, pEquivalence: Math.max(pAboveLower, pBelowUpper) };
}

/**
 * Four-way verdicts for one family of tests, Holm-adjusted (Holm, 1979).
 *
 * Conditional equivalence testing (Campbell & Gustafson, 2018): a contrast
 * whose difference test rejects is `better` or `worse`; one that does not, but
 * whose equivalence test rejects, is `equivalent`; anything else is
 * `inconclusive`. Each of the two tests is Holm-adjusted across the family.
 * Contrasts with too few tasks are left out of the family entirely — which
 * hypotheses are testable depends on how many tasks ran, not on the outcome.
 *
 * `higherIsBetter` orients the verdict: for cost and latency a negative
 * difference is `better`. Every test in a family shares one metric.
 */
export function resolveVerdicts(
  tests: readonly PairedTest[],
  alpha: number,
  higherIsBetter: boolean,
): { verdict: ContrastVerdict; pAdjusted: number | null; pEquivalenceAdjusted: number | null }[] {
  const testable = tests
    .map((test, index) => ({ test, index }))
    .filter(({ test }) => test.pDifference !== null && test.pEquivalence !== null);
  const diffAdjusted = holmAdjust(testable.map(({ test }) => test.pDifference as number));
  const equivAdjusted = holmAdjust(testable.map(({ test }) => test.pEquivalence as number));

  const out = tests.map(() => ({
    verdict: 'inconclusive' as ContrastVerdict,
    pAdjusted: null as number | null,
    pEquivalenceAdjusted: null as number | null,
  }));
  testable.forEach(({ test, index }, k) => {
    const pAdj = diffAdjusted[k] as number;
    const pEqAdj = equivAdjusted[k] as number;
    let verdict: ContrastVerdict = 'inconclusive';
    if (pAdj <= alpha) {
      verdict = test.estimate > 0 === higherIsBetter ? 'better' : 'worse';
    } else if (pEqAdj <= alpha) {
      verdict = 'equivalent';
    }
    out[index] = { verdict, pAdjusted: pAdj, pEquivalenceAdjusted: pEqAdj };
  });
  return out;
}

// ---------------------------------------------------------------------------
// Marginal estimates
// ---------------------------------------------------------------------------

/**
 * Mean over tasks of per-task values, with a cluster-bootstrap interval.
 *
 * `bounded` marks a metric that lives in [0, 1]. When every task has the same
 * value the bootstrap has nothing to resample. For a bounded metric sitting
 * at 0 or 1 a Wilson interval over the tasks stands in (a mean of [0, 1]
 * values is at least the share of tasks whose every run scored exactly 1,
 * which Wilson bounds); otherwise no interval is reported rather than a
 * zero-width one. Tasks, not runs, are the units: with every run alike the
 * data cannot say how correlated a task's runs are, and only the task count
 * is safe whatever that correlation is.
 */
export function clusterMeanEstimate(
  taskValues: readonly number[],
  settings: InferenceSettings,
  bounded = false,
): Estimate {
  const tasks = taskValues.length;
  const value = tasks === 0 ? Number.NaN : taskValues.reduce((a, v) => a + v, 0) / tasks;
  if (tasks === 0) return { value, ci: null, ciMethod: 'none' };

  const lo = Math.min(...taskValues);
  const hi = Math.max(...taskValues);
  if (hi - lo <= 1e-12 * Math.max(1, Math.abs(hi))) {
    if (bounded && (value <= 1e-12 || value >= 1 - 1e-12)) {
      const ci = wilsonInterval(value >= 0.5 ? tasks : 0, tasks, 1 - settings.alpha);
      return { value, ci, ciMethod: 'wilson' };
    }
    return { value, ci: null, ciMethod: 'none' };
  }
  if (tasks < 2) return { value, ci: null, ciMethod: 'none' };

  const replicates = bootstrapMeans(taskValues, settings.iterations, settings.seed);
  const ci = expandedPercentileInterval(replicates, tasks, 1 - settings.alpha);
  return { value, ci, ciMethod: ci ? 'bootstrap' : 'none' };
}
