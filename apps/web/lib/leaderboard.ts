/**
 * The leaderboard of one model as rows: rank (with ties), the intervals on
 * score, pass rate, cost and latency, the paired difference from the
 * control, and how many of the architecture's runs were ranked at all.
 *
 * Pure: no filesystem, safe anywhere.
 */

import type { Estimate, ModelAnalysis, PairedVerdict } from './analysis';
import { architectureColor, architectureName } from './architectures';
import { niceDomain } from './charts';

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
  /** Runs the numbers are computed over. */
  ranked: number;
  /** Every run of the architecture on this model, excluded ones included. */
  total: number;
  integrityFailed: number;
  apiErrors: number;
  onFrontier: boolean;
}

export function leaderboardRows(
  model: ModelAnalysis,
  baselineId: string,
  options: { ranked: boolean },
): LeaderRow[] {
  const frontier = new Set(model.frontier);
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
        ...(contrast ? { delta: contrast.scoreDelta, costRatio: contrast.costRatio } : {}),
        verdict: strategyId === baselineId ? 'control' : (contrast?.verdict ?? null),
        ranked: arch.runs,
        total: health?.total ?? arch.runs,
        integrityFailed: health?.integrityFailed ?? 0,
        apiErrors: health?.apiErrors ?? 0,
        onFrontier: frontier.has(strategyId),
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
  const [lo, hi] = niceDomain(
    Math.min(...rows.map((row) => row.score.low)),
    Math.max(...rows.map((row) => row.score.high)),
    4,
  );
  return [Math.max(0, lo), Math.min(1, hi)];
}
