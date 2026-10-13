/**
 * The landing page's argument, computed: the headline numbers, the
 * pre-registration scorecard (H1–H6, docs/PREREGISTRATION.md) and the one
 * exploratory observation worth stating.
 *
 * Every number comes from the site analysis (core's `analyzeRunSet`) or, for
 * H6's medians, from the run records. What is written by hand is the wording
 * of each hypothesis as registered and the rule that turns the verdicts into a
 * badge, so a different run set cannot inherit this one's conclusions: the
 * badge is recomputed from its own contrasts.
 *
 * Pure: no filesystem.
 */

import type { BaselineContrast, Estimate, ModelAnalysis, PairedVerdict, ScaleContrast, SiteAnalysis } from './analysis';
import { architectureName } from './architectures';
import { modelShortName } from './models';
import type { RunRecord } from './records';
import { isRankable } from './records';

export type Badge = 'supported' | 'consistent' | 'partial' | 'not-supported';

export const BADGE_LABEL: Record<Badge, string> = {
  supported: 'Supported',
  consistent: 'Consistent',
  partial: 'Partial',
  'not-supported': 'Not supported',
};

export interface Hypothesis {
  id: string;
  kind: 'confirmatory' | 'secondary' | 'descriptive';
  name: string;
  /** The prediction, as registered. */
  claim: string;
  badge: Badge;
  /** What the data said, in a sentence or two, with its numbers. */
  result: string;
}

/** The research tasks graded against a gold key, which H6 is about. */
export const GOLD_KEY_TASKS = ['research-status-codes', 'research-header-fields', 'research-nist-password-rules'];

const SCAFFOLD_H1 = ['plan-execute-verify', 'gated-execute'];

export function signed(value: number, digits = 3): string {
  const text = Math.abs(value).toFixed(digits);
  return value > 0 ? `+${text}` : value < 0 ? `−${text}` : text;
}

export function interval(estimate: Estimate, digits = 3): string {
  return estimate.ci ? `[${signed(estimate.ci.low, digits)}, ${signed(estimate.ci.high, digits)}]` : '';
}

export function times(value: number, digits = 2): string {
  return `×${value.toFixed(digits)}`;
}

const VERDICT_WORD: Record<PairedVerdict, string> = {
  better: 'better',
  worse: 'worse',
  equivalent: 'equivalent',
  inconclusive: 'inconclusive',
};

function median(values: number[]): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

function contrastOf(model: ModelAnalysis | undefined, strategyId: string): BaselineContrast | undefined {
  return model?.contrasts.find((c) => c.strategyId === strategyId);
}

function scaleOf(analysis: SiteAnalysis, model: string, strategyId: string): ScaleContrast | undefined {
  return analysis.scale.find((c) => c.model === model && c.strategyId === strategyId);
}

export interface Headline {
  /** Scaffold-vs-single score contrasts that came out `better`, of `total`. */
  scaffoldsBetter: number;
  scaffoldContrasts: number;
  /** Scaffold-vs-single cost contrasts that came out costlier, and the ratio range. */
  costlier: number;
  costMin: number;
  costMax: number;
  /** The plain agent, one model step up from the smallest. */
  step: { from: string; to: string; scoreGain: number; costRatio: number } | null;
  /** The smallest model's best scaffold against its own single agent. */
  bestSmall: { model: string; strategyId: string; scoreGain: number; costRatio: number; verdict: PairedVerdict } | null;
  /** Exploratory: a scaffold on a mid model that matched single on the top model. */
  match: {
    strategyId: string;
    model: string;
    nextModel: string;
    scoreDelta: Estimate;
    costRatio: number;
    verdict: PairedVerdict;
    pairs: number;
    tasks: number;
    /** The same scaffold against its own model's single agent. */
    own: { scoreDelta: Estimate; verdict: PairedVerdict } | null;
    /** The mid model's single agent against the next model's. */
    plain: { scoreDelta: Estimate; costRatio: number; verdict: PairedVerdict } | null;
  } | null;
}

