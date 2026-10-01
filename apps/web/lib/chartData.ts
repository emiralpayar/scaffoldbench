/**
 * Adapters from the analysis view model to what each chart draws. Pure, so
 * the shapes are tested without rendering, and a chart never reaches into
 * the analysis itself.
 */

import type { Estimate, ModelAnalysis, PairedVerdict, SiteAnalysis } from './analysis';
import { architectureColor, architectureName, compareArchitectures } from './architectures';
import { formatDelta, formatMultiple, formatScore, formatUsd, joinList } from './format';
import { modelShortName } from './models';

export interface IntervalPoint {
  id: string;
  label: string;
  color: string;
  x: Estimate;
  y: Estimate;
  /** Drawn as a ring rather than a disc: the baseline, or a dominated point. */
  hollow?: boolean;
  /** Full sentence for the native tooltip and the data table. */
  note: string;
  verdict?: PairedVerdict;
}

// ---------------------------------------------------------------------------
// "Does the extra structure pay for itself?"
// ---------------------------------------------------------------------------

export interface PayoffPanel {
  model: string;
  title: string;
  /** "45 paired runs" or "40–45 paired runs per architecture". */
  pairs: string;
  points: IntervalPoint[];
}

export interface PayoffData {
  panels: PayoffPanel[];
  margin: number;
}

const VERDICT_WORDS: Record<PairedVerdict, string> = {
  better: 'better than single',
  worse: 'worse than single',
  equivalent: 'equivalent to single',
  inconclusive: 'not separable from single',
};

export function payoffData(analysis: SiteAnalysis): PayoffData {
  const panels = analysis.models
    .filter((model) => model.contrasts.length > 0)
    .map((model) => ({
      model: model.model,
      title: modelShortName(model.model),
      pairs: pairsText(model.contrasts.map((c) => c.pairs)),
      points: model.contrasts
        .slice()
        .sort((a, b) => compareArchitectures(a.strategyId, b.strategyId))
        .map((contrast) => ({
          id: contrast.strategyId,
          label: architectureName(contrast.strategyId),
          color: architectureColor(contrast.strategyId),
          x: contrast.costRatio,
          y: contrast.scoreDelta,
          verdict: contrast.verdict,
          note:
            `${architectureName(contrast.strategyId)} on ${modelShortName(model.model)}: ` +
            `${formatDelta(contrast.scoreDelta.mean)} score ` +
            `[${formatDelta(contrast.scoreDelta.low)}, ${formatDelta(contrast.scoreDelta.high)}] ` +
            `at ${formatMultiple(contrast.costRatio.mean)} the cost of single, ` +
            `${VERDICT_WORDS[contrast.verdict]} (${contrast.pairs} paired runs).`,
        })),
    }));
  return { panels, margin: analysis.margin };
}

function pairsText(counts: readonly number[]): string {
  const lo = Math.min(...counts);
  const hi = Math.max(...counts);
  return lo === hi ? `${hi} paired runs each` : `${lo}–${hi} paired runs each`;
}

/** Shared axes for small multiples: one scale across panels, or they cannot be compared. */
export function payoffDomains(data: PayoffData): { x: [number, number]; y: [number, number] } {
  const points = data.panels.flatMap((panel) => panel.points);
  const xs = points.flatMap((p) => [p.x.low, p.x.high]).filter((v) => Number.isFinite(v) && v > 0);
  const ys = points.flatMap((p) => [p.y.low, p.y.high]).filter(Number.isFinite);
  const xMin = Math.min(1, ...xs);
  const xMax = Math.max(1, ...xs);
  const yMin = Math.min(-data.margin, ...ys);
  const yMax = Math.max(data.margin, ...ys);
  return { x: [xMin, xMax], y: [yMin, yMax] };
}

// ---------------------------------------------------------------------------
// Forest plot of one model's architectures
// ---------------------------------------------------------------------------

export interface ForestRow {
  id: string;
  label: string;
  color: string;
  estimate: Estimate;
  valueText: string;
  note: string;
}

export function forestRows(model: ModelAnalysis): ForestRow[] {
  return model.architectures.map((arch) => ({
    id: arch.strategyId,
    label: architectureName(arch.strategyId),
    color: architectureColor(arch.strategyId),
    estimate: arch.score,
    valueText: `${formatScore(arch.score.mean)}  ${formatScore(arch.score.low)}–${formatScore(arch.score.high)}`,
    note:
      `${architectureName(arch.strategyId)} on ${modelShortName(model.model)}: mean score ` +
      `${formatScore(arch.score.mean)}, interval ${formatScore(arch.score.low)}–${formatScore(arch.score.high)}, ` +
      `${arch.runs} runs on ${arch.tasks} tasks.`,
  }));
}

