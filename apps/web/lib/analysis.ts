/**
 * The statistics the charts draw, as one view model: per-model architecture
 * summaries, paired contrasts against the `single` control, "scaffold or
 * scale" contrasts across model tiers, and a health summary.
 *
 * INTERIM IMPLEMENTATION. The contract (PLAN §3) puts this analysis in
 * `@arena/core` as `analyzeRunSet`, owned by the stats stream. Until it lands,
 * `analyzeForSite` computes the same quantities with the same design — paired
 * by task and repeat, bootstrapped over tasks so repeats of one task stay
 * together — so the site can be built against real shapes. When core exports
 * it, this file should become a thin adapter from its output to `SiteAnalysis`,
 * and `method` should be taken from core's documentation of what it did.
 * What this version does not do yet, and says so in `method`: adjust the
 * verdicts for multiple comparisons.
 *
 * Pure: no filesystem, safe anywhere.
 */

import { makeRng, paretoFrontier } from '@arena/core';

import { BASELINE_ID, compareArchitectures } from './architectures';
import { compareModels } from './models';
import type { RunRecord } from './records';
import { hasIntegrity, isRankable } from './records';

export interface Estimate {
  mean: number;
  low: number;
  high: number;
}

export type PairedVerdict = 'better' | 'worse' | 'equivalent' | 'inconclusive';

export interface ArchitectureSummary {
  strategyId: string;
  /** Rankable runs (integrity intact, no infrastructure failure). */
  runs: number;
  tasks: number;
  /** Mean of per-task mean scores, task-clustered bootstrap interval. */
  score: Estimate;
  /** Share of runs that passed, Wilson score interval. */
  passRate: Estimate;
  costUsd: Estimate;
  latencyMs: Estimate;
}

export interface BaselineContrast {
  strategyId: string;
  baselineId: string;
  /** Matched (task, repeat) pairs the contrast is computed over. */
  pairs: number;
  tasks: number;
  /** Mean paired score difference, architecture minus baseline. */
  scoreDelta: Estimate;
  /** Architecture mean cost divided by the baseline's, over the same pairs. */
  costRatio: Estimate;
  latencyRatio: Estimate;
  verdict: PairedVerdict;
}

export interface ModelAnalysis {
  model: string;
  architectures: ArchitectureSummary[];
  /** One per non-baseline architecture that shares tasks with the baseline. */
  contrasts: BaselineContrast[];
  /** Non-dominated on (mean score, mean cost). Means only; see the intervals. */
  frontier: string[];
}

/**
 * "Scaffold or scale?": an architecture on one model against the plain
 * `single` agent on the next model up. A positive delta at a cost ratio below
 * one means the scaffold bought more than the upgrade, for less.
 */
export interface ScaleContrast {
  strategyId: string;
  model: string;
  nextModel: string;
  pairs: number;
  tasks: number;
  scoreDelta: Estimate;
  costRatio: Estimate;
  verdict: PairedVerdict;
}

export interface CheckFailureCount {
  id: string;
  count: number;
}

export interface StrategyHealth {
  strategyId: string;
  total: number;
  integrityFailed: number;
  apiErrors: number;
}

export interface RunSetHealth {
  total: number;
  rankable: number;
  integrityFailed: number;
  apiErrors: number;
  /** Records with no integrity verdict at all (recorded before the gate). */
  withoutIntegrity: number;
  failedChecks: CheckFailureCount[];
  byStrategy: StrategyHealth[];
}

export interface SiteAnalysis {
  baselineId: string;
  confidence: number;
  /** Half-width of the equivalence band on score differences. */
  margin: number;
  /** One sentence a chart caption can quote verbatim. */
  method: string;
  models: ModelAnalysis[];
  scale: ScaleContrast[];
  health: RunSetHealth;
}

export interface AnalysisOptions {
  baselineId?: string;
  margin?: number;
  iterations?: number;
  confidence?: number;
}

const DEFAULTS = { baselineId: BASELINE_ID, margin: 0.05, iterations: 2000, confidence: 0.95 };

