/**
 * The leaderboard of one model as rows: rank (with ties), the intervals on
 * score, pass rate, cost and latency (null where there is none), the paired
 * difference from the control, and how many of the architecture's runs were
 * ranked at all.
 *
 * Pure: no filesystem, safe anywhere.
 */

import type { ContrastCaveat, Estimate, ModelAnalysis, PairedVerdict } from './analysis';
import { architectureColor, architectureName } from './architectures';
import { niceDomain } from './charts';
import { boundsOf } from './format';

export interface LeaderRow {
  strategyId: string;
  label: string;
  color: string;
  /** Null when the run set cannot support a ranking (no fidelity checks). */
  rank: number | null;
  /** Shares its rank with another architecture. */
  tied: boolean;
  /** Architectures reliably above and below this one. */
  above: string[];
  below: string[];
  score: Estimate;
  passRate: Estimate;
  costUsd: Estimate;
  latencyMs: Estimate;
  /** Paired difference from the control; absent for the control itself. */
  delta?: Estimate;
  costRatio?: Estimate;
  verdict: PairedVerdict | 'control' | null;
  /** What the data withheld from the verdict, when it withheld anything. */
  caveat?: ContrastCaveat;
  /** Against the control on cost: `better` means cheaper. */
  costVerdict?: PairedVerdict;
  /** Runs the numbers are computed over. */
  ranked: number;
  /** Every run of the architecture on this model, excluded ones included. */
  total: number;
  integrityFailed: number;
  apiErrors: number;
  /** Not behind any other architecture on score and cost, on means or on the evidence. */
  onFrontier: boolean;
  /** Behind another on means, but the paired comparison does not separate them. */
  frontierTied: boolean;
}

export function leaderboardRows(
  model: ModelAnalysis,
  baselineId: string,
  options: { ranked: boolean },
): LeaderRow[] {
  // Without fidelity checks there is no evidence to read the frontier from, only the means.
  const frontier = new Set(options.ranked ? model.frontier : model.meanFrontier);
  const tied = new Set(options.ranked ? model.frontierTied : []);
  const byId = new Map(model.architectures.map((arch) => [arch.strategyId, arch]));
  const order = options.ranked
    ? model.ranks.map((entry) => entry.strategyId)
    : [...model.architectures]
        .sort((a, b) => b.score.mean - a.score.mean)
        .map((arch) => arch.strategyId);

  return order
    .map((strategyId): LeaderRow | null => {
      const arch = byId.get(strategyId);
      if (!arch) return null;
      const rank = model.ranks.find((entry) => entry.strategyId === strategyId);
      const contrast = model.contrasts.find((c) => c.strategyId === strategyId);
      const health = model.health.byStrategy.find((h) => h.strategyId === strategyId);
      return {
        strategyId,
        label: architectureName(strategyId),
        color: architectureColor(strategyId),
        rank: options.ranked && rank ? rank.rank : null,
        tied: options.ranked && rank ? rank.tied : false,
        above: rank?.above ?? [],
        below: rank?.below ?? [],
        score: arch.score,
        passRate: arch.passRate,
        costUsd: arch.costUsd,
        latencyMs: arch.latencyMs,
        ...(contrast
          ? { delta: contrast.scoreDelta, costRatio: contrast.costRatio, costVerdict: contrast.costVerdict }
          : {}),
        verdict: strategyId === baselineId ? 'control' : (contrast?.verdict ?? null),
        ...(contrast?.caveat ? { caveat: contrast.caveat } : {}),
        ranked: arch.runs,
        total: health?.total ?? arch.runs,
        integrityFailed: health?.integrityFailed ?? 0,
        apiErrors: health?.apiErrors ?? 0,
        onFrontier: frontier.has(strategyId) && !tied.has(strategyId),
        frontierTied: tied.has(strategyId),
      };
    })
    .filter((row): row is LeaderRow => row !== null);
}

/** "1" or "=1": a shared rank always says it is shared. */
export function rankLabel(row: Pick<LeaderRow, 'rank' | 'tied'>): string {
  if (row.rank === null) return '—';
  return row.tied ? `=${row.rank}` : String(row.rank);
}

/** A shared axis for every interval track on the board, zoomed to the data. */
export function scoreDomain(rows: readonly Pick<LeaderRow, 'score'>[]): [number, number] {
  if (rows.length === 0) return [0, 1];
  const bounds = rows.map((row) => boundsOf(row.score));
  const [lo, hi] = niceDomain(Math.min(...bounds.map(([low]) => low)), Math.max(...bounds.map(([, high]) => high)), 4);
  return [Math.max(0, lo), Math.min(1, hi)];
}
