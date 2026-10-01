/**
 * `analyzeRunSet`: the benchmark's inference in one call.
 *
 * For every model in a run set it summarizes each strategy (means with
 * task-clustered intervals, pass rate with a Wilson interval, pass^k, cost
 * per solved task, integrity), compares strategies on paired per-cell
 * differences with a four-way verdict, draws a Pareto frontier that respects
 * uncertainty, and — when the run set spans models — asks the "Scaffold or
 * Scale?" question: does an architecture on a cheaper model match the single
 * agent one model up? Runs that failed an integrity check or hit an
 * infrastructure error are reported under `health` and never ranked.
 *
 * `docs/STATISTICS.md` gives the formulas and the reasons behind them.
 */

import {
  armKey,
  buildGrid,
  cellAccounting,
  higherIsBetter,
  interactionDiffs,
  metricScale,
  pairedDiffs,
  taskMeans,
} from './analysisData';
import type {
  AnalysisMetric,
  ArmCells,
  ArmRef,
  HealthReport,
  ModelGrid,
  PairedDiffs,
} from './analysisData';
import {
  clusterBootstrap,
  clusterMeanEstimate,
  expandedPercentileInterval,
  pairedTest,
  resolveVerdicts,
} from './analysisInference';
import type {
  ContrastCaveat,
  ContrastVerdict,
  Estimate,
  InferenceSettings,
  PairedTest,
} from './analysisInference';
import { uncertainFrontier } from './analysisPareto';
import type { FrontierStatus } from './analysisPareto';
import { variance, wilsonInterval } from './stats';
import type { Interval } from './stats';
import type { FailureMode, RunRecord } from './types';

export type { AnalysisMetric, ArmRef, ExcludedRun, ExclusionReason, HealthReport } from './analysisData';
export type { ContrastCaveat, ContrastVerdict, Estimate } from './analysisInference';
export type { FrontierStatus } from './analysisPareto';

export const ANALYSIS_METRICS: readonly AnalysisMetric[] = ['score', 'pass', 'cost', 'latency'];

/**
 * Differences smaller than these are "equivalent". Score and pass are
 * absolute (0.05 = 5 points); cost and latency are ratios (1.1 = within
 * ×/÷ 1.1). Pre-register them: a margin chosen after seeing the data is not
 * a margin.
 */
export interface EquivalenceMargins {
  score: number;
  pass: number;
  cost: number;
  latency: number;
}

export const DEFAULT_MARGINS: Readonly<EquivalenceMargins> = {
  score: 0.05,
  pass: 0.05,
  cost: 1.1,
  latency: 1.1,
};

export interface AnalysisOptions {
  /** Strategy every other one is compared against. Default `single`. */
  baseline?: string;
  /** Models from cheapest to most capable; unlisted models follow by price tier. */
  modelOrder?: readonly string[];
  margins?: Partial<EquivalenceMargins>;
  /** Familywise error rate per Holm family; intervals are 1 − alpha. Default 0.05. */
  alpha?: number;
  /** Bootstrap replicates. Default 10,000. */
  iterations?: number;
  seed?: number;
  /** Fewest tasks a contrast needs before any verdict. Default 5, never below 2. */
  minTasks?: number;
  /** Quality axis of the Pareto frontier and of the strategy ordering. Default `score`. */
  quality?: 'score' | 'pass';
  /** Failure modes that say nothing about the architecture. Default `['api_error']`. */
  excludeFailureModes?: readonly FailureMode[];
  /** Model pairs for the architecture × model interaction. Default: cheapest vs most capable. */
  interactionModels?: readonly (readonly [string, string])[];
}

/** The options after defaults, echoed in the result so a report can cite them. */
export interface AnalysisSettings {
  baseline: string;
  modelOrder: string[];
  margins: EquivalenceMargins;
  alpha: number;
  iterations: number;
  seed: number;
  minTasks: number;
  quality: 'score' | 'pass';
  excludeFailureModes: FailureMode[];
  interactionModels: [string, string][];
}

