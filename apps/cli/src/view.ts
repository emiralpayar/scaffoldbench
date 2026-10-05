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
 * Every number and verdict comes from core's `analyzeRunSet` (docs/STATISTICS.md):
 * arms carry task-clustered intervals, and contrasts are paired by task and
 * repeat and Holm-adjusted. The shapes here are deliberately plain (estimates
 * as `{ value, ci }`, verdicts as better / worse / equivalent / inconclusive)
 * so the renderers need to know nothing about the method; `ci` is null where
 * the data cannot support an interval, and a `caveat` says why.
 */

import { analyzeRunSet, orderModels as orderModelsByTier } from '@scaffoldbench/core';
import type {
  AnalysisSettings,
  Contrast,
  ContrastCaveat,
  Integrity,
  ModelAnalysis,
  RunRecord,
  RunSetAnalysis,
  RunSetManifest,
  StrategyAnalysis,
} from '@scaffoldbench/core';

import type { Estimate, Interval, Pair, Verdict } from './plots';
import { integrityFor } from './runSet';
import type { Catalog, LoadedRunSet } from './runSet';

export interface ArmView {
  strategyId: string;
  label: string;
  /** Runs ranked: healthy, one per (task, repeat) cell. Unverified runs count. */
  runs: number;
  /** Of those, how many passed. */
  passed: number;
  /** Mean of per-task means, with a task-clustered bootstrap interval. */
  score: Estimate;
  /** Mean of per-task pass rates, with a Wilson interval on the effective run count. */
  passRate: Estimate;
  costUsd: Estimate;
  latencyMs: Estimate;
  /** Mean score per dollar of mean cost; null when nothing was spent. */
  scorePerDollar: number | null;
  /**
   * On the Pareto frontier: not behind any other arm on point estimates, and
   * not shown to be by the paired verdicts either.
   */
  frontier: boolean;
  /**
   * Point estimates put another arm ahead on score or cost, but the paired
   * verdicts do not separate them, so it stays off the dominated list: a tie,
   * not a place on the frontier.
   */
  frontierTied: boolean;
}

/** What a paired contrast says, on the scale of its metric. */
export interface PairedView {
  /** A difference for score (a minus b); a ratio for cost (a over b). */
  estimate: number;
  /** Null when the data cannot support an interval; see `caveat`. */
  ci: Interval | null;
  /** From the point of view of `a`; for cost, `better` means cheaper. */
  verdict: Verdict;
  /** What the data withheld, when it withheld anything. */
  caveat?: ContrastCaveat;
  /** Holm-adjusted p for "no difference"; the verdict uses it. */
  pAdjusted: number | null;
  /** Tasks behind the estimate: the unit that was resampled. */
  tasks: number;
}

/** Two strategies compared on score, `a` minus `b`. */
export interface ContrastView extends Pair, PairedView {}

/** A strategy against the model's baseline: the primary, pre-registerable family. */
export interface BaselineView {
  strategyId: string;
  /** Score difference, strategy minus baseline. */
  score: PairedView | undefined;
  /** Cost ratio, strategy over baseline. */
  cost: PairedView | undefined;
}

export interface ModelView {
  model: string;
  /** Ranked by mean score, ties in catalog order. Every section uses this order. */
  arms: ArmView[];
  /** Every pair of strategies on score (paired, Holm-adjusted); the pairwise grid. */
  contrasts: ContrastView[];
  /** What the contrasts compare, in a phrase, so the report can say it. */
  contrastMethod: string;
  /** The baseline strategy, when this model ran it; `vsBaseline` is empty otherwise. */
  baseline: string | undefined;
  /** Each other strategy against the baseline, in leaderboard order. */
  vsBaseline: BaselineView[];
  taskIds: string[];
  /** Mean score per task and strategy over the ranked runs. */
  scoreByTask: Map<string, Map<string, number>>;
  /** Every run of the model, ranked or not, by strategy and failure mode. */
  failureModes: Map<string, Map<string, number>>;
}

/**
 * Scaffold or Scale?: every strategy on a smaller model against the baseline
 * on the next model up. Better score at lower cost means the scaffold bought
 * more than the upgrade, for less.
 */
export interface ScaleView {
  model: string;
  nextModel: string;
  /** The strategy on `nextModel` that every row is compared with. */
  baseline: string;
  rows: BaselineView[];
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
  /**
   * Healthy runs of a (task, repeat) cell that already had one. The analysis
   * keeps the later run, so these are ranked in the counts but not analysed.
   */
  duplicates: number;
  /**
   * Calls that ended because the model could not finish the turn (out of
   * room, a refusal). The run's own limit, not a harness fault: these runs
   * stay ranked, so this is where they are counted.
   */
  modelStops: { runs: number; calls: number; byReason: Map<string, number>; byCategory: Map<string, number> };
}

