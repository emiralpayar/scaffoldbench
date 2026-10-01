import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildScore, runMatrix } from '@arena/core';
import type {
  Judge,
  RunContext,
  RunnerConfig,
  RunnerEvent,
  Strategy,
  Task,
  TaskEnvironment,
} from '@arena/core';

/**
 * End-to-end exercise of the runner with stub strategies and stub tasks.
 *
 * This is the test that proves the pipeline holds together — environment
 * creation, budget accounting, trace capture, scoring, failure classification
 * and persistence — without spending a cent or needing an API key. Every part
 * of it is deterministic, so it also runs in CI.
 */

interface CounterWorld {
  value: number;
  policyRead: boolean;
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'stub-task',
    category: 'tool-use',
    world: 'stub',
    title: 'Stub task',
    prompt: 'Set the counter to 2.',
    difficulty: 'easy',
    tags: ['stub'],
    maxTurns: 3,
    createEnvironment(): TaskEnvironment {
      const world: CounterWorld = { value: 0, policyRead: false };
      return {
        createMcpServers: () => ({}),
        allowedTools: ['mcp__stub__set', 'mcp__stub__read_policy'],
        readOnlyTools: ['mcp__stub__read_policy'],
        state: world,
        journal: [],
      };
    },
    async score({ env }) {
      const world = env.state as CounterWorld;
      return buildScore({
        breakdown: [
          { id: 'value', label: 'Counter is 2', weight: 1, earned: world.value === 2 ? 1 : 0 },
        ],
        penalties: world.value !== 0 && !world.policyRead
          ? [{ id: 'no-policy', label: 'Mutated without reading policy', kind: 'policy_violation', multiplier: 0 }]
          : [],
      });
    },
    ...overrides,
  };
}

/** A strategy that mutates the world directly, standing in for real tool use. */
function makeStrategy(
  id: string,
  behaviour: (ctx: RunContext) => void | Promise<void>,
  costUsd = 0.01,
): Strategy {
  return {
    id,
    label: id,
    description: `stub strategy ${id}`,
    async run(ctx) {
      ctx.trace.append({ phase: 'main', depth: 0, kind: 'phase_start', text: 'main' });
      await behaviour(ctx);
      ctx.budget.charge({
        costUsd,
        turns: 2,
        usage: { inputTokens: 100, outputTokens: 20 },
      });
      ctx.trace.append({ phase: 'main', depth: 0, kind: 'result', costUsd });
      return {
        finalText: `${id} finished`,
        subagentCount: 0,
        phases: [
          {
            phase: 'main',
            label: 'main',
            startedAtMs: 0,
            durationMs: 5,
            costUsd,
            turns: 2,
            toolCalls: 1,
            model: ctx.model,
            aborted: false,
          },
        ],
      };
    },
  };
}

const solves = makeStrategy('solver', (ctx) => {
  const world = ctx.env.state as CounterWorld;
  world.policyRead = true;
  world.value = 2;
  ctx.env.journal.push({ name: 'read_policy', args: {}, tMs: 1, ok: true, result: 'ok' });
  ctx.env.journal.push({ name: 'set', args: { value: 2 }, tMs: 2, ok: true, result: 'ok' });
});

const violates = makeStrategy('violator', (ctx) => {
  const world = ctx.env.state as CounterWorld;
  world.value = 2;
  ctx.env.journal.push({ name: 'set', args: { value: 2 }, tMs: 1, ok: true, result: 'ok' });
});

const doesNothing = makeStrategy('idle', () => {});

const neverCalledJudge: Judge = async () => {
  throw new Error('judge must not be called for tool-use tasks');
};

let resultsRoot: string;

beforeEach(async () => {
  resultsRoot = await mkdtemp(path.join(tmpdir(), 'arena-runner-'));
});

afterEach(async () => {
  await rm(resultsRoot, { recursive: true, force: true });
});

