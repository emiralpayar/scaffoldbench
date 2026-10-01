/**
 * Power planning: how many repeats (or tasks) a paired contrast needs.
 *
 * The task-level difference D_t of two arms varies for two reasons: the
 * true effect differs from task to task (σ²_between), and each repeat is
 * noisy (σ²_within, per paired cell). With T tasks and r repeats,
 *
 *   Var(mean D) = (σ²_between + σ²_within / r) / T.
 *
 * Repeats only shrink the second term, so past some point only more tasks
 * help — the planner says so instead of returning an absurd repeat count.
 */

import { buildGrid, metricScale, pairedDiffs } from './analysisData';
import type { AnalysisMetric } from './analysisData';
import { studentTCdf, studentTQuantile } from './stats';
import type { FailureMode, RunRecord } from './types';

export interface VarianceComponents {
  tasks: number;
  /** Harmonic mean of paired repeats per task. */
  repeats: number;
  /** Variance of one paired cell difference around its task mean; null without any task repeated. */
  withinTask: number | null;
  /** Variance of the true effect across tasks (ANOVA estimate, floored at 0). */
  betweenTask: number;
  /** Tasks where at least one paired cell differed — near 0, the variance is understated. */
  informativeTasks: number;
}

/**
 * One-way random-effects (ANOVA) estimates from paired cell differences
 * grouped by task.
 */
export function estimateVarianceComponents(
  cellDiffsByTask: readonly (readonly number[])[],
): VarianceComponents {
  const groups = cellDiffsByTask.filter((g) => g.length > 0);
  const tasks = groups.length;
  let ssWithin = 0;
  let dfWithin = 0;
  let inverseRepeats = 0;
  let informativeTasks = 0;
  const means: number[] = [];
  for (const g of groups) {
    const m = g.reduce((a, d) => a + d, 0) / g.length;
    means.push(m);
    for (const d of g) ssWithin += (d - m) ** 2;
    dfWithin += g.length - 1;
    inverseRepeats += 1 / g.length;
    if (g.some((d) => Math.abs(d) > 1e-12)) informativeTasks += 1;
  }
  const withinTask = dfWithin > 0 ? ssWithin / dfWithin : null;
  const meanInverseRepeats = tasks > 0 ? inverseRepeats / tasks : 1;
  let betweenOfMeans = 0;
  if (tasks >= 2) {
    const grand = means.reduce((a, m) => a + m, 0) / tasks;
    betweenOfMeans = means.reduce((a, m) => a + (m - grand) ** 2, 0) / (tasks - 1);
  }
  const betweenTask = Math.max(0, betweenOfMeans - (withinTask ?? 0) * meanInverseRepeats);
  return {
    tasks,
    repeats: tasks > 0 ? 1 / meanInverseRepeats : 0,
    withinTask,
    betweenTask,
    informativeTasks,
  };
}

export interface DesignQuery {
  tasks: number;
  repeats: number;
  /** Effect to detect, on the analysis scale (score points, or log ratio). */
  delta: number;
  /** Two-sided level per test. For a Holm family of m, α/m is the worst case. */
  alpha: number;
}

/**
 * Approximate power of the two-sided paired test: a shifted central t with
 * T − 1 degrees of freedom stands in for the noncentral t. Returns 0 when T
 * is too small for the sign-flip test to reach α at all (2 / 2^T > α),
 * because the verdict requires that test too.
 */
export function powerOfDesign(components: VarianceComponents, query: DesignQuery): number {
  const { tasks, repeats, delta, alpha } = query;
  if (tasks < 2 || 2 / 2 ** tasks > alpha) return 0;
  const variance = components.betweenTask + (components.withinTask ?? 0) / Math.max(1, repeats);
  if (!(variance > 0)) return Number.NaN;
  const ncp = Math.abs(delta) / Math.sqrt(variance / tasks);
  const df = tasks - 1;
  const crit = studentTQuantile(1 - alpha / 2, df);
  return 1 - studentTCdf(crit - ncp, df) + studentTCdf(-crit - ncp, df);
}

/** Smallest repeat count reaching `power` with `tasks` tasks; null if none up to `maxRepeats` does. */
export function repeatsForPower(
  components: VarianceComponents,
  query: Omit<DesignQuery, 'repeats'> & { power: number; maxRepeats?: number },
): number | null {
  const maxRepeats = query.maxRepeats ?? 100;
  for (let r = 1; r <= maxRepeats; r++) {
    const p = powerOfDesign(components, { ...query, repeats: r });
    if (p >= query.power) return r;
  }
  return null;
}

/** Smallest task count reaching `power` with `repeats` repeats; null if none up to `maxTasks` does. */
export function tasksForPower(
  components: VarianceComponents,
  query: Omit<DesignQuery, 'tasks'> & { power: number; maxTasks?: number },
): number | null {
  const maxTasks = query.maxTasks ?? 1000;
  for (let t = 2; t <= maxTasks; t++) {
    const p = powerOfDesign(components, { ...query, tasks: t });
    if (p >= query.power) return t;
  }
  return null;
}