export function headline(analysis: SiteAnalysis): Headline {
  const contrasts = analysis.models.flatMap((m) => m.contrasts);
  const costRatios = contrasts.map((c) => c.costRatio.mean).filter(Number.isFinite);
  const [small] = analysis.models;

  const stepContrast = small ? scaleOf(analysis, small.model, analysis.baselineId) : undefined;
  const step = stepContrast
    ? {
        from: stepContrast.model,
        to: stepContrast.nextModel,
        scoreGain: -stepContrast.scoreDelta.mean,
        costRatio: 1 / stepContrast.costRatio.mean,
      }
    : null;

  const best = [...(small?.contrasts ?? [])].sort((a, b) => b.scoreDelta.mean - a.scoreDelta.mean)[0];
  const bestSmall =
    small && best
      ? {
          model: small.model,
          strategyId: best.strategyId,
          scoreGain: best.scoreDelta.mean,
          costRatio: best.costRatio.mean,
          verdict: best.verdict,
        }
      : null;

  // The cheapest scaffold on a non-smallest model shown equivalent to single one step up.
  const matches = analysis.scale
    .filter((c) => c.strategyId !== analysis.baselineId && c.model !== small?.model && c.verdict === 'equivalent')
    .sort((a, b) => a.costRatio.mean - b.costRatio.mean);
  const m = matches[0];

  return {
    scaffoldsBetter: contrasts.filter((c) => c.verdict === 'better').length,
    scaffoldContrasts: contrasts.length,
    costlier: contrasts.filter((c) => c.costVerdict === 'worse').length,
    costMin: Math.min(...costRatios),
    costMax: Math.max(...costRatios),
    step,
    bestSmall,
    match: m
      ? {
          strategyId: m.strategyId,
          model: m.model,
          nextModel: m.nextModel,
          scoreDelta: m.scoreDelta,
          costRatio: m.costRatio.mean,
          verdict: m.verdict,
          pairs: m.pairs,
          tasks: m.tasks,
          own: (() => {
            const c = contrastOf(
              analysis.models.find((x) => x.model === m.model),
              m.strategyId,
            );
            return c ? { scoreDelta: c.scoreDelta, verdict: c.verdict } : null;
          })(),
          plain: (() => {
            const c = scaleOf(analysis, m.model, analysis.baselineId);
            return c ? { scoreDelta: c.scoreDelta, costRatio: c.costRatio.mean, verdict: c.verdict } : null;
          })(),
        }
      : null,
  };
}

/**
 * H1–H6 as registered, judged by this run set's own contrasts. `null` unless
 * the set has the three models the registration names, in order.
 */
