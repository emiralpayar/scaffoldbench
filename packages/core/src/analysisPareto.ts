/**
 * A Pareto frontier that respects uncertainty.
 *
 * On point estimates alone, a strategy that went 18/18 "dominates" one that
 * went 17/18 at the same price, and the frontier becomes a picture of one
 * coin flip. Here one arm dominates another only when the paired evidence
 * separates them: significantly better on one axis and at least equivalent
 * on the other. Everything not dominated that way stays on the frontier, and
 * the ones that would have fallen off on point estimates are marked `tied`.
 */

import type { ContrastVerdict } from './analysisInference';

export type FrontierStatus = 'frontier' | 'tied' | 'dominated';

export interface FrontierCandidate<K> {
  key: K;
  /** Higher is better. */
  quality: number;
  /** Lower is better. */
  cost: number;
}

export interface FrontierResult<K> {
  key: K;
  status: FrontierStatus;
  /** Candidates that dominate this one with separated evidence. */
  dominatedBy: K[];
}

/**
 * `verdict(p, q, axis)` is p's paired verdict against q on that axis, oriented
 * so that `better` means higher quality or lower cost.
 */
export function uncertainFrontier<K>(
  candidates: readonly FrontierCandidate<K>[],
  verdict: (p: K, q: K, axis: 'quality' | 'cost') => ContrastVerdict,
): FrontierResult<K>[] {
  const atLeastAsGood = (v: ContrastVerdict) => v === 'better' || v === 'equivalent';

  return candidates.map((q) => {
    const dominatedBy: K[] = [];
    let pointDominated = false;
    for (const p of candidates) {
      if (p === q) continue;
      const vq = verdict(p.key, q.key, 'quality');
      const vc = verdict(p.key, q.key, 'cost');
      if ((vq === 'better' && atLeastAsGood(vc)) || (vc === 'better' && atLeastAsGood(vq))) {
        dominatedBy.push(p.key);
      }
      const noWorse = p.quality >= q.quality && p.cost <= q.cost;
      if (noWorse && (p.quality > q.quality || p.cost < q.cost)) pointDominated = true;
    }
    const status: FrontierStatus =
      dominatedBy.length > 0 ? 'dominated' : pointDominated ? 'tied' : 'frontier';
    return { key: q.key, status, dominatedBy };
  });
}