/** Smallest |Δ| detected with `power` at this design (bisection on `powerOfDesign`). */
export function minimumDetectableEffect(
  components: VarianceComponents,
  query: Omit<DesignQuery, 'delta'> & { power: number },
): number | null {
  if (powerOfDesign(components, { ...query, delta: 1e6 }) < query.power) return null;
  let lo = 0;
  let hi = 1;
  while (powerOfDesign(components, { ...query, delta: hi }) < query.power) hi *= 2;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    if (powerOfDesign(components, { ...query, delta: mid }) < query.power) lo = mid;
    else hi = mid;
  }
  return hi;
}

// ---------------------------------------------------------------------------
// From records
// ---------------------------------------------------------------------------

export interface PowerPlanOptions {
  metric: AnalysisMetric;
  /**
   * Effect to detect. Score and pass: an absolute difference (0.05 = 5
   * points). Cost and latency: a ratio (1.2 = 20% more expensive).
   */
  delta: number;
  baseline?: string;
  /** Restrict to these models; default every model in the records. */
  models?: readonly string[];
  alpha?: number;
  power?: number;
  /** Size of the Holm family the contrast will be judged in; α is split Bonferroni-style. */
  familySize?: number;
  excludeFailureModes?: readonly FailureMode[];
}

export interface PowerPlanContrast {
  strategyId: string;
  components: VarianceComponents;
}

export interface PowerPlan {
  model: string;
  metric: AnalysisMetric;
  /** The effect asked about, as given (a ratio for cost and latency). */
  delta: number;
  alphaPerTest: number;
  power: number;
  /** Mean of the per-contrast components; what the plan below is based on. */
  pooled: VarianceComponents;
  contrasts: PowerPlanContrast[];
  /** Power of the current design (tasks × repeats as run). Null when no variance was observed. */
  currentPower: number | null;
  /** Repeats needed at the current task count; null if more repeats alone cannot get there. */
  repeatsNeeded: number | null;
  /** Tasks needed at the current repeat count. */
  tasksNeeded: number | null;
  /** Smallest effect the current design detects with the requested power, on the scale of `delta`. */
  minimumDetectableEffect: number | null;
  /** Why the plan is empty or should be distrusted, if it is. */
  warning?: 'no-variation' | 'saturated' | 'no-repeats';
}

/**
 * Estimate variance components from every strategy-vs-baseline contrast of
 * each model and plan the design that detects `delta` with `power`.
 */
export function planPower(records: readonly RunRecord[], options: PowerPlanOptions): PowerPlan[] {
  const {
    metric,
    baseline = 'single',
    alpha = 0.05,
    power = 0.8,
    familySize = 1,
    excludeFailureModes = ['api_error'],
  } = options;
  const ratio = metricScale(metric) === 'ratio';
  const delta = ratio ? Math.log(options.delta) : options.delta;
  const alphaPerTest = alpha / Math.max(1, familySize);
  const { models } = buildGrid(records, excludeFailureModes);

  const plans: PowerPlan[] = [];
  for (const [model, grid] of [...models].sort(([a], [b]) => a.localeCompare(b))) {
    if (options.models && !options.models.includes(model)) continue;
    const base = grid.arms.get(baseline);
    if (!base) continue;
    const contrasts: PowerPlanContrast[] = [];
    for (const [strategyId, arm] of [...grid.arms].sort(([a], [b]) => a.localeCompare(b))) {
      if (strategyId === baseline) continue;
      const { cellDiffs } = pairedDiffs(arm, base, metric);
      if (cellDiffs.length === 0) continue;
      contrasts.push({ strategyId, components: estimateVarianceComponents(cellDiffs) });
    }
    if (contrasts.length === 0) continue;

    const avg = (pick: (c: VarianceComponents) => number) =>
      contrasts.reduce((a, c) => a + pick(c.components), 0) / contrasts.length;
    const withins = contrasts.map((c) => c.components.withinTask).filter((w): w is number => w !== null);
    const pooled: VarianceComponents = {
      tasks: Math.round(avg((c) => c.tasks)),
      repeats: avg((c) => c.repeats),
      withinTask: withins.length > 0 ? withins.reduce((a, w) => a + w, 0) / withins.length : null,
      betweenTask: avg((c) => c.betweenTask),
      informativeTasks: Math.round(avg((c) => c.informativeTasks)),
    };

    const tasks = pooled.tasks;
    const repeats = Math.max(1, Math.round(pooled.repeats));
    const plan: PowerPlan = {
      model,
      metric,
      delta: options.delta,
      alphaPerTest,
      power,
      pooled,
      contrasts,
      currentPower: null,
      repeatsNeeded: null,
      tasksNeeded: null,
      minimumDetectableEffect: null,
    };
    if (!(pooled.betweenTask + (pooled.withinTask ?? 0) > 0)) {
      plans.push({ ...plan, warning: 'no-variation' });
      continue;
    }
    const query = { tasks, repeats, delta, alpha: alphaPerTest };
    plan.currentPower = powerOfDesign(pooled, query);
    plan.repeatsNeeded =
      pooled.withinTask === null ? null : repeatsForPower(pooled, { ...query, power });
    plan.tasksNeeded = tasksForPower(pooled, { ...query, power });
    const mde = minimumDetectableEffect(pooled, { ...query, power });
    plan.minimumDetectableEffect = mde === null ? null : ratio ? Math.exp(mde) : mde;
    if (pooled.withinTask === null) plan.warning = 'no-repeats';
    else if (pooled.informativeTasks < Math.min(5, tasks)) plan.warning = 'saturated';
    plans.push(plan);
  }
  return plans;
}
