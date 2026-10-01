import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@anthropic-ai/claude-agent-sdk')>();
  const fake = await import('../../core/test/support/fakeClaudeCode');
  return { ...actual, query: fake.fakeQuery };
});

import {
  BudgetTracker,
  STRUCTURED_OUTPUT_TOOL,
  TraceCollector,
  createJournaledToolServer,
} from '@arena/core';
import type { RunContext, Task, TaskEnvironment, ToolCall } from '@arena/core';
import {
  createDebateSelectStrategy,
  createOrchestratorWorkersStrategy,
  createPlanExecuteStrategy,
} from '@arena/strategies';
import {
  assistant,
  resetFake,
  sessions,
  setScript,
  sleep,
  success,
  toolResult,
  toolUse,
  type FakeSession,
} from '../../core/test/support/fakeClaudeCode';

/**
 * The architectures, run through the real `runQuery` against a scripted SDK.
 *
 * The orchestration tests in `strategies.test.ts` inject a fake `runQuery`,
 * which is why they stayed green while every structured phase was being
 * denied and every parallel phase after the first ran without tools. These
 * tests let the real seam — guard, per-call MCP servers, budget leases — sit
 * between the strategy and the model, so those failures cannot come back
 * unnoticed.
 */

function makeEnv(): TaskEnvironment & { journal: ToolCall[] } {
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
  return {
    createMcpServers: server.createMcpServers,
    allowedTools: server.allowedTools,
    readOnlyTools: server.readOnlyTools,
    state: {},
    journal,
  };
}

function makeCtx(env: TaskEnvironment): RunContext {
  return {
    runId: 'run-1',
    task: {
      id: 'shop-1',
      category: 'tool-use',
      world: 'shop',
      title: 'Refund O-1',
      prompt: 'Refund order O-1 if it is eligible.',
      maxTurns: 8,
      difficulty: 'easy',
      tags: [],
    } as unknown as Task,
    strategyId: 'test',
    model: 'claude-haiku-4-5-20251001',
    effort: 'low',
    env,
    cwd: '/tmp',
    signal: new AbortController().signal,
    budget: new BudgetTracker({ maxCostUsd: 0.9, maxWallClockMs: 60_000 }),
    trace: new TraceCollector(),
    systemPrompt: 'You are under test.',
  };
}

/** One tool call, its result, and a final answer. */
async function* useTool(session: FakeSession, tool: string, id: string, answer: string) {
  const call = await session.callTool(tool, { id });
  yield toolUse(tool, { id });
  yield toolResult(call);
  await sleep(10); // stay open long enough to overlap with siblings
  yield assistant(answer);
  yield success({ text: answer, costUsd: 0.01 });
}

async function* answerWith(session: FakeSession, structured: unknown) {
  const call = await session.callTool(STRUCTURED_OUTPUT_TOOL, structured as Record<string, unknown>);
  yield toolUse(STRUCTURED_OUTPUT_TOOL, structured);
  yield toolResult(call);
  yield call.denied
    ? success({ text: '', isError: false })
    : success({ structured, costUsd: 0.01 });
}

afterEach(() => resetFake());