export interface PassRateEstimate extends Estimate {
  passed: number;
  runs: number;
  /** Runs after the design effect of clustering by task; the Wilson interval uses this n. */
  effectiveRuns: number;
}

/** pass^k: the chance that k independent attempts at a task all pass (τ-bench). */
export interface PassHatK extends Estimate {
  k: number;
  /** Tasks with at least k healthy repeats. */
  tasks: number;
}

export interface CostPerSolved {
  /** Mean cost per run divided by pass rate; null when nothing passed. */
  value: number | null;
  /** `high` is null when too many resamples solved nothing for the bound to be finite. */
  ci: { low: number; high: number | null } | null;
}

export interface StrategyAnalysis {
  model: string;
  strategyId: string;
  /** Healthy runs, one per cell. */
  runs: number;
  tasks: number;
  cells: { expected: number; included: number; excluded: number; missing: number };
  score: Estimate;
  passRate: PassRateEstimate;
  passHatK: PassHatK[];
  costUsd: Estimate;
  latencyMs: Estimate;
  costPerSolvedUsd: CostPerSolved;
  /** Over every run of the arm, healthy or not; `rate` is null when none recorded integrity. */
  integrity: { checked: number; ok: number; rate: number | null };
  failureModes: Record<string, number>;
}

/**
 * Holm families. Each (family, metric) pair is one family across every model
 * in the run set: `baseline` is the pre-registerable primary family,
 * `pairwise` and `frontier` are exploratory.
 */
export type ContrastFamily = 'baseline' | 'pairwise' | 'scale' | 'interaction' | 'frontier';

export interface PairedResult {
  family: ContrastFamily;
  metric: AnalysisMetric;
  /** `difference` for score and pass; `ratio` (geometric mean, a over b) for cost and latency. */
  scale: 'difference' | 'ratio';
  estimate: number;
  /** Two-sided 1 − alpha interval on the same scale as `estimate`. */
  ci: Interval | null;
  /** Equivalence margin on the same scale: ±margin, or ×/÷margin for ratios. */
  margin: number;
  tasks: number;
  /** Complete (task, repeat) pairs behind the estimate. */
  cells: number;
  /** Two-sided p for "no difference", unadjusted. */
  pValue: number | null;
  /** Holm-adjusted within the family; the verdict uses this. */
  pAdjusted: number | null;
  /** TOST p for "the difference is at least the margin", unadjusted. */
  pEquivalence: number | null;
  pEquivalenceAdjusted: number | null;
  /**
   * `better`: a beats b (higher score or pass, lower cost or latency).
   * `equivalent`: no difference shown, and the equivalence test (TOST) rules out one as
   * large as the margin. Unadjusted, that is the 1 − 2·alpha interval inside the margin; `ci`
   * is the 1 − alpha one and may reach slightly past it.
   */
  verdict: ContrastVerdict;
  caveat?: ContrastCaveat;
}

export interface Contrast extends PairedResult {
  a: ArmRef;
  b: ArmRef;
}

/**
 * Architecture × model interaction: the strategy's gain over the baseline on
 * `models[0]` minus its gain on `models[1]`. `better` means it gains more on
 * `models[0]` (usually the cheaper model).
 */
export interface InteractionContrast extends PairedResult {
  strategyId: string;
  baseline: string;
  models: [string, string];
}

export interface FrontierEntry {
  arm: ArmRef;
  quality: number;
  costUsd: number;
  status: FrontierStatus;
  dominatedBy: ArmRef[];
}

export interface ModelAnalysis {
  model: string;
  tasks: number;
  /** Most repeats any task has. */
  repeats: number;
  /** Ordered by quality, then cost — an order, not a ranking: read the contrasts. */
  strategies: StrategyAnalysis[];
  vsBaseline: Contrast[];
  pairwise: Contrast[];
  frontier: FrontierEntry[];
}

