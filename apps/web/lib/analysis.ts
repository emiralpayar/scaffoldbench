/**
 * The statistics the charts draw, as one view model: per-model architecture
 * summaries, paired contrasts against the `single` control, "scaffold or
 * scale" contrasts across model tiers, and a health summary.
 *
 * A thin adapter over `analyzeRunSet` in `@scaffoldbench/core` (method:
 * docs/STATISTICS.md). Nothing is computed here that core does not compute:
 * the intervals, the paired contrasts, the Holm adjustment, the verdicts and
 * the uncertainty-aware frontier are core's, reshaped into what the pages
 * read. What stays here is bookkeeping: canonical architecture and model
 * order, ranks read off the verdicts, and the health counts.
 *
 * An interval is `null` where core withheld it (one task, or every task moved
 * by the same amount), and a `caveat` says why a verdict was withheld or
 * limited. Neither is ever replaced by a zero-width interval.
 *
 * Pure: no filesystem, safe anywhere.
 */

import { analyzeRunSet, paretoFrontier } from '@scaffoldbench/core';
import type {
  AnalysisOptions as CoreAnalysisOptions,
  AnalysisSettings,
  Contrast,
  ContrastCaveat,
  ContrastVerdict,
  Estimate as CoreEstimate,
  InteractionContrast as CoreInteraction,
  ModelAnalysis as CoreModelAnalysis,
  StrategyAnalysis,
} from '@scaffoldbench/core';

import { BASELINE_ID, compareArchitectures } from './architectures';
import { compareModels } from './models';
import type { RunRecord } from './records';
import { hasIntegrity, isRankable } from './records';

export type { ContrastCaveat };

export interface Interval {
  low: number;
  high: number;
}

/** A point estimate and its interval; `ci` is null where the data cannot support one. */
export interface Estimate {
  mean: number;
  ci: Interval | null;
}

export type PairedVerdict = ContrastVerdict;

export interface ArchitectureSummary {
  strategyId: string;
  /** Rankable runs, one per (task, repeat) cell. */
  runs: number;
  tasks: number;
  /** Mean of per-task mean scores, task-clustered bootstrap interval. */
  score: Estimate;
  /** Mean of per-task pass rates, Wilson interval on the effective run count. */
  passRate: Estimate;
  costUsd: Estimate;
  latencyMs: Estimate;
}

export interface BaselineContrast {
  strategyId: string;
  baselineId: string;
  /** Matched (task, repeat) cells the score contrast is computed over. */
  pairs: number;
  tasks: number;
  /** Mean paired score difference, architecture minus baseline. */
  scoreDelta: Estimate;
  /** Geometric mean of per-cell cost ratios, architecture over baseline. */
  costRatio: Estimate;
  latencyRatio: Estimate;
  /** On score, Holm-adjusted within the family of contrasts with the baseline. */
  verdict: PairedVerdict;
  /** What the data withheld from the score verdict, if anything. */
  caveat?: ContrastCaveat;
  /** For cost and latency `better` means cheaper or faster. */
  costVerdict: PairedVerdict;
  latencyVerdict: PairedVerdict;
  /** Holm-adjusted p for "no score difference"; null where no test was possible. */
  pAdjusted: number | null;
}

/**
 * Two architectures on the same model, paired by task and repeat, on score.
 * `winner` follows the verdict: `a` when it is better, `b` when it is worse,
 * `tie` for equivalent and inconclusive alike.
 */
export interface PairContrast {
  a: string;
  b: string;
  pairs: number;
  tasks: number;
  /** Mean paired score difference, a minus b. */
  scoreDelta: Estimate;
  verdict: PairedVerdict;
  caveat?: ContrastCaveat;
  winner: 'a' | 'b' | 'tie';
}

/**
 * A rank that shows ties as ties: one plus the number of architectures that
 * score reliably above this one. Two architectures share a rank when neither
 * is reliably above anything the other is not; the leaderboard draws that as
 * "=1", never as an order the data does not support.
 */