export interface ReportView {
  runSetId: string | undefined;
  manifest: RunSetManifest | undefined;
  synthetic: boolean;
  health: HealthView;
  models: ModelView[];
  /** One group per pair of neighbouring models; empty for a single-model run set. */
  scale: ScaleView[];
  /** How the vs-baseline and scale contrasts were made, as a phrase after "Compared by". */
  method: string;
  /** The echo of the analysis options, for a report that cites them. */
  settings: Pick<AnalysisSettings, 'alpha' | 'iterations' | 'baseline' | 'margins' | 'minTasks'>;
  totals: { costUsd: number; judgeCostUsd: number; discardedCostUsd: number };
}

/** Why a run is left out of the rankings, or undefined when it is ranked. */
export function exclusionOf(record: RunRecord, integrity: Integrity | undefined): 'api_error' | 'integrity' | undefined {
  if (record.failureMode === 'api_error') return 'api_error';
  if (integrity && !integrity.ok) return 'integrity';
  return undefined;
}

export interface ViewOptions {
  /** The strategy the others are compared with. Default `single`, the plain agent. */
  baseline?: string;
}

export function buildReportView(
  runSet: Pick<LoadedRunSet, 'runSetId' | 'manifest' | 'catalog' | 'records' | 'audits' | 'deniedTools'>,
  options: ViewOptions = {},
): ReportView {
  const { records, manifest, catalog } = runSet;
  const ranked = records.filter((record) => !exclusionOf(record, integrityFor(runSet, record)));

  const modelIds = orderModels(
    manifest?.models ?? [],
    records.map((record) => record.model),
  );
  // Core excludes failed-integrity and API-error runs itself, so it is handed
  // every record with the integrity this report went by: a legacy record's own
  // absence is replaced by the audit of its trace, when there is one.
  const analysis = analyzeRunSet(
    records.map((record) => {
      const integrity = integrityFor(runSet, record);
      return integrity === record.integrity ? record : { ...record, integrity };
    }),
    { modelOrder: modelIds, ...(options.baseline ? { baseline: options.baseline } : {}) },
  );
  const { settings } = analysis;

  const models = modelIds.map((model) =>
    modelView(
      model,
      analysis.models.find((candidate) => candidate.model === model),
      settings,
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
    health: healthView(runSet, analysis.health.duplicates),
    models,
    scale: scaleViews(analysis, models),
    method:
      `${methodPhrase(settings, 'score differences and cost ratios')}; ` +
      `≈ means shown to lie within ±${settings.margins.score} of score or ×/÷${settings.margins.cost} of cost`,
    settings: {
      alpha: settings.alpha,
      iterations: settings.iterations,
      baseline: settings.baseline,
      margins: settings.margins,
      minTasks: settings.minTasks,
    },
    totals: {
      costUsd: records.reduce((sum, r) => sum + r.costUsd, 0),
      judgeCostUsd: records.reduce((sum, r) => sum + r.judgeCostUsd, 0),
      discardedCostUsd: manifest?.totalDiscardedCostUsd ?? discardedFromRecords,
    },
  };
}

// ---------------------------------------------------------------------------
// Method
// ---------------------------------------------------------------------------

/**
 * The method in a phrase to follow "Compared by". `what` names the quantities
 * ("score differences"). Holm adjusts within a family of contrasts: one kind,
 * one metric, every model (docs/STATISTICS.md §3.5).
 */
function methodPhrase(settings: AnalysisSettings, what: string): string {
  const level = Math.round((1 - settings.alpha) * 100);
  return (
    `paired ${what} per task and repeat, a task-clustered bootstrap (${settings.iterations.toLocaleString('en-US')} draws) ` +
    `for ${level}% intervals, Holm-adjusted verdicts`
  );
}

// ---------------------------------------------------------------------------
// Per model
// ---------------------------------------------------------------------------

const paired = (contrast: Contrast | undefined): PairedView | undefined =>
  contrast && {
    estimate: contrast.estimate,
    ci: contrast.ci,
    verdict: contrast.verdict,
    pAdjusted: contrast.pAdjusted,
    tasks: contrast.tasks,
    ...(contrast.caveat ? { caveat: contrast.caveat } : {}),
  };

function modelView(
  model: string,
  analysis: ModelAnalysis | undefined,
  settings: AnalysisSettings,
  ranked: readonly RunRecord[],
  all: readonly RunRecord[],
  catalog: Catalog,
): ModelView {
  const strategies: readonly StrategyAnalysis[] = analysis?.strategies ?? [];
  const frontier = new Map((analysis?.frontier ?? []).map((entry) => [entry.arm.strategyId, entry.status]));
  const declared = new Map(catalog.strategies.map((info, index) => [info.id, index]));
  const order = (id: string) => declared.get(id) ?? catalog.strategies.length;

  const arms: ArmView[] = [...strategies]
    .sort(
      (a, b) =>
        b.score.value - a.score.value ||
        order(a.strategyId) - order(b.strategyId) ||
        a.strategyId.localeCompare(b.strategyId),
    )
    .map((strategy) => ({
      strategyId: strategy.strategyId,
      label: catalog.strategies.find((info) => info.id === strategy.strategyId)?.label ?? strategy.strategyId,
      runs: strategy.runs,
      passed: strategy.passRate.passed,
      score: { value: strategy.score.value, ci: strategy.score.ci },
      passRate: { value: strategy.passRate.value, ci: strategy.passRate.ci },
      costUsd: { value: strategy.costUsd.value, ci: strategy.costUsd.ci },
      latencyMs: { value: strategy.latencyMs.value, ci: strategy.latencyMs.ci },
      scorePerDollar: strategy.costUsd.value > 0 ? strategy.score.value / strategy.costUsd.value : null,
      frontier: frontier.get(strategy.strategyId) === 'frontier',
      frontierTied: frontier.get(strategy.strategyId) === 'tied',
    }));

  // The grid reads score; `a` and `b` are in core's order, and the grid flips
  // a verdict read from the other side.
  const contrasts: ContrastView[] = (analysis?.pairwise ?? [])
    .filter((contrast) => contrast.metric === 'score')
    .map((contrast) => ({
      a: contrast.a.strategyId,
      b: contrast.b.strategyId,
      ...(paired(contrast) as PairedView),
    }));

  const vsBaseline = analysis?.vsBaseline ?? [];
  const baseline = arms.some((arm) => arm.strategyId === settings.baseline) ? settings.baseline : undefined;
  const againstBaseline = (metric: 'score' | 'cost', strategyId: string) =>
    paired(vsBaseline.find((contrast) => contrast.metric === metric && contrast.a.strategyId === strategyId));

  const taskOrder = new Map(catalog.tasks.map((info, index) => [info.id, index]));
  const taskIds = [...new Set(ranked.map((record) => record.taskId))].sort(
    (a, b) =>
      (taskOrder.get(a) ?? catalog.tasks.length) - (taskOrder.get(b) ?? catalog.tasks.length) ||
      a.localeCompare(b),
  );
  // Mean score per (task, strategy) over the ranked runs.
  const scoreByTask = new Map<string, Map<string, number>>();
  const tally = new Map<string, Map<string, { total: number; count: number }>>();
  for (const record of ranked) {
    const row = tally.get(record.taskId) ?? new Map<string, { total: number; count: number }>();
    const cell = row.get(record.strategyId) ?? { total: 0, count: 0 };
    cell.total += record.score;
    cell.count += 1;
    row.set(record.strategyId, cell);
    tally.set(record.taskId, row);
  }
  for (const [taskId, row] of tally) {
    scoreByTask.set(taskId, new Map([...row].map(([strategyId, { total, count }]) => [strategyId, total / count])));
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
    contrastMethod:
      `${methodPhrase(settings, 'score differences')}; ≈ means shown to lie within ±${settings.margins.score}`,
    baseline,
    vsBaseline: baseline
      ? arms
          .filter((arm) => arm.strategyId !== baseline)
          .map((arm) => ({
            strategyId: arm.strategyId,
            score: againstBaseline('score', arm.strategyId),
            cost: againstBaseline('cost', arm.strategyId),
          }))
      : [],
    taskIds,
    scoreByTask,
    failureModes,
  };
}

/** One group per neighbouring pair of models, rows in the smaller model's leaderboard order. */
function scaleViews(analysis: RunSetAnalysis, models: readonly ModelView[]): ScaleView[] {
  const views: ScaleView[] = [];
  const { modelOrder } = analysis.settings;
  for (let index = 0; index + 1 < modelOrder.length; index++) {
    const model = modelOrder[index] as string;
    const nextModel = modelOrder[index + 1] as string;
    const contrasts = analysis.scaffoldOrScale.filter((c) => c.a.model === model && c.b.model === nextModel);
    const first = contrasts[0];
    if (!first) continue;
    const order = models.find((candidate) => candidate.model === model)?.arms.map((arm) => arm.strategyId) ?? [];
    const rows = [...new Set(contrasts.map((c) => c.a.strategyId))]
      .sort((a, b) => order.indexOf(a) - order.indexOf(b))
      .map((strategyId) => {
        const of = (metric: 'score' | 'cost') =>
          paired(contrasts.find((c) => c.metric === metric && c.a.strategyId === strategyId));
        return { strategyId, score: of('score'), cost: of('cost') };
      });
    views.push({ model, nextModel, baseline: first.b.strategyId, rows });
  }
  return views;
}

/** The manifest's order first, then cheapest model tier first, then by id. */
export function orderModels(declared: readonly string[], present: readonly string[]): string[] {
  return orderModelsByTier([...new Set(present)], declared);
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

function healthView(runSet: Pick<LoadedRunSet, 'records' | 'audits' | 'deniedTools'>, duplicates: number): HealthView {
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

  const stopsByReason = new Map<string, number>();
  const stopsByCategory = new Map<string, number>();
  let stopRuns = 0;
  let stopCalls = 0;
  for (const record of records) {
    const stops = record.modelStops ?? [];
    if (stops.length === 0) continue;
    stopRuns += 1;
    stopCalls += stops.length;
    for (const stop of stops) {
      stopsByReason.set(stop.reason, (stopsByReason.get(stop.reason) ?? 0) + 1);
      if (stop.category) stopsByCategory.set(stop.category, (stopsByCategory.get(stop.category) ?? 0) + 1);
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
    duplicates,
    modelStops: { runs: stopRuns, calls: stopCalls, byReason: stopsByReason, byCategory: stopsByCategory },
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
