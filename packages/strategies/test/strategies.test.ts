import { describe, expect, it } from 'vitest';
import { SCHEMA_MIN_TURNS, emptyUsage } from '@arena/core';
import type {
  BudgetLedger,
  FidelityInput,
  PhaseRecord,
  QueryOutcome,
  QuerySpec,
  RunContext,
  Strategy,
  Task,
  TaskEnvironment,
  TaskScore,
  TraceEvent,
  TraceSink,
} from '@arena/core';
import {
  ACTING_INSTRUCTIONS,
  FINAL_ANSWER_INSTRUCTION,
  LEGACY_STRATEGY_IDS,
  MAX_REVISIONS,
  PROPOSER_LENSES,
  REASONING_TURNS,
  STRATEGIES,
  VERIFY_SCHEMA,
  canonicalStrategyId,
  createOrchestratorWorkersStrategy,
  createPhaseRunner,
  createPlanExecuteStrategy,
  createPlanExecuteVerifyStrategy,
  createProposeSelectStrategy,
  createGatedExecuteStrategy,
  createSingleStrategy,
  getStrategies,
  orchestratorWorkersFidelityChecks,
  proposeSelectFidelityChecks,
} from '@arena/strategies';
import type { StrategyDeps } from '@arena/strategies';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

type RunQueryFn = StrategyDeps['runQuery'];

const BASE_OUTCOME: QueryOutcome = {
  callId: 'call-0',
  text: '',
  structured: undefined,
  structuredMissing: false,
  costUsd: 0.01,
  costEstimated: false,
  unpricedModels: [],
  usage: emptyUsage(),
  byModel: {},
  budgetUsd: 1,
  turns: 2,
  toolCalls: 1,
  deniedToolCalls: 0,
  aborted: false,
  subtype: 'success',
  mcpServersExpected: [],
  mcpServers: [],
  startedAtMs: 0,
  durationMs: 7,
};

type Script = (spec: QuerySpec, index: number) => Partial<QueryOutcome> | Promise<Partial<QueryOutcome>>;

interface Fake {
  runQuery: RunQueryFn;
  calls: QuerySpec[];
  /** How many scripted calls have returned so far. */
  resolved: number;
  phase(name: string): QuerySpec;
  phases(): string[];
}

function createFake(script: Script): Fake {
  const calls: QuerySpec[] = [];
  const fake: Fake = {
    calls,
    resolved: 0,
    runQuery: async (_ctx: RunContext, spec: QuerySpec): Promise<QueryOutcome> => {
      const index = calls.length;
      calls.push(spec);
      const partial = await script(spec, index);
      fake.resolved += 1;
      return { ...BASE_OUTCOME, callId: `call-${index + 1}`, ...partial };
    },
    phase(name: string): QuerySpec {
      const found = calls.find((call) => call.phase === name);
      if (!found) throw new Error(`no call for phase "${name}" in [${fake.phases().join(', ')}]`);
      return found;
    },
    phases: () => calls.map((call) => call.phase),
  };
  return fake;
}

class FakeTrace implements TraceSink {
  readonly collected: TraceEvent[] = [];

  append(event: Omit<TraceEvent, 'seq' | 'tMs'>): void {
    this.collected.push({ ...event, seq: this.collected.length, tMs: 0 });
  }

  get events(): readonly TraceEvent[] {
    return this.collected;
  }
}

function makeBudget(exceeded = false): BudgetLedger {
  return {
    spentUsd: 0,
    usage: emptyUsage(),
    turns: 0,
    exceeded,
    stopReason: exceeded ? 'cost' : undefined,
    remainingUsd: exceeded ? 0 : 5,
    availableUsd: exceeded ? 0 : 5,
    reserve: (capUsd?: number) => ({
      amountUsd: exceeded ? 0 : Math.min(capUsd ?? 5, 5),
      settle: () => undefined,
    }),
    charge: () => undefined,
  };
}

const MUTATING_TOOLS = ['mcp__shop__get_order', 'mcp__shop__refund'];
const READ_ONLY_TOOLS = ['mcp__shop__get_order'];

function makeEnv(overrides: Partial<TaskEnvironment> = {}): TaskEnvironment {
  return {
    createMcpServers: () => ({}),
    allowedTools: MUTATING_TOOLS,
    readOnlyTools: READ_ONLY_TOOLS,
    state: {},
    journal: [],
    ...overrides,
  };
}

function makeTask(env: TaskEnvironment): Task {
  const score: TaskScore = {
    score: 0,
    passed: false,
    breakdown: [],
    penalties: [],
    failureMode: 'none',
  };
  return {
    id: 'shop-1',
    category: 'tool-use',
    world: 'shop',
    title: 'Refund order 42',
    prompt: 'Refund order 42 and tell the customer what you did.',
    policy: 'Never refund without reading the order first.',
    maxTurns: 12,
    difficulty: 'medium',
    tags: ['refund'],
    createEnvironment: () => env,
    score: async () => score,
  };
}

interface CtxOptions {
  env?: TaskEnvironment;
  budget?: BudgetLedger;
  aborted?: boolean;
}

function makeCtx(options: CtxOptions = {}): RunContext {
  const env = options.env ?? makeEnv();
  const controller = new AbortController();
  if (options.aborted) controller.abort();
  return {
    runId: 'run-1',
    task: makeTask(env),
    strategyId: 'test',
    model: 'test-model',
    effort: 'medium',
    env,
    cwd: '/tmp/arena-test',
    signal: controller.signal,
    budget: options.budget ?? makeBudget(),
    trace: new FakeTrace(),
    systemPrompt: 'You are an autonomous agent.',
  };
}

function deferred(): { promise: Promise<void>; release: () => void } {
  let release = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    release = () => resolve();
  });
  return { promise, release };
}

