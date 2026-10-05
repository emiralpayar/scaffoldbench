import type { FidelityInput, IntegrityCheck, RunContext, Strategy, StrategyOutcome } from '@scaffoldbench/core';
import { phase, toolSurfaceCheck } from './fidelity';
import {
  ACTING_INSTRUCTIONS,
  FINAL_ANSWER_INSTRUCTION,
  createPhaseRunner,
  joinSections,
  taskBlock,
  type StrategyDeps,
} from './helpers';

const DESCRIPTION =
  'One agent, one context, the full toolset. It reads the task, acts, and answers in a single ' +
  'session with no separate planning, review or delegation step. This is the control condition ' +
  'the other architectures are measured against: every extra phase they add has to earn its ' +
  'cost and latency back in score.';

export function mainPrompt(ctx: RunContext): string {
  return joinSections(
    taskBlock(ctx),
    'Complete this task now.',
    ACTING_INSTRUCTIONS,
    FINAL_ANSWER_INSTRUCTION,
  );
}

/** The control has one invariant: the agent held the whole toolset. */
export function singleFidelityChecks(input: FidelityInput): IntegrityCheck[] {
  return [
    toolSurfaceCheck('single.tools', input, [
      { role: 'agent', matches: phase('main'), tools: input.env.allowedTools },
    ]),
  ];
}

export function createSingleStrategy(deps: Partial<StrategyDeps> = {}): Strategy {
  return {
    id: 'single',
    label: 'Single agent',
    description: DESCRIPTION,
    fidelityChecks: singleFidelityChecks,

    async run(ctx: RunContext): Promise<StrategyOutcome> {
      const runner = createPhaseRunner(ctx, deps);
      if (!runner.canContinue()) return runner.finish();

      const main = await runner.run({
        phase: 'main',
        label: 'Main',
        prompt: mainPrompt(ctx),
        answers: true,
      });

      return runner.finish({ finalText: main.text });
    },
  };
}

export const singleStrategy = createSingleStrategy();