export interface RankEntry {
  strategyId: string;
  rank: number;
  /** Another architecture holds the same rank. */
  tied: boolean;
  /** Architectures that score reliably above this one. */
  below: string[];
  /** Architectures this one scores reliably above. */
  above: string[];
}

export interface ModelAnalysis {
  model: string;
  architectures: ArchitectureSummary[];
  /** One per non-baseline architecture that shares tasks with the baseline. */
  contrasts: BaselineContrast[];
  /** Every pair of architectures that share tasks. */
  pairwise: PairContrast[];
  /** In rank order; within a rank, by mean score. */
  ranks: RankEntry[];
  /**
   * Not shown to be beaten: no other architecture is significantly better on
   * one of score and cost and at least equivalent on the other. Includes
   * `frontierTied`.
   */
  frontier: string[];
  /** Behind another architecture on point estimates, but nothing separates them. */
  frontierTied: string[];
  /**
   * The frontier of mean score and mean cost alone, ignoring the evidence. It
   * is all a run set without fidelity checks can show: a description of what
   * ran, which supports no verdict about the designs.
   */
  meanFrontier: string[];
  health: RunSetHealth;
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
  caveat?: ContrastCaveat;
  /** `better` means cheaper than the baseline on the larger model. */
  costVerdict: PairedVerdict;
}

/**
 * Does an architecture's gain over `single` differ between two models? The
 * estimate is (gain on the first model) minus (gain on the second).
 */
export interface InteractionContrast {
  strategyId: string;
  models: [string, string];
  pairs: number;
  tasks: number;
  delta: Estimate;
  verdict: PairedVerdict;
  caveat?: ContrastCaveat;
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
  /** 1 − alpha: the level of every interval. */
  confidence: number;
  /** Half-width of the equivalence band on score differences. */
  margin: number;
  /** The options core ran with, for citing. */
  settings: AnalysisSettings;
  /** A paragraph a chart caption can quote verbatim; describes what core did. */
  method: string;
  models: ModelAnalysis[];
  scale: ScaleContrast[];
  /** Score interactions, cheapest model against the most capable. */
  interactions: InteractionContrast[];
  health: RunSetHealth;
}

/** Core's options: `baseline`, `margins`, `alpha`, `iterations`, `seed`, `minTasks`, … */
export type AnalysisOptions = CoreAnalysisOptions;

export function analyzeForSite(
  records: readonly RunRecord[],
  options: AnalysisOptions = {},
): SiteAnalysis {
  const modelOrder = [...new Set(records.map((record) => record.model))].sort(compareModels);
  // Core does the excluding (failed integrity, API errors) and counts what it
  // left out; `summarizeHealth` below counts the same records for the pages.
  const core = analyzeRunSet(records, { baseline: BASELINE_ID, modelOrder, ...options });
  const { settings } = core;

  const models = core.models
    // A model whose every run was excluded has nothing to show.
    .filter((model) => model.strategies.length > 0)
    .map((model) => modelAnalysis(model, records, settings));

  return {
    baselineId: settings.baseline,
    confidence: 1 - settings.alpha,
    margin: settings.margins.score,
    settings,
    method: describeMethod(settings),
    models,
    scale: scaleContrasts(core.scaffoldOrScale),
    interactions: core.interactions
      .filter((contrast) => contrast.metric === 'score')
      .map(interactionContrast)
      .sort((a, b) => compareArchitectures(a.strategyId, b.strategyId)),
    health: summarizeHealth(records),
  };
}

/**
 * What core did, in plain words and with this run's settings, for the
 * methodology page and every chart caption.
 */