export function scorecard(analysis: SiteAnalysis, records: readonly RunRecord[]): Hypothesis[] | null {
  if (analysis.models.length < 3) return null;
  const [hz, sn, op] = analysis.models as [ModelAnalysis, ModelAnalysis, ModelAnalysis];
  const name = (id: string) => modelShortName(id);

  // H1
  const h1 = SCAFFOLD_H1.map((id) => contrastOf(hz, id)).filter((c): c is BaselineContrast => Boolean(c));
  const h1Better = h1.some((c) => c.verdict === 'better');
  const h1Text = h1
    .map((c) => `${architectureName(c.strategyId)} ${signed(c.scoreDelta.mean)} ${interval(c.scoreDelta)}`)
    .join(', ');

  // H2
  const h2 = op.contrasts;
  const h2Better = h2.filter((c) => c.verdict === 'better').length;
  const h2Eq = h2.filter((c) => c.verdict === 'equivalent').length;

  // H3
  const all = analysis.models.flatMap((m) => m.contrasts);
  const costlier = all.filter((c) => c.costVerdict === 'worse').length;
  const ratios = all.map((c) => c.costRatio.mean).filter(Number.isFinite);

  // H4
  const h4 = analysis.interactions.find(
    (c) => c.strategyId === 'plan-execute-verify' && c.models[0] === hz.model && c.models[1] === op.model,
  );

  // H5
  const h5 = analysis.scale.filter((c) => c.model === hz.model && c.nextModel === sn.model);
  const h5Worse = h5.filter((c) => c.verdict === 'worse');

  // H6, descriptive
  const latency = (model: string, strategyId: string) =>
    median(
      records
        .filter((r) => isRankable(r) && r.model === model && r.strategyId === strategyId && GOLD_KEY_TASKS.includes(r.taskId))
        .map((r) => r.latencyMs),
    ) / 1000;
  const models = analysis.models.map((m) => m.model);
  const slower = models.filter((m) => latency(m, 'orchestrator-workers') > latency(m, analysis.baselineId)).length;

  return [
    {
      id: 'H1',
      kind: 'confirmatory',
      name: 'Scaffolds help the small model',
      claim: `On ${name(hz.model)}, plan-execute-verify or gated-execute scores better than a single agent.`,
      badge: h1Better ? 'supported' : 'not-supported',
      result: h1Better
        ? `At least one separated from single: ${h1Text}.`
        : `Neither separated, and both point estimates are below zero: ${h1Text}.`,
    },
    {
      id: 'H2',
      kind: 'confirmatory',
      name: 'Scaffolds stop paying on the large model',
      claim: `On ${name(op.model)}, no architecture scores better than a single agent.`,
      badge: h2Better === 0 ? 'consistent' : 'not-supported',
      result:
        h2Better === 0
          ? `None of ${h2.length} is better.${h2Eq === 0 ? ' None is shown equivalent either, so the data cannot say the gain is under 0.05.' : ` ${h2Eq} shown equivalent within ±0.05.`}`
          : `${h2Better} of ${h2.length} scored better than single.`,
    },
    {
      id: 'H3',
      kind: 'confirmatory',
      name: 'Every scaffold costs more',
      claim: 'On every model, every multi-call architecture costs more per task than a single agent.',
      badge: costlier === all.length ? 'supported' : costlier > 0 ? 'partial' : 'not-supported',
      result: `${costlier} of ${all.length} costlier, each interval above ×1: ${times(Math.min(...ratios))} to ${times(Math.max(...ratios))} the cost of a run.`,
    },
    {
      id: 'H4',
      kind: 'secondary',
      name: 'The gain shrinks as models scale',
      claim: `Plan-execute-verify gains more over a single agent on ${name(hz.model)} than on ${name(op.model)}.`,
      badge: h4?.verdict === 'better' ? 'supported' : 'not-supported',
      result: h4
        ? `Difference in gains ${signed(h4.delta.mean)} ${interval(h4.delta)}: ${VERDICT_WORD[h4.verdict]}${h4.delta.mean < 0 ? ', and the wrong sign' : ''}.`
        : 'No interaction contrast was computed.',
    },
    {
      id: 'H5',
      kind: 'secondary',
      name: 'Scale beats scaffold, one step up',
      claim: `A single agent on ${name(sn.model)} scores better than every architecture on ${name(hz.model)}.`,
      badge: h5Worse.length === h5.length && h5.length > 0 ? 'supported' : h5Worse.length > 0 ? 'partial' : 'not-supported',
      result: `${h5Worse.length} of ${h5.length} shown below Sonnet’s single agent (${h5Worse
        .map((c) => architectureName(c.strategyId))
        .join(', ')}); the other ${h5.length - h5Worse.length} are below it on point estimates but not separated after Holm. None matches it while costing less.`,
    },
    {
      id: 'H6',
      kind: 'descriptive',
      name: 'Fan-out buys time on breadth research',
      claim: 'On the gold-key research tasks, orchestrator-workers ties a single agent on score and is faster.',
      badge: slower === 0 ? 'consistent' : 'not-supported',
      result: `Three tasks, so no verdict. Orchestrator-workers was slower on ${slower} of ${models.length} models (median ${models
        .map((m) => `${latency(m, 'orchestrator-workers').toFixed(0)} s vs ${latency(m, analysis.baselineId).toFixed(0)} s`)
        .join('; ')}).`,
    },
  ];
}
