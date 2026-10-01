import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@anthropic-ai/claude-agent-sdk')>();
  const fake = await import('./support/fakeClaudeCode');
  return { ...actual, query: fake.fakeQuery };
});

import {
  HARNESS_CHECK,
  STRUCTURED_OUTPUT_TOOL,
  buildScore,
  createJournaledToolServer,
  runMatrix,
  runQuery,
} from '@arena/core';
import type {
  McpServerConfig,
  PhaseRecord,
  QueryOutcome,
  RunContext,
  RunRecord,
  RunnerConfig,
  RunnerEvent,
  Strategy,
  Task,
  TaskEnvironment,
  ToolCall,
} from '@arena/core';
import {
  assistant,
  errorResult,
  resetFake,
  setScript,
  sleep,
  success,
  toolResult,
  toolUse,
  type FakeSession,
} from './support/fakeClaudeCode';

/**
 * The runner, driven through the real `runQuery`, guard and per-call MCP
 * servers against a scripted SDK: what lands in `RunRecord.integrity` and
 * `failureMode` when the harness, the API or the run's own limits are what
 * went wrong. `runner.test.ts` covers the runner's bookkeeping with stubs.
 */

const MODEL = 'claude-haiku-4-5-20251001';
const PLAN = { steps: ['look up the order', 'refund it'] };
const PLAN_SCHEMA = {
  type: 'object',
  properties: { steps: { type: 'array', items: { type: 'string' } } },
  required: ['steps'],
};

interface ShopOptions {
  /**
   * Hand every call the same server instances, as every phase was handed
   * them before servers were built per call.
   */
  sharedServers?: boolean;
}

function makeEnv(options: ShopOptions = {}): TaskEnvironment & { journal: ToolCall[] } {
  const journal: ToolCall[] = [];
  const server = createJournaledToolServer({
    name: 'shop',
    journal,
    tools: [
      {
        name: 'get_order',
        description: 'Read an order',
        schema: { id: z.string() },
        readOnly: true,
        handler: (args: { id: string }) => `order ${args.id}: paid, eligible for refund`,
      },
      {
        name: 'refund',
        description: 'Refund an order',
        schema: { id: z.string() },
        handler: (args: { id: string }) => `refunded ${args.id}`,
      },
    ],
  });
  let shared: Record<string, McpServerConfig> | undefined;
  return {
    createMcpServers: options.sharedServers
      ? () => (shared ??= server.createMcpServers())
      : server.createMcpServers,
    allowedTools: server.allowedTools,
    readOnlyTools: server.readOnlyTools,
    state: {},
    journal,
  };
}

function makeTask(options: ShopOptions = {}): Task {
  return {
    id: 'shop-refund',
    category: 'tool-use',
    world: 'shop',
    title: 'Refund an order',
    prompt: 'Refund order O-1.',
    difficulty: 'easy',
    tags: [],
    maxTurns: 6,
    createEnvironment: () => makeEnv(options),
    async score({ env }) {
      const refunded = env.journal.some((call) => call.name === 'refund' && call.ok);
      return buildScore({
        breakdown: [{ id: 'refund', label: 'O-1 refunded', weight: 1, earned: refunded ? 1 : 0 }],
      });
    },
  };
}

function phaseOf(outcome: QueryOutcome, phase: string): PhaseRecord {
  return {
    phase,
    label: phase,
    startedAtMs: outcome.startedAtMs,
    durationMs: outcome.durationMs,
    costUsd: outcome.costUsd,
    turns: outcome.turns,
    toolCalls: outcome.toolCalls,
    model: MODEL,
    aborted: outcome.aborted,
    subtype: outcome.subtype,
    ...(outcome.error ? { error: outcome.error } : {}),
    ...(outcome.apiError ? { apiError: outcome.apiError } : {}),
    ...(outcome.costEstimated ? { costEstimated: true } : {}),
    ...(outcome.structuredMissing ? { structuredMissing: true } : {}),
  };
}

function strategy(id: string, run: (ctx: RunContext) => Promise<PhaseRecord[]>): Strategy {
  return {
    id,
    label: id,
    description: id,
    run: async (ctx) => ({ finalText: 'done', subagentCount: 0, phases: await run(ctx) }),
  };
}

/** One agent with every tool. */
const single = strategy('single', async (ctx) => [
  phaseOf(await runQuery(ctx, { phase: 'main', prompt: 'ACT' }), 'main'),
]);

/** A planner, then an executor with every tool. */
function planThenAct(plannerSchema: boolean): Strategy {
  return strategy('plan-then-act', async (ctx) => {
    const plan = await runQuery(ctx, {
      phase: 'plan',
      prompt: 'PLAN',
      allowedTools: [],
      maxTurns: 1,
      ...(plannerSchema ? { outputSchema: PLAN_SCHEMA } : {}),
    });
    const act = await runQuery(ctx, { phase: 'execute', prompt: 'ACT' });
    return [phaseOf(plan, 'plan'), phaseOf(act, 'execute')];
  });
}