export function describeMethod(settings: AnalysisSettings): string {
  const pct = Math.round((1 - settings.alpha) * 100);
  const { margins } = settings;
  return (
    `Every number is a mean over tasks, not runs: whole tasks are resampled (a cluster bootstrap of ` +
    `${settings.iterations.toLocaleString('en-US')} replicates), so a task's repeats stay together and the ${pct}% ` +
    `intervals are as wide as the tasks make them. Architectures are compared in pairs on the cells both ran, the ` +
    `same task and the same repeat: score differences are differences of means, cost and latency are ` +
    `geometric-mean ratios, and for them “better” means cheaper or faster. Each verdict comes from tests, not ` +
    `from whether two intervals overlap, and is Holm-adjusted within its family (one kind of contrast on one ` +
    `metric, across every model) to hold the chance of any false call in a family at ${100 - pct}%; so a verdict ` +
    `can read “not separable” while the unadjusted interval excludes zero. “Equivalent” means two one-sided ` +
    `tests show the difference within ±${margins.score.toFixed(2)} of score (×/÷${margins.cost} for cost and ` +
    `latency). With fewer than ${settings.minTasks} tasks no verdict is drawn, and where every task moved by ` +
    `the same amount there is no interval, which the table says instead of printing a zero-width one.`
  );
}

// ---------------------------------------------------------------------------
// From core to the site's shapes
// ---------------------------------------------------------------------------

const estimateOf = (estimate: CoreEstimate): Estimate => ({ mean: estimate.value, ci: estimate.ci });

/** A contrast core could not form (say, no positive costs to take a ratio of). */
const NONE: Estimate = { mean: Number.NaN, ci: null };

const contrastEstimate = (contrast: Contrast | undefined): Estimate =>
  contrast ? { mean: contrast.estimate, ci: contrast.ci } : NONE;

function summarize(strategy: StrategyAnalysis): ArchitectureSummary {
  return {
    strategyId: strategy.strategyId,
    runs: strategy.runs,
    tasks: strategy.tasks,
    score: estimateOf(strategy.score),
    passRate: estimateOf(strategy.passRate),
    costUsd: estimateOf(strategy.costUsd),
    latencyMs: estimateOf(strategy.latencyMs),
  };
}

function modelAnalysis(
  model: CoreModelAnalysis,
  records: readonly RunRecord[],
  settings: AnalysisSettings,
): ModelAnalysis {
  // Canonical architecture order: the reading order does not move with the scores.
  const architectures = model.strategies.map(summarize).sort((a, b) => compareArchitectures(a.strategyId, b.strategyId));

  const contrasts = model.vsBaseline
    .filter((contrast) => contrast.metric === 'score')
    .map((score): BaselineContrast => {
      const same = (metric: 'cost' | 'latency') =>
        model.vsBaseline.find((c) => c.metric === metric && c.a.strategyId === score.a.strategyId);
      const cost = same('cost');
      const latency = same('latency');
      return {
        strategyId: score.a.strategyId,
        baselineId: settings.baseline,
        pairs: score.cells,
        tasks: score.tasks,
        scoreDelta: contrastEstimate(score),
        costRatio: contrastEstimate(cost),
        latencyRatio: contrastEstimate(latency),
        verdict: score.verdict,
        ...(score.caveat ? { caveat: score.caveat } : {}),
        costVerdict: cost?.verdict ?? 'inconclusive',
        latencyVerdict: latency?.verdict ?? 'inconclusive',
        pAdjusted: score.pAdjusted,
      };
    })
    .sort((a, b) => compareArchitectures(a.strategyId, b.strategyId));

  const pairwise = model.pairwise
    .filter((contrast) => contrast.metric === 'score')
    .map(pairContrast)
    .sort((a, b) => compareArchitectures(a.a, b.a) || compareArchitectures(a.b, b.b));

  const onFrontier = model.frontier.filter((entry) => entry.status !== 'dominated');

  return {
    model: model.model,
    architectures,
    contrasts,
    pairwise,
    ranks: rankArchitectures(architectures, pairwise),
    frontier: onFrontier.map((entry) => entry.arm.strategyId),
    frontierTied: onFrontier.filter((entry) => entry.status === 'tied').map((entry) => entry.arm.strategyId),
    meanFrontier: paretoFrontier(
      architectures,
      (a) => a.score.mean,
      (a) => a.costUsd.mean,
    ).map((a) => a.strategyId),
    health: summarizeHealth(records.filter((record) => record.model === model.model)),
  };
}

