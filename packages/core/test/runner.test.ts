import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_RETRY_POLICY,
  EFFORT_MIXED,
  HARNESS_CHECK,
  REPO_ROOT,
  buildScore,
  completedCells,
  createJudge,
  retryDelayMs,
  runMatrix,
} from '@arena/core';
import type {
  ApiError,
  FidelityInput,
  Judge,
  PhaseRecord,
  RunContext,
  RunRecord,
  RunSetManifest,
  RunnerConfig,
  RunnerEvent,
  Strategy,
  Task,
  TaskEnvironment,
  TraceEvent,
} from '@arena/core';

/**
 * End-to-end exercise of the runner with stub strategies and stub tasks.
 *
 * This is the test that proves the pipeline holds together — environment
 * creation, budget accounting, trace capture, scoring, failure classification,
 * integrity, retries, stopping, resuming and persistence — without spending a
 * cent or needing an API key. Every part of it is deterministic, so it also
 * runs in CI. `runner.seam.test.ts` drives the same runner through the real
 * `runQuery` against a scripted SDK.
 */

interface CounterWorld {
  value: number;
  policyRead: boolean;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

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

interface StubOptions {
  costUsd?: number;
  /** Extra fields for the strategy's single phase record. */
  phase?: Partial<PhaseRecord>;
  fidelityChecks?: Strategy['fidelityChecks'];
}

/** A strategy that mutates the world directly, standing in for real tool use. */
function makeStrategy(
  id: string,
  behaviour: (ctx: RunContext) => void | Promise<void>,
  options: StubOptions | number = {},
): Strategy {
  const { costUsd = 0.01, phase, fidelityChecks } =
    typeof options === 'number' ? { costUsd: options } : options;
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
            ...phase,
          },
        ],
      };
    },
    ...(fidelityChecks ? { fidelityChecks } : {}),
  };
}

function solve(ctx: RunContext): void {
  const world = ctx.env.state as CounterWorld;
  world.policyRead = true;
  world.value = 2;
  ctx.env.journal.push({ name: 'read_policy', args: {}, tMs: 1, ok: true, result: 'ok' });
  ctx.env.journal.push({ name: 'set', args: { value: 2 }, tMs: 2, ok: true, result: 'ok' });
}

const solves = makeStrategy('solver', solve);

const violates = makeStrategy('violator', (ctx) => {
  const world = ctx.env.state as CounterWorld;
  world.value = 2;
  ctx.env.journal.push({ name: 'set', args: { value: 2 }, tMs: 1, ok: true, result: 'ok' });
});

const doesNothing = makeStrategy('idle', () => {});

/** A strategy whose single phase failed at the API, as `runQuery` would report it. */
function failsAtApi(id: string, apiError: ApiError | (() => ApiError | undefined), costUsd = 0.01): Strategy {
  const inner = (failure: ApiError | undefined) =>
    makeStrategy(id, failure ? () => {} : solve, {
      costUsd,
      ...(failure ? { phase: { subtype: 'success', error: `API error (${failure.kind})`, apiError: failure } } : {}),
    });
  return {
    id,
    label: id,
    description: 'fails at the API',
    run: (ctx) => inner(typeof apiError === 'function' ? apiError() : apiError).run(ctx),
  };
}

const RATE_LIMIT: ApiError = { kind: 'rate_limit', retryable: true, message: 'Rate limit reached', status: 429 };
const AUTH: ApiError = { kind: 'auth', retryable: false, message: 'Invalid API key', status: 401 };
const BAD_MODEL: ApiError = { kind: 'invalid_request', retryable: false, message: 'model not found', status: 404 };

const neverCalledJudge: Judge = async () => {
  throw new Error('judge must not be called for tool-use tasks');
};

/** Retries without waiting, so retry tests stay fast. */
const QUICK_RETRY = { baseDelayMs: 1, maxDelayMs: 1 };

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
    models: ['stub-model'],
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
    retry: QUICK_RETRY,
    ...overrides,
  };
}

const setDir = () => path.join(resultsRoot, 'test-set');

async function manifestOnDisk(): Promise<RunSetManifest> {
  return JSON.parse(await readFile(path.join(setDir(), 'manifest.json'), 'utf8')) as RunSetManifest;
}

