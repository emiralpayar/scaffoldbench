/**
 * The report's view-model: what a run set says, reduced to what is drawn.
 *
 * Two rules from the record format are applied here, once, so every section
 * of every rendering agrees:
 *
 *  - A run whose integrity failed, or that hit an API error, did not measure
 *    its architecture. It is counted under health and never ranked.
 *  - A run with no integrity at all predates the checks. It is ranked, but
 *    counted as unverified, never presented as healthy.
 *
 * The shapes are deliberately plain (estimates as `{ value, ci }`, verdicts
 * as better / worse / equivalent / inconclusive) so a richer analysis can be
 * mapped onto them and drawn by the same renderers.
 */

import { summarizeRuns } from '@arena/core';
import type { Integrity, RunRecord, RunSetManifest } from '@arena/core';

import type { Estimate, Interval, Pair } from './plots';
import { integrityFor } from './runSet';
import type { Catalog, LoadedRunSet } from './runSet';

export interface ArmView {
  strategyId: string;
  label: string;
  /** Runs ranked: healthy or unverified. */
  runs: number;
  score: Estimate;
  passRate: Estimate;
  costUsd: Estimate;
  latencyMs: Estimate;
  /** Mean score per dollar of mean cost; null when nothing was spent. */
  scorePerDollar: number | null;
  /** On the mean-cost / mean-score Pareto frontier. */
  frontier: boolean;
}

export interface ContrastView extends Pair {
  /** Mean score of `a` minus mean score of `b`. */
  estimate: number;
  ci: Interval | null;
}

export interface ModelView {
  model: string;
  /** Ranked by mean score, ties in catalog order. Every section uses this order. */
  arms: ArmView[];
  contrasts: ContrastView[];
  /** What the contrasts compare, in a phrase, so the report can say it. */
  contrastMethod: string;
  taskIds: string[];
  /** Mean score per task and strategy over the ranked runs. */
  scoreByTask: Map<string, Map<string, number>>;
  /** Every run of the model, ranked or not, by strategy and failure mode. */
  failureModes: Map<string, Map<string, number>>;
}

export interface CheckFailure {
  id: string;
  runs: number;
  byStrategy: Map<string, number>;
  /** One failing run's detail, so the reader sees what the check saw. */
  example: string | undefined;
}

export interface PhaseIssue {
  strategyId: string;
  phase: string;
  /** How the phase ended: an SDK subtype, an error message, or what it degraded to. */
  outcome: string;
  runs: number;
  /** Runs of that strategy that had this phase at all. */
  of: number;
}

export interface HealthView {
  runs: number;
  ranked: number;
  /** Not ranked: integrity failed or an API error. */
  excluded: number;
  integrityFailed: number;
  apiErrors: number;
  /** Ranked without integrity: recorded before the checks, and no trace to audit. */
  unverified: number;
  /** Integrity re-derived from the trace of a record that predates the checks. */
  audited: number;
  failingChecks: CheckFailure[];
  apiErrorKinds: { kind: string; runs: number; example: string }[];
  denied: { total: number; byStrategy: Map<string, number>; byTool: Map<string, number> };
  phaseIssues: PhaseIssue[];
  /** Runs that needed more than one attempt because of transient API failures. */
  retried: number;
}

export interface ReportView {
  runSetId: string | undefined;
  manifest: RunSetManifest | undefined;
  synthetic: boolean;
  health: HealthView;
  models: ModelView[];
  totals: { costUsd: number; judgeCostUsd: number; discardedCostUsd: number };
}

/** Why a run is left out of the rankings, or undefined when it is ranked. */
export function exclusionOf(record: RunRecord, integrity: Integrity | undefined): 'api_error' | 'integrity' | undefined {
  if (record.failureMode === 'api_error') return 'api_error';
  if (integrity && !integrity.ok) return 'integrity';
  return undefined;
}

export function buildReportView(runSet: Pick<LoadedRunSet, 'runSetId' | 'manifest' | 'catalog' | 'records' | 'audits' | 'deniedTools'>): ReportView {
  const { records, manifest, catalog } = runSet;
  const ranked = records.filter((record) => !exclusionOf(record, integrityFor(runSet, record)));

  const models = orderModels(
    manifest?.models ?? [],
    records.map((record) => record.model),
  ).map((model) =>
    modelView(
      model,
      ranked.filter((record) => record.model === model),
      records.filter((record) => record.model === model),
      catalog,
    ),
  );

  const discardedFromRecords = records.reduce((sum, r) => sum + (r.discardedCostUsd ?? 0), 0);
  return {
    runSetId: runSet.runSetId,
    manifest,
    synthetic: manifest?.synthetic === true,
    health: healthView(runSet),
    models,
    totals: {
      costUsd: records.reduce((sum, r) => sum + r.costUsd, 0),
      judgeCostUsd: records.reduce((sum, r) => sum + r.judgeCostUsd, 0),
      discardedCostUsd: manifest?.totalDiscardedCostUsd ?? discardedFromRecords,
    },
  };
}