/** Two read-only proposers at once, then an executor. */
const proposeThenAct = strategy('propose-then-act', async (ctx) => {
  const share = ctx.budget.availableUsd / 2;
  const proposals = await Promise.all(
    [1, 2].map((n) =>
      runQuery(ctx, {
        phase: `propose-${n}`,
        prompt: 'PROPOSE',
        allowedTools: ctx.env.readOnlyTools,
        maxBudgetUsd: share,
      }),
    ),
  );
  const act = await runQuery(ctx, { phase: 'execute', prompt: 'ACT' });
  return [...proposals.map((p, i) => phaseOf(p, `propose-${i + 1}`)), phaseOf(act, 'execute')];
});

/** The model's side of a solving session: refund O-1, then finish. */
async function* solves(session: FakeSession) {
  const outcome = await session.callTool('mcp__shop__refund', { id: 'O-1' });
  yield toolUse('mcp__shop__refund', { id: 'O-1' });
  yield toolResult(outcome, 'toolu_mcp__shop__refund');
  yield assistant('Refunded O-1.');
  yield success({ text: 'Refunded O-1.', costUsd: 0.01 });
}

async function* answersInProse() {
  await sleep(10);
  yield assistant('Look up the order, then refund it.');
  yield success({ text: 'Look up the order, then refund it.', costUsd: 0.01 });
}

function apiFailure(code: string, text: string) {
  return async function* () {
    yield assistant(text, { model: '<synthetic>', error: code, usage: {} });
    yield success({ text, isError: true, costUsd: 0.001 });
  };
}

function config(overrides: Partial<RunnerConfig> = {}): RunnerConfig {
  return {
    runSetId: 'seam-test',
    strategies: [single],
    tasks: [makeTask()],
    models: [MODEL],
    effort: 'low',
    repeats: 1,
    concurrency: 1,
    maxCostUsdPerRun: 1,
    maxWallClockMsPerRun: 10_000,
    totalBudgetUsd: 10,
    fixtureMode: 'replay',
    fixtureDir: '/tmp',
    judge: async () => {
      throw new Error('no judge for tool-use tasks');
    },
    judgeSamples: 1,
    persist: false,
    retry: { baseDelayMs: 1, maxDelayMs: 1 },
    ...overrides,
  };
}

async function onlyRecord(overrides: Partial<RunnerConfig> = {}): Promise<RunRecord> {
  const { records } = await runMatrix(config(overrides));
  expect(records).toHaveLength(1);
  return records[0]!;
}

function failedChecks(record: RunRecord): string[] {
  return (record.integrity?.checks ?? []).filter((c) => !c.ok).map((c) => c.id);
}

afterEach(() => resetFake());

describe('integrity through the real call path', () => {
  it('finds nothing wrong with a healthy run', async () => {
    setScript(solves);

    const record = await onlyRecord();

    expect(record.passed).toBe(true);
    expect(record.failureMode).toBe('none');
    expect(record.integrity?.ok).toBe(true);
    expect(record.phases[0]).toMatchObject({ subtype: 'success', toolCalls: 1 });
    expect(record.costUsd).toBeCloseTo(0.01);
  });

  it('catches concurrent phases sharing one tool server, the first run set’s bug', async () => {
    setScript((session) => (session.prompt === 'PROPOSE' ? answersInProse() : solves(session)));

    const record = await onlyRecord({
      strategies: [proposeThenAct],
      tasks: [makeTask({ sharedServers: true })],
    });

    // The executor still solved the task, but proposer 2 never had its tools:
    // the architecture under test did not run.
    expect(record.passed).toBe(true);
    expect(record.integrity?.ok).toBe(false);
    expect(failedChecks(record)).toEqual([HARNESS_CHECK.mcpConnected]);
    expect(record.integrity?.checks.find((c) => c.id === HARNESS_CHECK.mcpConnected)?.detail).toMatch(
      /^propose-2 \(call-2\): shop failed$/,
    );
  });

  it('calls a run the harness broke a harness_error, whatever it scored', async () => {
    setScript(answersInProse);

    const record = await onlyRecord({
      strategies: [proposeThenAct],
      tasks: [makeTask({ sharedServers: true })],
    });

    expect(record.passed).toBe(false);
    expect(record.failureMode).toBe('harness_error');
    expect(record.error).toMatch(/^harness failure \(harness\.mcp-connected\): propose-2/);
  });

  it('passes the same architecture once every call gets its own servers', async () => {
    setScript((session) => (session.prompt === 'PROPOSE' ? answersInProse() : solves(session)));

    const record = await onlyRecord({ strategies: [proposeThenAct] });

    expect(record.integrity?.ok).toBe(true);
    expect(record.phases.map((p) => p.subtype)).toEqual(['success', 'success', 'success']);
  });

  it('fails a run whose planner never returned its structured plan', async () => {
    setScript((session) => (session.prompt === 'PLAN' ? answersInProse() : solves(session)));

    const record = await onlyRecord({ strategies: [planThenAct(true)] });

    expect(record.passed).toBe(true);
    expect(failedChecks(record)).toEqual([HARNESS_CHECK.structuredOutput]);
  });

  it('passes a planner that answered through the structured-output tool', async () => {
    setScript(async function* (session) {
      if (session.prompt !== 'PLAN') {
        yield* solves(session);
        return;
      }
      const outcome = await session.callTool(STRUCTURED_OUTPUT_TOOL, PLAN);
      yield toolUse(STRUCTURED_OUTPUT_TOOL, PLAN);
      yield toolResult(outcome);
      yield success({ structured: PLAN, costUsd: 0.01 });
    });

    const record = await onlyRecord({ strategies: [planThenAct(true)] });

    expect(record.integrity?.ok).toBe(true);
    expect(record.deniedToolCalls).toBe(0);
  });
});

