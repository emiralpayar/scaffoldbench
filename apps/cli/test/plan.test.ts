import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { completedCells, runMatrix, runsDir, writeJson } from '@arena/core';
import type { Judge, RunRecord, RunSetManifest, Strategy, Task } from '@arena/core';

import { parseArgs } from '../src/args';
import type { RunArgs } from '../src/args';
import { addToHistory, emptyHistory, expectedCost } from '../src/history';
import { MAX_ATTEMPTS, ceilingText, firstRunIdClash, matrixCells, needsConfirmation, resolveResume, spendPlan } from '../src/plan';
import { makeRecord } from './support';

function run(argv: string[]): RunArgs {
  const parsed = parseArgs(['run', ...argv], {});
  if (!parsed.ok || parsed.command !== 'run') throw new Error(parsed.ok ? parsed.command : parsed.error);
  return parsed.args;
}

const stubTask = (id: string): Task => ({
  id,
  category: 'tool-use',
  world: 'stub',
  title: id,
  prompt: 'p',
  maxTurns: 1,
  difficulty: 'easy',
  tags: [],
  createEnvironment: () => ({
    createMcpServers: () => ({}),
    allowedTools: ['mcp__stub__noop'],
    readOnlyTools: [],
    state: {},
    journal: [],
  }),
  score: async () => ({ score: 1, passed: true, breakdown: [], penalties: [], failureMode: 'none' }),
});

const stubStrategy = (id: string): Strategy => ({
  id,
  label: id,
  description: id,
  run: async () => ({ finalText: 'ok', subagentCount: 0, phases: [] }),
});

const judge: Judge = async () => {
  throw new Error('no judge here');
};

describe('matrixCells', () => {
  it('lists cells in exactly the order the runner starts them', async () => {
    const started: string[] = [];
    await runMatrix({
      runSetId: 'order-check',
      strategies: [stubStrategy('s1'), stubStrategy('s2')],
      tasks: [stubTask('t1'), stubTask('t2')],
      models: ['m1', 'm2'],
      effort: 'low',
      repeats: 2,
      concurrency: 1,
      maxCostUsdPerRun: 1,
      maxWallClockMsPerRun: 10_000,
      totalBudgetUsd: 100,
      fixtureMode: 'replay',
      fixtureDir: tmpdir(),
      judge,
      judgeSamples: 1,
      persist: false,
      onEvent: (event) => {
        if (event.type === 'run-start') started.push(event.runId);
      },
    });

    const cells = matrixCells(['m1', 'm2'], ['s1', 's2'], ['t1', 't2'], 2);
    expect(cells.map((cell) => cell.runId)).toEqual(started);
    expect(cells[0]).toMatchObject({ model: 'm1', strategyId: 's1', taskId: 't1', repeat: 1, key: 'm1|s1|t1|1' });
  });
});

describe('firstRunIdClash', () => {
  it('finds two models that are one once made file-safe, and nothing in an honest matrix', () => {
    expect(firstRunIdClash(matrixCells(['claude-haiku-4-5-20251001', 'claude-sonnet-5-5'], ['s1', 's2'], ['t1'], 2))).toBeUndefined();

    const clash = firstRunIdClash(matrixCells(['claude/sonnet-5-5', 'claude-sonnet-5-5'], ['s1'], ['t1'], 1));
    expect(clash?.map((cell) => cell.model)).toEqual(['claude/sonnet-5-5', 'claude-sonnet-5-5']);
    expect(clash?.[0].runId).toBe(clash?.[1].runId);
  });
});

