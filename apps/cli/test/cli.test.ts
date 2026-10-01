import { describe, expect, it } from 'vitest';

import { FIXTURES_DIR, summarizeRuns } from '@arena/core';
import type { Judge, ReportSummary, RunRecord, StrategyInfo, TaskInfo } from '@arena/core';
import { getStrategies } from '@arena/strategies';
import { ALL_TASKS, getTasks } from '@arena/tasks';

import { parseArgs } from '../src/args';
import type { ParsedCommand, RunArgs } from '../src/args';
import {
  formatFailureModes,
  formatLeaderboard,
  formatMatrix,
  formatPairwise,
  formatPareto,
  toMarkdown,
} from '../src/report';
import type { Catalog } from '../src/report';

/** Narrow a ParsedCommand to a successful `run`, failing loudly otherwise. */
function expectRun(parsed: ParsedCommand): RunArgs {
  if (!parsed.ok) throw new Error(`expected a parse success, got: ${parsed.error}`);
  if (parsed.command !== 'run') throw new Error(`expected the run command, got: ${parsed.command}`);
  return parsed.args;
}

function expectError(parsed: ParsedCommand): string {
  if (parsed.ok) throw new Error(`expected a parse error, got command: ${parsed.command}`);
  return parsed.error;
}

describe('parseArgs', () => {
  it('applies documented defaults with an empty environment', () => {
    const args = expectRun(parseArgs(['run'], {}));

    expect(args.strategies).toEqual(['all']);
    expect(args.tasks).toEqual(['all']);
    expect(args.repeats).toBe(3);
    expect(args.model).toBe('claude-opus-5');
    expect(args.effort).toBe('high');
    expect(args.concurrency).toBe(4);
    expect(args.maxCostUsd).toBe(1.0);
    expect(args.maxSeconds).toBe(600);
    expect(args.totalBudgetUsd).toBe(25);
    expect(args.judgeSamples).toBe(3);
    expect(args.fixtureMode).toBe('replay');
    expect(args.persist).toBe(true);
    expect(args.runSetId).toBeUndefined();
  });

  it('takes the model and the per-run cost cap from the environment', () => {
    const args = expectRun(
      parseArgs(['run'], { ARENA_MODEL: 'claude-sonnet-5', ARENA_MAX_COST_USD: '0.25' }),
    );

    expect(args.model).toBe('claude-sonnet-5');
    expect(args.maxCostUsd).toBe(0.25);
  });

  it('lets an explicit flag beat the environment', () => {
    const args = expectRun(
      parseArgs(['run', '--model', 'claude-haiku-4-5'], { ARENA_MODEL: 'claude-sonnet-5' }),
    );

    expect(args.model).toBe('claude-haiku-4-5');
  });

  it('reads every run flag', () => {
    const args = expectRun(
      parseArgs(
        [
          'run',
          '--strategies',
          'single,plan-execute',
          '--tasks',
          'airline,research',
          '--repeats',
          '5',
          '--model',
          'claude-sonnet-5',
          '--effort',
          'max',
          '--concurrency',
          '8',
          '--max-cost',
          '2.5',
          '--max-seconds',
          '900',
          '--total-budget',
          '40',
          '--judge-model',
          'claude-haiku-4-5',
          '--judge-samples',
          '5',
          '--record',
          '--run-set',
          'my-set',
          '--no-persist',
        ],
        {},
      ),
    );

    expect(args.strategies).toEqual(['single', 'plan-execute']);
    expect(args.tasks).toEqual(['airline', 'research']);
    expect(args.repeats).toBe(5);
    expect(args.model).toBe('claude-sonnet-5');
    expect(args.effort).toBe('max');
    expect(args.concurrency).toBe(8);
    expect(args.maxCostUsd).toBe(2.5);
    expect(args.maxSeconds).toBe(900);
    expect(args.totalBudgetUsd).toBe(40);
    expect(args.judgeModel).toBe('claude-haiku-4-5');
    expect(args.judgeSamples).toBe(5);
    expect(args.fixtureMode).toBe('record');
    expect(args.runSetId).toBe('my-set');
    expect(args.persist).toBe(false);
  });

  it('accepts --flag=value as well as --flag value', () => {
    const args = expectRun(parseArgs(['run', '--repeats=7', '--effort=low'], {}));

    expect(args.repeats).toBe(7);
    expect(args.effort).toBe('low');
  });

  it('coerces numeric flags to numbers, not strings', () => {
    const args = expectRun(parseArgs(['run', '--repeats', '2', '--max-cost', '0.5'], {}));

    expect(args.repeats).toBe(2);
    expect(args.maxCostUsd).toBe(0.5);
    expect(typeof args.repeats).toBe('number');
    expect(typeof args.maxCostUsd).toBe('number');
  });

  it('rejects a non-numeric numeric flag', () => {
    expect(expectError(parseArgs(['run', '--repeats', 'lots'], {}))).toMatch(/--repeats/);
  });

  it('rejects a repeats value below one', () => {
    expect(expectError(parseArgs(['run', '--repeats', '0'], {}))).toMatch(/--repeats/);
  });

  it('rejects an effort level outside the supported set', () => {
    const error = expectError(parseArgs(['run', '--effort', 'turbo'], {}));

    expect(error).toMatch(/turbo/);
    expect(error).toMatch(/low, medium, high, xhigh, max/);
  });

  it('rejects two fixture mode flags at once', () => {
    const error = expectError(parseArgs(['run', '--record', '--live'], {}));

    expect(error).toMatch(/--record/);
    expect(error).toMatch(/--live/);
  });

  it('accepts a single fixture mode flag', () => {
    expect(expectRun(parseArgs(['run', '--live'], {})).fixtureMode).toBe('live');
    expect(expectRun(parseArgs(['run', '--replay'], {})).fixtureMode).toBe('replay');
  });

  it('rejects an unknown flag', () => {
    expect(expectError(parseArgs(['run', '--turbo-mode'], {}))).toMatch(/--turbo-mode/);
  });

  it('rejects a flag that belongs to another command', () => {
    expect(expectError(parseArgs(['run', '--markdown'], {}))).toMatch(/--markdown/);
  });

  it('rejects a value flag with nothing after it', () => {
    expect(expectError(parseArgs(['run', '--model'], {}))).toMatch(/--model/);
  });

  it('recognises --help anywhere on the line', () => {
    expect(parseArgs(['--help'], {})).toEqual({ ok: true, command: 'help' });
    expect(parseArgs(['run', '--help'], {})).toEqual({ ok: true, command: 'help' });
    expect(parseArgs([], {})).toEqual({ ok: true, command: 'help' });
  });

  it('rejects an unknown command and names it', () => {
    expect(expectError(parseArgs(['frobnicate'], {}))).toMatch(/frobnicate/);
  });

  it('parses the report command with a positional run set id', () => {
    const parsed = parseArgs(['report', '2026-07-25T12-00-00Z-abcd', '--markdown'], {});

    expect(parsed).toEqual({
      ok: true,
      command: 'report',
      args: { runSetId: '2026-07-25T12-00-00Z-abcd', markdown: true },
    });
  });

  it('defaults the report run set id to undefined so the latest pointer wins', () => {
    expect(parseArgs(['report'], {})).toEqual({
      ok: true,
      command: 'report',
      args: { runSetId: undefined, markdown: false },
    });
  });

  it('parses the discovery commands', () => {
    expect(parseArgs(['tasks'], {})).toEqual({ ok: true, command: 'tasks' });
    expect(parseArgs(['strategies'], {})).toEqual({ ok: true, command: 'strategies' });
  });
});