export function analyzeForSite(
  records: readonly RunRecord[],
  options: AnalysisOptions = {},
): SiteAnalysis {
  const { baselineId, margin, iterations, confidence } = { ...DEFAULTS, ...options };
  // A canonical order makes the result independent of how the records were
  // read: floating-point sums depend on order, and a published interval must
  // not change in its last digit because a directory listing did.
  const rankable = [...records].filter(isRankable).sort(compareRecords);
  const models = [...new Set(rankable.map((record) => record.model))].sort(compareModels);

  const perModel: ModelAnalysis[] = models.map((model) => {
    const scoped = rankable.filter((record) => record.model === model);
    const strategies = [...new Set(scoped.map((record) => record.strategyId))].sort(
      compareArchitectures,
    );
    const architectures = strategies.map((strategyId) =>
      summarizeArchitecture(
        scoped.filter((record) => record.strategyId === strategyId),
        strategyId,
        { iterations, confidence, seedKey: `${model}/${strategyId}` },
      ),
    );

    const baseline = scoped.filter((record) => record.strategyId === baselineId);
    const contrasts = strategies
      .filter((strategyId) => strategyId !== baselineId)
      .map((strategyId) => {
        const paired = pairRuns(
          scoped.filter((record) => record.strategyId === strategyId),
          baseline,
        );
        if (paired.pairs === 0) return null;
        const stats = pairedStatistics(paired, {
          iterations,
          confidence,
          seedKey: `${model}/${strategyId}-vs-${baselineId}`,
        });
        return {
          strategyId,
          baselineId,
          pairs: paired.pairs,
          tasks: paired.tasks.length,
          scoreDelta: stats.scoreDelta,
          costRatio: stats.costRatio,
          latencyRatio: stats.latencyRatio,
          verdict: verdictFor(stats.scoreDelta, margin),
        };
      })
      .filter((contrast): contrast is BaselineContrast => contrast !== null);

    const frontier = paretoFrontier(
      architectures,
      (a) => a.score.mean,
      (a) => a.costUsd.mean,
    ).map((a) => a.strategyId);

    return { model, architectures, contrasts, frontier };
  });

  const scale: ScaleContrast[] = [];
  for (let i = 0; i + 1 < models.length; i++) {
    const model = models[i] as string;
    const nextModel = models[i + 1] as string;
    const nextBaseline = rankable.filter(
      (record) => record.model === nextModel && record.strategyId === baselineId,
    );
    if (nextBaseline.length === 0) continue;
    const strategies = [
      ...new Set(rankable.filter((r) => r.model === model).map((r) => r.strategyId)),
    ].sort(compareArchitectures);
    for (const strategyId of strategies) {
      const paired = pairRuns(
        rankable.filter((record) => record.model === model && record.strategyId === strategyId),
        nextBaseline,
      );
      if (paired.pairs === 0) continue;
      const stats = pairedStatistics(paired, {
        iterations,
        confidence,
        seedKey: `${model}/${strategyId}-vs-${nextModel}/${baselineId}`,
      });
      scale.push({
        strategyId,
        model,
        nextModel,
        pairs: paired.pairs,
        tasks: paired.tasks.length,
        scoreDelta: stats.scoreDelta,
        costRatio: stats.costRatio,
        verdict: verdictFor(stats.scoreDelta, margin),
      });
    }
  }

  const pct = Math.round(confidence * 100);
  return {
    baselineId,
    confidence,
    margin,
    method:
      `${pct}% percentile intervals from a ${iterations.toLocaleString('en-US')}-draw bootstrap that resamples tasks, ` +
      `keeping each task's repeats together. Differences are paired by task and repeat; ` +
      `"equivalent" means the whole interval sits within ±${margin.toFixed(2)}. ` +
      'Verdicts are not yet adjusted for multiple comparisons.',
    models: perModel,
    scale,
    health: summarizeHealth(records),
  };
}

// ---------------------------------------------------------------------------
// Verdicts
// ---------------------------------------------------------------------------

/**
 * Four-way verdict on a difference interval. Equivalence is checked first: a
 * tight interval inside the margin is "equivalent" even if it excludes zero,
 * because a real but negligible difference is not a reason to pay for
 * structure.
 */
export function verdictFor(delta: Estimate, margin: number): PairedVerdict {
  if (delta.low >= -margin && delta.high <= margin) return 'equivalent';
  if (delta.low > 0) return 'better';
  if (delta.high < 0) return 'worse';
  return 'inconclusive';
}

// ---------------------------------------------------------------------------
// Single-architecture summaries
// ---------------------------------------------------------------------------

interface BootstrapConfig {
  iterations: number;
  confidence: number;
  seedKey: string;
}

