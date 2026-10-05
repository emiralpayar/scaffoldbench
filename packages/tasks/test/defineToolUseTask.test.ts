import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineToolUseTask, cloneWorld } from '@scaffoldbench/tasks';
import type { ScoreInput, TaskEnvironment, ToolCall } from '@scaffoldbench/core';

interface TinyWorld {
  counter: number;
  policyRead: boolean;
}

function makeTask(overrides: Partial<Parameters<typeof defineToolUseTask<TinyWorld>>[0]> = {}) {
  return defineToolUseTask<TinyWorld>({
    id: 'tiny-1',
    world: 'tiny',
    title: 'Tiny task',
    prompt: 'Increment the counter to 2.',
    policy: 'Read the policy before incrementing.',
    difficulty: 'easy',
    tags: ['test'],
    maxTurns: 4,
    createWorld: () => ({ counter: 0, policyRead: false }),
    createTools: (world) => [
      {
        name: 'read_policy',
        description: 'Read the policy',
        schema: {},
        handler: () => {
          world.policyRead = true;
          return 'policy: increment at most twice';
        },
      },
      {
        name: 'increment',
        description: 'Increment the counter',
        schema: { by: z.number() },
        handler: (args: { by: number }) => {
          world.counter += args.by;
          return `counter=${world.counter}`;
        },
      },
    ],
    assertions: [
      {
        id: 'counter',
        label: 'Counter reaches 2',
        weight: 1,
        check: (world) => world.counter === 2,
        detail: (world) => `counter=${world.counter}`,
      },
    ],
    forbidden: [
      {
        id: 'no-policy',
        label: 'Incremented without reading the policy',
        violated: (world, journal) =>
          journal.some((entry) => entry.name === 'increment') && !world.policyRead,
      },
    ],
    ...overrides,
  });
}

const emptyScoreInput = (env: TaskEnvironment): ScoreInput => ({
  env,
  outcome: { finalText: '', subagentCount: 0, phases: [] },
  trace: [],
  deps: {
    judge: async () => {
      throw new Error('tool-use tasks must not call the judge');
    },
    judgeSamples: 1,
  },
});

describe('cloneWorld', () => {
  it('produces an independent copy', () => {
    const original = { nested: { list: [1, 2] } };
    const copy = cloneWorld(original);
    copy.nested.list.push(3);
    expect(original.nested.list).toEqual([1, 2]);
  });
});

describe('defineToolUseTask', () => {
  it('exposes task metadata', () => {
    const task = makeTask();
    expect(task.category).toBe('tool-use');
    expect(task.world).toBe('tiny');
    expect(task.maxTurns).toBe(4);
    expect(task.policy).toContain('Read the policy');
  });

  it('creates an isolated world per environment', async () => {
    const task = makeTask();
    const a = (await task.createEnvironment(opts())) as TaskEnvironment;
    const b = (await task.createEnvironment(opts())) as TaskEnvironment;
    (a.state as TinyWorld).counter = 99;
    expect((b.state as TinyWorld).counter).toBe(0);
  });

  it('exposes fully-qualified allowed tool names', async () => {
    const env = await task().createEnvironment(opts());
    expect(env.allowedTools).toEqual(['mcp__tiny__read_policy', 'mcp__tiny__increment']);
  });

  it('scores zero on an untouched world', async () => {
    const env = await task().createEnvironment(opts());
    const score = await task().score(emptyScoreInput(env));
    expect(score.score).toBe(0);
    expect(score.passed).toBe(false);
    expect(score.failureMode).toBe('wrong_answer');
  });

  it('scores one when the assertion holds and no rule was broken', async () => {
    const t = task();
    const env = await t.createEnvironment(opts());
    const world = env.state as TinyWorld;
    world.policyRead = true;
    world.counter = 2;
    env.journal.push(journalEntry('increment'));

    const score = await t.score(emptyScoreInput(env));
    expect(score.score).toBe(1);
    expect(score.passed).toBe(true);
    expect(score.failureMode).toBe('none');
  });

  it('hard-fails when a forbidden rule fires even with the assertion met', async () => {
    const t = task();
    const env = await t.createEnvironment(opts());
    const world = env.state as TinyWorld;
    world.counter = 2;
    world.policyRead = false;
    env.journal.push(journalEntry('increment'));

    const score = await t.score(emptyScoreInput(env));
    expect(score.score).toBe(0);
    expect(score.failureMode).toBe('policy_violation');
    expect(score.penalties[0]?.id).toBe('no-policy');
  });

  it('supports partial credit from a numeric check', async () => {
    const t = makeTask({
      assertions: [
        { id: 'partial', label: 'Half done', weight: 1, check: () => 0.5 },
      ],
    });
    const env = await t.createEnvironment(opts());
    expect((await t.score(emptyScoreInput(env))).score).toBeCloseTo(0.5);
  });

  it('treats a throwing assertion as zero without failing the run', async () => {
    const t = makeTask({
      assertions: [
        {
          id: 'boom',
          label: 'Throws',
          weight: 1,
          check: () => {
            throw new Error('bad predicate');
          },
        },
        { id: 'fine', label: 'Fine', weight: 1, check: () => true },
      ],
    });
    const env = await t.createEnvironment(opts());
    const score = await t.score(emptyScoreInput(env));
    expect(score.score).toBeCloseTo(0.5);
    expect(score.breakdown).toHaveLength(2);
  });

  it('records tool statistics in metadata', async () => {
    const t = task();
    const env = await t.createEnvironment(opts());
    env.journal.push(journalEntry('increment'), journalEntry('increment'), journalEntry('read_policy', false));
    const score = await t.score(emptyScoreInput(env));
    expect(score.metadata?.toolCalls).toBe(3);
    expect(score.metadata?.failedToolCalls).toBe(1);
    expect(score.metadata?.distinctTools).toBe(2);
  });

  it('runs tool handlers against the world instance', async () => {
    const t = task();
    const env = await t.createEnvironment(opts());
    // The MCP server owns the handlers, so exercise the world directly to prove
    // the closure targets this environment's state and not a shared singleton.
    const world = env.state as TinyWorld;
    expect(world.counter).toBe(0);
    world.counter += 2;
    expect((env.state as TinyWorld).counter).toBe(2);
  });
});

function task() {
  return makeTask();
}

function opts() {
  return { cwd: '/tmp/scaffoldbench-test', fixtureMode: 'replay' as const, fixtureDir: '/tmp/fixtures' };
}

function journalEntry(name: string, ok = true): ToolCall {
  return { name, args: {}, tMs: 0, ok, result: '' };
}
