import type { Strategy } from '@arena/core';
import { singleStrategy } from './single';
import { planExecuteStrategy } from './planExecute';
import { orchestratorWorkersStrategy } from './orchestratorWorkers';
import { planExecuteVerifyStrategy } from './planExecuteVerify';
import { debateSelectStrategy } from './debateSelect';

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
export { createDebateSelectStrategy, debateSelectStrategy } from './debateSelect';

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
  debateSelectStrategy,
];

export function getStrategies(ids?: string[]): Strategy[] {
  if (ids === undefined || ids.length === 0 || ids.includes('all')) return [...STRATEGIES];

  const wanted = new Set(ids);
  const unknown = ids.filter((id) => !STRATEGIES.some((strategy) => strategy.id === id));
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