describe('failure modes through the real call path', () => {
  it('calls a run whose acting phase ran out of turns max_turns, and still ranks it', async () => {
    setScript(async function* () {
      yield assistant('Still looking.');
      yield errorResult('error_max_turns', { costUsd: 0.02 });
    });

    const record = await onlyRecord();

    expect(record.failureMode).toBe('max_turns');
    expect(record.integrity?.ok).toBe(true);
  });

  it('does not blame the turn limit when only the planner ran out of turns', async () => {
    setScript(async function* (session) {
      if (session.prompt === 'PLAN') {
        yield assistant('Thinking about it.');
        yield errorResult('error_max_turns');
        return;
      }
      yield assistant('I could not do it.');
      yield success({ text: 'I could not do it.' });
    });

    const record = await onlyRecord({ strategies: [planThenAct(false)] });
    expect(record.failureMode).toBe('wrong_answer');
  });

  it('calls a run that hit its cost cap budget_exceeded', async () => {
    setScript(async function* () {
      yield assistant('Working.');
      yield errorResult('error_max_budget_usd', { costUsd: 1.2 });
    });

    const record = await onlyRecord({ maxCostUsdPerRun: 1 });
    expect(record.failureMode).toBe('budget_exceeded');
    expect(record.integrity?.ok).toBe(true);
  });

  it('times out a run that would not finish, and charges what it streamed', async () => {
    setScript(async function* (session) {
      yield assistant('Looking into it.', { usage: { input_tokens: 50_000, output_tokens: 5_000 } });
      await session.untilAborted();
    });

    const record = await onlyRecord({ maxWallClockMsPerRun: 100 });

    expect(record.failureMode).toBe('timeout');
    expect(record.costUsd).toBeGreaterThan(0);
    expect(record.phases[0]).toMatchObject({ subtype: 'aborted', costEstimated: true });
    expect(record.integrity?.ok).toBe(true);
  });
});

describe('API failures through the real call path', () => {
  it('runs a cell again after an overloaded API and keeps the attempt that worked', async () => {
    let sessionCount = 0;
    setScript((session) =>
      ++sessionCount === 1 ? apiFailure('overloaded', 'Repeated 529 Overloaded errors')() : solves(session),
    );

    const record = await onlyRecord();

    expect(record.failureMode).toBe('none');
    expect(record.attempts).toBe(2);
    expect(record.discardedCostUsd).toBeCloseTo(0.001);
    expect(record.integrity?.ok).toBe(true);
  });

  it('records an exhausted rate limit as api_error, outside the rankings', async () => {
    setScript(apiFailure('rate_limit', 'API Error: Rate limit reached'));

    const record = await onlyRecord();

    expect(record.failureMode).toBe('api_error');
    expect(record.apiError).toMatchObject({ kind: 'rate_limit', retryable: true });
    expect(record.attempts).toBe(3);
    expect(record.integrity?.ok).toBe(false);
    expect(failedChecks(record)).toEqual([HARNESS_CHECK.api]);
  });

  it('stops the whole matrix when the credentials are rejected', async () => {
    setScript(apiFailure('authentication_failed', 'Invalid API key · Please run /login'));
    const events: RunnerEvent[] = [];

    const { records, manifest } = await runMatrix(
      config({ repeats: 3, onEvent: (event) => events.push(event) }),
    );

    expect(records).toHaveLength(1);
    expect(records[0]?.failureMode).toBe('api_error');
    expect(records[0]?.apiError?.kind).toBe('auth');
    expect(events.find((e) => e.type === 'stop')).toMatchObject({ reason: 'auth' });
    expect(manifest).toMatchObject({ status: 'interrupted', stoppedBy: 'auth' });
  });
});