// ---------------------------------------------------------------------------
// Per model
// ---------------------------------------------------------------------------

function modelView(
  model: string,
  ranked: readonly RunRecord[],
  all: readonly RunRecord[],
  catalog: Catalog,
): ModelView {
  const summary = summarizeRuns(ranked);
  const frontier = new Set(summary.paretoStrategyIds);
  const declared = new Map(catalog.strategies.map((info, index) => [info.id, index]));
  const order = (id: string) => declared.get(id) ?? catalog.strategies.length;

  const arms: ArmView[] = [...summary.strategies]
    .sort(
      (a, b) =>
        b.score.mean - a.score.mean ||
        order(a.strategyId) - order(b.strategyId) ||
        a.strategyId.localeCompare(b.strategyId),
    )
    .map((strategy) => ({
      strategyId: strategy.strategyId,
      label: catalog.strategies.find((info) => info.id === strategy.strategyId)?.label ?? strategy.strategyId,
      runs: strategy.runs,
      score: { value: strategy.score.mean, ci: { low: strategy.score.ciLow, high: strategy.score.ciHigh } },
      passRate: { value: strategy.passRate, ci: null },
      costUsd: { value: strategy.costUsd.mean, ci: { low: strategy.costUsd.ciLow, high: strategy.costUsd.ciHigh } },
      latencyMs: {
        value: strategy.latencyMs.mean,
        ci: { low: strategy.latencyMs.ciLow, high: strategy.latencyMs.ciHigh },
      },
      scorePerDollar: strategy.costUsd.mean > 0 ? strategy.scorePerDollar : null,
      frontier: frontier.has(strategy.strategyId),
    }));

  const contrasts: ContrastView[] = summary.pairwise.map((comparison) => ({
    a: comparison.a,
    b: comparison.b,
    verdict:
      comparison.verdict === 'a-better' ? 'better' : comparison.verdict === 'b-better' ? 'worse' : 'inconclusive',
    estimate: comparison.meanDelta,
    ci: null,
  }));

  const taskOrder = new Map(catalog.tasks.map((info, index) => [info.id, index]));
  const taskIds = [...new Set(ranked.map((record) => record.taskId))].sort(
    (a, b) =>
      (taskOrder.get(a) ?? catalog.tasks.length) - (taskOrder.get(b) ?? catalog.tasks.length) ||
      a.localeCompare(b),
  );
  const scoreByTask = new Map<string, Map<string, number>>();
  for (const cell of summary.cells) {
    const row = scoreByTask.get(cell.taskId) ?? new Map<string, number>();
    row.set(cell.strategyId, cell.meanScore);
    scoreByTask.set(cell.taskId, row);
  }

  const failureModes = new Map<string, Map<string, number>>();
  for (const record of all) {
    const row = failureModes.get(record.strategyId) ?? new Map<string, number>();
    row.set(record.failureMode, (row.get(record.failureMode) ?? 0) + 1);
    failureModes.set(record.strategyId, row);
  }

  return {
    model,
    arms,
    contrasts,
    contrastMethod: 'bootstrap intervals of the two means; overlapping intervals are inconclusive',
    taskIds,
    scoreByTask,
    failureModes,
  };
}

const MODEL_TIERS: readonly RegExp[] = [/haiku/i, /sonnet/i, /opus/i, /fable/i];

