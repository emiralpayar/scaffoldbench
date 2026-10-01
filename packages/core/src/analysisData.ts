/**
 * From run records to the grid the analysis works on.
 *
 * Every strategy runs the same (task, repeat) cells for every model, so the
 * records form a grid: model → strategy → task → repeat. This module builds
 * it, drops runs that do not measure the architecture (failed integrity
 * checks, infrastructure errors) into a health report instead of the
 * rankings, and turns pairs of arms into per-task paired differences.
 */

import type { FailureMode, RunRecord } from './types';

/** One arm of the experiment: a strategy on a model. */
export interface ArmRef {
  model: string;
  strategyId: string;
}

export type AnalysisMetric = 'score' | 'pass' | 'cost' | 'latency';

/** Score and pass are compared as differences; cost and latency as ratios. */
export function metricScale(metric: AnalysisMetric): 'difference' | 'ratio' {
  return metric === 'cost' || metric === 'latency' ? 'ratio' : 'difference';
}

export function higherIsBetter(metric: AnalysisMetric): boolean {
  return metric === 'score' || metric === 'pass';
}

export function metricValue(record: RunRecord, metric: AnalysisMetric): number {
  switch (metric) {
    case 'score':
      return record.score;
    case 'pass':
      return record.passed ? 1 : 0;
    case 'cost':
      return record.costUsd;
    case 'latency':
      return record.latencyMs;
  }
}