export interface RunSetAnalysis {
  settings: AnalysisSettings;
  /** Cheapest model first. */
  models: ModelAnalysis[];
  /** Every strategy on each model against the baseline on the next model up. */
  scaffoldOrScale: Contrast[];
  interactions: InteractionContrast[];
  /** Frontier over every (model, strategy) arm. */
  frontier: FrontierEntry[];
  frontierContrasts: Contrast[];
  health: HealthReport;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** Price tiers, cheapest first. Ids are matched by family name. */
const MODEL_TIERS: readonly RegExp[] = [/haiku/i, /sonnet/i, /opus/i, /fable/i];

/**
 * Order models from cheapest to most capable: `preferred` first (those present),
 * then by price tier (Haiku, Sonnet, Opus, Fable), then by id.
 */
export function orderModels(models: readonly string[], preferred: readonly string[] = []): string[] {
  const tier = (m: string) => {
    const index = MODEL_TIERS.findIndex((re) => re.test(m));
    return index === -1 ? MODEL_TIERS.length : index;
  };
  const explicit = preferred.filter((m, i) => models.includes(m) && preferred.indexOf(m) === i);
  const rest = models
    .filter((m) => !explicit.includes(m))
    .sort((a, b) => tier(a) - tier(b) || a.localeCompare(b));
  return [...explicit, ...rest];
}

function resolveSettings(options: AnalysisOptions, models: readonly string[]): AnalysisSettings {
  const modelOrder = orderModels(models, options.modelOrder);
  const first = modelOrder[0];
  const last = modelOrder[modelOrder.length - 1];
  const interactionModels: [string, string][] = options.interactionModels
    ? options.interactionModels.map(([x, y]) => [x, y])
    : first !== undefined && last !== undefined && first !== last
      ? [[first, last]]
      : [];
  return {
    baseline: options.baseline ?? 'single',
    modelOrder,
    margins: { ...DEFAULT_MARGINS, ...options.margins },
    alpha: options.alpha ?? 0.05,
    iterations: options.iterations ?? 10_000,
    seed: options.seed ?? 0xa11ce,
    minTasks: Math.max(2, options.minTasks ?? 5),
    quality: options.quality ?? 'score',
    excludeFailureModes: [...(options.excludeFailureModes ?? ['api_error'])],
    interactionModels,
  };
}

// ---------------------------------------------------------------------------
// Strategy summaries
// ---------------------------------------------------------------------------

interface ArmTasks {
  /** Per task, in task-id order: passes, healthy runs and their ratio. */
  passes: number[];
  runs: number[];
  rates: number[];
}

function armTasks(arm: ArmCells): ArmTasks {
  const passes: number[] = [];
  const runs: number[] = [];
  for (const taskId of [...arm.cells.keys()].sort()) {
    const byRepeat = arm.cells.get(taskId) as Map<number, RunRecord>;
    let passed = 0;
    for (const record of byRepeat.values()) if (record.passed) passed += 1;
    passes.push(passed);
    runs.push(byRepeat.size);
  }
  return { passes, runs, rates: passes.map((p, i) => p / (runs[i] as number)) };
}

/**
 * Pass rate (mean over tasks of each task's pass rate) with a Wilson interval
 * on an effective sample size: n_eff = p(1 − p) / Var̂(p̂), the binomial
 * variance over the task-clustered one, kept within [tasks, runs]. At 0% or
 * 100% the clustered variance is not estimable, and n_eff is the task count:
 * the one value that is safe however strongly a task's runs agree. Counting
 * runs there undercovers when outcomes are mostly decided by the task.
 */
function passRateEstimate(t: ArmTasks, alpha: number): PassRateEstimate {
  const { rates } = t;
  const tasks = rates.length;
  const value = rates.reduce((a, r) => a + r, 0) / tasks;
  const passed = t.passes.reduce((a, p) => a + p, 0);
  const runs = t.runs.reduce((a, r) => a + r, 0);
  const clustered = tasks >= 2 ? variance(rates) / tasks : 0;
  let effectiveRuns = runs;
  if (value <= 0 || value >= 1) {
    effectiveRuns = tasks;
  } else if (clustered > 0) {
    effectiveRuns = Math.min(runs, Math.max(tasks, (value * (1 - value)) / clustered));
  }
  return {
    value,
    ci: wilsonInterval(value * effectiveRuns, effectiveRuns, 1 - alpha),
    ciMethod: 'wilson',
    passed,
    runs,
    effectiveRuns,
  };
}

/** Unbiased per-task pass^k: C(c, k) / C(n, k) for c passes in n attempts. */
function passHatKOfTask(passes: number, runs: number, k: number): number {
  let value = 1;
  for (let i = 0; i < k; i++) value *= (passes - i) / (runs - i);
  return Math.max(0, value);
}

function costPerSolved(costs: readonly number[], passRates: readonly number[], inf: InferenceSettings): CostPerSolved {
  const tasks = costs.length;
  const sum = (xs: readonly number[]) => xs.reduce((a, x) => a + x, 0);
  const meanPass = sum(passRates) / tasks;
  if (!(meanPass > 0)) return { value: null, ci: null };
  const value = sum(costs) / tasks / meanPass;
  if (tasks < 2) return { value, ci: null };
  const replicates = clusterBootstrap(tasks, inf.iterations, inf.seed, (idx) => {
    let c = 0;
    let p = 0;
    for (let i = 0; i < tasks; i++) {
      c += costs[idx[i] as number] as number;
      p += passRates[idx[i] as number] as number;
    }
    return p > 0 ? c / p : Number.POSITIVE_INFINITY;
  });
  const ci = expandedPercentileInterval(replicates, tasks, 1 - inf.alpha);
  if (!ci) return { value, ci: null };
  return { value, ci: { low: ci.low, high: Number.isFinite(ci.high) ? ci.high : null } };
}

function summarizeArm(grid: ModelGrid, arm: ArmCells, inf: InferenceSettings): StrategyAnalysis {
  const t = armTasks(arm);
  const tasks = t.runs.length;
  const runs = t.runs.reduce((a, r) => a + r, 0);
  const costs = taskMeans(arm, 'cost');

  const maxRepeats = Math.max(...t.runs);
  const passHatK: PassHatK[] = [];
  for (let k = 1; k <= maxRepeats; k++) {
    const values: number[] = [];
    t.runs.forEach((n, i) => {
      if (n >= k) values.push(passHatKOfTask(t.passes[i] as number, n, k));
    });
    passHatK.push({ k, tasks: values.length, ...clusterMeanEstimate(values, inf, true) });
  }

  const failureModes: Record<string, number> = {};
  for (const byRepeat of arm.cells.values()) {
    for (const record of byRepeat.values()) {
      failureModes[record.failureMode] = (failureModes[record.failureMode] ?? 0) + 1;
    }
  }
  const checked = arm.all.filter((r) => r.integrity !== undefined);
  const ok = checked.filter((r) => r.integrity?.ok === true).length;

  return {
    model: arm.arm.model,
    strategyId: arm.arm.strategyId,
    runs,
    tasks,
    cells: cellAccounting(grid, arm),
    score: clusterMeanEstimate(taskMeans(arm, 'score'), inf, true),
    passRate: passRateEstimate(t, inf.alpha),
    passHatK,
    costUsd: clusterMeanEstimate(costs, inf),
    latencyMs: clusterMeanEstimate(taskMeans(arm, 'latency'), inf),
    costPerSolvedUsd: costPerSolved(costs, t.rates, inf),
    integrity: { checked: checked.length, ok, rate: checked.length > 0 ? ok / checked.length : null },
    failureModes,
  };
}

function qualityOf(summary: StrategyAnalysis, quality: 'score' | 'pass'): number {
  return quality === 'score' ? summary.score.value : summary.passRate.value;
}

// ---------------------------------------------------------------------------
// Contrasts
// ---------------------------------------------------------------------------

interface PendingContrast {
  family: ContrastFamily;
  metric: AnalysisMetric;
  test: PairedTest;
  cells: number;
  a?: ArmRef;
  b?: ArmRef;
  interaction?: { strategyId: string; baseline: string; models: [string, string] };
}

/** Paired tests are symmetric, so (b, a) is (a, b) mirrored rather than recomputed. */
class PairedTestCache {
  private readonly tests = new Map<string, { test: PairedTest; cells: number }>();