/** The manifest's order first, then cheapest model tier first, then by id. */
export function orderModels(declared: readonly string[], present: readonly string[]): string[] {
  const seen = new Set(present);
  const ordered = declared.filter((model, index) => seen.has(model) && declared.indexOf(model) === index);
  const tier = (model: string) => {
    const index = MODEL_TIERS.findIndex((pattern) => pattern.test(model));
    return index === -1 ? MODEL_TIERS.length : index;
  };
  const rest = [...seen]
    .filter((model) => !ordered.includes(model))
    .sort((a, b) => tier(a) - tier(b) || a.localeCompare(b));
  return [...ordered, ...rest];
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

function healthView(runSet: Pick<LoadedRunSet, 'records' | 'audits' | 'deniedTools'>): HealthView {
  const { records } = runSet;
  let integrityFailed = 0;
  let apiErrors = 0;
  let unverified = 0;
  let excluded = 0;
  const checks = new Map<string, CheckFailure>();
  const apiKinds = new Map<string, { kind: string; runs: number; example: string }>();

  for (const record of records) {
    const integrity = integrityFor(runSet, record);
    const exclusion = exclusionOf(record, integrity);
    if (exclusion) excluded += 1;
    if (exclusion === 'api_error') {
      apiErrors += 1;
      const kind = record.apiError?.kind ?? 'unknown';
      const entry = apiKinds.get(kind) ?? { kind, runs: 0, example: record.apiError?.message ?? record.error ?? '' };
      entry.runs += 1;
      apiKinds.set(kind, entry);
    } else if (exclusion === 'integrity') {
      integrityFailed += 1;
    }
    if (!integrity && !exclusion) unverified += 1;

    // An API error fails `harness.api` by definition; listing it again as a
    // failing check would count the same failure twice.
    if (!integrity || exclusion === 'api_error') continue;
    for (const check of integrity.checks) {
      if (check.ok) continue;
      const entry = checks.get(check.id) ?? { id: check.id, runs: 0, byStrategy: new Map(), example: check.detail };
      entry.runs += 1;
      entry.byStrategy.set(record.strategyId, (entry.byStrategy.get(record.strategyId) ?? 0) + 1);
      checks.set(check.id, entry);
    }
  }

  const deniedByStrategy = new Map<string, number>();
  const deniedByTool = new Map<string, number>();
  let deniedTotal = 0;
  for (const record of records) {
    if (record.deniedToolCalls <= 0) continue;
    deniedTotal += record.deniedToolCalls;
    deniedByStrategy.set(record.strategyId, (deniedByStrategy.get(record.strategyId) ?? 0) + record.deniedToolCalls);
    for (const tool of runSet.deniedTools.get(record.runId) ?? []) {
      deniedByTool.set(tool, (deniedByTool.get(tool) ?? 0) + 1);
    }
  }

  return {
    runs: records.length,
    ranked: records.length - excluded,
    excluded,
    integrityFailed,
    apiErrors,
    unverified,
    audited: records.filter((record) => !record.integrity && runSet.audits.has(record.runId)).length,
    failingChecks: [...checks.values()].sort((a, b) => b.runs - a.runs || a.id.localeCompare(b.id)),
    apiErrorKinds: [...apiKinds.values()].sort((a, b) => b.runs - a.runs),
    denied: { total: deniedTotal, byStrategy: deniedByStrategy, byTool: deniedByTool },
    phaseIssues: phaseIssues(records),
    retried: records.filter((record) => (record.attempts ?? 1) > 1).length,
  };
}

/**
 * Phases that did not simply succeed, grouped by strategy, phase and
 * outcome. Informational: running out of turns while acting on the task is
 * a legitimate way to lose, and only the integrity checks decide what is
 * excluded. But a planner that failed in every run is the first thing a
 * reader of the first published run set would have wanted to see.
 */
function phaseIssues(records: readonly RunRecord[]): PhaseIssue[] {
  const totals = new Map<string, number>();
  const issues = new Map<string, PhaseIssue>();
  for (const record of records) {
    const seen = new Set<string>();
    for (const phase of record.phases) {
      const key = `${record.strategyId}␟${phase.phase}`;
      if (!seen.has(key)) {
        seen.add(key);
        totals.set(key, (totals.get(key) ?? 0) + 1);
      }
      // API failures are reported as such, not as phase trouble.
      if (phase.apiError) continue;
      const outcome = phaseOutcome(phase);
      if (outcome === undefined) continue;
      const issueKey = `${key}␟${outcome}`;
      const issue =
        issues.get(issueKey) ?? { strategyId: record.strategyId, phase: phase.phase, outcome, runs: 0, of: 0 };
      issue.runs += 1;
      issues.set(issueKey, issue);
    }
  }
  for (const issue of issues.values()) {
    issue.of = totals.get(`${issue.strategyId}␟${issue.phase}`) ?? issue.runs;
  }
  return [...issues.values()].sort(
    (a, b) => b.runs - a.runs || a.strategyId.localeCompare(b.strategyId) || a.phase.localeCompare(b.phase),
  );
}

function phaseOutcome(phase: RunRecord['phases'][number]): string | undefined {
  if (phase.degraded !== undefined) return `degraded: ${phase.degraded}`;
  if (phase.structuredMissing) return `no structured output (${phase.subtype ?? 'no result'})`;
  if (phase.subtype !== undefined && phase.subtype !== 'success') return phase.subtype;
  if (phase.error !== undefined) return phase.error.replace(/^Claude Code returned an error result:\s*/, '');
  return undefined;
}
