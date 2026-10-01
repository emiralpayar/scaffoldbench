import type { Strategy } from '@arena/core';
import { singleStrategy } from './single';
import { planExecuteStrategy } from './planExecute';
import { orchestratorWorkersStrategy } from './orchestratorWorkers';
import { planExecuteVerifyStrategy } from './planExecuteVerify';
import { proposeSelectStrategy } from './proposeSelect';

export type { StrategyDeps, LabeledSpec, PhaseNote, PhaseRunner } from './helpers';
export {
  ACTING_INSTRUCTIONS,
  FINAL_ANSWER_INSTRUCTION,
  REASONING_TURNS,
  createPhaseRunner,
  interrupted,
  recordPhase,
} from './helpers';

export { createSingleStrategy, singleFidelityChecks, singleStrategy } from './single';
export {
  createPlanExecuteStrategy,
  planExecuteFidelityChecks,
  planExecuteStrategy,
} from './planExecute';
export {
  createOrchestratorWorkersStrategy,
  orchestratorWorkersFidelityChecks,
  orchestratorWorkersStrategy,
} from './orchestratorWorkers';
export {
  MAX_REVISIONS,
  VERIFY_SCHEMA,
  createPlanExecuteVerifyStrategy,
  planExecuteVerifyFidelityChecks,
  planExecuteVerifyStrategy,
} from './planExecuteVerify';
export {
  PROPOSER_LENSES,
  SELECT_SCHEMA,
  createProposeSelectStrategy,
  proposeSelectFidelityChecks,
  proposeSelectStrategy,
} from './proposeSelect';

/**
 * The comparison set, in increasing order of structure.
 *
 * Reports and the leaderboard render strategies in this order, so it is the
 * order the architectures are meant to be read in: one call, then two, then
 * fan-out, then review, then selection.
 */
export const STRATEGIES: Strategy[] = [
  singleStrategy,
  planExecuteStrategy,
  orchestratorWorkersStrategy,
  planExecuteVerifyStrategy,
  proposeSelectStrategy,
];

/**
 * Ids architectures were published under before a rename, mapped to their
 * current ids.
 *
 * `debate-select` held no debate — three proposers that never see one
 * another, then a selector — so it is now `propose-select`. Run sets
 * measured before a rename keep the old id in their records; this map is
 * how a reader shows which current architecture an old record belongs to.
 * It does not make the old runs comparable with new ones: they measured an
 * earlier implementation and are never pooled with current results.
 */
export const LEGACY_STRATEGY_IDS: Readonly<Record<string, string>> = {
  'debate-select': 'propose-select',
};

/** The current id for `id`, which may be one an architecture had before a rename. */
export function canonicalStrategyId(id: string): string {
  return LEGACY_STRATEGY_IDS[id] ?? id;
}

/**
 * The strategies named by `ids`, in registry order. `all`, or nothing, is
 * every strategy; a retired id selects the architecture it was renamed to.
 */
export function getStrategies(ids?: string[]): Strategy[] {
  if (ids === undefined || ids.length === 0 || ids.includes('all')) return [...STRATEGIES];

  const wanted = new Set(ids.map(canonicalStrategyId));
  const unknown = ids.filter((id) => !STRATEGIES.some((strategy) => strategy.id === canonicalStrategyId(id)));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown strategy id(s): ${unknown.join(', ')}. ` +
        `Valid ids: ${STRATEGIES.map((strategy) => strategy.id).join(', ')}, all.`,
    );
  }

  // Registry order, not argument order, so two runs of the same set are
  // reported identically however the flags were typed.
  return STRATEGIES.filter((strategy) => wanted.has(strategy.id));
}