function config(overrides: Partial<RunnerConfig> = {}): RunnerConfig {
  return {
    runSetId: 'test-set',
    strategies: [solves],
    tasks: [makeTask()],
    model: 'stub-model',
    effort: 'high',
    repeats: 1,
    concurrency: 2,
    maxCostUsdPerRun: 1,
    maxWallClockMsPerRun: 5_000,
    totalBudgetUsd: 100,
    fixtureMode: 'replay',
    fixtureDir: path.join(resultsRoot, 'fixtures'),
    judge: neverCalledJudge,
    judgeSamples: 1,
    persist: false,
    resultsRoot,
    ...overrides,
  };
}

describe('runMatrix', () => {
  it('runs strategy x task x repeat and scores each cell', async () => {
    const { manifest, records } = await runMatrix(
      config({ strategies: [solves, violates], repeats: 2 }),
    );

    expect(manifest.totalRuns).toBe(4);
    expect(manifest.completedRuns).toBe(4);
    expect(records).toHaveLength(4);

    const solverRuns = records.filter((r) => r.strategyId === 'solver');
    const violatorRuns = records.filter((r) => r.strategyId === 'violator');
    expect(solverRuns.every((r) => r.score === 1 && r.passed)).toBe(true);
    expect(violatorRuns.every((r) => r.score === 0)).toBe(true);
    expect(violatorRuns[0]?.failureMode).toBe('policy_violation');
  });

  it('gives every run a fresh world', async () => {
    const { records } = await runMatrix(config({ repeats: 3 }));
    // If the world leaked between repeats the violator check would misfire and
    // scores would diverge; identical scores prove isolation.
    expect(records.map((r) => r.score)).toEqual([1, 1, 1]);
    expect(new Set(records.map((r) => r.runId)).size).toBe(3);
  });

  it('accounts cost, turns and usage per run', async () => {
    const { records } = await runMatrix(config());
    const record = records[0];
    expect(record?.costUsd).toBeCloseTo(0.01);
    expect(record?.turns).toBe(2);
    expect(record?.usage.inputTokens).toBe(100);
    expect(record?.judgeCostUsd).toBe(0);
  });

  it('records tool calls from the journal', async () => {
    const { records } = await runMatrix(config());
    expect(records[0]?.toolCalls).toBe(2);
  });

  it('scores an inert strategy zero without failing the run', async () => {
    const { records } = await runMatrix(config({ strategies: [doesNothing] }));
    expect(records[0]?.score).toBe(0);
    expect(records[0]?.failureMode).toBe('wrong_answer');
    expect(records[0]?.error).toBeUndefined();
  });

  it('turns a thrown strategy into a harness_error record rather than losing the cell', async () => {
    const exploding: Strategy = {
      id: 'exploding',
      label: 'exploding',
      description: 'throws',
      async run() {
        throw new Error('strategy blew up');
      },
    };
    const { records } = await runMatrix(config({ strategies: [exploding] }));

    expect(records).toHaveLength(1);
    expect(records[0]?.failureMode).toBe('harness_error');
    expect(records[0]?.error).toContain('strategy blew up');
    expect(records[0]?.score).toBe(0);
  });

  it('classifies a run that exhausts its cost ceiling', async () => {
    const spender = makeStrategy('spender', () => {}, 5);
    const { records } = await runMatrix(
      config({ strategies: [spender], maxCostUsdPerRun: 1 }),
    );
    expect(records[0]?.failureMode).toBe('budget_exceeded');
  });

  it('stops launching cells once the total budget is reached', async () => {
    const expensive = makeStrategy('expensive', () => {}, 1);
    const events: RunnerEvent[] = [];
    const { records, manifest } = await runMatrix(
      config({
        strategies: [expensive],
        repeats: 10,
        concurrency: 1,
        totalBudgetUsd: 2.5,
        maxCostUsdPerRun: 10,
        onEvent: (event) => events.push(event),
      }),
    );

    expect(records.length).toBeLessThan(10);
    expect(events.some((e) => e.type === 'budget-stop')).toBe(true);
    expect(manifest.notes).toContain('Stopped early');
  });

  it('emits start and end events for every completed run', async () => {
    const events: RunnerEvent[] = [];
    await runMatrix(config({ repeats: 2, onEvent: (event) => events.push(event) }));

    expect(events.filter((e) => e.type === 'run-start')).toHaveLength(2);
    expect(events.filter((e) => e.type === 'run-end')).toHaveLength(2);
  });

  it('runs cells concurrently', async () => {
    let active = 0;
    let peak = 0;
    const slow = makeStrategy('slow', async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 30));
      active -= 1;
    });

    await runMatrix(config({ strategies: [slow], repeats: 4, concurrency: 3 }));
    expect(peak).toBeGreaterThan(1);
  });

  it('passes judge calls through and bills them separately', async () => {
    let judgeCalls = 0;
    const researchTask = makeTask({
      id: 'stub-research',
      category: 'research',
      world: 'web',
      async score({ deps }) {
        const reply = await deps.judge<{ ok: boolean }>({
          system: 's',
          prompt: 'p',
          schema: { type: 'object' },
        });
        return buildScore({
          breakdown: [{ id: 'j', label: 'judged', weight: 1, earned: reply.value.ok ? 1 : 0 }],
        });
      },
    });

    const { records } = await runMatrix(
      config({
        tasks: [researchTask],
        judge: async () => {
          judgeCalls += 1;
          return { value: { ok: true } as never, costUsd: 0.004 };
        },
      }),
    );

    expect(judgeCalls).toBe(1);
    expect(records[0]?.score).toBe(1);
    expect(records[0]?.judgeCostUsd).toBeCloseTo(0.004);
    // Judge spend must never inflate the strategy's own cost.
    expect(records[0]?.costUsd).toBeCloseTo(0.01);
  });

  it('writes manifest, catalog, run JSON and traces when persisting', async () => {
    const { manifest } = await runMatrix(config({ persist: true }));

    const base = path.join(resultsRoot, 'test-set');
    expect(existsSync(path.join(base, 'manifest.json'))).toBe(true);
    expect(existsSync(path.join(base, 'catalog.json'))).toBe(true);
    expect(existsSync(path.join(base, 'runs', 'solver__stub-task__r1.json'))).toBe(true);

    const traceFile = path.join(base, 'traces', 'solver__stub-task__r1.jsonl');
    expect(existsSync(traceFile)).toBe(true);
    const lines = (await readFile(traceFile, 'utf8')).trim().split('\n');
    expect(lines.length).toBeGreaterThan(0);
    expect(JSON.parse(lines[0] as string)).toMatchObject({ kind: 'phase_start', seq: 0 });

    const catalog = JSON.parse(await readFile(path.join(base, 'catalog.json'), 'utf8'));
    expect(catalog.strategies[0].id).toBe('solver');
    expect(catalog.tasks[0].id).toBe('stub-task');

    expect(manifest.model).toBe('stub-model');
    expect(manifest.strategyIds).toEqual(['solver']);
  });

  it('writes nothing when persist is false', async () => {
    await runMatrix(config({ persist: false }));
    expect(existsSync(path.join(resultsRoot, 'test-set'))).toBe(false);
  });

  it('records a relative trace path so results stay portable', async () => {
    const { records } = await runMatrix(config({ persist: true }));
    expect(records[0]?.traceFile).toBe('traces/solver__stub-task__r1.jsonl');
  });

  it('sorts records deterministically regardless of completion order', async () => {
    const { records } = await runMatrix(
      config({ strategies: [solves, violates], repeats: 2, concurrency: 4 }),
    );
    const ids = records.map((r) => r.runId);
    expect(ids).toEqual([...ids].sort());
  });
});
