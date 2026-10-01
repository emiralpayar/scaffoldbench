import { describe, expect, it } from 'vitest';
import { emptyUsage } from '@arena/core';
import type {
  BudgetLedger,
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
  STRATEGIES,
  createDebateSelectStrategy,
  createOrchestratorWorkersStrategy,
  createPlanExecuteStrategy,
  createPlanExecuteVerifyStrategy,
  createSingleStrategy,
  getStrategies,
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
      return { ...BASE_OUTCOME, ...partial };
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
  if (spec.phase === 'verify') {
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

const allFactories: { id: string; create: (deps: Partial<StrategyDeps>) => Strategy }[] = [
  { id: 'single', create: createSingleStrategy },
  { id: 'plan-execute', create: createPlanExecuteStrategy },
  { id: 'orchestrator-workers', create: createOrchestratorWorkersStrategy },
  { id: 'plan-execute-verify', create: createPlanExecuteVerifyStrategy },
  { id: 'debate-select', create: createDebateSelectStrategy },
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

  it('falls back to the raw plan text when structured output is undefined', async () => {
    const fake = createFake((spec) =>
      spec.phase === 'plan'
        ? { text: 'first check the order, then refund it', structured: undefined }
        : { text: 'done' },
    );
    await createPlanExecuteStrategy({ runQuery: fake.runQuery }).run(makeCtx());

    expect(fake.phase('execute').prompt).toContain('first check the order, then refund it');
  });

  it('still executes when the plan phase produced nothing at all', async () => {
    const fake = createFake((spec) => (spec.phase === 'plan' ? { text: '' } : { text: 'done anyway' }));
    const outcome = await createPlanExecuteStrategy({ runQuery: fake.runQuery }).run(makeCtx());

    expect(fake.phases()).toEqual(['plan', 'execute']);
    expect(outcome.finalText).toBe('done anyway');
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

  it('falls back to a single worker when decomposition returns nothing', async () => {
    const fake = createFake((spec) =>
      spec.phase === 'decompose' ? { structured: { subtasks: [] } } : { text: `${spec.phase} report` },
    );
    const outcome = await createOrchestratorWorkersStrategy({ runQuery: fake.runQuery }).run(makeCtx());

    const workers = fake.calls.filter((call) => call.phase.startsWith('worker-'));
    expect(workers).toHaveLength(1);
    expect(outcome.subagentCount).toBe(1);
    expect(fake.calls).toHaveLength(3);
  });

  it('falls back to a single worker when decomposition returns one subtask', async () => {
    const fake = createFake((spec) =>
      spec.phase === 'decompose'
        ? { structured: { subtasks: [{ id: 'only', goal: 'Do half of it.' }] } }
        : { text: `${spec.phase} report` },
    );
    await createOrchestratorWorkersStrategy({ runQuery: fake.runQuery }).run(makeCtx());

    const workers = fake.calls.filter((call) => call.phase.startsWith('worker-'));
    expect(workers).toHaveLength(1);
    // A lone subtask is not a decomposition, so the worker is given the whole task.
    expect(workers[0]?.prompt).not.toContain('Do half of it.');
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

  it('falls back to the last worker report when synthesize returns nothing', async () => {
    const fake = createFake((spec) => {
      if (spec.phase === 'decompose') return threeSubtasks(spec, 0);
      if (spec.phase === 'synthesize') return { text: '', aborted: true };
      return { text: `${spec.phase} report` };
    });
    const outcome = await createOrchestratorWorkersStrategy({ runQuery: fake.runQuery }).run(makeCtx());

    expect(outcome.finalText).toBe('worker-notify report');
  });
});

// ---------------------------------------------------------------------------
// plan-execute-verify
// ---------------------------------------------------------------------------

describe('plan-execute-verify', () => {
  it('stops after the first verify when the work is approved', async () => {
    const fake = createFake(genericScript);
    const outcome = await createPlanExecuteVerifyStrategy({ runQuery: fake.runQuery }).run(makeCtx());

    expect(fake.phases()).toEqual(['plan', 'execute', 'verify']);
    expect(outcome.finalText).toBe('execute answer');
    expect(outcome.subagentCount).toBe(0);
    expect(outcome.phases).toHaveLength(3);
  });

  it('gives the verifier read-only tools and the executor the full toolset', async () => {
    const fake = createFake(genericScript);
    const ctx = makeCtx();
    await createPlanExecuteVerifyStrategy({ runQuery: fake.runQuery }).run(ctx);

    expect(fake.phase('verify').allowedTools).toEqual(ctx.env.readOnlyTools);
    expect(fake.phase('execute').allowedTools).toBeUndefined();
    expect(fake.phase('plan').allowedTools).toEqual([]);
  });

  it('revises at most twice when the verifier keeps rejecting', async () => {
    const fake = createFake((spec) => {
      if (spec.phase === 'plan') return genericScript(spec, 0);
      if (spec.phase === 'verify') {
        return {
          text: 'not yet',
          structured: { approved: false, issues: ['refund amount is wrong'], severity: 'blocking' },
        };
      }
      return { text: `${spec.phase} answer` };
    });
    const outcome = await createPlanExecuteVerifyStrategy({ runQuery: fake.runQuery }).run(makeCtx());

    expect(fake.phases()).toEqual([
      'plan',
      'execute',
      'verify',
      'revise-1',
      'verify',
      'revise-2',
      'verify',
    ]);
    expect(outcome.phases.map((phase) => phase.phase)).toEqual(fake.phases());
    // The verifier's critique must not become the agent's answer.
    expect(outcome.finalText).toBe('revise-2 answer');
  });

  it('injects the reported issues into the revision prompt', async () => {
    const fake = createFake((spec) => {
      if (spec.phase === 'plan') return genericScript(spec, 0);
      if (spec.phase === 'verify') {
        return {
          text: 'not yet',
          structured: { approved: false, issues: ['refund amount is wrong'], severity: 'blocking' },
        };
      }
      return { text: `${spec.phase} answer` };
    });
    await createPlanExecuteVerifyStrategy({ runQuery: fake.runQuery }).run(makeCtx());

    const revise = fake.phase('revise-1');
    expect(revise.prompt).toContain('refund amount is wrong');
    expect(revise.prompt).toContain('execute answer');
    expect(revise.allowedTools).toBeUndefined();
  });

  it('treats an unreadable verdict as approval rather than revising blindly', async () => {
    const fake = createFake((spec) => {
      if (spec.phase === 'plan') return genericScript(spec, 0);
      if (spec.phase === 'verify') return { text: 'I could not decide', structured: undefined };
      return { text: `${spec.phase} answer` };
    });
    await createPlanExecuteVerifyStrategy({ runQuery: fake.runQuery }).run(makeCtx());

    expect(fake.phases()).toEqual(['plan', 'execute', 'verify']);
  });

  it('uses the verifier prose when it rejects without listing issues', async () => {
    const fake = createFake((spec) => {
      if (spec.phase === 'plan') return genericScript(spec, 0);
      if (spec.phase === 'verify') {
        return { text: 'the order was never read', structured: { approved: false, issues: [], severity: 'blocking' } };
      }
      return { text: `${spec.phase} answer` };
    });
    await createPlanExecuteVerifyStrategy({ runQuery: fake.runQuery }).run(makeCtx());

    expect(fake.phase('revise-1').prompt).toContain('the order was never read');
  });
});

// ---------------------------------------------------------------------------
// debate-select
// ---------------------------------------------------------------------------

describe('debate-select', () => {
  it('runs three read-only proposers, selects, then executes', async () => {
    const fake = createFake(genericScript);
    const ctx = makeCtx();
    const outcome = await createDebateSelectStrategy({ runQuery: fake.runQuery }).run(ctx);

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
  });

  it('starts every proposer before any of them finishes', async () => {
    const gate = deferred();
    const fake = createFake(async (spec) => {
      if (!spec.phase.startsWith('propose-')) return genericScript(spec, 0);
      await gate.promise;
      return { text: `${spec.phase} proposal` };
    });

    const running = createDebateSelectStrategy({ runQuery: fake.runQuery }).run(makeCtx());
    await waitFor(() => fake.calls.length === 3, 'three proposers to start');
    expect(fake.resolved).toBe(0);

    gate.release();
    await running;
  });

  it('shows the selector every proposal and the executor the winning one', async () => {
    const fake = createFake((spec) =>
      spec.phase.startsWith('propose-') ? { text: `${spec.phase} proposal` } : genericScript(spec, 0),
    );
    await createDebateSelectStrategy({ runQuery: fake.runQuery }).run(makeCtx());

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
    const outcome = await createDebateSelectStrategy({ runQuery: fake.runQuery }).run(ctx);

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

  it.each(clampCases)('clamps an out-of-range winnerIndex ($label)', async ({ winnerIndex }) => {
    const fake = createFake((spec) => {
      if (spec.phase.startsWith('propose-')) return { text: `${spec.phase} proposal` };
      if (spec.phase === 'select') {
        return { structured: { winnerIndex, rationale: 'r', mergedAnswer: 'merged answer' } };
      }
      return { text: 'execute answer' };
    });
    const outcome = await createDebateSelectStrategy({ runQuery: fake.runQuery }).run(makeCtx());

    expect(outcome.finalText).toBe('execute answer');
    expect(fake.phase('execute').prompt).toMatch(/propose-[123] proposal/);
  });

  it('still executes when the selector returns nothing usable', async () => {
    const fake = createFake((spec) =>
      spec.phase.startsWith('propose-') ? { text: `${spec.phase} proposal` } : { text: '' },
    );
    const outcome = await createDebateSelectStrategy({ runQuery: fake.runQuery }).run(makeCtx());

    expect(fake.phases()).toEqual(['propose-1', 'propose-2', 'propose-3', 'select', 'execute']);
    expect(outcome.finalText).toBe('propose-3 proposal');
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

  it.each(allFactories)('$id keeps the answer of the last productive phase', async ({ create }) => {
    // Everything after the first call comes back empty and aborted, as it would
    // once the wall clock trips mid-run.
    const fake = createFake((spec, index) =>
      index === 0
        ? { ...(genericScript(spec, index) as Partial<QueryOutcome>), text: 'first phase answer' }
        : { text: '', aborted: true, subtype: 'aborted' },
    );
    const outcome = await create({ runQuery: fake.runQuery }).run(makeCtx());

    expect(outcome.finalText).toBe('first phase answer');
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
// Registry
// ---------------------------------------------------------------------------

describe('STRATEGIES', () => {
  it('lists the five architectures in comparison order', () => {
    expect(STRATEGIES.map((strategy) => strategy.id)).toEqual([
      'single',
      'plan-execute',
      'orchestrator-workers',
      'plan-execute-verify',
      'debate-select',
    ]);
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
    expect(getStrategies()).toHaveLength(5);
    expect(getStrategies([])).toHaveLength(5);
    expect(getStrategies(['all'])).toHaveLength(5);
  });

  it('returns the requested subset in registry order', () => {
    expect(getStrategies(['debate-select', 'single']).map((s) => s.id)).toEqual([
      'single',
      'debate-select',
    ]);
  });

  it('deduplicates repeated ids', () => {
    expect(getStrategies(['single', 'single']).map((s) => s.id)).toEqual(['single']);
  });

  it('throws for an unknown id and names the valid ones', () => {
    expect(() => getStrategies(['nope'])).toThrow(/nope/);
    expect(() => getStrategies(['nope'])).toThrow(/plan-execute-verify/);
  });
});
