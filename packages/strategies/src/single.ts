import type { RunContext, Strategy, StrategyOutcome } from '@arena/core';
import { createPhaseRunner, joinSections, taskBlock, type StrategyDeps } from './helpers';

const DESCRIPTION =
  'One agent, one context, the full toolset. It reads the task, acts, and answers in a single ' +
  'session with no separate planning, review or delegation step. This is the control condition ' +
  'the other four architectures are measured against: every extra phase they add has to earn its ' +
  'cost and latency back in score.';

function mainPrompt(ctx: RunContext): string {
  return joinSections(
    taskBlock(ctx),
    'Complete this task now. Use the tools available to you, checking the state you are about ' +
      'to change before you change it. When you are finished, reply with your final answer.',
  );
}

export function createSingleStrategy(deps: Partial<StrategyDeps> = {}): Strategy {
  return {
    id: 'single',
    label: 'Single agent',
    description: DESCRIPTION,

    async run(ctx: RunContext): Promise<StrategyOutcome> {
      const runner = createPhaseRunner(ctx, deps);
      if (!runner.canContinue()) return runner.finish();

      const main = await runner.run({
        phase: 'main',
        label: 'Main',
        prompt: mainPrompt(ctx),
      });

      return runner.finish({ finalText: main.text });
    },
  };
}

export const singleStrategy = createSingleStrategy();