describe('getTasks', () => {
  it('returns everything for "all" and for no selector', () => {
    expect(getTasks(['all'])).toHaveLength(ALL_TASKS.length);
    expect(getTasks()).toHaveLength(ALL_TASKS.length);
    expect(getTasks([])).toHaveLength(ALL_TASKS.length);
  });

  it('selects by category', () => {
    const toolUse = getTasks(['tool-use']);
    const research = getTasks(['research']);

    expect(toolUse.length).toBeGreaterThan(0);
    expect(toolUse.every((task) => task.category === 'tool-use')).toBe(true);
    expect(research.length).toBeGreaterThan(0);
    expect(research.every((task) => task.category === 'research')).toBe(true);
    expect(toolUse.length + research.length).toBe(ALL_TASKS.length);
  });

  it('selects by world', () => {
    const airline = getTasks(['airline']);

    expect(airline.length).toBeGreaterThan(0);
    expect(airline.every((task) => task.world === 'airline')).toBe(true);
    expect(getTasks(['web']).every((task) => task.category === 'research')).toBe(true);
  });

  it('selects an exact task id', () => {
    expect(getTasks(['airline-hard']).map((task) => task.id)).toEqual(['airline-hard']);
  });

  it('selects with a glob', () => {
    const globbed = getTasks(['airline-*']).map((task) => task.id);

    expect(globbed).toEqual(getTasks(['airline']).map((task) => task.id));
    expect(globbed.length).toBeGreaterThan(1);
  });

  it('de-duplicates overlapping selectors and keeps declaration order', () => {
    const ids = getTasks(['airline-hard', 'airline', 'airline-*']).map((task) => task.id);

    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(ALL_TASKS.filter((task) => task.world === 'airline').map((t) => t.id));
  });

  it('orders the result by declaration, not by the order of the selectors', () => {
    const ids = getTasks(['support', 'airline']).map((task) => task.id);
    const expected = ALL_TASKS.filter(
      (task) => task.world === 'support' || task.world === 'airline',
    ).map((task) => task.id);

    expect(ids).toEqual(expected);
  });

  it('throws for an unknown selector, naming it and listing the valid ids', () => {
    let thrown: unknown;
    try {
      getTasks(['airline-hard', 'nonsense']);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toMatch(/nonsense/);
    expect(message).toMatch(/airline-hard/);
    expect(message).toMatch(/tool-use/);
  });
});

describe('getStrategies', () => {
  it('returns the whole comparison set for "all"', () => {
    expect(getStrategies(['all'])).toEqual(getStrategies());
    expect(getStrategies(['all']).length).toBeGreaterThan(1);
  });

  it('throws for an unknown id and names it', () => {
    expect(() => getStrategies(['single', 'telepathy'])).toThrow(/telepathy/);
  });
});

describe('ALL_TASKS', () => {
  it('has unique ids', () => {
    const ids = ALL_TASKS.map((task) => task.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('gives every task a prompt, a turn budget and a known category', () => {
    for (const task of ALL_TASKS) {
      expect(task.prompt.trim(), task.id).not.toBe('');
      expect(task.title.trim(), task.id).not.toBe('');
      expect(task.maxTurns, task.id).toBeGreaterThan(0);
      expect(['tool-use', 'research'], task.id).toContain(task.category);
      expect(task.world.trim(), task.id).not.toBe('');
    }
  });

  it('gives every task a usable environment and every tool-use task an assertion', async () => {
    const options = {
      cwd: '/tmp/arena-cli-test',
      fixtureMode: 'replay' as const,
      // Research environments load the shipped corpus, so this must be real.
      fixtureDir: FIXTURES_DIR,
    };
    // Tool-use scoring is deterministic; a judge call here would be a bug.
    const judge: Judge = async () => {
      throw new Error('a tool-use task must not call the judge');
    };

    for (const task of ALL_TASKS) {
      const env = await task.createEnvironment(options);

      expect(env.allowedTools.length, task.id).toBeGreaterThan(0);
      expect(Object.keys(env.mcpServers).length, task.id).toBeGreaterThan(0);
      for (const tool of env.readOnlyTools) {
        expect(env.allowedTools, task.id).toContain(tool);
      }

      if (task.category !== 'tool-use') continue;
      const score = await task.score({
        env,
        outcome: { finalText: '', subagentCount: 0, phases: [] },
        trace: [],
        deps: { judge, judgeSamples: 1 },
      });
      expect(score.breakdown.length, task.id).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

function makeRecord(overrides: Partial<RunRecord> & Pick<RunRecord, 'strategyId' | 'taskId'>): RunRecord {
  return {
    runId: `${overrides.strategyId}__${overrides.taskId}__r${overrides.repeat ?? 1}`,
    runSetId: 'test-set',
    taskTitle: 'A task',
    taskCategory: 'tool-use',
    taskWorld: 'airline',
    taskDifficulty: 'easy',
    model: 'claude-opus-5',
    effort: 'high',
    repeat: 1,
    startedAt: '2026-07-25T12:00:00.000Z',
    finishedAt: '2026-07-25T12:00:30.000Z',
    latencyMs: 30_000,
    score: 0.5,
    passed: false,
    breakdown: [],
    penalties: [],
    failureMode: 'wrong_answer',
    scoreMetadata: {},
    costUsd: 0.04,
    judgeCostUsd: 0,
    usage: {
      inputTokens: 1000,
      outputTokens: 100,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    },
    turns: 5,
    toolCalls: 4,
    deniedToolCalls: 0,
    subagentCount: 0,
    phases: [],
    finalText: 'done',
    ...overrides,
  };
}

/** Two strategies whose confidence intervals overlap, over two tasks. */
function syntheticSummary(): ReportSummary {
  const scores: Record<string, number[]> = {
    alpha: [0.6, 0.7, 0.5, 0.6, 0.7, 0.5],
    beta: [0.55, 0.65, 0.45, 0.55, 0.65, 0.45],
  };
  const records: RunRecord[] = [];

  for (const strategyId of ['alpha', 'beta']) {
    let i = 0;
    for (const taskId of ['airline-easy', 'airline-hard']) {
      for (let repeat = 1; repeat <= 3; repeat++) {
        const score = scores[strategyId]?.[i] ?? 0;
        i += 1;
        records.push(
          makeRecord({
            strategyId,
            taskId,
            repeat,
            score,
            passed: score >= 0.999,
            failureMode: repeat === 1 ? 'wrong_answer' : 'policy_violation',
            costUsd: strategyId === 'alpha' ? 0.04 : 0.12,
            latencyMs: strategyId === 'alpha' ? 20_000 : 45_000,
          }),
        );
      }
    }
  }

  return summarizeRuns(records);
}

const syntheticCatalog: Catalog = {
  strategies: [
    { id: 'alpha', label: 'Alpha harness', description: 'The baseline.' },
    { id: 'beta', label: 'Beta harness', description: 'More structure, more cost.' },
  ] satisfies StrategyInfo[],
  tasks: [
    {
      id: 'airline-easy',
      category: 'tool-use',
      world: 'airline',
      title: 'An easy airline task',
      prompt: 'Do the easy thing.',
      difficulty: 'easy',
      tags: ['airline'],
      maxTurns: 12,
    },
    {
      id: 'airline-hard',
      category: 'tool-use',
      world: 'airline',
      title: 'A hard airline task',
      prompt: 'Do the hard thing.',
      difficulty: 'hard',
      tags: ['airline'],
      maxTurns: 20,
    },
  ] satisfies TaskInfo[],
};

describe('report formatters', () => {
  const summary = syntheticSummary();

  it('builds a fixture whose confidence intervals genuinely overlap', () => {
    expect(summary.strategies).toHaveLength(2);
    expect(summary.pairwise).toHaveLength(1);
    expect(summary.pairwise[0]?.verdict).toBe('inconclusive');
  });

  it('renders a leaderboard with the strategy ids and CI notation', () => {
    const out = formatLeaderboard(summary, syntheticCatalog);

    expect(out).toMatch(/alpha/);
    expect(out).toMatch(/beta/);
    expect(out).toMatch(/\[\d\.\d{3}, \d\.\d{3}\]/);
    expect(out).toMatch(/SCORE/);
    expect(out).toMatch(/\$/);
  });

  it('keeps leaderboard columns aligned', () => {
    const lines = formatLeaderboard(summary, syntheticCatalog).split('\n');
    const header = lines[0] ?? '';
    const scoreColumn = header.indexOf('SCORE');

    expect(scoreColumn).toBeGreaterThan(0);
    for (const line of lines.slice(1, 3)) {
      expect(line.slice(scoreColumn)).toMatch(/^\d\.\d{3} \[/);
    }
  });

  it('names the Pareto frontier members', () => {
    const out = formatPareto(summary, syntheticCatalog);

    expect(out).toMatch(/Pareto/i);
    for (const id of summary.paretoStrategyIds) {
      expect(out).toContain(id);
    }
  });

  it('renders the strategy x task matrix with every id present', () => {
    const out = formatMatrix(summary, syntheticCatalog);

    expect(out).toMatch(/alpha/);
    expect(out).toMatch(/beta/);
    expect(out).toMatch(/airline-easy/);
    expect(out).toMatch(/airline-hard/);
  });

  it('breaks down failure modes per strategy', () => {
    const out = formatFailureModes(summary);

    expect(out.toLowerCase()).toMatch(/policy_violation/);
    expect(out.toLowerCase()).toMatch(/wrong_answer/);
    expect(out).toMatch(/alpha/);
  });

  it('says "inconclusive" when the confidence intervals overlap', () => {
    const out = formatPairwise(summary);

    expect(out).toContain('inconclusive');
    expect(out).toMatch(/alpha/);
    expect(out).toMatch(/beta/);
  });

  it('calls a winner when the intervals are disjoint', () => {
    const records: RunRecord[] = [];
    for (let repeat = 1; repeat <= 4; repeat++) {
      records.push(makeRecord({ strategyId: 'winner', taskId: 'airline-easy', repeat, score: 1 }));
      records.push(makeRecord({ strategyId: 'loser', taskId: 'airline-easy', repeat, score: 0 }));
    }
    const decisive = summarizeRuns(records);

    expect(decisive.pairwise[0]?.verdict).toBe('a-better');
    const out = formatPairwise(decisive);
    expect(out).toMatch(/winner/);
    expect(out).not.toContain('inconclusive');
  });

  it('emits markdown table syntax', () => {
    const out = toMarkdown(summary, syntheticCatalog);

    expect(out).toMatch(/^# /m);
    expect(out).toMatch(/^\| .+ \|$/m);
    expect(out).toMatch(/^\|[ :|-]+\|$/m);
    expect(out).toContain('alpha');
    expect(out).toContain('Alpha harness');
    expect(out).toContain('inconclusive');
    expect(out).toMatch(/\[\d\.\d{3}, \d\.\d{3}\]/);
  });

  it('gives every markdown table a separator row and a uniform cell count', () => {
    const lines = toMarkdown(summary, syntheticCatalog).split('\n');

    // Consecutive `|` lines form one table; every table must be well-formed.
    const tables: string[][] = [];
    let current: string[] = [];
    for (const line of lines) {
      if (line.startsWith('|')) {
        current.push(line);
        continue;
      }
      if (current.length > 0) tables.push(current);
      current = [];
    }
    if (current.length > 0) tables.push(current);

    expect(tables.length).toBeGreaterThanOrEqual(4);

    for (const table of tables) {
      expect(table.length).toBeGreaterThanOrEqual(3);
      expect(table[1] ?? '').toMatch(/^\|[ :|-]+\|$/);
      const width = (table[0] ?? '').split('|').length;
      for (const row of table) {
        expect(row.split('|').length).toBe(width);
      }
    }
  });
});