describe('runMatrix', () => {
  it('runs strategy x task x repeat and scores each cell', async () => {
    const { manifest, records } = await runMatrix(
      config({ strategies: [solves, violates], repeats: 2 }),
    );

    expect(manifest.totalRuns).toBe(4);
    expect(manifest.completedRuns).toBe(4);
    expect(manifest.status).toBe('complete');
    expect(records).toHaveLength(4);

    const solverRuns = records.filter((r) => r.strategyId === 'solver');
    const violatorRuns = records.filter((r) => r.strategyId === 'violator');
    expect(solverRuns.every((r) => r.score === 1 && r.passed)).toBe(true);
    expect(violatorRuns.every((r) => r.score === 0)).toBe(true);
    expect(violatorRuns[0]?.failureMode).toBe('policy_violation');
  });

  it('treats the model as a matrix dimension, ordered repeat → task → model → strategy', async () => {
    const seen: string[] = [];
    const record = (id: string) =>
      makeStrategy(id, (ctx) => {
        seen.push(`${ctx.model}/${ctx.strategyId}/${ctx.task.id}`);
      });
    const events: RunnerEvent[] = [];

    const { records, manifest } = await runMatrix(
      config({
        strategies: [record('s1'), record('s2')],
        tasks: [makeTask({ id: 't1' }), makeTask({ id: 't2' })],
        models: ['model-a', 'model-b'],
        repeats: 2,
        concurrency: 1,
        onEvent: (event) => events.push(event),
      }),
    );

    expect(records).toHaveLength(16);
    expect(manifest.totalRuns).toBe(16);
    expect(manifest.models).toEqual(['model-a', 'model-b']);
    expect(manifest.model).toBe('model-a, model-b');
    const starts = events.flatMap((e) => (e.type === 'run-start' ? [e.runId] : []));
    expect(starts.slice(0, 5)).toEqual([
      'model-a__s1__t1__r1',
      'model-a__s2__t1__r1',
      'model-b__s1__t1__r1',
      'model-b__s2__t1__r1',
      'model-a__s1__t2__r1',
    ]);
    expect(starts[8]).toBe('model-a__s1__t1__r2');
    // Each cell ran on its own model, and its record says so.
    expect(seen.slice(0, 3)).toEqual(['model-a/s1/t1', 'model-a/s2/t1', 'model-b/s1/t1']);
    expect(records.find((r) => r.runId === 'model-b__s2__t2__r2')?.model).toBe('model-b');
  });

  it('refuses an empty model list and a run set id that could leave results/', async () => {
    await expect(runMatrix(config({ models: [] }))).rejects.toThrow(/at least one model/);
    await expect(runMatrix(config({ runSetId: '../escape' }))).rejects.toThrow(/Invalid run set id/);
    await expect(completedCells('../escape', resultsRoot)).rejects.toThrow(/Invalid run set id/);
  });

  it('gives every run a fresh world', async () => {
    const { records } = await runMatrix(config({ repeats: 3 }));
    // If the world leaked between repeats the violator check would misfire and
    // scores would diverge; identical scores prove isolation.
    expect(records.map((r) => r.score)).toEqual([1, 1, 1]);
    expect(new Set(records.map((r) => r.runId)).size).toBe(3);
  });

  it('gives every run its own scratch directory outside the repository, and removes it', async () => {
    const cwds: string[] = [];
    const recordsCwd = makeStrategy('cwd', (ctx) => {
      cwds.push(ctx.cwd);
      expect(existsSync(ctx.cwd)).toBe(true);
    });

    await runMatrix(config({ strategies: [recordsCwd], repeats: 3, concurrency: 3 }));

    expect(new Set(cwds).size).toBe(3);
    for (const cwd of cwds) {
      expect(cwd.startsWith(tmpdir())).toBe(true);
      expect(path.relative(REPO_ROOT, cwd).startsWith('..')).toBe(true);
      expect(existsSync(cwd)).toBe(false);
    }
  });

  it('accounts cost, turns and usage per run', async () => {
    const { records } = await runMatrix(config());
    const record = records[0];
    expect(record?.costUsd).toBeCloseTo(0.01);
    expect(record?.turns).toBe(2);
    expect(record?.usage.inputTokens).toBe(100);
    expect(record?.judgeCostUsd).toBe(0);
    expect(record?.attempts).toBe(1);
    expect(record?.discardedCostUsd).toBe(0);
  });

  it('records tool calls from the journal', async () => {
    const { records } = await runMatrix(config());
    expect(records[0]?.toolCalls).toBe(2);
  });

  it('emits start and end events for every completed run', async () => {
    const events: RunnerEvent[] = [];
    await runMatrix(config({ repeats: 2, onEvent: (event) => events.push(event) }));

    expect(events.filter((e) => e.type === 'run-start')).toHaveLength(2);
    expect(events.filter((e) => e.type === 'run-end')).toHaveLength(2);
  });

  it('does not lose a run to a listener that throws', async () => {
    const { records } = await runMatrix(
      config({
        onEvent: () => {
          throw new Error('listener bug');
        },
      }),
    );
    expect(records).toHaveLength(1);
    expect(records[0]?.passed).toBe(true);
  });

  it('runs cells concurrently', async () => {
    let active = 0;
    let peak = 0;
    const slow = makeStrategy('slow', async () => {
      active += 1;
      peak = Math.max(peak, active);
      await sleep(30);
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
    expect(records[0]?.integrity?.checks.find((c) => c.id === HARNESS_CHECK.judge)?.ok).toBe(true);
  });

  it('sorts records deterministically regardless of completion order', async () => {
    const { records } = await runMatrix(
      config({ strategies: [solves, violates], repeats: 2, concurrency: 4 }),
    );
    const ids = records.map((r) => r.runId);
    expect(ids).toEqual([...ids].sort());
  });
});

describe('timing', () => {
  it('times the strategy alone, with setup and grading reported separately', async () => {
    const task = makeTask({
      async createEnvironment(opts) {
        await sleep(60);
        return makeTask().createEnvironment(opts);
      },
      async score(input) {
        await sleep(60);
        return makeTask().score(input);
      },
    });

    const { records } = await runMatrix(config({ tasks: [task] }));
    const record = records[0]!;

    expect(record.latencyMs).toBeLessThan(50);
    expect(record.setupMs).toBeGreaterThanOrEqual(50);
    expect(record.gradingMs).toBeGreaterThanOrEqual(50);
  });

  it('starts the wall clock with the strategy, not with the environment', async () => {
    const task = makeTask({
      async createEnvironment(opts) {
        await sleep(150);
        return makeTask().createEnvironment(opts);
      },
    });

    const { records } = await runMatrix(config({ tasks: [task], maxWallClockMsPerRun: 100 }));
    expect(records[0]?.passed).toBe(true);
    expect(records[0]?.failureMode).toBe('none');
  });

  it('labels a run that overran its wall clock a timeout', async () => {
    const dawdles = makeStrategy('dawdler', () => sleep(150));
    const { records } = await runMatrix(config({ strategies: [dawdles], maxWallClockMsPerRun: 50 }));
    expect(records[0]?.failureMode).toBe('timeout');
    // A run that hit its own limit is a valid, losing data point.
    expect(records[0]?.integrity?.ok).toBe(true);
  });

  it('does not let a slow grader turn a run that finished in time into a timeout', async () => {
    const task = makeTask({
      async score(input) {
        await sleep(150);
        return makeTask().score(input);
      },
    });

    const { records } = await runMatrix(
      config({ strategies: [doesNothing], tasks: [task], maxWallClockMsPerRun: 50 }),
    );
    expect(records[0]?.failureMode).toBe('wrong_answer');
  });
});

describe('failure modes', () => {
  it('scores an inert strategy zero without failing the run', async () => {
    const { records } = await runMatrix(config({ strategies: [doesNothing] }));
    expect(records[0]?.score).toBe(0);
    expect(records[0]?.failureMode).toBe('wrong_answer');
    expect(records[0]?.error).toBeUndefined();
    expect(records[0]?.integrity?.ok).toBe(true);
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
    expect(records[0]?.integrity?.ok).toBe(false);
    expect(records[0]?.integrity?.checks[0]).toMatchObject({
      id: HARNESS_CHECK.runCompleted,
      ok: false,
      detail: 'strategy blew up',
    });
  });

  it('classifies a run that exhausts its cost ceiling', async () => {
    const spender = makeStrategy('spender', () => {}, 5);
    const { records } = await runMatrix(
      config({ strategies: [spender], maxCostUsdPerRun: 1 }),
    );
    expect(records[0]?.failureMode).toBe('budget_exceeded');
  });

  it('records an API failure as api_error, unscored, unranked and ungraded', async () => {
    let graded = false;
    const task = makeTask({
      async score(input) {
        graded = true;
        return makeTask().score(input);
      },
    });

    const { records } = await runMatrix(
      config({ strategies: [failsAtApi('unlucky', BAD_MODEL)], tasks: [task] }),
    );
    const record = records[0]!;

    expect(graded).toBe(false);
    expect(record.failureMode).toBe('api_error');
    expect(record.score).toBe(0);
    expect(record.passed).toBe(false);
    expect(record.apiError).toEqual(BAD_MODEL);
    expect(record.error).toBe('API error (invalid_request 404: model not found)');
    expect(record.attempts).toBe(1);
    expect(record.integrity?.ok).toBe(false);
    expect(record.integrity?.checks.find((c) => c.id === HARNESS_CHECK.api)?.ok).toBe(false);
  });

  it('blames the API, not the strategy, when a strategy throws after losing a call', async () => {
    const throwsAfter: Strategy = {
      id: 'throws-after',
      label: 'throws-after',
      description: 'loses a call to the API, then throws',
      async run(ctx) {
        ctx.trace.append({ phase: 'main', depth: 0, callId: 'call-1', kind: 'phase_start' });
        ctx.trace.append({
          phase: 'main',
          depth: 0,
          callId: 'call-1',
          kind: 'phase_end',
          meta: { subtype: 'success', apiError: BAD_MODEL },
        });
        throw new Error('no text to work with');
      },
    };

    const { records } = await runMatrix(config({ strategies: [throwsAfter] }));
    expect(records[0]?.failureMode).toBe('api_error');
    expect(records[0]?.apiError).toEqual(BAD_MODEL);
  });
});

describe('integrity', () => {
  it('passes a healthy run on every harness check', async () => {
    const { records } = await runMatrix(config());
    const integrity = records[0]?.integrity;
    expect(integrity?.ok).toBe(true);
    expect(integrity?.checks.map((c) => c.id)).toContain(HARNESS_CHECK.mcpConnected);
    expect(integrity?.checks.every((c) => c.ok)).toBe(true);
  });

  it('adds the strategy’s own fidelity checks and fails the run on any of them', async () => {
    const inputs: FidelityInput[] = [];
    const planless = makeStrategy('planless', solve, {
      fidelityChecks: (input) => {
        inputs.push(input);
        return [
          { id: 'planless.plan', ok: false, detail: 'the plan was empty' },
          { id: 'planless.executed', ok: true },
        ];
      },
    });

    const { records } = await runMatrix(config({ strategies: [planless] }));
    const record = records[0]!;

    // The run still passed the task: integrity says it did not measure the architecture.
    expect(record.passed).toBe(true);
    expect(record.failureMode).toBe('none');
    expect(record.integrity?.ok).toBe(false);
    expect(record.integrity?.checks.slice(-2)).toEqual([
      { id: 'planless.plan', ok: false, detail: 'the plan was empty' },
      { id: 'planless.executed', ok: true },
    ]);

    const input = inputs[0]!;
    expect(input.task.id).toBe('stub-task');
    expect(input.outcome.finalText).toBe('planless finished');
    expect(input.trace.length).toBeGreaterThan(0);
    expect((input.env.state as CounterWorld).value).toBe(2);
    expect(input.stoppedBy).toBeUndefined();
  });

  it('tells the fidelity checks when the run was cut short', async () => {
    let stoppedBy: FidelityInput['stoppedBy'];
    const spender = makeStrategy('spender', () => {}, {
      costUsd: 5,
      fidelityChecks: (input) => {
        stoppedBy = input.stoppedBy;
        return [];
      },
    });

    await runMatrix(config({ strategies: [spender], maxCostUsdPerRun: 1 }));
    expect(stoppedBy).toBe('cost');
  });

  it('records fidelity checks that throw as a failed check', async () => {
    const broken = makeStrategy('broken', solve, {
      fidelityChecks: () => {
        throw new Error('bad check');
      },
    });

    const { records } = await runMatrix(config({ strategies: [broken] }));
    expect(records[0]?.integrity?.ok).toBe(false);
    expect(records[0]?.integrity?.checks.at(-1)).toEqual({
      id: 'broken.fidelity-checks',
      ok: false,
      detail: 'the fidelity checks threw: bad check',
    });
  });

  it('does not ask a strategy that threw for its fidelity checks', async () => {
    let asked = false;
    const exploding: Strategy = {
      id: 'exploding',
      label: 'exploding',
      description: 'throws',
      async run() {
        throw new Error('boom');
      },
      fidelityChecks: () => {
        asked = true;
        return [];
      },
    };

    await runMatrix(config({ strategies: [exploding] }));
    expect(asked).toBe(false);
  });

  it('fails a run in which a phase fell back on a default', async () => {
    const degraded = makeStrategy('degraded', solve, {
      phase: { degraded: 'selection unreadable; kept proposal 1' },
    });

    const { records } = await runMatrix(config({ strategies: [degraded] }));
    expect(records[0]?.integrity?.ok).toBe(false);
    expect(records[0]?.integrity?.checks.find((c) => c.id === HARNESS_CHECK.notDegraded)).toEqual({
      id: HARNESS_CHECK.notDegraded,
      ok: false,
      detail: 'main: selection unreadable; kept proposal 1',
    });
  });
});

describe('effort', () => {
  /** A stub whose calls reported running at these levels, as `runQuery` would trace them. */
  function reportsEffort(id: string, levels: readonly (string | null | undefined)[]): Strategy {
    return makeStrategy(id, (ctx) => {
      solve(ctx);
      levels.forEach((level, index) => {
        ctx.trace.append({
          phase: `call-${index + 1}`,
          callId: `call-${index + 1}`,
          depth: 0,
          kind: 'phase_end',
          meta: { subtype: 'success', ...(level !== undefined ? { effectiveEffort: level } : {}) },
        });
      });
    });
  }

  it('records the level the calls reported, and says when they disagree', async () => {
    const { records, manifest } = await runMatrix(
      config({
        strategies: [
          reportsEffort('agrees', ['high', undefined, 'high']),
          reportsEffort('disagrees', ['high', 'low']),
        ],
      }),
    );

    const effortOf = (id: string) => records.find((r) => r.strategyId === id)?.effectiveEffort;
    expect(effortOf('agrees')).toBe('high');
    expect(effortOf('disagrees')).toBe(EFFORT_MIXED);
    expect(manifest.effort).toBe('high');
    expect(manifest.effectiveEffort).toEqual({ 'stub-model': EFFORT_MIXED });
  });

  it('claims no level when no call reported one', async () => {
    const { records, manifest } = await runMatrix(
      config({ strategies: [reportsEffort('silent', [undefined])] }),
    );

    expect(records[0]).not.toHaveProperty('effectiveEffort');
    expect(manifest.effectiveEffort).toEqual({});
  });
});

describe('retries', () => {
  it('runs a cell again after a transient API failure and records the attempt that worked', async () => {
    let attempt = 0;
    const flaky = failsAtApi('flaky', () => (++attempt === 1 ? RATE_LIMIT : undefined), 0.01);
    const events: RunnerEvent[] = [];
    const traces: TraceEvent[] = [];

    const { records, manifest } = await runMatrix(
      config({
        strategies: [flaky],
        onEvent: (event) => events.push(event),
        onTraceEvent: (_runId, event) => traces.push(event),
      }),
    );
    const record = records[0]!;

    expect(records).toHaveLength(1);
    expect(record.failureMode).toBe('none');
    expect(record.passed).toBe(true);
    expect(record.attempts).toBe(2);
    expect(record.costUsd).toBeCloseTo(0.01);
    expect(record.discardedCostUsd).toBeCloseTo(0.01);
    expect(record.integrity?.ok).toBe(true);
    expect(events.filter((e) => e.type === 'run-retry')).toEqual([
      expect.objectContaining({ runId: record.runId, attempt: 1, error: 'rate_limit 429: Rate limit reached' }),
    ]);
    // The recorded attempt's own trace says it is a retry.
    const note = traces.find((e) => e.phase === 'runner' && e.kind === 'note');
    expect(note?.text).toMatch(/^Attempt 2 of 3: attempt 1 failed at the API \(rate_limit 429/);
    // The discarded spend is on the run set's books, not on the architecture's.
    expect(manifest.totalCostUsd).toBeCloseTo(0.01);
    expect(manifest.totalDiscardedCostUsd).toBeCloseTo(0.01);
  });

  it('records api_error once the attempts are exhausted', async () => {
    const events: RunnerEvent[] = [];
    const { records } = await runMatrix(
      config({
        strategies: [failsAtApi('down', RATE_LIMIT, 0.01)],
        onEvent: (event) => events.push(event),
      }),
    );

    expect(records[0]?.failureMode).toBe('api_error');
    expect(records[0]?.attempts).toBe(DEFAULT_RETRY_POLICY.maxAttempts);
    expect(records[0]?.discardedCostUsd).toBeCloseTo(0.02);
    expect(events.filter((e) => e.type === 'run-retry')).toHaveLength(2);
  });

  it('does not retry a failure a retry cannot fix', async () => {
    const events: RunnerEvent[] = [];
    const { records } = await runMatrix(
      config({ strategies: [failsAtApi('bad-model', BAD_MODEL)], onEvent: (e) => events.push(e) }),
    );
    expect(records[0]?.attempts).toBe(1);
    expect(events.some((e) => e.type === 'run-retry')).toBe(false);
  });

  it('honours a configured attempt limit', async () => {
    const { records } = await runMatrix(
      config({ strategies: [failsAtApi('down', RATE_LIMIT)], retry: { ...QUICK_RETRY, maxAttempts: 1 } }),
    );
    expect(records[0]?.attempts).toBe(1);
    expect(records[0]?.failureMode).toBe('api_error');
  });

  it('backs off exponentially, with jitter, up to a ceiling', async () => {
    const policy = { maxAttempts: 5, baseDelayMs: 1_000, maxDelayMs: 3_000 };
    expect(retryDelayMs(1, policy, () => 0)).toBe(500);
    expect(retryDelayMs(1, policy, () => 1)).toBe(1_000);
    expect(retryDelayMs(2, policy, () => 0)).toBe(1_000);
    expect(retryDelayMs(2, policy, () => 1)).toBe(2_000);
    expect(retryDelayMs(3, policy, () => 1)).toBe(3_000);
    expect(retryDelayMs(9, policy, () => 0.5)).toBe(2_250);

    const delays: number[] = [];
    await runMatrix(
      config({
        strategies: [failsAtApi('down', RATE_LIMIT)],
        retry: { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 15 },
        onEvent: (e) => {
          if (e.type === 'run-retry') delays.push(e.delayMs);
        },
      }),
    );
    expect(delays).toHaveLength(2);
    expect(delays[0]).toBeGreaterThanOrEqual(5);
    expect(delays[0]).toBeLessThanOrEqual(10);
    expect(delays[1]).toBeGreaterThanOrEqual(8);
    expect(delays[1]).toBeLessThanOrEqual(15);
  });

  it('records the failed attempt when a retry no longer fits in the total budget', async () => {
    const events: RunnerEvent[] = [];
    const { records } = await runMatrix(
      config({
        strategies: [failsAtApi('down', RATE_LIMIT, 0.5)],
        maxCostUsdPerRun: 1,
        totalBudgetUsd: 1,
        onEvent: (e) => events.push(e),
      }),
    );

    expect(records[0]?.failureMode).toBe('api_error');
    expect(records[0]?.attempts).toBe(1);
    expect(events.some((e) => e.type === 'budget-stop')).toBe(true);
  });

  it('stops the matrix when the API rejects the credentials', async () => {
    const events: RunnerEvent[] = [];
    const { records, manifest } = await runMatrix(
      config({
        strategies: [failsAtApi('unauthorised', AUTH)],
        repeats: 5,
        concurrency: 1,
        onEvent: (e) => events.push(e),
      }),
    );

    expect(records).toHaveLength(1);
    expect(records[0]?.failureMode).toBe('api_error');
    expect(records[0]?.attempts).toBe(1);
    const stop = events.find((e) => e.type === 'stop');
    expect(stop).toMatchObject({ type: 'stop', reason: 'auth' });
    expect(stop && 'message' in stop ? stop.message : '').toMatch(
      /rejected the credentials \(auth 401: Invalid API key\)/,
    );
    expect(manifest.status).toBe('interrupted');
    expect(manifest.stoppedBy).toBe('auth');
    expect(manifest.notes).toBe('Stopped early: the API rejected the credentials.');
  });
});

describe('stopping', () => {
  /** A strategy that works until the run is aborted. */
  const waitsForAbort = makeStrategy('waiter', (ctx) =>
    new Promise<void>((resolve) => ctx.signal.addEventListener('abort', () => resolve(), { once: true })),
  );

  it('cuts off and discards the runs in flight on the caller’s signal', async () => {
    const controller = new AbortController();
    const events: RunnerEvent[] = [];
    let started = 0;

    const { records, manifest } = await runMatrix(
      config({
        strategies: [waitsForAbort],
        repeats: 4,
        concurrency: 2,
        persist: true,
        signal: controller.signal,
        onEvent: (event) => {
          events.push(event);
          if (event.type === 'run-start' && ++started === 2) setTimeout(() => controller.abort(), 20);
        },
      }),
    );

    expect(records).toHaveLength(0);
    expect(events.filter((e) => e.type === 'run-interrupted')).toHaveLength(2);
    expect(events.filter((e) => e.type === 'run-start')).toHaveLength(2);
    expect(manifest).toMatchObject({ status: 'interrupted', stoppedBy: 'signal', completedRuns: 0 });
    // What the cut-off runs spent is still on the books.
    expect(manifest.totalDiscardedCostUsd).toBeCloseTo(0.02);

    const onDisk = await manifestOnDisk();
    expect(onDisk.status).toBe('interrupted');
    expect(onDisk.finishedAt).toBeDefined();
    expect(await readdir(path.join(setDir(), 'runs'))).toEqual([]);
  });

  it('finishes and records the runs in flight on a drain, and starts nothing new', async () => {
    const drain = new AbortController();
    const drains = makeStrategy('drains', (ctx) => {
      solve(ctx);
      drain.abort();
    });
    const events: RunnerEvent[] = [];

    const { records, manifest } = await runMatrix(
      config({
        strategies: [drains],
        repeats: 3,
        concurrency: 1,
        drainSignal: drain.signal,
        onEvent: (event) => events.push(event),
      }),
    );

    expect(records).toHaveLength(1);
    expect(records[0]?.passed).toBe(true);
    expect(events.find((e) => e.type === 'stop')).toMatchObject({ reason: 'drain' });
    expect(manifest).toMatchObject({ status: 'interrupted', stoppedBy: 'drain', completedRuns: 1 });
  });

  it('starts nothing when the signal has already fired', async () => {
    const controller = new AbortController();
    controller.abort();
    const { records, manifest } = await runMatrix(config({ signal: controller.signal, repeats: 2 }));
    expect(records).toHaveLength(0);
    expect(manifest.status).toBe('interrupted');
  });
});

describe('total budget', () => {
  it('stops launching cells once the next run’s cap no longer fits', async () => {
    const expensive = makeStrategy('expensive', () => {}, 1);
    const events: RunnerEvent[] = [];
    const { records, manifest } = await runMatrix(
      config({
        strategies: [expensive],
        repeats: 10,
        concurrency: 1,
        totalBudgetUsd: 2.5,
        maxCostUsdPerRun: 1,
        onEvent: (event) => events.push(event),
      }),
    );

    // $1 + $1 spent; a third run's $1 cap would not fit in $2.50.
    expect(records).toHaveLength(2);
    expect(events.some((e) => e.type === 'budget-stop')).toBe(true);
    expect(manifest.status).toBe('interrupted');
    expect(manifest.stoppedBy).toBe('total_budget');
    expect(manifest.notes).toContain('Stopped early');
  });

  it('reserves each run’s cap while it is in flight, so concurrency cannot overshoot', async () => {
    let active = 0;
    let peak = 0;
    const slow = makeStrategy(
      'slow',
      async () => {
        active += 1;
        peak = Math.max(peak, active);
        await sleep(20);
        active -= 1;
      },
      0.1,
    );

    const { records } = await runMatrix(
      config({ strategies: [slow], repeats: 6, concurrency: 4, maxCostUsdPerRun: 1, totalBudgetUsd: 2.5 }),
    );

    // Only two $1 caps fit in $2.50 at once, whatever the concurrency.
    expect(peak).toBe(2);
    expect(records).toHaveLength(6);
  });

  it('starts nothing when a single run’s cap exceeds the total budget', async () => {
    const events: RunnerEvent[] = [];
    const { records, manifest } = await runMatrix(
      config({ maxCostUsdPerRun: 2, totalBudgetUsd: 1, onEvent: (e) => events.push(e) }),
    );
    expect(records).toHaveLength(0);
    expect(events.some((e) => e.type === 'budget-stop')).toBe(true);
    expect(manifest.stoppedBy).toBe('total_budget');
  });
});

describe('persistence', () => {
  it('writes manifest, catalog, run JSON and traces when persisting', async () => {
    const { manifest } = await runMatrix(config({ persist: true }));

    const base = setDir();
    expect(existsSync(path.join(base, 'manifest.json'))).toBe(true);
    expect(existsSync(path.join(base, 'catalog.json'))).toBe(true);
    expect(existsSync(path.join(base, 'runs', 'stub-model__solver__stub-task__r1.json'))).toBe(true);

    const traceFile = path.join(base, 'traces', 'stub-model__solver__stub-task__r1.jsonl');
    expect(existsSync(traceFile)).toBe(true);
    const lines = (await readFile(traceFile, 'utf8')).trim().split('\n');
    expect(lines.length).toBeGreaterThan(0);
    expect(JSON.parse(lines[0] as string)).toMatchObject({ kind: 'phase_start', seq: 0 });

    const catalog = JSON.parse(await readFile(path.join(base, 'catalog.json'), 'utf8'));
    expect(catalog.strategies[0].id).toBe('solver');
    expect(catalog.tasks[0].id).toBe('stub-task');

    expect(manifest.model).toBe('stub-model');
    expect(manifest.strategyIds).toEqual(['solver']);
    expect(await manifestOnDisk()).toEqual(manifest);
  });

  it('writes nothing when persist is false', async () => {
    await runMatrix(config({ persist: false }));
    expect(existsSync(setDir())).toBe(false);
  });

  it('records a relative trace path so results stay portable', async () => {
    const { records } = await runMatrix(config({ persist: true }));
    expect(records[0]?.traceFile).toBe('traces/stub-model__solver__stub-task__r1.jsonl');
  });

  it('keeps the manifest current while the session runs', async () => {
    const seen: RunSetManifest[] = [];
    let run = 0;
    const watches = makeStrategy('watcher', async (ctx) => {
      solve(ctx);
      run += 1;
      // The update after the previous run is written without being awaited.
      const deadline = Date.now() + 2_000;
      for (;;) {
        const manifest = await manifestOnDisk();
        if (manifest.completedRuns >= run - 1 || Date.now() > deadline) {
          seen.push(manifest);
          return;
        }
        await sleep(5);
      }
    });

    const { manifest } = await runMatrix(
      config({ strategies: [watches], repeats: 3, concurrency: 1, persist: true }),
    );

    expect(seen.map((m) => [m.status, m.completedRuns])).toEqual([
      ['running', 0],
      ['running', 1],
      ['running', 2],
    ]);
    expect(seen[0]?.finishedAt).toBeUndefined();
    expect(manifest.status).toBe('complete');
    expect((await manifestOnDisk()).status).toBe('complete');
  });

  it('records where, with what and under which settings the session ran', async () => {
    const judge = createJudge({ model: 'judge-model', effort: 'low' });
    const argv = ['run', '--note', 'sk-ant-api03-secretsecretsecret'];

    const { manifest } = await runMatrix(
      config({
        persist: true,
        judge,
        judgeSamples: 3,
        concurrency: 2,
        maxCostUsdPerRun: 0.5,
        maxWallClockMsPerRun: 90_000,
        totalBudgetUsd: 4,
        retry: { maxAttempts: 4, baseDelayMs: 1, maxDelayMs: 2 },
        argv,
      }),
    );

    expect(manifest).toMatchObject({
      runSetId: 'test-set',
      status: 'complete',
      models: ['stub-model'],
      effort: 'high',
      repeats: 1,
      fixtureMode: 'replay',
      concurrency: 2,
      maxCostUsdPerRun: 0.5,
      maxWallClockMsPerRun: 90_000,
      totalBudgetUsd: 4,
      judge: { model: 'judge-model', effort: 'low', samples: 3 },
      retry: { maxAttempts: 4, baseDelayMs: 1, maxDelayMs: 2 },
    });
    expect(manifest.startedAt).toBe(manifest.createdAt);
    expect(manifest.finishedAt).toBeDefined();
    const provenance = manifest.provenance!;
    expect(provenance.argv).toEqual(['run', '--note', 'sk-ant-***redacted***']);
    expect(provenance.nodeVersion).toBe(process.version);
    expect(provenance.agentSdkVersion).toMatch(/^\d+\.\d+\.\d+/);
    expect(provenance.claudeCodeVersion).toMatch(/^\d+\.\d+\.\d+/);
    expect(manifest.gitSha).toBe(provenance.gitSha);
  });

  it('records a judge that does not describe itself as unknown, not as a guess', async () => {
    const { manifest } = await runMatrix(config({ judgeSamples: 2 }));
    expect(manifest.judge).toEqual({ model: null, effort: null, samples: 2 });
  });

  it('leaves results/latest.json alone unless asked to update it', async () => {
    const pointer = path.join(resultsRoot, 'latest.json');

    await runMatrix(config({ persist: true }));
    expect(existsSync(pointer)).toBe(false);

    await runMatrix(config({ persist: true, runSetId: 'second-set', updateLatestPointer: true }));
    expect(JSON.parse(await readFile(pointer, 'utf8'))).toEqual({ runSetId: 'second-set' });
  });
});

describe('resuming', () => {
  async function interruptedAfterFirstRun(strategy: Strategy = solves): Promise<void> {
    const drain = new AbortController();
    await runMatrix(
      config({
        strategies: [strategy],
        repeats: 3,
        concurrency: 1,
        persist: true,
        drainSignal: drain.signal,
        onEvent: (event) => {
          if (event.type === 'run-end') drain.abort();
        },
      }),
    );
  }

  it('runs only the cells an earlier session did not finish', async () => {
    await interruptedAfterFirstRun();
    const first = await manifestOnDisk();
    expect(first).toMatchObject({ status: 'interrupted', completedRuns: 1 });

    const skipCells = await completedCells('test-set', resultsRoot);
    expect([...skipCells]).toEqual(['stub-model|solver|stub-task|1']);

    const { records, manifest } = await runMatrix(
      config({ repeats: 3, concurrency: 1, persist: true, skipCells }),
    );

    expect(records.map((r) => r.repeat)).toEqual([2, 3]);
    expect(manifest).toMatchObject({ status: 'complete', completedRuns: 3, totalRuns: 3 });
    expect(manifest.totalCostUsd).toBeCloseTo(0.03);
    expect(manifest.createdAt).toBe(first.createdAt);
    expect(manifest.previousSessions).toHaveLength(1);
    expect(manifest.previousSessions?.[0]).toMatchObject({
      startedAt: first.startedAt,
      status: 'interrupted',
      stoppedBy: 'drain',
    });
    expect(manifest.durationMs).toBeGreaterThanOrEqual(first.durationMs);
    expect(await readdir(path.join(setDir(), 'runs'))).toHaveLength(3);
  });

  it('refuses to write into a run set that holds runs unless resuming', async () => {
    await interruptedAfterFirstRun();
    await expect(runMatrix(config({ repeats: 3, persist: true }))).rejects.toThrow(
      /already holds 1 run\(s\)/,
    );
  });

  it('refuses to resume under settings the run set was not measured with', async () => {
    await interruptedAfterFirstRun();
    const skipCells = await completedCells('test-set', resultsRoot);

    await expect(
      runMatrix(config({ repeats: 3, persist: true, skipCells, models: ['other-model'] })),
    ).rejects.toThrow(/different settings.*models was \["stub-model"\], now \["other-model"\]/);
  });

  it('starts over a run set whose earlier session recorded nothing', async () => {
    const controller = new AbortController();
    controller.abort();
    await runMatrix(config({ persist: true, signal: controller.signal }));

    const { manifest } = await runMatrix(config({ persist: true, repeats: 2 }));
    expect(manifest).toMatchObject({ status: 'complete', completedRuns: 2, repeats: 2 });
    expect(manifest.previousSessions).toBeUndefined();
  });

  it('runs api_error cells again, and the new record inherits their attempts and spend', async () => {
    let failing = true;
    const sometimes = failsAtApi('sometimes', () => (failing ? BAD_MODEL : undefined), 0.01);

    await runMatrix(config({ strategies: [sometimes], persist: true }));
    const skipCells = await completedCells('test-set', resultsRoot);
    expect(skipCells.size).toBe(0);

    failing = false;
    const { records, manifest } = await runMatrix(
      config({ strategies: [sometimes], persist: true, skipCells }),
    );
    const record: RunRecord = records[0]!;

    expect(record.failureMode).toBe('none');
    expect(record.attempts).toBe(2);
    expect(record.discardedCostUsd).toBeCloseTo(0.01);
    expect(manifest.completedRuns).toBe(1);
    expect(manifest.totalCostUsd).toBeCloseTo(0.01);
    expect(manifest.totalDiscardedCostUsd).toBeCloseTo(0.01);
  });
});