async function waitFor(predicate: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Structured replies that satisfy every phase of every strategy. */
const genericScript: Script = (spec) => {
  if (spec.phase === 'plan') {
    return { text: 'plan prose', structured: { steps: ['read the order', 'refund it'], rationale: 'safe' } };
  }
  if (spec.phase === 'decompose') {
    return {
      structured: {
        subtasks: [
          { id: 'read', goal: 'Read order 42.' },
          { id: 'refund', goal: 'Refund order 42.' },
        ],
      },
    };
  }
  if (spec.phase.startsWith('verify')) {
    return { text: 'looks good', structured: { approved: true, issues: [], severity: 'none' } };
  }
  if (spec.phase === 'select') {
    return {
      text: 'selection prose',
      structured: { winnerIndex: 2, rationale: 'most thorough', mergedAnswer: 'merged answer' },
    };
  }
  return { text: `${spec.phase} answer` };
};

/** `genericScript`, except that the first verdict rejects the work, so a revision runs. */
function rejectingFirstVerdict(): Script {
  let verdicts = 0;
  return (spec, index) => {
    if (spec.phase.startsWith('verify') && verdicts++ === 0) {
      return {
        text: 'not yet',
        structured: { approved: false, issues: ['refund amount is wrong'], severity: 'blocking' },
      };
    }
    return genericScript(spec, index);
  };
}

/** Phases that hold the tools that change state. */
const ACTING_PHASE = /^(main|execute|worker-.*|revise-\d+)$/;

const allFactories: { id: string; create: (deps: Partial<StrategyDeps>) => Strategy }[] = [
  { id: 'single', create: createSingleStrategy },
  { id: 'plan-execute', create: createPlanExecuteStrategy },
  { id: 'orchestrator-workers', create: createOrchestratorWorkersStrategy },
  { id: 'plan-execute-verify', create: createPlanExecuteVerifyStrategy },
  { id: 'propose-select', create: createProposeSelectStrategy },
  { id: 'gated-execute', create: createGatedExecuteStrategy },
];

// ---------------------------------------------------------------------------
// single
// ---------------------------------------------------------------------------

describe('single', () => {
  it('makes exactly one call in phase main and returns its text', async () => {
    const fake = createFake(() => ({ text: 'refunded order 42' }));
    const outcome = await createSingleStrategy({ runQuery: fake.runQuery }).run(makeCtx());

    expect(fake.phases()).toEqual(['main']);
    expect(outcome.finalText).toBe('refunded order 42');
    expect(outcome.subagentCount).toBe(0);
    expect(outcome.phases).toHaveLength(1);
    expect(outcome.phases[0]?.phase).toBe('main');
    expect(outcome.phases[0]?.model).toBe('test-model');
  });

  it('gives the main phase the task toolset and puts the task in the prompt', async () => {
    const fake = createFake(() => ({ text: 'done' }));
    const ctx = makeCtx();
    await createSingleStrategy({ runQuery: fake.runQuery }).run(ctx);

    expect(fake.phase('main').allowedTools).toBeUndefined();
    expect(fake.phase('main').prompt).toContain(ctx.task.prompt);
  });
});

// ---------------------------------------------------------------------------
// plan-execute
// ---------------------------------------------------------------------------

describe('plan-execute', () => {
  it('plans without tools, then executes with the full toolset', async () => {
    const fake = createFake(genericScript);
    const outcome = await createPlanExecuteStrategy({ runQuery: fake.runQuery }).run(makeCtx());

    expect(fake.phases()).toEqual(['plan', 'execute']);
    expect(fake.phase('plan').allowedTools).toEqual([]);
    expect(fake.phase('plan').outputSchema).toBeDefined();
    expect(fake.phase('execute').allowedTools).toBeUndefined();
    expect(outcome.finalText).toBe('execute answer');
    expect(outcome.subagentCount).toBe(0);
  });

  it('injects the structured plan into the execute prompt', async () => {
    const fake = createFake(genericScript);
    await createPlanExecuteStrategy({ runQuery: fake.runQuery }).run(makeCtx());

    const prompt = fake.phase('execute').prompt;
    expect(prompt).toContain('read the order');
    expect(prompt).toContain('refund it');
  });

  it('records how many steps the plan had and that it came through the schema', async () => {
    const fake = createFake(genericScript);
    const outcome = await createPlanExecuteStrategy({ runQuery: fake.runQuery }).run(makeCtx());

    const plan = outcome.phases.find((phase) => phase.phase === 'plan');
    expect(plan?.meta).toEqual({ steps: 2, source: 'schema' });
    expect(plan?.degraded).toBeUndefined();
    expect(plan?.callId).toBe('call-1');
  });

  it('hands on a prose plan, and records that it fell back to one', async () => {
    const fake = createFake((spec) =>
      spec.phase === 'plan'
        ? { text: 'first check the order, then refund it', structured: undefined, structuredMissing: true }
        : { text: 'done' },
    );
    const outcome = await createPlanExecuteStrategy({ runQuery: fake.runQuery }).run(makeCtx());

    expect(fake.phase('execute').prompt).toContain('first check the order, then refund it');
    const plan = outcome.phases.find((phase) => phase.phase === 'plan');
    expect(plan?.meta).toEqual({ steps: 0, source: 'prose' });
    expect(plan?.degraded).toMatch(/came back as prose/);
  });

  it('reads steps out of JSON in prose, and records that it had to', async () => {
    const fake = createFake((spec) =>
      spec.phase === 'plan'
        ? { text: 'Plan: {"steps": ["read it", "refund it"], "rationale": "r"}', structuredMissing: true }
        : { text: 'done' },
    );
    const outcome = await createPlanExecuteStrategy({ runQuery: fake.runQuery }).run(makeCtx());

    expect(fake.phase('execute').prompt).toContain('1. read it');
    const plan = outcome.phases.find((phase) => phase.phase === 'plan');
    expect(plan?.meta).toEqual({ steps: 2, source: 'prose' });
    expect(plan?.degraded).toMatch(/JSON in prose/);
  });

  it('still executes when the plan phase produced nothing at all, and records it', async () => {
    const fake = createFake((spec) => (spec.phase === 'plan' ? { text: '' } : { text: 'done anyway' }));
    const outcome = await createPlanExecuteStrategy({ runQuery: fake.runQuery }).run(makeCtx());

    expect(fake.phases()).toEqual(['plan', 'execute']);
    expect(fake.phase('execute').prompt).toContain('(the planning step produced no plan)');
    expect(outcome.finalText).toBe('done anyway');
    expect(outcome.phases[0]?.degraded).toBe('the planner produced no plan; the executor ran without one');
  });

  it('does not call a plan the run’s limits cut short degraded', async () => {
    const fake = createFake((spec) =>
      spec.phase === 'plan'
        ? { text: '', subtype: 'error_max_budget_usd', structuredMissing: true }
        : { text: 'done' },
    );
    const outcome = await createPlanExecuteStrategy({ runQuery: fake.runQuery }).run(makeCtx());

    expect(outcome.phases[0]?.degraded).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// orchestrator-workers
// ---------------------------------------------------------------------------

describe('orchestrator-workers', () => {
  const threeSubtasks: Script = (spec) => {
    if (spec.phase === 'decompose') {
      return {
        structured: {
          subtasks: [
            { id: 'read', goal: 'Read order 42.' },
            { id: 'refund', goal: 'Refund order 42.' },
            { id: 'notify', goal: 'Draft the customer note.' },
          ],
        },
      };
    }
    return { text: `${spec.phase} report` };
  };

  it('runs one worker per subtask between decompose and synthesize', async () => {
    const fake = createFake(threeSubtasks);
    const outcome = await createOrchestratorWorkersStrategy({ runQuery: fake.runQuery }).run(makeCtx());

    expect(fake.calls).toHaveLength(5);
    expect(fake.phases()).toEqual([
      'decompose',
      'worker-read',
      'worker-refund',
      'worker-notify',
      'synthesize',
    ]);
    expect(outcome.subagentCount).toBe(3);
    expect(outcome.phases.map((phase) => phase.phase)).toEqual(fake.phases());
    expect(outcome.finalText).toBe('synthesize report');
  });

  it('runs workers as depth-1 subagents with the full toolset', async () => {
    const fake = createFake(threeSubtasks);
    await createOrchestratorWorkersStrategy({ runQuery: fake.runQuery }).run(makeCtx());

    const workers = fake.calls.filter((call) => call.phase.startsWith('worker-'));
    expect(workers).toHaveLength(3);
    for (const worker of workers) {
      expect(worker.depth).toBe(1);
      expect(worker.agentLabel).toBe(worker.phase);
      expect(worker.allowedTools).toBeUndefined();
    }
    expect(fake.phase('decompose').allowedTools).toEqual([]);
    expect(fake.phase('synthesize').allowedTools).toEqual([]);
  });

  it('gives each worker only its own assignment', async () => {
    const fake = createFake(threeSubtasks);
    await createOrchestratorWorkersStrategy({ runQuery: fake.runQuery }).run(makeCtx());

    expect(fake.phase('worker-read').prompt).toContain('Read order 42.');
    expect(fake.phase('worker-read').prompt).not.toContain('Draft the customer note.');
  });

  it('starts every worker before any of them finishes', async () => {
    const gate = deferred();
    const fake = createFake(async (spec) => {
      if (!spec.phase.startsWith('worker-')) return threeSubtasks(spec, 0);
      await gate.promise;
      return { text: `${spec.phase} report` };
    });

    const running = createOrchestratorWorkersStrategy({ runQuery: fake.runQuery }).run(makeCtx());
    await waitFor(
      () => fake.calls.filter((call) => call.phase.startsWith('worker-')).length === 3,
      'three workers to start',
    );
    // Only decompose has returned; the three workers are all in flight.
    expect(fake.resolved).toBe(1);

    gate.release();
    const outcome = await running;
    expect(outcome.subagentCount).toBe(3);
  });

  it('passes every worker report to synthesize', async () => {
    const fake = createFake(threeSubtasks);
    await createOrchestratorWorkersStrategy({ runQuery: fake.runQuery }).run(makeCtx());

    const prompt = fake.phase('synthesize').prompt;
    expect(prompt).toContain('worker-read report');
    expect(prompt).toContain('worker-refund report');
    expect(prompt).toContain('worker-notify report');
  });

  it('records the decomposition it fanned out', async () => {
    const fake = createFake(threeSubtasks);
    const outcome = await createOrchestratorWorkersStrategy({ runQuery: fake.runQuery }).run(makeCtx());

    const decompose = outcome.phases.find((phase) => phase.phase === 'decompose');
    expect(decompose?.meta).toEqual({ subtasks: 3, workers: 3, source: 'schema' });
    expect(decompose?.degraded).toBeUndefined();
  });

  it('falls back to a single worker when the decomposition cannot be read, and records it', async () => {
    const fake = createFake((spec) =>
      spec.phase === 'decompose' ? { structured: { subtasks: [] } } : { text: `${spec.phase} report` },
    );
    const outcome = await createOrchestratorWorkersStrategy({ runQuery: fake.runQuery }).run(makeCtx());

    const workers = fake.calls.filter((call) => call.phase.startsWith('worker-'));
    expect(workers).toHaveLength(1);
    expect(outcome.subagentCount).toBe(1);
    expect(fake.calls).toHaveLength(3);
    const decompose = outcome.phases.find((phase) => phase.phase === 'decompose');
    expect(decompose?.meta).toEqual({ subtasks: 0, workers: 1, source: 'none' });
    expect(decompose?.degraded).toBe('the decomposition could not be read; one worker was given the whole task');
  });

  it('gives one worker the whole task when the orchestrator chooses not to split it', async () => {
    const fake = createFake((spec) =>
      spec.phase === 'decompose'
        ? { structured: { subtasks: [{ id: 'only', goal: 'Do half of it.' }] } }
        : { text: `${spec.phase} report` },
    );
    const outcome = await createOrchestratorWorkersStrategy({ runQuery: fake.runQuery }).run(makeCtx());

    const workers = fake.calls.filter((call) => call.phase.startsWith('worker-'));
    expect(workers).toHaveLength(1);
    // A lone subtask covers the whole task, so the worker is given the task itself.
    expect(workers[0]?.prompt).not.toContain('Do half of it.');
    // Declining to split is the orchestrator's call, not a fallback.
    const decompose = outcome.phases.find((phase) => phase.phase === 'decompose');
    expect(decompose?.meta).toEqual({ subtasks: 1, workers: 1, source: 'schema' });
    expect(decompose?.degraded).toBeUndefined();
  });

  it('caps the fan-out at four workers', async () => {
    const fake = createFake((spec) =>
      spec.phase === 'decompose'
        ? {
            structured: {
              subtasks: Array.from({ length: 9 }, (_, i) => ({ id: `s${i}`, goal: `goal ${i}` })),
            },
          }
        : { text: `${spec.phase} report` },
    );
    const outcome = await createOrchestratorWorkersStrategy({ runQuery: fake.runQuery }).run(makeCtx());

    expect(fake.calls.filter((call) => call.phase.startsWith('worker-'))).toHaveLength(4);
    expect(outcome.subagentCount).toBe(4);
    expect(fake.calls).toHaveLength(6);
  });

  it('keeps worker phase names unique when the model repeats an id', async () => {
    const fake = createFake((spec) =>
      spec.phase === 'decompose'
        ? {
            structured: {
              subtasks: [
                { id: 'step', goal: 'first' },
                { id: 'step', goal: 'second' },
              ],
            },
          }
        : { text: `${spec.phase} report` },
    );
    await createOrchestratorWorkersStrategy({ runQuery: fake.runQuery }).run(makeCtx());

    const workers = fake.calls.filter((call) => call.phase.startsWith('worker-')).map((c) => c.phase);
    expect(new Set(workers).size).toBe(workers.length);
  });

  it('falls back to the last worker report when synthesize is cut short', async () => {
    const fake = createFake((spec) => {
      if (spec.phase === 'decompose') return threeSubtasks(spec, 0);
      if (spec.phase === 'synthesize') return { text: '', aborted: true, subtype: 'aborted' };
      return { text: `${spec.phase} report` };
    });
    const outcome = await createOrchestratorWorkersStrategy({ runQuery: fake.runQuery }).run(makeCtx());

    expect(outcome.finalText).toBe('worker-notify report');
    expect(outcome.phases.at(-1)?.degraded).toBeUndefined();
  });

  it('records a synthesis that came back empty on its own as degraded', async () => {
    const fake = createFake((spec) => {
      if (spec.phase === 'decompose') return threeSubtasks(spec, 0);
      if (spec.phase === 'synthesize') return { text: '' };
      return { text: `${spec.phase} report` };
    });
    const outcome = await createOrchestratorWorkersStrategy({ runQuery: fake.runQuery }).run(makeCtx());

    // The latest-started worker, whichever finished last.
    expect(outcome.finalText).toBe('worker-notify report');
    expect(outcome.phases.at(-1)?.degraded).toMatch(/synthesis came back empty/);
  });
});

// ---------------------------------------------------------------------------
// plan-execute-verify
// ---------------------------------------------------------------------------

describe('plan-execute-verify', () => {
  const BLOCKING = { approved: false, issues: ['refund amount is wrong'], severity: 'blocking' };
  /** Every verdict is `verdict`; everything else is `genericScript`. */
  const verdicts =
    (verdict: unknown): Script =>
    (spec, index) =>
      spec.phase.startsWith('verify')
        ? { text: 'verifier notes', structured: verdict }
        : spec.phase === 'plan'
          ? genericScript(spec, index)
          : { text: `${spec.phase} answer` };

  it('stops after the first verify when the work is approved', async () => {
    const fake = createFake(genericScript);
    const outcome = await createPlanExecuteVerifyStrategy({ runQuery: fake.runQuery }).run(makeCtx());

    expect(fake.phases()).toEqual(['plan', 'execute', 'verify-1']);
    expect(outcome.finalText).toBe('execute answer');
    expect(outcome.subagentCount).toBe(0);
    expect(outcome.phases).toHaveLength(3);
    expect(outcome.phases[2]?.meta).toEqual({
      approved: true,
      severity: 'none',
      issues: 0,
      decision: 'approve',
      source: 'schema',
    });
  });

  it('asks the verifier for its verdict through the schema, holding only the read-only tools', async () => {
    const fake = createFake(genericScript);
    const ctx = makeCtx();
    await createPlanExecuteVerifyStrategy({ runQuery: fake.runQuery }).run(ctx);

    expect(fake.phase('verify-1').outputSchema).toBe(VERIFY_SCHEMA);
    expect(fake.phase('verify-1').allowedTools).toEqual(ctx.env.readOnlyTools);
    expect(fake.phase('execute').allowedTools).toBeUndefined();
    expect(fake.phase('plan').allowedTools).toEqual([]);
  });

  it('revises a blocking rejection, at most twice, and leaves the last revision final', async () => {
    const fake = createFake(verdicts(BLOCKING));
    const outcome = await createPlanExecuteVerifyStrategy({ runQuery: fake.runQuery }).run(makeCtx());

    expect(fake.phases()).toEqual(['plan', 'execute', 'verify-1', 'revise-1', 'verify-2', 'revise-2']);
    expect(MAX_REVISIONS).toBe(2);
    expect(outcome.phases.map((phase) => phase.phase)).toEqual(fake.phases());
    // The verifier's critique must not become the agent's answer.
    expect(outcome.finalText).toBe('revise-2 answer');
  });

  it('shows the next verifier the revised answer and the reviser the issues', async () => {
    const fake = createFake(verdicts(BLOCKING));
    await createPlanExecuteVerifyStrategy({ runQuery: fake.runQuery }).run(makeCtx());

    const revise = fake.phase('revise-1');
    expect(revise.prompt).toContain('refund amount is wrong');
    expect(revise.prompt).toContain('execute answer');
    expect(revise.allowedTools).toBeUndefined();
    expect(fake.phase('verify-2').prompt).toContain('revise-1 answer');
  });

  it('ends the review on a rejection whose issues are only minor', async () => {
    const fake = createFake(verdicts({ approved: false, issues: ['the note is terse'], severity: 'minor' }));
    const outcome = await createPlanExecuteVerifyStrategy({ runQuery: fake.runQuery }).run(makeCtx());

    expect(fake.phases()).toEqual(['plan', 'execute', 'verify-1']);
    expect(outcome.phases[2]?.meta).toMatchObject({ approved: false, decision: 'accept-minor' });
  });

  it('revises a rejection that names no severity', async () => {
    const fake = createFake(verdicts({ approved: false, issues: ['wrong order refunded'], severity: 'none' }));
    await createPlanExecuteVerifyStrategy({ runQuery: fake.runQuery }).run(makeCtx());

    expect(fake.phases()).toContain('revise-1');
  });

  it('asks again when the verdict cannot be read, and acts on the second answer', async () => {
    let asked = 0;
    const fake = createFake((spec, index) => {
      if (spec.phase.startsWith('verify')) {
        return asked++ === 0
          ? { text: 'I checked R-1 and the refund looks wrong', structuredMissing: true }
          : { text: '', structured: BLOCKING };
      }
      return verdicts(BLOCKING)(spec, index);
    });
    const outcome = await createPlanExecuteVerifyStrategy({ runQuery: fake.runQuery }).run(makeCtx());

    expect(fake.phases().slice(0, 5)).toEqual(['plan', 'execute', 'verify-1', 'verify-1-retry', 'revise-1']);
    // The retry starts from what the first attempt found.
    expect(fake.phase('verify-1-retry').prompt).toContain('I checked R-1 and the refund looks wrong');
    expect(fake.phase('verify-1-retry').outputSchema).toBe(VERIFY_SCHEMA);
    const [first, retry] = outcome.phases.slice(2, 4);
    expect(first).toMatchObject({ retriedBy: 'verify-1-retry', meta: { decision: 'unreadable' } });
    expect(first?.degraded).toBeUndefined();
    expect(retry?.meta).toMatchObject({ decision: 'revise', source: 'schema' });
  });

  it('never approves a verdict it cannot read: it ends the review and records why', async () => {
    const fake = createFake((spec, index) =>
      spec.phase.startsWith('verify')
        ? { text: 'I could not decide', structuredMissing: true }
        : verdicts(BLOCKING)(spec, index),
    );
    const outcome = await createPlanExecuteVerifyStrategy({ runQuery: fake.runQuery }).run(makeCtx());

    expect(fake.phases()).toEqual(['plan', 'execute', 'verify-1', 'verify-1-retry']);
    const retry = outcome.phases[3];
    expect(retry?.meta).toEqual({ decision: 'unreadable' });
    expect(retry?.degraded).toBe('no verdict could be read, even when asked again; the review ended without one');
  });

  it('falls back to a verdict in prose only after the schema failed twice, and says so', async () => {
    const fake = createFake((spec, index) =>
      spec.phase.startsWith('verify')
        ? {
            text: 'Verdict: {"approved": false, "issues": ["wrong amount"], "severity": "blocking"}',
            structuredMissing: true,
          }
        : verdicts(BLOCKING)(spec, index),
    );
    const outcome = await createPlanExecuteVerifyStrategy({ runQuery: fake.runQuery }).run(makeCtx());

    expect(fake.phases().slice(0, 5)).toEqual(['plan', 'execute', 'verify-1', 'verify-1-retry', 'revise-1']);
    expect(outcome.phases[3]?.degraded).toMatch(/read from prose/);
    expect(outcome.phases[3]?.meta).toMatchObject({ decision: 'revise', source: 'prose' });
  });

  it('does not ask again when the run’s limits cut the verifier short', async () => {
    const fake = createFake((spec, index) =>
      spec.phase.startsWith('verify')
        ? { text: '', structuredMissing: true, aborted: true, subtype: 'aborted' }
        : verdicts(BLOCKING)(spec, index),
    );
    const outcome = await createPlanExecuteVerifyStrategy({ runQuery: fake.runQuery }).run(makeCtx());

    expect(fake.phases()).toEqual(['plan', 'execute', 'verify-1']);
    expect(outcome.phases[2]?.degraded).toBeUndefined();
    expect(outcome.finalText).toBe('execute answer');
  });

  it('uses the verifier prose when it rejects without listing issues', async () => {
    const fake = createFake((spec, index) =>
      spec.phase.startsWith('verify')
        ? { text: 'the order was never read', structured: { approved: false, issues: [], severity: 'blocking' } }
        : verdicts(BLOCKING)(spec, index),
    );
    await createPlanExecuteVerifyStrategy({ runQuery: fake.runQuery }).run(makeCtx());

    expect(fake.phase('revise-1').prompt).toContain('the order was never read');
  });
});

// ---------------------------------------------------------------------------
// propose-select
// ---------------------------------------------------------------------------

describe('propose-select', () => {
  it('runs three read-only proposers, selects, then executes', async () => {
    const fake = createFake(genericScript);
    const ctx = makeCtx();
    const outcome = await createProposeSelectStrategy({ runQuery: fake.runQuery }).run(ctx);

    expect(fake.phases()).toEqual(['propose-1', 'propose-2', 'propose-3', 'select', 'execute']);
    expect(outcome.subagentCount).toBe(3);
    expect(outcome.finalText).toBe('execute answer');

    for (const index of [1, 2, 3]) {
      const proposer = fake.phase(`propose-${index}`);
      expect(proposer.allowedTools).toEqual(ctx.env.readOnlyTools);
      expect(proposer.depth).toBe(1);
      expect(proposer.agentLabel).toBe(`proposer-${index}`);
    }
    expect(fake.phase('select').allowedTools).toEqual([]);
    expect(fake.phase('execute').allowedTools).toBeUndefined();
    expect(outcome.phases.find((phase) => phase.phase === 'select')?.meta).toEqual({
      winnerIndex: 2,
      source: 'schema',
      mergedAnswer: true,
    });
    expect(outcome.phases.some((phase) => phase.degraded !== undefined)).toBe(false);
  });

  it('gives each proposer its own lens, and records which', async () => {
    const fake = createFake(genericScript);
    const outcome = await createProposeSelectStrategy({ runQuery: fake.runQuery }).run(makeCtx());

    expect(PROPOSER_LENSES.map((lens) => lens.id)).toEqual(['policy-first', 'state-first', 'outcome-first']);
    PROPOSER_LENSES.forEach((lens, i) => {
      const prompt = fake.phase(`propose-${i + 1}`).prompt;
      expect(prompt).toContain(lens.instruction);
      for (const other of PROPOSER_LENSES.filter((candidate) => candidate !== lens)) {
        expect(prompt).not.toContain(other.instruction);
      }
      expect(outcome.phases[i]?.meta).toEqual({ lens: lens.id });
      expect(outcome.phases[i]?.label).toBe(`Proposal ${i + 1} (${lens.id})`);
    });
  });

  it('starts every proposer before any of them finishes', async () => {
    const gate = deferred();
    const fake = createFake(async (spec) => {
      if (!spec.phase.startsWith('propose-')) return genericScript(spec, 0);
      await gate.promise;
      return { text: `${spec.phase} proposal` };
    });

    const running = createProposeSelectStrategy({ runQuery: fake.runQuery }).run(makeCtx());
    await waitFor(() => fake.calls.length === 3, 'three proposers to start');
    expect(fake.resolved).toBe(0);

    gate.release();
    await running;
  });

  it('shows the selector every proposal and the executor the winning one', async () => {
    const fake = createFake((spec) =>
      spec.phase.startsWith('propose-') ? { text: `${spec.phase} proposal` } : genericScript(spec, 0),
    );
    await createProposeSelectStrategy({ runQuery: fake.runQuery }).run(makeCtx());

    const select = fake.phase('select').prompt;
    expect(select).toContain('propose-1 proposal');
    expect(select).toContain('propose-2 proposal');
    expect(select).toContain('propose-3 proposal');

    const execute = fake.phase('execute').prompt;
    expect(execute).toContain('propose-2 proposal');
    expect(execute).toContain('merged answer');
  });

  it('skips the execute phase when the task has nothing to mutate', async () => {
    const readOnly = ['mcp__web__search', 'mcp__web__fetch'];
    const ctx = makeCtx({ env: makeEnv({ allowedTools: readOnly, readOnlyTools: [...readOnly] }) });
    const fake = createFake(genericScript);
    const outcome = await createProposeSelectStrategy({ runQuery: fake.runQuery }).run(ctx);

    expect(fake.phases()).toEqual(['propose-1', 'propose-2', 'propose-3', 'select']);
    expect(outcome.finalText).toBe('merged answer');
    expect(outcome.subagentCount).toBe(3);
  });

  const clampCases: { label: string; winnerIndex: unknown }[] = [
    { label: 'above range', winnerIndex: 99 },
    { label: 'zero', winnerIndex: 0 },
    { label: 'negative', winnerIndex: -4 },
    { label: 'fractional', winnerIndex: 2.6 },
    { label: 'not a number', winnerIndex: 'second' },
  ];

  it.each(clampCases)('clamps an out-of-range winnerIndex, and records it ($label)', async ({ winnerIndex }) => {
    const fake = createFake((spec) => {
      if (spec.phase.startsWith('propose-')) return { text: `${spec.phase} proposal` };
      if (spec.phase === 'select') {
        return { structured: { winnerIndex, rationale: 'r', mergedAnswer: 'merged answer' } };
      }
      return { text: 'execute answer' };
    });
    const outcome = await createProposeSelectStrategy({ runQuery: fake.runQuery }).run(makeCtx());

    expect(outcome.finalText).toBe('execute answer');
    expect(fake.phase('execute').prompt).toMatch(/propose-[123] proposal/);
    expect(outcome.phases.find((phase) => phase.phase === 'select')?.degraded).toMatch(
      /was not a proposal number/,
    );
  });

  it('still executes when the selector returns nothing usable, and records the default winner', async () => {
    const fake = createFake((spec) =>
      spec.phase.startsWith('propose-') ? { text: `${spec.phase} proposal` } : { text: '' },
    );
    const outcome = await createProposeSelectStrategy({ runQuery: fake.runQuery }).run(makeCtx());

    expect(fake.phases()).toEqual(['propose-1', 'propose-2', 'propose-3', 'select', 'execute']);
    expect(fake.phase('execute').prompt).toContain('propose-1 proposal');
    const select = outcome.phases.find((phase) => phase.phase === 'select');
    expect(select?.meta).toEqual({ winnerIndex: 1, source: 'none', mergedAnswer: false });
    expect(select?.degraded).toBe('the selection could not be read; proposal 1 was used by default');
    // A proposal is a plan for the executor, never the answer: the executor
    // said nothing, so there is no answer.
    expect(outcome.finalText).toBe('');
  });

  it('records a read-only run whose selector wrote no merged answer', async () => {
    const readOnly = ['mcp__web__search', 'mcp__web__fetch'];
    const ctx = makeCtx({ env: makeEnv({ allowedTools: readOnly, readOnlyTools: [...readOnly] }) });
    const fake = createFake((spec) =>
      spec.phase === 'select'
        ? { structured: { winnerIndex: 3, rationale: 'r', mergedAnswer: '' } }
        : { text: `${spec.phase} proposal` },
    );
    const outcome = await createProposeSelectStrategy({ runQuery: fake.runQuery }).run(ctx);

    expect(outcome.finalText).toBe('propose-3 proposal');
    expect(outcome.phases.at(-1)?.degraded).toBe(
      'the selector wrote no merged answer; the winning proposal stands as the answer',
    );
  });

  it('does not call a selection the run’s limits cut short degraded', async () => {
    const fake = createFake((spec) =>
      spec.phase === 'select'
        ? { text: '', aborted: true, subtype: 'aborted', structuredMissing: true }
        : { text: `${spec.phase} proposal` },
    );
    const outcome = await createProposeSelectStrategy({ runQuery: fake.runQuery }).run(makeCtx());

    expect(outcome.phases.find((phase) => phase.phase === 'select')?.degraded).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Shared contract
// ---------------------------------------------------------------------------

describe('every strategy', () => {
  it.each(allFactories)('$id records one phase per call', async ({ create }) => {
    const fake = createFake(genericScript);
    const outcome = await create({ runQuery: fake.runQuery }).run(makeCtx());

    expect(outcome.phases).toHaveLength(fake.calls.length);
    expect(outcome.phases.map((phase) => phase.phase)).toEqual(fake.phases());
    expect(outcome.finalText).not.toBe('');
    for (const phase of outcome.phases) {
      expect(phase.model).toBe('test-model');
      expect(phase.label).not.toBe('');
      expect(phase.costUsd).toBe(BASE_OUTCOME.costUsd);
      expect(phase.turns).toBe(BASE_OUTCOME.turns);
      expect(phase.durationMs).toBe(BASE_OUTCOME.durationMs);
    }
  });

  it.each(allFactories)('$id stops before any call when the budget is exhausted', async ({ create }) => {
    const fake = createFake(genericScript);
    const outcome = await create({ runQuery: fake.runQuery }).run(makeCtx({ budget: makeBudget(true) }));

    expect(fake.calls).toHaveLength(0);
    expect(outcome.phases).toEqual([]);
    expect(outcome.finalText).toBe('');
    expect(outcome.subagentCount).toBe(0);
  });

  it.each(allFactories)('$id stops before any call when the run was aborted', async ({ create }) => {
    const fake = createFake(genericScript);
    const outcome = await create({ runQuery: fake.runQuery }).run(makeCtx({ aborted: true }));

    expect(fake.calls).toHaveLength(0);
    expect(outcome.phases).toEqual([]);
  });

  it.each(allFactories)('$id keeps the acting phase’s answer when the run is cut short after it', async ({ create }) => {
    // The first acting phase answers; everything after it comes back empty
    // and aborted, as it would once the wall clock trips mid-run.
    let acted = false;
    const fake = createFake((spec, index) => {
      if (ACTING_PHASE.test(spec.phase)) {
        acted = true;
        return { text: 'acting answer' };
      }
      if (acted) return { text: '', aborted: true, subtype: 'aborted' };
      return genericScript(spec, index);
    });
    const outcome = await create({ runQuery: fake.runQuery }).run(makeCtx());

    expect(outcome.finalText).toBe('acting answer');
  });

  it.each(allFactories)('$id never answers with a plan, a verdict or a choice', async ({ create }) => {
    // Every phase that is not an answer says something; every acting phase,
    // and the synthesis, comes back empty.
    const fake = createFake((spec, index) =>
      ACTING_PHASE.test(spec.phase) || spec.phase === 'synthesize'
        ? { text: '' }
        : { ...(genericScript(spec, index) as Partial<QueryOutcome>), text: `${spec.phase} notes` },
    );
    const outcome = await create({ runQuery: fake.runQuery }).run(makeCtx());

    expect(outcome.finalText).toBe('');
  });

  it.each(allFactories)('$id gives every acting phase the same instructions', async ({ create }) => {
    const fake = createFake(rejectingFirstVerdict());
    await create({ runQuery: fake.runQuery }).run(makeCtx());

    const acting = fake.calls.filter((call) => ACTING_PHASE.test(call.phase));
    expect(acting.length).toBeGreaterThan(0);
    for (const call of acting) {
      expect(call.prompt).toContain(ACTING_INSTRUCTIONS);
      // A worker reports to the orchestrator; every other acting phase answers the task.
      if (call.phase.startsWith('worker-')) {
        expect(call.prompt).toMatch(/Your report is all the orchestrator will see\.$/);
      } else {
        expect(call.prompt.endsWith(FINAL_ANSWER_INSTRUCTION)).toBe(true);
      }
    }
    for (const call of fake.calls.filter((c) => !ACTING_PHASE.test(c.phase))) {
      expect(call.prompt).not.toContain(ACTING_INSTRUCTIONS);
    }
  });

  it.each(allFactories)('$id gives every phase the turns the shared policy sets', async ({ create }) => {
    const fake = createFake(rejectingFirstVerdict());
    await create({ runQuery: fake.runQuery }).run(makeCtx());

    for (const call of fake.calls) {
      const toolless = call.allowedTools !== undefined && call.allowedTools.length === 0;
      if (toolless && call.outputSchema) expect(call.maxTurns, call.phase).toBe(SCHEMA_MIN_TURNS);
      else if (toolless) expect(call.maxTurns, call.phase).toBe(REASONING_TURNS);
      // Anything holding tools gets the task's own allowance.
      else expect(call.maxTurns, call.phase).toBeUndefined();
    }
  });

  it.each(allFactories)('$id never restates the task instead of quoting it', async ({ create }) => {
    const fake = createFake(genericScript);
    const ctx = makeCtx();
    await create({ runQuery: fake.runQuery }).run(ctx);

    for (const call of fake.calls) {
      expect(call.prompt).toContain(ctx.task.prompt);
      expect(call.label ?? '').not.toBe('');
    }
  });
});

// ---------------------------------------------------------------------------
// Fan-out fidelity
// ---------------------------------------------------------------------------

describe('fan-out fidelity', () => {
  const record = (phase: string, overrides: Partial<PhaseRecord> = {}): PhaseRecord => ({
    phase,
    label: phase,
    startedAtMs: 0,
    durationMs: 1,
    costUsd: 0.01,
    turns: 1,
    toolCalls: 0,
    model: 'm',
    aborted: false,
    subtype: 'success',
    ...overrides,
  });
  const input = (phases: PhaseRecord[], subagentCount: number, stoppedBy?: 'cost'): FidelityInput => {
    const env = makeEnv();
    return {
      task: makeTask(env),
      env,
      outcome: { finalText: 'x', subagentCount, phases },
      trace: [],
      ...(stoppedBy ? { stoppedBy } : {}),
    };
  };
  const check = (checks: { id: string; ok: boolean; detail?: string }[], id: string) =>
    checks.find((c) => c.id === id);

  it('fails a fan-out in which one worker was starved while the others ran', () => {
    const phases = [
      record('decompose', { meta: { subtasks: 2, workers: 2, source: 'schema' } }),
      record('worker-a'),
      record('worker-b', { subtype: 'skipped', aborted: true }),
      record('synthesize'),
    ];
    expect(check(orchestratorWorkersFidelityChecks(input(phases, 2)), 'orchestrator-workers.fan-out')).toEqual({
      id: 'orchestrator-workers.fan-out',
      ok: false,
      detail: 'worker-b never started while the others ran',
    });
  });

  it('fails a selection among proposals when one proposer was starved', () => {
    const phases = [
      record('propose-1', { meta: { lens: 'policy-first' } }),
      record('propose-2', { meta: { lens: 'state-first' }, subtype: 'skipped', aborted: true }),
      record('propose-3', { meta: { lens: 'outcome-first' } }),
    ];
    expect(check(proposeSelectFidelityChecks(input(phases, 3)), 'propose-select.proposals')).toMatchObject({
      ok: false,
      detail: 'propose-2 never started while the others ran',
    });
  });

  it('says so, rather than claiming they ran, when no worker had budget enough to start', () => {
    const skipped = { subtype: 'skipped', aborted: true } as const;
    const workers = [
      record('decompose', { meta: { subtasks: 2, workers: 2, source: 'schema' } }),
      record('worker-a', skipped),
      record('worker-b', skipped),
    ];
    expect(check(orchestratorWorkersFidelityChecks(input(workers, 2)), 'orchestrator-workers.fan-out')).toEqual({
      id: 'orchestrator-workers.fan-out',
      ok: true,
      detail: 'no worker started: the run had too little budget left to start any',
    });
    const proposers = PROPOSER_LENSES.map((lens, i) => record(`propose-${i + 1}`, { ...skipped, meta: { lens: lens.id } }));
    expect(check(proposeSelectFidelityChecks(input(proposers, 3)), 'propose-select.proposals')).toEqual({
      id: 'propose-select.proposals',
      ok: true,
      detail: 'no proposer started: the run had too little budget left to start any',
    });
  });

  it('excuses a fan-out the run’s budget stopped before it began', () => {
    const phases = [record('decompose', { meta: { subtasks: 3, workers: 3, source: 'schema' } })];
    expect(check(orchestratorWorkersFidelityChecks(input(phases, 0, 'cost')), 'orchestrator-workers.fan-out')).toMatchObject({
      ok: true,
    });
  });
});

// ---------------------------------------------------------------------------
// The phase runner
// ---------------------------------------------------------------------------

describe('createPhaseRunner', () => {
  it('lists a phase where it started, not where it finished', async () => {
    const gate = deferred();
    const fake = createFake(async (spec) => {
      if (spec.phase === 'slow') await gate.promise;
      return { text: spec.phase };
    });
    const runner = createPhaseRunner(makeCtx(), { runQuery: fake.runQuery });

    const slow = runner.run({ phase: 'slow', label: 'Slow', prompt: 'go' });
    // A call made while the slow one waits — as a review is — finishes first.
    await runner.run({ phase: 'quick', label: 'Quick', prompt: 'go' });
    gate.release();
    await slow;

    expect(runner.phases.map((phase) => phase.phase)).toEqual(['slow', 'quick']);
  });

  it('falls back to the latest-started answer, whichever finished last', async () => {
    const gate = deferred();
    const fake = createFake(async (spec) => {
      if (spec.phase === 'first') await gate.promise;
      return { text: `${spec.phase} answer` };
    });
    const runner = createPhaseRunner(makeCtx(), { runQuery: fake.runQuery });

    const first = runner.run({ phase: 'first', label: 'First', prompt: 'go', answers: true });
    await runner.run({ phase: 'second', label: 'Second', prompt: 'go', answers: true });
    await runner.run({ phase: 'notes', label: 'Notes', prompt: 'go' });
    gate.release();
    await first;

    expect(runner.finish().finalText).toBe('second answer');
  });

  it('adds what the strategy read to the phase’s record', async () => {
    const fake = createFake(() => ({ text: 'x' }));
    const runner = createPhaseRunner(makeCtx(), { runQuery: fake.runQuery });

    const outcome = await runner.run({ phase: 'plan', label: 'Plan', prompt: 'go' });
    runner.annotate(outcome, { meta: { steps: 0 }, degraded: 'no plan', retriedBy: 'plan-retry' });
    runner.annotate(outcome, { meta: { source: 'none' } });

    expect(runner.phases[0]).toMatchObject({
      callId: 'call-1',
      meta: { steps: 0, source: 'none' },
      degraded: 'no plan',
      retriedBy: 'plan-retry',
    });
  });
});

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

describe('STRATEGIES', () => {
  it('lists the six architectures in comparison order', () => {
    expect(STRATEGIES.map((strategy) => strategy.id)).toEqual([
      'single',
      'plan-execute',
      'orchestrator-workers',
      'plan-execute-verify',
      'propose-select',
      'gated-execute',
    ]);
  });

  it('gives every strategy its fidelity checks', () => {
    for (const strategy of STRATEGIES) expect(strategy.fidelityChecks, strategy.id).toBeTypeOf('function');
  });

  it('gives every strategy a label and a description', () => {
    for (const strategy of STRATEGIES) {
      expect(strategy.label.length).toBeGreaterThan(0);
      expect(strategy.description.length).toBeGreaterThan(40);
    }
  });
});

describe('getStrategies', () => {
  it('returns everything for undefined, an empty list and "all"', () => {
    expect(getStrategies()).toHaveLength(STRATEGIES.length);
    expect(getStrategies([])).toHaveLength(STRATEGIES.length);
    expect(getStrategies(['all'])).toHaveLength(STRATEGIES.length);
  });

  it('returns the requested subset in registry order', () => {
    expect(getStrategies(['propose-select', 'single']).map((s) => s.id)).toEqual([
      'single',
      'propose-select',
    ]);
  });

  it('deduplicates repeated ids', () => {
    expect(getStrategies(['single', 'single']).map((s) => s.id)).toEqual(['single']);
  });

  it('selects an architecture by the id it had before a rename', () => {
    expect(LEGACY_STRATEGY_IDS).toEqual({ 'debate-select': 'propose-select' });
    expect(canonicalStrategyId('debate-select')).toBe('propose-select');
    expect(canonicalStrategyId('single')).toBe('single');
    expect(getStrategies(['debate-select']).map((s) => s.id)).toEqual(['propose-select']);
  });

  it('throws for an unknown id and names the valid ones', () => {
    expect(() => getStrategies(['nope'])).toThrow(/nope/);
    expect(() => getStrategies(['nope'])).toThrow(/plan-execute-verify/);
  });
});