export function armKey(arm: ArmRef): string {
  return `${arm.model}\u0000${arm.strategyId}`;
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

export type ExclusionReason = 'integrity' | 'failure-mode';

export interface ExcludedRun {
  runId: string;
  model: string;
  strategyId: string;
  taskId: string;
  repeat: number;
  reasons: ExclusionReason[];
  /** Ids of the integrity checks that failed, if any. */
  failedChecks: string[];
  failureMode: FailureMode;
}

/**
 * What was left out of the rankings and why. A run whose integrity check
 * failed did not measure the architecture it is labelled with, and an
 * `api_error` is the infrastructure's failure, not the agent's: counting
 * either as a score would rank the harness, not the scaffold.
 */
export interface HealthReport {
  runs: number;
  included: number;
  excluded: number;
  byReason: Record<ExclusionReason, number>;
  /** Excluded runs per strategy, model, failing check id and failure mode. */
  byStrategy: Record<string, number>;
  byModel: Record<string, number>;
  byCheck: Record<string, number>;
  byFailureMode: Record<string, number>;
  /** Integrity over every run that recorded it; `rate` is null when none did. */
  integrity: { checked: number; ok: number; unchecked: number; rate: number | null };
  /** Healthy runs that repeated an already-filled cell; the later one was kept. */
  duplicates: number;
  excludedRuns: ExcludedRun[];
}

export function exclusionReasons(
  record: RunRecord,
  excludeFailureModes: readonly FailureMode[],
): ExclusionReason[] {
  const reasons: ExclusionReason[] = [];
  if (record.integrity && record.integrity.ok === false) reasons.push('integrity');
  if (excludeFailureModes.includes(record.failureMode)) reasons.push('failure-mode');
  return reasons;
}

// ---------------------------------------------------------------------------
// Grid
// ---------------------------------------------------------------------------

export interface ArmCells {
  arm: ArmRef;
  /** Healthy runs, task → repeat → record. */
  cells: Map<string, Map<number, RunRecord>>;
  /** Every run of the arm, healthy or not, for integrity accounting. */
  all: RunRecord[];
}

export interface ModelGrid {
  model: string;
  /** Repeats observed per task across every strategy and run, healthy or not. */
  expected: Map<string, Set<number>>;
  arms: Map<string, ArmCells>;
}

export interface RunGrid {
  models: Map<string, ModelGrid>;
  health: HealthReport;
}

function bump(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

export function buildGrid(
  records: readonly RunRecord[],
  excludeFailureModes: readonly FailureMode[],
): RunGrid {
  const models = new Map<string, ModelGrid>();
  const health: HealthReport = {
    runs: records.length,
    included: 0,
    excluded: 0,
    byReason: { integrity: 0, 'failure-mode': 0 },
    byStrategy: {},
    byModel: {},
    byCheck: {},
    byFailureMode: {},
    integrity: { checked: 0, ok: 0, unchecked: 0, rate: null },
    duplicates: 0,
    excludedRuns: [],
  };

  for (const record of records) {
    let modelGrid = models.get(record.model);
    if (!modelGrid) {
      modelGrid = { model: record.model, expected: new Map(), arms: new Map() };
      models.set(record.model, modelGrid);
    }
    let repeats = modelGrid.expected.get(record.taskId);
    if (!repeats) {
      repeats = new Set();
      modelGrid.expected.set(record.taskId, repeats);
    }
    repeats.add(record.repeat);

    let arm = modelGrid.arms.get(record.strategyId);
    if (!arm) {
      arm = { arm: { model: record.model, strategyId: record.strategyId }, cells: new Map(), all: [] };
      modelGrid.arms.set(record.strategyId, arm);
    }
    arm.all.push(record);

    if (record.integrity) {
      health.integrity.checked += 1;
      if (record.integrity.ok) health.integrity.ok += 1;
    } else {
      health.integrity.unchecked += 1;
    }

    const reasons = exclusionReasons(record, excludeFailureModes);
    if (reasons.length > 0) {
      const failedChecks = (record.integrity?.checks ?? []).filter((c) => !c.ok).map((c) => c.id);
      health.excluded += 1;
      for (const reason of reasons) health.byReason[reason] += 1;
      bump(health.byStrategy, record.strategyId);
      bump(health.byModel, record.model);
      bump(health.byFailureMode, record.failureMode);
      for (const id of failedChecks) bump(health.byCheck, id);
      health.excludedRuns.push({
        runId: record.runId,
        model: record.model,
        strategyId: record.strategyId,
        taskId: record.taskId,
        repeat: record.repeat,
        reasons,
        failedChecks,
        failureMode: record.failureMode,
      });
      continue;
    }

    let byRepeat = arm.cells.get(record.taskId);
    if (!byRepeat) {
      byRepeat = new Map();
      arm.cells.set(record.taskId, byRepeat);
    }
    const existing = byRepeat.get(record.repeat);
    if (existing) {
      // A resumed or re-run cell; keep the later run so the grid stays
      // one-per-cell. Ties go to the larger run id, so the order the records
      // arrive in never changes the result.
      health.duplicates += 1;
      const later =
        record.finishedAt > existing.finishedAt ||
        (record.finishedAt === existing.finishedAt && record.runId > existing.runId);
      if (!later) continue;
    } else {
      health.included += 1;
    }
    byRepeat.set(record.repeat, record);
  }

  const { checked, ok } = health.integrity;
  health.integrity.rate = checked > 0 ? ok / checked : null;
  const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  health.excludedRuns.sort(
    (x, y) =>
      cmp(x.model, y.model) ||
      cmp(x.strategyId, y.strategyId) ||
      cmp(x.taskId, y.taskId) ||
      x.repeat - y.repeat ||
      cmp(x.runId, y.runId),
  );
  return { models, health };
}

/** Expected, healthy, excluded and missing cells of one arm. */
export function cellAccounting(
  modelGrid: ModelGrid,
  arm: ArmCells,
): { expected: number; included: number; excluded: number; missing: number } {
  let expected = 0;
  let included = 0;
  const attempted = new Set(arm.all.map((r) => `${r.taskId}\u0000${r.repeat}`));
  let excluded = 0;
  for (const [taskId, repeats] of modelGrid.expected) {
    for (const repeat of repeats) {
      expected += 1;
      if (arm.cells.get(taskId)?.has(repeat)) included += 1;
      else if (attempted.has(`${taskId}\u0000${repeat}`)) excluded += 1;
    }
  }
  return { expected, included, excluded, missing: expected - included - excluded };
}

/** Per-task mean of `metric` over the arm's healthy repeats, in task order. */
export function taskMeans(arm: ArmCells, metric: AnalysisMetric): number[] {
  const out: number[] = [];
  for (const taskId of [...arm.cells.keys()].sort()) {
    const byRepeat = arm.cells.get(taskId) as Map<number, RunRecord>;
    let total = 0;
    for (const record of byRepeat.values()) total += metricValue(record, metric);
    out.push(total / byRepeat.size);
  }
  return out;
}

/** Per-task paired differences, plus the cell-level differences behind them. */
export interface PairedDiffs {
  /** One value per task with at least one complete pair: mean over its pairs. */
  taskDiffs: number[];
  /** The paired cell differences of each task, for variance components. */
  cellDiffs: number[][];
  /** Complete (task, repeat) pairs used. */
  cells: number;
}

/**
 * Paired differences between arms `a` and `b` on the (task, repeat) cells both
 * have. Ratio metrics are differenced on the log scale, so the mean
 * difference is the log of a geometric-mean ratio; cells with a non-positive
 * cost or latency cannot be logged and are skipped, as are non-finite values.
 *
 * Arms may be on different models: the pairing is by task and repeat.
 */
export function pairedDiffs(a: ArmCells, b: ArmCells, metric: AnalysisMetric): PairedDiffs {
  return contrastDiffs([a, b], [1, -1], metric);
}

/**
 * Differences-in-differences for an architecture × model interaction:
 * (s − base) on the first model minus (s − base) on the second, per cell.
 */
export function interactionDiffs(
  s1: ArmCells,
  base1: ArmCells,
  s2: ArmCells,
  base2: ArmCells,
  metric: AnalysisMetric,
): PairedDiffs {
  return contrastDiffs([s1, base1, s2, base2], [1, -1, -1, 1], metric);
}

/** A linear contrast Σ wᵢ·f(armᵢ) per complete cell, averaged within each task. */
function contrastDiffs(
  arms: readonly ArmCells[],
  weights: readonly number[],
  metric: AnalysisMetric,
): PairedDiffs {
  const transform = metricScale(metric) === 'ratio' ? Math.log : (x: number) => x;
  const usable = (x: number) => metricScale(metric) === 'difference' || x > 0;
  const first = arms[0] as ArmCells;
  const taskDiffs: number[] = [];
  const cellDiffs: number[][] = [];
  let cells = 0;

  for (const taskId of [...first.cells.keys()].sort()) {
    const perArm = arms.map((arm) => arm.cells.get(taskId));
    if (perArm.some((m) => m === undefined)) continue;
    const diffs: number[] = [];
    const repeats = [...(perArm[0] as Map<number, RunRecord>).keys()].sort((x, y) => x - y);
    for (const repeat of repeats) {
      const values = perArm.map((m) => {
        const record = (m as Map<number, RunRecord>).get(repeat);
        return record === undefined ? Number.NaN : metricValue(record, metric);
      });
      if (values.some((v) => !Number.isFinite(v) || !usable(v))) continue;
      let d = 0;
      values.forEach((v, i) => {
        d += (weights[i] as number) * transform(v);
      });
      diffs.push(d);
    }
    if (diffs.length === 0) continue;
    cells += diffs.length;
    cellDiffs.push(diffs);
    taskDiffs.push(diffs.reduce((acc, d) => acc + d, 0) / diffs.length);
  }
  return { taskDiffs, cellDiffs, cells };
}