describe('resolveResume', () => {
  const manifest: RunSetManifest = {
    runSetId: 'set-1',
    createdAt: '2026-10-01T00:00:00.000Z',
    gitSha: null,
    model: 'claude-haiku-4-5-20251001',
    models: ['claude-haiku-4-5-20251001'],
    effort: 'low',
    repeats: 2,
    fixtureMode: 'replay',
    strategyIds: ['single', 'plan-execute'],
    taskIds: ['airline-easy'],
    totalRuns: 4,
    completedRuns: 1,
    totalCostUsd: 0.1,
    totalJudgeCostUsd: 0,
    durationMs: 1,
    maxCostUsdPerRun: 0.5,
    maxWallClockMsPerRun: 120_000,
    judge: { model: 'claude-sonnet-5-5', effort: 'medium', samples: 1 },
  };
  const resolver = {
    strategies: (selectors: string[]) => selectors,
    tasks: (selectors: string[]) => selectors,
  };

  it('takes every measurement setting from the run set when no flag says otherwise', () => {
    const result = resolveResume(run(['--resume', 'set-1', '--concurrency', '2']), manifest, resolver);
    if (!result.ok) throw new Error(result.error);

    expect(result.args).toMatchObject({
      runSetId: 'set-1',
      models: ['claude-haiku-4-5-20251001'],
      strategies: ['single', 'plan-execute'],
      tasks: ['airline-easy'],
      repeats: 2,
      effort: 'low',
      maxCostUsd: 0.5,
      maxSeconds: 120,
      judgeModel: 'claude-sonnet-5-5',
      judgeEffort: 'medium',
      judgeSamples: 1,
      concurrency: 2,
    });
    expect(result.notes).toEqual([]);
  });

  it('accepts flags that agree with the run set', () => {
    const result = resolveResume(
      run(['--resume', 'set-1', '--strategies', 'single,plan-execute', '--repeats', '2']),
      manifest,
      resolver,
    );
    expect(result.ok).toBe(true);
  });

  it('refuses flags that would measure something else, naming each', () => {
    const result = resolveResume(
      run(['--resume', 'set-1', '--repeats', '3', '--models', 'claude-opus-5-5', '--max-cost', '0.9']),
      manifest,
      resolver,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/--models is \["claude-opus-5-5"\], but the run set was measured with \["claude-haiku-4-5-20251001"\]/);
    expect(result.error).toMatch(/--repeats is 3/);
    expect(result.error).toMatch(/--max-cost is 0\.9/);
  });

  it('falls back to the flags for settings an older manifest never recorded', () => {
    const legacy: RunSetManifest = { ...manifest, models: undefined, maxWallClockMsPerRun: undefined, judge: undefined };
    const result = resolveResume(run(['--resume', 'set-1']), legacy, resolver);
    if (!result.ok) throw new Error(result.error);
    expect(result.args.models).toEqual(['claude-haiku-4-5-20251001']);
    expect(result.args.maxSeconds).toBe(600);
    expect(result.notes.join('\n')).toMatch(/does not record max-seconds/);
  });

  it('refuses a resume whose recorded cap no longer fits the session budget', () => {
    const result = resolveResume(run(['--resume', 'set-1', '--total-budget', '0.25']), manifest, resolver);
    expect(result.ok).toBe(false);
  });
});

describe('cells to resume', () => {
  let root: string | undefined;
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('runs again only the cells with no record, and the API errors', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'arena-cli-resume-'));
    const runs = runsDir('set-1', root);
    const recorded = [
      makeRecord({ model: 'm', strategyId: 's1', taskId: 't1', repeat: 1 }),
      makeRecord({ model: 'm', strategyId: 's2', taskId: 't1', repeat: 1, failureMode: 'api_error' }),
      makeRecord({ model: 'm', strategyId: 's1', taskId: 't1', repeat: 2, integrity: { ok: false, checks: [] } }),
    ];
    for (const record of recorded) await writeJson(path.join(runs, `${record.runId}.json`), record);

    const skip = await completedCells('set-1', root);
    const pending = matrixCells(['m'], ['s1', 's2'], ['t1'], 2).filter((cell) => !skip.has(cell.key));

    // The API error never measured anything; the failed integrity did, badly, and stays.
    expect(pending.map((cell) => cell.key)).toEqual(['m|s2|t1|1', 'm|s2|t1|2']);
  });
});

