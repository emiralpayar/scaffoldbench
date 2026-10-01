import { expect } from 'vitest';
import { z } from 'zod';
import type { JournaledToolSpec, ScoreInput, TaskScore, ToolCall } from '@arena/core';

/**
 * Drives a task's real tool handlers the way the journaling MCP wrapper does,
 * without the SDK in the loop.
 *
 * Arguments go through the tool's own zod shape first, exactly as the MCP
 * server validates them in production, so a schema that rejects (or silently
 * strips) what a handler needs fails here instead of in a paid run. The world
 * the driver mutates is the object the scorer is later handed, which is what
 * makes these tests end-to-end.
 */
export interface Driver<W> {
  world: W;
  journal: ToolCall[];
  /** Call a tool that must succeed; returns its reply text. */
  call(name: string, args?: Record<string, unknown>): Promise<string>;
  /** Call a tool that must report an error; returns the error text. */
  expectError(name: string, args?: Record<string, unknown>): Promise<string>;
  /** Call a tool and accept either outcome. */
  attempt(name: string, args?: Record<string, unknown>): Promise<{ text: string; ok: boolean }>;
}

export function createDriver<W>(world: W, tools: JournaledToolSpec[]): Driver<W> {
  const journal: ToolCall[] = [];
  const byName = new Map(tools.map((spec) => [spec.name, spec] as const));

  async function attempt(name: string, args: Record<string, unknown> = {}) {
    const spec = byName.get(name);
    if (!spec) throw new Error(`unknown tool in test: ${name}`);
    const parsed = z.object(spec.schema).safeParse(args);
    if (!parsed.success) {
      throw new Error(`test passed invalid arguments to ${name}: ${parsed.error.message}`);
    }
    const validArgs = parsed.data as Record<string, unknown>;
    const reply = await spec.handler(validArgs);
    const text = typeof reply === 'string' ? reply : reply.text;
    const ok = typeof reply === 'string' ? true : reply.isError !== true;
    journal.push({ name, args: validArgs, tMs: journal.length, ok, result: text });
    return { text, ok };
  }

  return {
    world,
    journal,
    attempt,
    async call(name, args = {}) {
      const { text, ok } = await attempt(name, args);
      if (!ok) throw new Error(`tool ${name} failed unexpectedly: ${text}`);
      return text;
    },
    async expectError(name, args = {}) {
      const { text, ok } = await attempt(name, args);
      expect(ok, `expected ${name} to report an error, got: ${text}`).toBe(false);
      return text;
    },
  };
}

/** The scorer's input for a driven world. The judge throws: tool-use scoring must not need one. */
export function scoreInput<W>(driver: Pick<Driver<W>, 'world' | 'journal'>): ScoreInput {
  return {
    env: {
      mcpServers: {},
      allowedTools: [],
      readOnlyTools: [],
      state: driver.world,
      journal: driver.journal,
    },
    outcome: { finalText: '', subagentCount: 0, phases: [] },
    trace: [],
    deps: {
      judge: async () => {
        throw new Error('tool-use tasks must not call the judge');
      },
      judgeSamples: 1,
    },
  };
}

export function penaltyIds(score: Pick<TaskScore, 'penalties'>): string[] {
  return score.penalties.map((penalty) => penalty.id);
}

/** Credit earned by one breakdown item; throws when the id does not exist, so a typo cannot pass. */
export function earned(score: Pick<TaskScore, 'breakdown'>, id: string): number {
  const item = score.breakdown.find((entry) => entry.id === id);
  if (!item) throw new Error(`no breakdown item ${id}; have ${score.breakdown.map((e) => e.id).join(', ')}`);
  return item.earned;
}

/** Ids of breakdown items that did not earn full credit. */
export function missed(score: Pick<TaskScore, 'breakdown'>): string[] {
  return score.breakdown.filter((item) => item.earned < 1).map((item) => item.id);
}

export const environmentOptions = () => ({
  cwd: '/tmp/arena-task-test',
  fixtureMode: 'replay' as const,
  fixtureDir: '/tmp/arena-task-fixtures',
});
