import { SCHEMA_MIN_TURNS, parseLooseJson } from '@arena/core';
import type {
  FidelityInput,
  IntegrityCheck,
  QueryOutcome,
  RunContext,
  Strategy,
  StrategyOutcome,
} from '@arena/core';
import {
  fail,
  metaNumber,
  metaString,
  pass,
  phase,
  phaseNamed,
  toolSurfaceCheck,
  unjudged,
} from './fidelity';
import {
  ACTING_INSTRUCTIONS,
  FINAL_ANSWER_INSTRUCTION,
  createPhaseRunner,
  interrupted,
  joinSections,
  numbered,
  stringList,
  tagged,
  taskBlock,
  type PhaseRunner,
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
      minItems: 1,
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

export function executePlanPrompt(ctx: RunContext, plan: string): string {
  return joinSections(
    taskBlock(ctx),
    tagged('plan', plan === '' ? '(the planning step produced no plan)' : plan),
    'Carry out the task following the plan above. The plan was written without access to the ' +
      'tools, so treat it as guidance rather than instruction.',
    ACTING_INSTRUCTIONS,
    FINAL_ANSWER_INSTRUCTION,
  );
}

/** How the plan was read: through the schema, out of prose, or not at all. */
export type PlanSource = 'schema' | 'prose' | 'none';

export interface PlanReading {
  /** The plan as the executor is handed it; empty when there was none. */
  text: string;
  steps: number;
  source: PlanSource;
  /** What the executor got instead of a schema plan, when it did. */
  fallback?: string;
}

/**
 * The plan as text for the executor.
 *
 * The schema reply is the plan. A planner that answered in prose still wrote
 * something the executor can use, so it is passed on rather than thrown away
 * — but it is a fallback, and the reading says so.
 */
export function readPlan(outcome: Pick<QueryOutcome, 'structured' | 'text'>): PlanReading {
  const fromSchema = planFrom(outcome.structured);
  if (fromSchema && fromSchema.steps.length > 0) {
    return { text: render(fromSchema), steps: fromSchema.steps.length, source: 'schema' };
  }

  const fromProse = planFrom(parseLooseJson(outcome.text));
  if (fromProse && fromProse.steps.length > 0) {
    return {
      text: render(fromProse),
      steps: fromProse.steps.length,
      source: 'prose',
      fallback: 'the plan came back as JSON in prose, not through the schema; its steps were used',
    };
  }

  const prose = outcome.text.trim();
  if (prose !== '') {
    return {
      text: prose,
      steps: 0,
      source: 'prose',
      fallback: 'the plan came back as prose, not through the schema; the executor got it as written',
    };
  }

  return {
    text: '',
    steps: 0,
    source: fromSchema ? 'schema' : 'none',
    fallback: fromSchema
      ? 'the plan had no steps; the executor ran without one'
      : 'the planner produced no plan; the executor ran without one',
  };
}

interface ParsedPlan {
  steps: string[];
  rationale: string;
}

function planFrom(value: unknown): ParsedPlan | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { steps, rationale } = value as { steps?: unknown; rationale?: unknown };
  return {
    steps: stringList(steps, MAX_PLAN_STEPS),
    rationale: typeof rationale === 'string' ? rationale.trim() : '',
  };
}

function render(plan: ParsedPlan): string {
  return joinSections(numbered(plan.steps), plan.rationale === '' ? '' : `Rationale: ${plan.rationale}`);
}

/**
 * Run the planning phase and record how its plan was read. Shared with
 * plan-execute-verify, whose first two phases are this architecture's.
 */
export async function runPlanPhase(runner: PhaseRunner, ctx: RunContext): Promise<string> {
  const outcome = await runner.run({
    phase: 'plan',
    label: 'Plan',
    prompt: planPrompt(ctx),
    allowedTools: [],
    outputSchema: PLAN_SCHEMA,
    maxTurns: SCHEMA_MIN_TURNS,
  });
  const reading = readPlan(outcome);
  runner.annotate(outcome, {
    meta: { steps: reading.steps, source: reading.source },
    ...(reading.fallback !== undefined && !interrupted(outcome) ? { degraded: reading.fallback } : {}),
  });
  return reading.text;
}

/** The plan was a plan: read through the schema, with at least one step. */
export function planCheck(id: string, input: FidelityInput): IntegrityCheck {
  const plan = phaseNamed(input, 'plan');
  const excused = unjudged(id, input, plan, 'the plan');
  if (excused || !plan) return excused ?? fail(id, 'the plan never ran');

  const steps = metaNumber(plan, 'steps') ?? 0;
  if (metaString(plan, 'source') === 'schema' && steps > 0) {
    return pass(id, `a ${steps}-step plan, read from the schema reply`);
  }
  return fail(id, plan.degraded ?? 'the plan was not read from a schema reply');
}

export function planExecuteFidelityChecks(input: FidelityInput): IntegrityCheck[] {
  return [
    planCheck('plan-execute.plan', input),
    toolSurfaceCheck('plan-execute.tools', input, [
      { role: 'planner', matches: phase('plan'), tools: [] },
      { role: 'executor', matches: phase('execute'), tools: input.env.allowedTools },
    ]),
  ];
}

export function createPlanExecuteStrategy(deps: Partial<StrategyDeps> = {}): Strategy {
  return {
    id: 'plan-execute',
    label: 'Plan then execute',
    description: DESCRIPTION,
    fidelityChecks: planExecuteFidelityChecks,

    async run(ctx: RunContext): Promise<StrategyOutcome> {
      const runner = createPhaseRunner(ctx, deps);
      if (!runner.canContinue()) return runner.finish();

      const plan = await runPlanPhase(runner, ctx);
      if (!runner.canContinue()) return runner.finish();

      const execute = await runner.run({
        phase: 'execute',
        label: 'Execute',
        prompt: executePlanPrompt(ctx, plan),
        answers: true,
      });

      return runner.finish({ finalText: execute.text });
    },
  };
}

export const planExecuteStrategy = createPlanExecuteStrategy();