describe('spend', () => {
  it('bounds a matrix by its caps when they are below the budget', () => {
    const input = { runs: 10, gradedRuns: 0, maxCostUsd: 0.5, totalBudgetUsd: 25, concurrency: 4, judgeSamples: 3, attempts: 1 };
    const plan = spendPlan(input);
    expect(plan).toMatchObject({ maxInFlight: 4, agentCeiling: 5, judgeOverBudget: 0, ceiling: 5 });
    expect(ceilingText(input, plan)).toBe('$5.00  10 runs × $0.50 cap');
  });

  it('says "1 run", not "1 runs"', () => {
    const input = { runs: 1, gradedRuns: 1, maxCostUsd: 0.5, totalBudgetUsd: 0.5, concurrency: 4, judgeSamples: 3, attempts: 1 };
    expect(ceilingText(input, spendPlan(input))).toBe('$2.00  1 run × $0.50 cap + grading of up to 1 run in flight (3 × $0.50 each)');
  });

  it('adds the grading of the runs still in flight once the budget binds', () => {
    const input = { runs: 180, gradedRuns: 36, maxCostUsd: 1, totalBudgetUsd: 25, concurrency: 4, judgeSamples: 3, attempts: 1 };
    const plan = spendPlan(input);
    expect(plan).toMatchObject({ maxInFlight: 4, judgeCapPerRun: 1.5, agentCeiling: 25, judgeOverBudget: 6, ceiling: 31 });
    expect(ceilingText(input, plan)).toMatch(/total budget \$25\.00 \+ grading of up to 4 runs in flight/);
  });

  it('counts every attempt the runner may make, because each one reserves the cap again', () => {
    // The runner retries a run hit by a transient API error, up to MAX_ATTEMPTS
    // times; a failed attempt has been billed, so the cap can be spent each time.
    expect(MAX_ATTEMPTS).toBe(3);
    const input = { runs: 2, gradedRuns: 1, maxCostUsd: 0.5, totalBudgetUsd: 25, concurrency: 4, judgeSamples: 2, attempts: 3 };
    const plan = spendPlan(input);
    // 3 attempts x (2 runs x $0.50 + 1 graded run x 2 x $0.50)
    expect(plan.ceiling).toBe(6);
    expect(ceilingText(input, plan)).toBe('$6.00  2 runs × $0.50 cap × 3 attempts + grading of up to 1 run in flight (2 × $0.50 each)');

    // Once the budget binds, attempts draw on it like anything else.
    const large = spendPlan({ ...input, runs: 180, gradedRuns: 0 });
    expect(large.ceiling).toBe(25);
  });

  it('knows a small budget holds fewer runs in flight than --concurrency', () => {
    const plan = spendPlan({ runs: 20, gradedRuns: 0, maxCostUsd: 0.5, totalBudgetUsd: 1, concurrency: 8, judgeSamples: 1, attempts: 1 });
    expect(plan.maxInFlight).toBe(2);
  });
});

/** A record as written before runs carried an `integrity` verdict. */
function legacy(record: RunRecord): RunRecord {
  const { integrity: _integrity, ...rest } = record;
  return rest;
}

describe('needsConfirmation', () => {
  const ask = { interactive: true, yes: false, budgetGiven: false, ceilingUsd: 31 };

  it('asks a person at a terminal who is about to spend a lot on a limit they did not pick', () => {
    expect(needsConfirmation(ask)).toBe(true);
    expect(needsConfirmation({ ...ask, ceilingUsd: 5.01 })).toBe(true);
  });

  it('does not ask when anything says it need not: a small run, a chosen budget, --yes, or nobody to ask', () => {
    expect(needsConfirmation({ ...ask, ceilingUsd: 5 })).toBe(false);
    expect(needsConfirmation({ ...ask, budgetGiven: true })).toBe(false);
    expect(needsConfirmation({ ...ask, yes: true })).toBe(false);
    expect(needsConfirmation({ ...ask, interactive: false })).toBe(false);
  });
});

describe('expected cost from history', () => {
  it('prices cells from their own runs, then from the same model and strategy, and counts the rest', () => {
    const history = emptyHistory();
    addToHistory(history, [
      makeRecord({ model: 'm', strategyId: 's1', taskId: 't1', costUsd: 0.1, judgeCostUsd: 0.02 }),
      makeRecord({ model: 'm', strategyId: 's1', taskId: 't1', repeat: 2, costUsd: 0.3, judgeCostUsd: 0.02 }),
      makeRecord({ model: 'm', strategyId: 's1', taskId: 't2', costUsd: 0.5 }),
      // Never counted: what an API error or a broken run cost says nothing about a working one.
      makeRecord({ model: 'm', strategyId: 's2', taskId: 't1', costUsd: 9, failureMode: 'api_error' }),
      makeRecord({ model: 'm', strategyId: 's2', taskId: 't1', costUsd: 9, integrity: { ok: false, checks: [] } }),
      // Nor one from before the integrity checks existed: nothing says it ran the architecture it is labelled with.
      legacy(makeRecord({ model: 'm', strategyId: 's2', taskId: 't1', costUsd: 9 })),
    ]);

    const expected = expectedCost(
      [
        { model: 'm', strategyId: 's1', taskId: 't1' },
        { model: 'm', strategyId: 's1', taskId: 't3' },
        { model: 'm', strategyId: 's2', taskId: 't1' },
      ],
      history,
    );

    expect(expected.exact).toBe(1);
    expect(expected.fromArm).toBe(1);
    expect(expected.unknown).toBe(1);
    // t1: (0.12 + 0.32) / 2 = 0.22; t3 from s1 overall: (0.12 + 0.32 + 0.5) / 3.
    expect(expected.usd).toBeCloseTo(0.22 + 0.94 / 3, 10);
    expect(history.runs).toBe(3);
  });
});
