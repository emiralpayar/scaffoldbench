import { describe, expect, it } from 'vitest';

import { FIXTURES_DIR } from '@scaffoldbench/core';
import type { Judge } from '@scaffoldbench/core';
import { getStrategies } from '@scaffoldbench/strategies';
import { ALL_TASKS, getTasks } from '@scaffoldbench/tasks';

/** What `--tasks` and `--strategies` select, and that every task can be built and scored. */

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
      cwd: '/tmp/scaffoldbench-cli-test',
      fixtureMode: 'replay' as const,
      // Research environments load the shipped corpus, so point at the real one.
      fixtureDir: FIXTURES_DIR,
    };
    // Tool-use scoring is deterministic; a judge call here would be a bug.
    const judge: Judge = async () => {
      throw new Error('a tool-use task must not call the judge');
    };

    for (const task of ALL_TASKS) {
      const env = await task.createEnvironment(options);

      expect(env.allowedTools.length, task.id).toBeGreaterThan(0);
      expect(Object.keys(env.createMcpServers()).length, task.id).toBeGreaterThan(0);
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