// ---------------------------------------------------------------------------
// Score against cost (one model), with intervals on both axes
// ---------------------------------------------------------------------------

export function paretoPoints(model: ModelAnalysis): IntervalPoint[] {
  const frontier = new Set(model.frontier);
  return model.architectures.map((arch) => ({
    id: arch.strategyId,
    label: architectureName(arch.strategyId),
    color: architectureColor(arch.strategyId),
    x: arch.costUsd,
    y: arch.score,
    hollow: !frontier.has(arch.strategyId),
    note:
      `${architectureName(arch.strategyId)}: score ${formatScore(arch.score.mean)} ` +
      `[${formatScore(arch.score.low)}–${formatScore(arch.score.high)}] at ${formatUsd(arch.costUsd.mean)} a run ` +
      `[${formatUsd(arch.costUsd.low)}–${formatUsd(arch.costUsd.high)}]` +
      (frontier.has(arch.strategyId) ? ', on the mean frontier.' : ', dominated on means.'),
  }));
}

// ---------------------------------------------------------------------------
// Scaffold or scale: every model's architectures on one cost axis
// ---------------------------------------------------------------------------

export interface ScaffoldScaleGroup {
  model: string;
  title: string;
  baseline: IntervalPoint | undefined;
  points: IntervalPoint[];
}

export function scaffoldScaleGroups(analysis: SiteAnalysis): ScaffoldScaleGroup[] {
  return analysis.models.map((model) => {
    const toPoint = (strategyId: string): IntervalPoint | undefined => {
      const arch = model.architectures.find((a) => a.strategyId === strategyId);
      if (!arch) return undefined;
      return {
        id: `${model.model}/${strategyId}`,
        label: architectureName(strategyId),
        color: architectureColor(strategyId),
        x: arch.costUsd,
        y: arch.score,
        hollow: strategyId === analysis.baselineId,
        note:
          `${architectureName(strategyId)} on ${modelShortName(model.model)}: score ${formatScore(arch.score.mean)} ` +
          `[${formatScore(arch.score.low)}–${formatScore(arch.score.high)}] at ${formatUsd(arch.costUsd.mean)} a run.`,
      };
    };
    return {
      model: model.model,
      title: modelShortName(model.model),
      baseline: toPoint(analysis.baselineId),
      points: model.architectures
        .filter((a) => a.strategyId !== analysis.baselineId)
        .map((a) => toPoint(a.strategyId))
        .filter((p): p is IntervalPoint => !!p),
    };
  });
}

// ---------------------------------------------------------------------------
// Headline sentence
// ---------------------------------------------------------------------------

/**
 * One sentence over the payoff chart, stating only what the verdicts support.
 * It names architectures that beat the control, and otherwise says that none
 * did; it never ranks inconclusive results.
 */
export function payoffHeadline(analysis: SiteAnalysis): string {
  const contrasts = analysis.models.flatMap((model) =>
    model.contrasts.map((contrast) => ({ model: model.model, contrast })),
  );
  const total = contrasts.length;
  if (total === 0) return 'No architecture has been compared with the single-agent control yet.';

  const wins = contrasts
    .filter(({ contrast }) => contrast.verdict === 'better')
    .map(({ model, contrast }) => `${architectureName(contrast.strategyId)} on ${modelShortName(model)}`);
  const worse = contrasts.filter(({ contrast }) => contrast.verdict === 'worse').length;
  const rest = total - wins.length - worse;

  const lead =
    wins.length === 0
      ? `None of the ${total} architecture–model combinations scores reliably above a single agent.`
      : `${wins.length} of ${total} architecture–model combinations score reliably above a single agent: ${
          wins.length === 1 ? wins[0] : `${wins.slice(0, -1).join(', ')} and ${wins[wins.length - 1]}`
        }.`;
  const below = worse > 0 ? ` ${worse} ${worse === 1 ? 'scores' : 'score'} reliably below it.` : '';
  const others =
    rest > 0
      ? wins.length + worse === 0
        ? ` ${rest === 1 ? 'It is' : `All ${rest} are`} equivalent to it or not separable at this sample size.`
        : ` The other ${rest} ${rest === 1 ? 'is' : 'are'} equivalent to it or not separable at this sample size.`
      : '';
  return `${lead}${below}${others}`;
}

/**
 * The "scaffold or scale" sentence: how often an architecture on a smaller
 * model reliably beat a plain agent on the next model up, and how often it
 * did so for less money. Only `better` verdicts count as wins.
 */
