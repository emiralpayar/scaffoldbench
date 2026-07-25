import { readStructured } from '@arena/core';
import type { QueryOutcome, RunContext, Strategy, StrategyOutcome } from '@arena/core';
import {
  REASONING_TURNS,
  createPhaseRunner,
  joinSections,
  numbered,
  stringList,
  tagged,
  taskBlock,
  type StrategyDeps,
} from './helpers';

const DESCRIPTION =
  'The run is split in two: a tool-less planning call writes an ordered list of steps, then a ' +
  'second call executes them with the full toolset. The planner cannot look anything up, so the ' +
  'plan is only as good as the task statement — the question this architecture answers is ' +
  'whether committing to a sequence up front beats deciding one action at a time.';

/** Enough steps for a real procedure, few enough that the plan stays actionable. */
const MAX_PLAN_STEPS = 8;

export const PLAN_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    steps: {
      type: 'array',
      description: 'Ordered, concrete actions for the executor to carry out.',
      items: { type: 'string' },
    },
    rationale: {
      type: 'string',
      description: 'Two or three sentences on why this approach and not another.',
    },
  },
  required: ['steps', 'rationale'],
  additionalProperties: false,
};

export function planPrompt(ctx: RunContext): string {
  return joinSections(
    taskBlock(ctx),
    'You are the planning step. You have no tools here: think the task through and write the ' +
      'plan only.',
    `Produce an ordered list of at most ${MAX_PLAN_STEPS} steps for an executor who will have ` +
      'the full toolset. Each step must be one concrete action, specific enough to carry out ' +
      'without guessing, and must include any check that has to happen before it. Add a short ' +
      'rationale for the approach.',
  );
}

export function executePrompt(ctx: RunContext, plan: string): string {
  return joinSections(
    taskBlock(ctx),
    tagged('plan', plan),
    'Carry out the task following the plan above. The plan was written without access to the ' +
      'tools, so treat it as guidance rather than instruction: if what you find contradicts it, ' +
      'do what the task and the rules require and say so. When you are finished, reply with your ' +
      'final answer.',
  );
}

/**
 * The plan as text for the executor.
 *
 * Structured output is the happy path, but a model that answers in prose still
 * produced a usable plan, and throwing it away would cost a phase for nothing.
 */
export function planText(outcome: QueryOutcome): string {
  const parsed = readStructured<{ steps?: unknown; rationale?: unknown }>(outcome);
  const steps = stringList(parsed?.steps, MAX_PLAN_STEPS);
  if (steps.length === 0) return outcome.text.trim();

  const rationale = typeof parsed?.rationale === 'string' ? parsed.rationale.trim() : '';
  return joinSections(numbered(steps), rationale === '' ? '' : `Rationale: ${rationale}`);
}

export function createPlanExecuteStrategy(deps: Partial<StrategyDeps> = {}): Strategy {
  return {
    id: 'plan-execute',
    label: 'Plan then execute',
    description: DESCRIPTION,

    async run(ctx: RunContext): Promise<StrategyOutcome> {
      const runner = createPhaseRunner(ctx, deps);
      if (!runner.canContinue()) return runner.finish();

      const plan = await runner.run({
        phase: 'plan',
        label: 'Plan',
        prompt: planPrompt(ctx),
        allowedTools: [],
        outputSchema: PLAN_SCHEMA,
        maxTurns: REASONING_TURNS,
      });

      if (!runner.canContinue()) return runner.finish();

      const execute = await runner.run({
        phase: 'execute',
        label: 'Execute',
        prompt: executePrompt(ctx, planText(plan)),
      });

      return runner.finish({ finalText: execute.text });
    },
  };
}

export const planExecuteStrategy = createPlanExecuteStrategy();