function summarizeArchitecture(
  records: readonly RunRecord[],
  strategyId: string,
  config: BootstrapConfig,
): ArchitectureSummary {
  const byTask = groupByTask(records);
  const tasks = [...byTask.values()];
  const taskMean = (pick: (r: RunRecord) => number) => tasks.map((runs) => mean(runs.map(pick)));

  const scores = taskMean((r) => r.score);
  const costs = taskMean((r) => r.costUsd);
  const latencies = taskMean((r) => r.latencyMs);
  const passed = records.filter((r) => r.passed).length;

  return {
    strategyId,
    runs: records.length,
    tasks: tasks.length,
    score: clusterMean(scores, { ...config, seedKey: `${config.seedKey}/score` }),
    passRate: wilson(passed, records.length, config.confidence),
    costUsd: clusterMean(costs, { ...config, seedKey: `${config.seedKey}/cost` }),
    latencyMs: clusterMean(latencies, { ...config, seedKey: `${config.seedKey}/latency` }),
  };
}

/** Bootstrap the mean of per-task values by resampling tasks. */
function clusterMean(values: readonly number[], config: BootstrapConfig): Estimate {
  const point = mean(values);
  if (values.length < 2) return { mean: point, low: point, high: point };
  const rng = makeRng(seedFrom(config.seedKey));
  const draws = new Array<number>(config.iterations);
  for (let i = 0; i < config.iterations; i++) {
    let total = 0;
    for (let j = 0; j < values.length; j++) {
      total += values[Math.floor(rng() * values.length)] as number;
    }
    draws[i] = total / values.length;
  }
  return { mean: point, ...percentiles(draws, config.confidence) };
}

/** Wilson score interval for a binomial proportion. */
export function wilson(successes: number, n: number, confidence = 0.95): Estimate {
  if (n === 0) return { mean: 0, low: 0, high: 0 };
  const z = zFor(confidence);
  const p = successes / n;
  const denom = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return { mean: p, low: Math.max(0, centre - half), high: Math.min(1, centre + half) };
}

function zFor(confidence: number): number {
  // The site only ever asks for 90/95/99%; a table beats an inverse-erf here.
  if (confidence >= 0.99) return 2.5758;
  if (confidence >= 0.95) return 1.96;
  return 1.6449;
}

// ---------------------------------------------------------------------------
// Paired contrasts
// ---------------------------------------------------------------------------

interface TaskPairs {
  taskId: string;
  /** Per matched repeat: [architecture, baseline]. */
  score: [number, number][];
  cost: [number, number][];
  latency: [number, number][];
}

interface PairedRuns {
  pairs: number;
  tasks: TaskPairs[];
}

/** Match runs to the baseline by task and repeat; unmatched runs are left out. */
export function pairRuns(
  candidate: readonly RunRecord[],
  baseline: readonly RunRecord[],
): PairedRuns {
  const baseByKey = new Map<string, RunRecord>();
  for (const record of baseline) baseByKey.set(`${record.taskId}#${record.repeat}`, record);

  const byTask = new Map<string, TaskPairs>();
  let pairs = 0;
  for (const record of candidate) {
    const base = baseByKey.get(`${record.taskId}#${record.repeat}`);
    if (!base) continue;
    let bucket = byTask.get(record.taskId);
    if (!bucket) {
      bucket = { taskId: record.taskId, score: [], cost: [], latency: [] };
      byTask.set(record.taskId, bucket);
    }
    bucket.score.push([record.score, base.score]);
    bucket.cost.push([record.costUsd, base.costUsd]);
    bucket.latency.push([record.latencyMs, base.latencyMs]);
    pairs += 1;
  }

  const tasks = [...byTask.values()].sort((a, b) => a.taskId.localeCompare(b.taskId));
  return { pairs, tasks };
}

function pairedStatistics(
  paired: PairedRuns,
  config: BootstrapConfig,
): { scoreDelta: Estimate; costRatio: Estimate; latencyRatio: Estimate } {
  const deltas = paired.tasks.map((task) => mean(task.score.map(([a, b]) => a - b)));
  const costA = paired.tasks.map((task) => mean(task.cost.map(([a]) => a)));
  const costB = paired.tasks.map((task) => mean(task.cost.map(([, b]) => b)));
  const latA = paired.tasks.map((task) => mean(task.latency.map(([a]) => a)));
  const latB = paired.tasks.map((task) => mean(task.latency.map(([, b]) => b)));

  return {
    scoreDelta: clusterMean(deltas, { ...config, seedKey: `${config.seedKey}/delta` }),
    costRatio: clusterRatio(costA, costB, { ...config, seedKey: `${config.seedKey}/cost` }),
    latencyRatio: clusterRatio(latA, latB, { ...config, seedKey: `${config.seedKey}/latency` }),
  };
}