  constructor(
    private readonly settings: AnalysisSettings,
    private readonly inf: InferenceSettings,
  ) {}

  get(a: ArmCells, b: ArmCells, metric: AnalysisMetric): { test: PairedTest; cells: number } {
    const ka = armKey(a.arm);
    const kb = armKey(b.arm);
    const flipped = ka > kb;
    const key = flipped ? `${kb}\u0001${ka}\u0001${metric}` : `${ka}\u0001${kb}\u0001${metric}`;
    let hit = this.tests.get(key);
    if (!hit) {
      const diffs = flipped ? pairedDiffs(b, a, metric) : pairedDiffs(a, b, metric);
      hit = this.compute(diffs, metric);
      this.tests.set(key, hit);
    }
    if (!flipped) return hit;
    const { test } = hit;
    return {
      cells: hit.cells,
      test: {
        ...test,
        estimate: -test.estimate,
        ci: test.ci ? { low: -test.ci.high, high: -test.ci.low } : null,
      },
    };
  }

  compute(diffs: PairedDiffs, metric: AnalysisMetric): { test: PairedTest; cells: number } {
    const margin = this.settings.margins[metric];
    const onScale = metricScale(metric) === 'ratio' ? Math.log(margin) : margin;
    // Pass/fail differences get the binary variance floor on their equivalence test.
    const options = { cellDiffs: diffs.cellDiffs, binary: metric === 'pass' };
    return { test: pairedTest(diffs.taskDiffs, onScale, this.inf, options), cells: diffs.cells };
  }
}

function finalize(pending: readonly PendingContrast[], settings: AnalysisSettings): PairedResult[] {
  const results: PairedResult[] = new Array(pending.length);
  const groups = new Map<string, number[]>();
  pending.forEach((p, i) => {
    const key = `${p.family}\u0000${p.metric}`;
    const group = groups.get(key);
    if (group) group.push(i);
    else groups.set(key, [i]);
  });

  for (const indices of groups.values()) {
    const metric = (pending[indices[0] as number] as PendingContrast).metric;
    const verdicts = resolveVerdicts(
      indices.map((i) => (pending[i] as PendingContrast).test),
      settings.alpha,
      higherIsBetter(metric),
    );
    indices.forEach((i, k) => {
      const p = pending[i] as PendingContrast;
      const v = verdicts[k] as (typeof verdicts)[number];
      const ratio = metricScale(metric) === 'ratio';
      const { test } = p;
      results[i] = {
        family: p.family,
        metric,
        scale: ratio ? 'ratio' : 'difference',
        estimate: ratio ? Math.exp(test.estimate) : test.estimate,
        ci: test.ci
          ? ratio
            ? { low: Math.exp(test.ci.low), high: Math.exp(test.ci.high) }
            : test.ci
          : null,
        margin: settings.margins[metric],
        tasks: test.tasks,
        cells: p.cells,
        pValue: test.pDifference,
        pAdjusted: v.pAdjusted,
        pEquivalence: test.pEquivalence,
        pEquivalenceAdjusted: v.pEquivalenceAdjusted,
        verdict: v.verdict,
        ...(test.caveat ? { caveat: test.caveat } : {}),
      };
    });
  }
  return results;
}

// ---------------------------------------------------------------------------
// analyzeRunSet
// ---------------------------------------------------------------------------

/**
 * Analyze a run set: per-model summaries, paired contrasts with Holm-adjusted
 * four-way verdicts, cross-model "Scaffold or Scale?" contrasts, an
 * uncertainty-aware Pareto frontier and a health report. Deterministic for a
 * given seed. Filter `records` first to analyze one task category.
 */
export function analyzeRunSet(
  records: readonly RunRecord[],
  options: AnalysisOptions = {},
): RunSetAnalysis {
  const { models: grids, health } = buildGrid(records, options.excludeFailureModes ?? ['api_error']);
  const settings = resolveSettings(options, [...grids.keys()]);
  const inf: InferenceSettings = {
    iterations: settings.iterations,
    seed: settings.seed,
    alpha: settings.alpha,
    minClusters: settings.minTasks,
  };
  const cache = new PairedTestCache(settings, inf);
  const qualityMetric: AnalysisMetric = settings.quality;

  // Summaries, ordered by quality then cost within each model.
  const summaries = new Map<string, StrategyAnalysis[]>();
  const armsByModel = new Map<string, ArmCells[]>();
  for (const model of settings.modelOrder) {
    const grid = grids.get(model) as ModelGrid;
    const arms = [...grid.arms.values()].filter((arm) => arm.cells.size > 0);
    const rows = arms.map((arm) => ({ arm, summary: summarizeArm(grid, arm, inf) }));
    rows.sort(
      (x, y) =>
        qualityOf(y.summary, settings.quality) - qualityOf(x.summary, settings.quality) ||
        x.summary.costUsd.value - y.summary.costUsd.value ||
        x.summary.strategyId.localeCompare(y.summary.strategyId),
    );
    summaries.set(model, rows.map((r) => r.summary));
    armsByModel.set(model, rows.map((r) => r.arm));
  }

  const pending: PendingContrast[] = [];
  const add = (family: ContrastFamily, metric: AnalysisMetric, a: ArmCells, b: ArmCells) => {
    const { test, cells } = cache.get(a, b, metric);
    if (test.tasks === 0) return;
    pending.push({ family, metric, test, cells, a: a.arm, b: b.arm });
  };

  for (const model of settings.modelOrder) {
    const arms = armsByModel.get(model) as ArmCells[];
    const base = arms.find((arm) => arm.arm.strategyId === settings.baseline);
    for (const metric of ANALYSIS_METRICS) {
      if (base) for (const arm of arms) if (arm !== base) add('baseline', metric, arm, base);
      for (let i = 0; i < arms.length; i++) {
        for (let j = i + 1; j < arms.length; j++) {
          add('pairwise', metric, arms[i] as ArmCells, arms[j] as ArmCells);
        }
      }
    }
  }

  // Scaffold or Scale: every strategy on model m against the baseline one model up.
  for (let m = 0; m + 1 < settings.modelOrder.length; m++) {
    const small = armsByModel.get(settings.modelOrder[m] as string) as ArmCells[];
    const large = armsByModel.get(settings.modelOrder[m + 1] as string) as ArmCells[];
    const largeBase = large.find((arm) => arm.arm.strategyId === settings.baseline);
    if (!largeBase) continue;
    for (const metric of ANALYSIS_METRICS) {
      for (const arm of small) add('scale', metric, arm, largeBase);
    }
  }

  // Interaction: does the scaffold's gain shrink on the bigger model?
  for (const [m1, m2] of settings.interactionModels) {
    const arms1 = armsByModel.get(m1);
    const arms2 = armsByModel.get(m2);
    if (!arms1 || !arms2 || m1 === m2) continue;
    const base1 = arms1.find((arm) => arm.arm.strategyId === settings.baseline);
    const base2 = arms2.find((arm) => arm.arm.strategyId === settings.baseline);
    if (!base1 || !base2) continue;
    for (const metric of ['score', 'pass'] as const) {
      for (const s1 of arms1) {
        if (s1 === base1) continue;
        const s2 = arms2.find((arm) => arm.arm.strategyId === s1.arm.strategyId);
        if (!s2) continue;
        const diffs = interactionDiffs(s1, base1, s2, base2, metric);
        const { test, cells } = cache.compute(diffs, metric);
        if (test.tasks === 0) continue;
        pending.push({
          family: 'interaction',
          metric,
          test,
          cells,
          interaction: { strategyId: s1.arm.strategyId, baseline: settings.baseline, models: [m1, m2] },
        });
      }
    }
  }

  // Frontier over every arm of every model, as its own family.
  const allArms = settings.modelOrder.flatMap((m) => armsByModel.get(m) as ArmCells[]);
  for (const metric of [qualityMetric, 'cost'] as const) {
    for (let i = 0; i < allArms.length; i++) {
      for (let j = i + 1; j < allArms.length; j++) {
        add('frontier', metric, allArms[i] as ArmCells, allArms[j] as ArmCells);
      }
    }
  }

  const results = finalize(pending, settings);
  const contrasts: Contrast[] = [];
  const interactions: InteractionContrast[] = [];
  pending.forEach((p, i) => {
    const result = results[i] as PairedResult;
    if (p.interaction) interactions.push({ ...result, ...p.interaction });
    else contrasts.push({ ...result, a: p.a as ArmRef, b: p.b as ArmRef });
  });

  const byFamily = (family: ContrastFamily) => contrasts.filter((c) => c.family === family);
  const frontierContrasts = byFamily('frontier');
  const summaryOf = (arm: ArmRef) =>
    (summaries.get(arm.model) ?? []).find((s) => s.strategyId === arm.strategyId) as StrategyAnalysis;

  const frontierOf = (arms: readonly ArmRef[], family: readonly Contrast[]): FrontierEntry[] => {
    const lookup = new Map<string, ContrastVerdict>();
    for (const c of family) {
      if (c.metric !== qualityMetric && c.metric !== 'cost') continue;
      const axis = c.metric === 'cost' ? 'cost' : 'quality';
      lookup.set(`${armKey(c.a)}\u0001${armKey(c.b)}\u0001${axis}`, c.verdict);
      lookup.set(`${armKey(c.b)}\u0001${armKey(c.a)}\u0001${axis}`, mirror(c.verdict));
    }
    const candidates = arms.map((arm) => {
      const s = summaryOf(arm);
      return { key: arm, quality: qualityOf(s, settings.quality), cost: s.costUsd.value };
    });
    return uncertainFrontier(candidates, (p, q, axis) => {
      return lookup.get(`${armKey(p)}\u0001${armKey(q)}\u0001${axis}`) ?? 'inconclusive';
    }).map((r, i) => ({
      arm: r.key,
      quality: (candidates[i] as (typeof candidates)[number]).quality,
      costUsd: (candidates[i] as (typeof candidates)[number]).cost,
      status: r.status,
      dominatedBy: r.dominatedBy,
    }));
  };

  const models: ModelAnalysis[] = settings.modelOrder.map((model) => {
    const grid = grids.get(model) as ModelGrid;
    const strategies = summaries.get(model) ?? [];
    const inModel = (c: Contrast) => c.a.model === model && c.b.model === model;
    const pairwise = byFamily('pairwise').filter(inModel);
    let repeats = 0;
    for (const set of grid.expected.values()) repeats = Math.max(repeats, set.size);
    return {
      model,
      tasks: grid.expected.size,
      repeats,
      strategies,
      vsBaseline: byFamily('baseline').filter(inModel),
      pairwise,
      frontier: frontierOf(
        strategies.map((s) => ({ model, strategyId: s.strategyId })),
        pairwise,
      ),
    };
  });

  return {
    settings,
    models,
    scaffoldOrScale: byFamily('scale'),
    interactions,
    frontier: frontierOf(
      allArms.map((arm) => arm.arm),
      frontierContrasts,
    ),
    frontierContrasts,
    health,
  };
}

function mirror(verdict: ContrastVerdict): ContrastVerdict {
  return verdict === 'better' ? 'worse' : verdict === 'worse' ? 'better' : verdict;
}
