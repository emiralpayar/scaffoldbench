/**
 * Report-time reductions of run records.
 *
 * Two layers live behind this module. `analyzeRunSet` (re-exported from
 * `analysis.ts`) is the inference: paired, task-clustered contrasts with
 * four-way verdicts, per model. `summarizeRuns` is the older descriptive
 * summary the site and CLI were built on; it is kept working, but its
 * pairwise verdicts compare marginal intervals and should not be cited.
 */

import { exclusionReasons } from './analysisData';
import { aggregate, comparisonVerdict, paretoFrontier } from './stats';
import type { Aggregate, Verdict } from './stats';
import type { FailureMode, RunRecord, TaskCategory } from './types';

export * from './analysis';
export * from './analysisInference';
export { uncertainFrontier } from './analysisPareto';
export type { FrontierCandidate, FrontierResult } from './analysisPareto';

/** Everything the site needs about one strategy, precomputed at report time. */
export interface StrategySummary {
  strategyId: string;
  runs: number;
  score: Aggregate;
  costUsd: Aggregate;
  latencyMs: Aggregate;
  turns: Aggregate;
  toolCalls: Aggregate;
  passRate: number;
  /** Mean score per US dollar. The number nobody publishes and everybody needs. */
  scorePerDollar: number;
  totalCostUsd: number;
  failureModes: Record<string, number>;
  deniedToolCalls: number;
}

export interface CellSummary {
  strategyId: string;
  taskId: string;
  runs: number;
  meanScore: number;
  passRate: number;
  meanCostUsd: number;
  meanLatencyMs: number;
  failureModes: Record<string, number>;
}

export interface PairwiseComparison {
  a: string;
  b: string;
  verdict: Verdict;
  meanDelta: number;
}

export interface ReportSummary {
  strategies: StrategySummary[];
  cells: CellSummary[];
  pairwise: PairwiseComparison[];
  paretoStrategyIds: string[];
  byCategory: Record<TaskCategory, StrategySummary[]>;
  totals: {
    runs: number;
    costUsd: number;
    judgeCostUsd: number;
    failureModes: Record<string, number>;
    /**
     * Runs left out of every ranking above because they failed an integrity
     * check or hit an `api_error`. They still count in `runs` and the costs.
     */
    excludedRuns: number;
  };
}

function countFailureModes(records: readonly RunRecord[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const record of records) {
    const key: FailureMode = record.failureMode;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function summarizeStrategy(strategyId: string, records: readonly RunRecord[]): StrategySummary {
  const scores = records.map((r) => r.score);
  const costs = records.map((r) => r.costUsd);
  const totalCostUsd = costs.reduce((acc, c) => acc + c, 0);
  const meanScore = scores.length === 0 ? 0 : scores.reduce((a, b) => a + b, 0) / scores.length;
  const meanCost = costs.length === 0 ? 0 : totalCostUsd / costs.length;

  return {
    strategyId,
    runs: records.length,
    score: aggregate(scores),
    costUsd: aggregate(costs),
    latencyMs: aggregate(records.map((r) => r.latencyMs)),
    turns: aggregate(records.map((r) => r.turns)),
    toolCalls: aggregate(records.map((r) => r.toolCalls)),
    passRate: records.length === 0 ? 0 : records.filter((r) => r.passed).length / records.length,
    scorePerDollar: meanCost > 0 ? meanScore / meanCost : 0,
    totalCostUsd,
    failureModes: countFailureModes(records),
    deniedToolCalls: records.reduce((acc, r) => acc + r.deniedToolCalls, 0),
  };
}

function groupBy<T, K extends string>(items: readonly T[], key: (item: T) => K): Map<K, T[]> {
  const map = new Map<K, T[]>();
  for (const item of items) {
    const k = key(item);
    const bucket = map.get(k);
    if (bucket) bucket.push(item);
    else map.set(k, [item]);
  }
  return map;
}

/**
 * Reduce raw run records into everything the leaderboard, matrix and Pareto
 * views need. Done once at report time so the site stays a pure renderer.
 *
 * Descriptive: runs are pooled across tasks and models, intervals treat runs
 * as independent, and `pairwise` compares marginal intervals. Use
 * `analyzeRunSet` for anything that claims one strategy beats another. Like
 * it, this leaves runs that failed an integrity check or hit an `api_error`
 * out of every ranking; `totals` still counts them.
 */
export function summarizeRuns(allRecords: readonly RunRecord[]): ReportSummary {
  const records = allRecords.filter((r) => exclusionReasons(r, ['api_error']).length === 0);
  const byStrategy = groupBy(records, (r) => r.strategyId);
  const strategies = [...byStrategy.entries()]
    .map(([id, rows]) => summarizeStrategy(id, rows))
    .sort((a, b) => b.score.mean - a.score.mean);

  const cells: CellSummary[] = [];
  for (const [strategyId, strategyRows] of byStrategy) {
    for (const [taskId, rows] of groupBy(strategyRows, (r) => r.taskId)) {
      cells.push({
        strategyId,
        taskId,
        runs: rows.length,
        meanScore: rows.reduce((a, r) => a + r.score, 0) / rows.length,
        passRate: rows.filter((r) => r.passed).length / rows.length,
        meanCostUsd: rows.reduce((a, r) => a + r.costUsd, 0) / rows.length,
        meanLatencyMs: rows.reduce((a, r) => a + r.latencyMs, 0) / rows.length,
        failureModes: countFailureModes(rows),
      });
    }
  }
  cells.sort((a, b) => a.strategyId.localeCompare(b.strategyId) || a.taskId.localeCompare(b.taskId));

  const pairwise: PairwiseComparison[] = [];
  for (let i = 0; i < strategies.length; i++) {
    for (let j = i + 1; j < strategies.length; j++) {
      const a = strategies[i];
      const b = strategies[j];
      if (!a || !b) continue;
      pairwise.push({
        a: a.strategyId,
        b: b.strategyId,
        verdict: comparisonVerdict(a.score, b.score),
        meanDelta: a.score.mean - b.score.mean,
      });
    }
  }

  const frontier = paretoFrontier(
    strategies,
    (s) => s.score.mean,
    (s) => s.costUsd.mean,
  );

  const byCategory = {} as Record<TaskCategory, StrategySummary[]>;
  for (const category of ['tool-use', 'research'] as TaskCategory[]) {
    const subset = records.filter((r) => r.taskCategory === category);
    byCategory[category] = [...groupBy(subset, (r) => r.strategyId).entries()]
      .map(([id, rows]) => summarizeStrategy(id, rows))
      .sort((a, b) => b.score.mean - a.score.mean);
  }

  return {
    strategies,
    cells,
    pairwise,
    paretoStrategyIds: frontier.map((s) => s.strategyId),
    byCategory,
    totals: {
      runs: allRecords.length,
      costUsd: allRecords.reduce((acc, r) => acc + r.costUsd, 0),
      judgeCostUsd: allRecords.reduce((acc, r) => acc + r.judgeCostUsd, 0),
      failureModes: countFailureModes(allRecords),
      excludedRuns: allRecords.length - records.length,
    },
  };
}