export function scaleHeadline(analysis: SiteAnalysis): string | null {
  const scaffolds = analysis.scale.filter((s) => s.strategyId !== analysis.baselineId);
  if (scaffolds.length === 0) return null;
  const wins = scaffolds.filter((s) => s.verdict === 'better');
  const cheaper = wins.filter((s) => s.costRatio.high < 1);
  if (wins.length === 0) {
    return `In none of the ${scaffolds.length} comparisons did an architecture on a smaller model score reliably above a single agent on the next model up.`;
  }
  const examples = wins
    .slice(0, 3)
    .map((s) => `${architectureName(s.strategyId)} on ${modelShortName(s.model)}`)
    .join(', ');
  return (
    `In ${wins.length} of ${scaffolds.length} comparisons an architecture on a smaller model scored reliably above a single agent on the next model up (${examples})` +
    (cheaper.length > 0
      ? `, and ${cheaper.length === wins.length ? (wins.length === 1 ? 'it was' : 'all were') : `${cheaper.length} ${cheaper.length === 1 ? 'was' : 'were'}`} reliably cheaper.`
      : ', but none was reliably cheaper.')
  );
}

// ---------------------------------------------------------------------------
// Per-model summary table and prose
// ---------------------------------------------------------------------------

export interface ModelTableRow {
  strategyId: string;
  label: string;
  color: string;
  runs: number;
  score: string;
  scoreInterval: string;
  passRate: string;
  cost: string;
  latency: string;
  /** Against the control; empty for the control itself. */
  delta: string;
  deltaInterval: string;
  costMultiple: string;
  verdict: PairedVerdict | 'control' | '—';
  onFrontier: boolean;
}

export function modelTableRows(model: ModelAnalysis, baselineId: string): ModelTableRow[] {
  const frontier = new Set(model.frontier);
  return model.architectures.map((arch) => {
    const contrast = model.contrasts.find((c) => c.strategyId === arch.strategyId);
    const isBaseline = arch.strategyId === baselineId;
    return {
      strategyId: arch.strategyId,
      label: architectureName(arch.strategyId),
      color: architectureColor(arch.strategyId),
      runs: arch.runs,
      score: formatScore(arch.score.mean),
      scoreInterval: `${formatScore(arch.score.low)}–${formatScore(arch.score.high)}`,
      passRate: `${Math.round(arch.passRate.mean * 100)}%`,
      cost: formatUsd(arch.costUsd.mean),
      latency: `${(arch.latencyMs.mean / 1000).toFixed(1)}s`,
      delta: contrast ? formatDelta(contrast.scoreDelta.mean) : '',
      deltaInterval: contrast
        ? `${formatDelta(contrast.scoreDelta.low)} to ${formatDelta(contrast.scoreDelta.high)}`
        : '',
      costMultiple: contrast ? formatMultiple(contrast.costRatio.mean) : isBaseline ? '1.0×' : '',
      verdict: isBaseline ? 'control' : (contrast?.verdict ?? '—'),
      onFrontier: frontier.has(arch.strategyId),
    };
  });
}

/** What one model's numbers support, in a sentence or two, and nothing more. */
export function describeModel(model: ModelAnalysis): string {
  const name = modelShortName(model.model);
  const better = model.contrasts.filter((c) => c.verdict === 'better');
  const worse = model.contrasts.filter((c) => c.verdict === 'worse');
  const equivalent = model.contrasts.filter((c) => c.verdict === 'equivalent');
  const names = (list: typeof better) => joinList(list.map((c) => architectureName(c.strategyId)));

  if (model.contrasts.length === 0) {
    return `On ${name}, no architecture shares enough tasks and repeats with the single-agent control to compare.`;
  }
  const parts: string[] = [];
  if (better.length > 0) {
    parts.push(
      `On ${name}, ${names(better)} ${better.length === 1 ? 'scores' : 'score'} reliably above a single agent, at ${better
        .map((c) => formatMultiple(c.costRatio.mean))
        .join(', ')} its cost.`,
    );
  } else {
    parts.push(`On ${name}, no architecture scores reliably above a single agent.`);
  }
  if (worse.length > 0) parts.push(`${names(worse)} ${worse.length === 1 ? 'scores' : 'score'} reliably below it.`);
  if (equivalent.length > 0) {
    parts.push(`${names(equivalent)} ${equivalent.length === 1 ? 'is' : 'are'} equivalent to it within the margin.`);
  }
  const rest = model.contrasts.length - better.length - worse.length - equivalent.length;
  if (rest > 0) parts.push(`${rest === 1 ? 'One is' : `${rest} are`} not separable from it at this sample size.`);
  return parts.join(' ');
}