/** A pair in canonical order, so `a` is the architecture listed first on the site. */
function pairContrast(contrast: Contrast): PairContrast {
  const flip = compareArchitectures(contrast.a.strategyId, contrast.b.strategyId) > 0;
  const verdict = flip ? mirror(contrast.verdict) : contrast.verdict;
  return {
    a: flip ? contrast.b.strategyId : contrast.a.strategyId,
    b: flip ? contrast.a.strategyId : contrast.b.strategyId,
    pairs: contrast.cells,
    tasks: contrast.tasks,
    scoreDelta: flip
      ? {
          mean: contrast.estimate === 0 ? 0 : -contrast.estimate,
          ci: contrast.ci && { low: -contrast.ci.high, high: -contrast.ci.low },
        }
      : contrastEstimate(contrast),
    verdict,
    ...(contrast.caveat ? { caveat: contrast.caveat } : {}),
    winner: verdict === 'better' ? 'a' : verdict === 'worse' ? 'b' : 'tie',
  };
}

function interactionContrast(contrast: CoreInteraction): InteractionContrast {
  return {
    strategyId: contrast.strategyId,
    models: contrast.models,
    pairs: contrast.cells,
    tasks: contrast.tasks,
    delta: { mean: contrast.estimate, ci: contrast.ci },
    verdict: contrast.verdict,
    ...(contrast.caveat ? { caveat: contrast.caveat } : {}),
  };
}

function mirror(verdict: PairedVerdict): PairedVerdict {
  return verdict === 'better' ? 'worse' : verdict === 'worse' ? 'better' : verdict;
}

function scaleContrasts(contrasts: readonly Contrast[]): ScaleContrast[] {
  return contrasts
    .filter((contrast) => contrast.metric === 'score')
    .map((score): ScaleContrast => {
      const cost = contrasts.find(
        (c) =>
          c.metric === 'cost' &&
          c.a.model === score.a.model &&
          c.a.strategyId === score.a.strategyId &&
          c.b.model === score.b.model,
      );
      return {
        strategyId: score.a.strategyId,
        model: score.a.model,
        nextModel: score.b.model,
        pairs: score.cells,
        tasks: score.tasks,
        scoreDelta: contrastEstimate(score),
        costRatio: contrastEstimate(cost),
        verdict: score.verdict,
        ...(score.caveat ? { caveat: score.caveat } : {}),
        costVerdict: cost?.verdict ?? 'inconclusive',
      };
    })
    .sort(
      (a, b) =>
        compareModels(a.model, b.model) || compareArchitectures(a.strategyId, b.strategyId),
    );
}

/** Rank = 1 + the number of architectures reliably above; ties share a rank. */
export function rankArchitectures(
  architectures: readonly Pick<ArchitectureSummary, 'strategyId' | 'score'>[],
  pairwise: readonly Pick<PairContrast, 'a' | 'b' | 'winner'>[],
): RankEntry[] {
  const below = new Map<string, string[]>();
  const above = new Map<string, string[]>();
  for (const arch of architectures) {
    below.set(arch.strategyId, []);
    above.set(arch.strategyId, []);
  }
  for (const pair of pairwise) {
    if (pair.winner === 'tie') continue;
    const [high, low] = pair.winner === 'a' ? [pair.a, pair.b] : [pair.b, pair.a];
    below.get(low)?.push(high);
    above.get(high)?.push(low);
  }
  const entries = architectures.map((arch) => ({
    strategyId: arch.strategyId,
    score: arch.score.mean,
    rank: 1 + (below.get(arch.strategyId)?.length ?? 0),
  }));
  entries.sort(
    (x, y) => x.rank - y.rank || y.score - x.score || compareArchitectures(x.strategyId, y.strategyId),
  );
  return entries.map((entry) => ({
    strategyId: entry.strategyId,
    rank: entry.rank,
    tied: entries.some((other) => other !== entry && other.rank === entry.rank),
    below: below.get(entry.strategyId) ?? [],
    above: above.get(entry.strategyId) ?? [],
  }));
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