describe('debate-select through the real runQuery', () => {
  it('runs three grounded proposers, a selector that answers, and an executor', async () => {
    setScript(async function* (session) {
      const proposer = /You are proposer (\d)/.exec(session.prompt)?.[1];
      if (proposer) {
        yield* useTool(session, 'mcp__shop__get_order', 'O-1', `proposal ${proposer}: refund O-1`);
      } else if (session.prompt.includes('You are the selector')) {
        yield* answerWith(session, {
          winnerIndex: 2,
          rationale: 'grounded in the order record',
          mergedAnswer: 'Refund O-1.',
        });
      } else {
        yield* useTool(session, 'mcp__shop__refund', 'O-1', 'Refunded O-1.');
      }
    });
    const env = makeEnv();
    const ctx = makeCtx(env);

    const outcome = await createDebateSelectStrategy().run(ctx);

    const proposers = sessions().filter((s) => /You are proposer/.test(s.prompt));
    expect(proposers).toHaveLength(3);
    for (const proposer of proposers) {
      expect(proposer.mcpServers).toEqual([{ name: 'shop', status: 'connected' }]);
      // Read-only proposers are shown only the read-only tool.
      expect(proposer.tools).toEqual(['mcp__shop__get_order']);
      // An equal share of the $0.90 available when the fan-out started.
      expect(proposer.options.maxBudgetUsd).toBeCloseTo(0.3, 10);
    }

    const selector = sessions().find((s) => s.prompt.includes('You are the selector'));
    expect(selector?.tools).toEqual([STRUCTURED_OUTPUT_TOOL]);
    const select = outcome.phases.find((p) => p.phase === 'select');
    expect(select?.subtype).toBe('success');
    expect(select?.structuredMissing).toBeUndefined();

    // The winner the selector chose is what the executor was handed.
    const executor = sessions().at(-1);
    expect(executor?.prompt).toContain('proposal 2: refund O-1');
    expect(executor?.prompt).toContain('Refund O-1.');

    expect(env.journal.map((entry) => entry.name)).toEqual([
      'get_order',
      'get_order',
      'get_order',
      'refund',
    ]);
    expect(outcome.finalText).toBe('Refunded O-1.');
    expect(ctx.trace.events.some((e) => e.kind === 'tool_denied')).toBe(false);

    // The proposers ran side by side, and their records say so.
    const starts = outcome.phases.filter((p) => p.phase.startsWith('propose-')).map((p) => p.startedAtMs);
    expect(Math.max(...starts) - Math.min(...starts)).toBeLessThan(10);
  });
});

describe('orchestrator-workers through the real runQuery', () => {
  it('fans the decomposition out to workers that each have the tools', async () => {
    setScript(async function* (session) {
      if (session.prompt.includes('You are the orchestrator. You have no tools here: split')) {
        yield* answerWith(session, {
          subtasks: [
            { id: 'check', goal: 'Read order O-1 and report its state.' },
            { id: 'refund', goal: 'Refund order O-1.' },
          ],
        });
      } else if (session.prompt.includes('<your_assignment>')) {
        const refund = session.prompt.includes('Refund order O-1.');
        yield* refund
          ? useTool(session, 'mcp__shop__refund', 'O-1', 'Refunded O-1.')
          : useTool(session, 'mcp__shop__get_order', 'O-1', 'O-1 is paid.');
      } else {
        yield assistant('O-1 was checked and refunded.');
        yield success({ text: 'O-1 was checked and refunded.' });
      }
    });
    const env = makeEnv();

    const outcome = await createOrchestratorWorkersStrategy().run(makeCtx(env));

    expect(outcome.subagentCount).toBe(2);
    const workers = sessions().filter((s) => s.prompt.includes('<your_assignment>'));
    expect(workers).toHaveLength(2);
    for (const worker of workers) {
      expect(worker.mcpServers).toEqual([{ name: 'shop', status: 'connected' }]);
    }
    expect(env.journal.map((entry) => entry.name).sort()).toEqual(['get_order', 'refund']);
    const synthesizer = sessions().at(-1);
    expect(synthesizer?.tools).toEqual([]);
    expect(outcome.finalText).toBe('O-1 was checked and refunded.');
  });
});

describe('plan-execute through the real runQuery', () => {
  it('hands the executor the plan the planner wrote', async () => {
    setScript(async function* (session) {
      if (session.prompt.includes('You are the planning step')) {
        yield* answerWith(session, {
          steps: ['Read order O-1', 'Refund it if eligible'],
          rationale: 'policy requires reading first',
        });
      } else {
        yield* useTool(session, 'mcp__shop__refund', 'O-1', 'Refunded O-1.');
      }
    });

    const outcome = await createPlanExecuteStrategy().run(makeCtx(makeEnv()));

    const executor = sessions().at(-1);
    expect(executor?.prompt).toContain('1. Read order O-1');
    expect(executor?.prompt).toContain('2. Refund it if eligible');
    expect(outcome.phases.find((p) => p.phase === 'plan')?.subtype).toBe('success');
  });
});