/** Ratio of means, bootstrapped by resampling tasks for numerator and denominator together. */
function clusterRatio(
  numerator: readonly number[],
  denominator: readonly number[],
  config: BootstrapConfig,
): Estimate {
  const ratio = (num: number, den: number) => (den > 0 ? num / den : Number.NaN);
  const point = ratio(mean(numerator), mean(denominator));
  const n = numerator.length;
  if (n < 2) return { mean: point, low: point, high: point };
  const rng = makeRng(seedFrom(config.seedKey));
  const draws: number[] = [];
  for (let i = 0; i < config.iterations; i++) {
    let num = 0;
    let den = 0;
    for (let j = 0; j < n; j++) {
      const k = Math.floor(rng() * n);
      num += numerator[k] as number;
      den += denominator[k] as number;
    }
    const value = ratio(num, den);
    if (Number.isFinite(value)) draws.push(value);
  }
  if (draws.length === 0) return { mean: point, low: point, high: point };
  return { mean: point, ...percentiles(draws, config.confidence) };
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

export function summarizeHealth(records: readonly RunRecord[]): RunSetHealth {
  const failedChecks = new Map<string, number>();
  const byStrategy = new Map<string, StrategyHealth>();
  let integrityFailed = 0;
  let apiErrors = 0;

  for (const record of records) {
    let strategy = byStrategy.get(record.strategyId);
    if (!strategy) {
      strategy = { strategyId: record.strategyId, total: 0, integrityFailed: 0, apiErrors: 0 };
      byStrategy.set(record.strategyId, strategy);
    }
    strategy.total += 1;

    if (record.failureMode === 'api_error') {
      apiErrors += 1;
      strategy.apiErrors += 1;
    }
    if (record.integrity && !record.integrity.ok) {
      integrityFailed += 1;
      strategy.integrityFailed += 1;
      for (const check of record.integrity.checks) {
        if (!check.ok) failedChecks.set(check.id, (failedChecks.get(check.id) ?? 0) + 1);
      }
    }
  }

  return {
    total: records.length,
    rankable: records.filter(isRankable).length,
    integrityFailed,
    apiErrors,
    withoutIntegrity: records.filter((record) => !hasIntegrity(record)).length,
    failedChecks: [...failedChecks.entries()]
      .map(([id, count]) => ({ id, count }))
      .sort((a, b) => b.count - a.count || a.id.localeCompare(b.id)),
    byStrategy: [...byStrategy.values()].sort((a, b) =>
      compareArchitectures(a.strategyId, b.strategyId),
    ),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function compareRecords(a: RunRecord, b: RunRecord): number {
  return (
    a.model.localeCompare(b.model) ||
    a.strategyId.localeCompare(b.strategyId) ||
    a.taskId.localeCompare(b.taskId) ||
    a.repeat - b.repeat ||
    a.runId.localeCompare(b.runId)
  );
}

function groupByTask(records: readonly RunRecord[]): Map<string, RunRecord[]> {
  const map = new Map<string, RunRecord[]>();
  for (const record of [...records].sort((a, b) => a.taskId.localeCompare(b.taskId))) {
    const bucket = map.get(record.taskId);
    if (bucket) bucket.push(record);
    else map.set(record.taskId, [record]);
  }
  return map;
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  let total = 0;
  for (const value of values) total += value;
  return total / values.length;
}

function percentiles(draws: number[], confidence: number): { low: number; high: number } {
  draws.sort((a, b) => a - b);
  const alpha = (1 - confidence) / 2;
  const lowIdx = Math.max(0, Math.floor(alpha * draws.length));
  const highIdx = Math.min(draws.length - 1, Math.ceil((1 - alpha) * draws.length) - 1);
  return { low: draws[lowIdx] as number, high: draws[highIdx] as number };
}

/** FNV-1a: a stable seed per quantity, so intervals do not depend on iteration order. */
function seedFrom(key: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
