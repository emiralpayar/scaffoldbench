import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@anthropic-ai/claude-agent-sdk')>();
  const fake = await import('../../core/test/support/fakeClaudeCode');
  return { ...actual, query: fake.fakeQuery };
});

import {
  BudgetTracker,
  HARNESS_CHECK,
  STRUCTURED_OUTPUT_TOOL,
  TraceCollector,
  createJournaledToolServer,
  harnessChecks,
} from '@scaffoldbench/core';
import type {
  BudgetStopReason,
  IntegrityCheck,
  RunContext,
  Strategy,
  StrategyOutcome,
  Task,
  TaskEnvironment,
  ToolCall,
} from '@scaffoldbench/core';
import {
  EXECUTOR_BUDGET_SHARE,
  createGatedExecuteStrategy,
  createProposeSelectStrategy,
  createOrchestratorWorkersStrategy,
  createPlanExecuteStrategy,
  createPlanExecuteVerifyStrategy,
  createSingleStrategy,
} from '@scaffoldbench/strategies';
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
  type ToolOutcome,
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

function makeEnv(options: { leaky?: boolean } = {}): TaskEnvironment & { journal: ToolCall[] } {
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
    // A leaky environment ignores the filter and shows every phase every
    // tool: what the fidelity checks must catch.
    createMcpServers: options.leaky ? () => server.createMcpServers() : server.createMcpServers,
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

/** A strategy's fidelity checks on a run it just made, read from the run's own trace. */
function fidelityOf(
  strategy: Strategy,
  ctx: RunContext,
  outcome: StrategyOutcome,
  stoppedBy?: BudgetStopReason,
): IntegrityCheck[] {
  return (
    strategy.fidelityChecks?.({
      task: ctx.task,
      env: ctx.env,
      outcome,
      trace: ctx.trace.events,
      ...(stoppedBy ? { stoppedBy } : {}),
    }) ?? []
  );
}

/** Every check, the runner's own and the strategy's, that did not pass. */
function failures(strategy: Strategy, ctx: RunContext, outcome: StrategyOutcome): IntegrityCheck[] {
  return [
    ...harnessChecks({ trace: ctx.trace.events, phases: outcome.phases }),
    ...fidelityOf(strategy, ctx, outcome),
  ].filter((check) => !check.ok);
}

function checkNamed(checks: IntegrityCheck[], id: string): IntegrityCheck {
  const found = checks.find((check) => check.id === id);
  if (!found) throw new Error(`no check ${id} in [${checks.map((c) => c.id).join(', ')}]`);
  return found;
}

/** A schema phase whose model answers in prose and never calls StructuredOutput. */
async function* proseOnly(text: string) {
  yield assistant(text);
  yield success({ text, costUsd: 0.01 });
}

afterEach(() => resetFake());

describe('propose-select through the real runQuery', () => {
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
    const strategy = createProposeSelectStrategy();

    const outcome = await strategy.run(ctx);

    expect(failures(strategy, ctx, outcome)).toEqual([]);
    expect(checkNamed(fidelityOf(strategy, ctx, outcome), 'propose-select.selection').detail).toBe(
      'proposal 2 chosen',
    );

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
    // Every proposer started before any of them finished: an ordering, not a
    // wall-clock bound, so a slow CI runner cannot fail it.
    const proposerPhases = outcome.phases.filter((p) => p.phase.startsWith('propose-'));
    const lastStart = Math.max(...proposerPhases.map((p) => p.startedAtMs));
    const firstEnd = Math.min(...proposerPhases.map((p) => p.startedAtMs + p.durationMs));
    expect(lastStart).toBeLessThanOrEqual(firstEnd);
  });

  it('fails fidelity when the selector never answers through the schema', async () => {
    setScript(async function* (session) {
      const proposer = /You are proposer (\d)/.exec(session.prompt)?.[1];
      if (proposer) {
        yield* useTool(session, 'mcp__shop__get_order', 'O-1', `proposal ${proposer}: refund O-1`);
      } else if (session.prompt.includes('You are the selector')) {
        yield* proseOnly('Proposal 2 is the strongest.');
      } else {
        yield* useTool(session, 'mcp__shop__refund', 'O-1', 'Refunded O-1.');
      }
    });
    const ctx = makeCtx(makeEnv());
    const strategy = createProposeSelectStrategy();

    const outcome = await strategy.run(ctx);

    // The run went on with proposal 1, and says so.
    expect(sessions().at(-1)?.prompt).toContain('proposal 1: refund O-1');
    expect(failures(strategy, ctx, outcome).map((check) => check.id)).toEqual([
      HARNESS_CHECK.structuredOutput,
      HARNESS_CHECK.notDegraded,
      'propose-select.selection',
    ]);
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
    const ctx = makeCtx(env);
    const strategy = createOrchestratorWorkersStrategy();

    const outcome = await strategy.run(ctx);

    expect(failures(strategy, ctx, outcome)).toEqual([]);
    expect(checkNamed(fidelityOf(strategy, ctx, outcome), 'orchestrator-workers.fan-out').detail).toBe(
      '2 workers ran in parallel',
    );
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
    // The workers ran side by side, and their records say so.
    const starts = outcome.phases.filter((p) => p.phase.startsWith('worker-')).map((p) => p.startedAtMs);
    expect(Math.max(...starts) - Math.min(...starts)).toBeLessThan(10);
  });

  it('passes fidelity when the orchestrator chooses not to split the task', async () => {
    setScript(async function* (session) {
      if (session.prompt.includes('split the work only')) {
        yield* answerWith(session, { subtasks: [{ id: 'all', goal: 'Check and refund O-1.' }] });
      } else if (session.prompt.includes('<your_assignment>')) {
        yield* useTool(session, 'mcp__shop__refund', 'O-1', 'Refunded O-1.');
      } else {
        yield assistant('Refunded O-1.');
        yield success({ text: 'Refunded O-1.' });
      }
    });
    const ctx = makeCtx(makeEnv());
    const strategy = createOrchestratorWorkersStrategy();

    const outcome = await strategy.run(ctx);

    expect(failures(strategy, ctx, outcome)).toEqual([]);
    expect(checkNamed(fidelityOf(strategy, ctx, outcome), 'orchestrator-workers.fan-out').detail).toBe(
      'one worker on the whole task, as the orchestrator chose',
    );
  });

  it('fails fidelity when the decomposition never comes through the schema', async () => {
    setScript(async function* (session) {
      if (session.prompt.includes('split the work only')) {
        yield* proseOnly('I would split this into checking and refunding.');
      } else if (session.prompt.includes('<your_assignment>')) {
        yield* useTool(session, 'mcp__shop__refund', 'O-1', 'Refunded O-1.');
      } else {
        yield assistant('Refunded O-1.');
        yield success({ text: 'Refunded O-1.' });
      }
    });
    const ctx = makeCtx(makeEnv());
    const strategy = createOrchestratorWorkersStrategy();

    const outcome = await strategy.run(ctx);

    expect(failures(strategy, ctx, outcome).map((check) => check.id)).toEqual([
      HARNESS_CHECK.structuredOutput,
      HARNESS_CHECK.notDegraded,
      'orchestrator-workers.decomposition',
    ]);
    expect(checkNamed(fidelityOf(strategy, ctx, outcome), 'orchestrator-workers.decomposition').detail).toBe(
      'the decomposition could not be read; one worker was given the whole task',
    );
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

    const ctx = makeCtx(makeEnv());
    const strategy = createPlanExecuteStrategy();

    const outcome = await strategy.run(ctx);

    const executor = sessions().at(-1);
    expect(executor?.prompt).toContain('1. Read order O-1');
    expect(executor?.prompt).toContain('2. Refund it if eligible');
    expect(outcome.phases.find((p) => p.phase === 'plan')?.subtype).toBe('success');
    expect(failures(strategy, ctx, outcome)).toEqual([]);
    expect(checkNamed(fidelityOf(strategy, ctx, outcome), 'plan-execute.plan').detail).toBe(
      'a 2-step plan, read from the schema reply',
    );
  });

  it('fails fidelity when the planner answers in prose instead of through the schema', async () => {
    setScript(async function* (session) {
      if (session.prompt.includes('You are the planning step')) {
        yield* proseOnly('Read the order, then refund it.');
      } else {
        yield* useTool(session, 'mcp__shop__refund', 'O-1', 'Refunded O-1.');
      }
    });
    const ctx = makeCtx(makeEnv());
    const strategy = createPlanExecuteStrategy();

    const outcome = await strategy.run(ctx);

    // The executor still got the plan as written…
    expect(sessions().at(-1)?.prompt).toContain('Read the order, then refund it.');
    // …but the run says plainly that the architecture did not run as designed.
    expect(failures(strategy, ctx, outcome).map((check) => check.id)).toEqual([
      HARNESS_CHECK.structuredOutput,
      HARNESS_CHECK.notDegraded,
      'plan-execute.plan',
    ]);
  });

  it('fails fidelity when a phase is shown tools the architecture does not give it', async () => {
    setScript(async function* (session) {
      if (session.prompt.includes('You are the planning step')) {
        yield* answerWith(session, { steps: ['Refund O-1'], rationale: 'r' });
      } else {
        yield* useTool(session, 'mcp__shop__refund', 'O-1', 'Refunded O-1.');
      }
    });
    const ctx = makeCtx(makeEnv({ leaky: true }));
    const strategy = createPlanExecuteStrategy();

    const outcome = await strategy.run(ctx);

    expect(checkNamed(fidelityOf(strategy, ctx, outcome), 'plan-execute.tools')).toEqual({
      id: 'plan-execute.tools',
      ok: false,
      detail: 'the planner (plan) was also shown get_order, refund',
    });
  });

  it('excuses a plan the run’s limits cut short', async () => {
    setScript(async function* (session) {
      yield assistant('thinking…');
      await session.untilAborted();
    });
    const controller = new AbortController();
    const ctx = { ...makeCtx(makeEnv()), signal: controller.signal };
    const strategy = createPlanExecuteStrategy();

    const running = strategy.run(ctx);
    await sleep(5);
    controller.abort();
    const outcome = await running;

    expect(outcome.phases.map((p) => [p.phase, p.subtype])).toEqual([['plan', 'aborted']]);
    expect(checkNamed(fidelityOf(strategy, ctx, outcome, 'wallclock'), 'plan-execute.plan')).toMatchObject({
      ok: true,
      detail: 'the plan was cut short (aborted), so it is not judged',
    });
  });
});

describe('single through the real runQuery', () => {
  it('passes fidelity holding the whole toolset', async () => {
    setScript(async function* (session) {
      yield* useTool(session, 'mcp__shop__refund', 'O-1', 'Refunded O-1.');
    });
    const ctx = makeCtx(makeEnv());
    const strategy = createSingleStrategy();

    const outcome = await strategy.run(ctx);

    expect(outcome.finalText).toBe('Refunded O-1.');
    expect(failures(strategy, ctx, outcome)).toEqual([]);
    expect(sessions()[0]?.tools).toEqual(['mcp__shop__get_order', 'mcp__shop__refund']);
  });

  it('records a model that refused on its phase, as the run’s own ending, not a lapse of fidelity', async () => {
    const notice = "API Error: Haiku 4.5's safeguards flagged this message.";
    setScript(async function* () {
      yield {
        type: 'assistant',
        parent_tool_use_id: null,
        error: 'invalid_request',
        message: {
          id: 'msg_refusal',
          model: '<synthetic>',
          content: [{ type: 'text', text: notice }],
          stop_reason: 'refusal',
          stop_details: { type: 'refusal', category: 'cyber', explanation: null },
          usage: {},
        },
      };
      yield success({ text: notice, isError: true, costUsd: 0.002 });
    });
    const ctx = makeCtx(makeEnv());
    const strategy = createSingleStrategy();

    const outcome = await strategy.run(ctx);

    expect(outcome.phases[0]?.modelStop).toMatchObject({ reason: 'refusal', category: 'cyber' });
    expect(outcome.phases[0]?.apiError).toBeUndefined();
    expect(failures(strategy, ctx, outcome)).toEqual([]);
  });
});

describe('plan-execute-verify through the real runQuery', () => {
  const PLAN = { steps: ['Read order O-1', 'Refund it'], rationale: 'read before acting' };
  const APPROVE = { approved: true, issues: [], severity: 'none' };
  const REJECT = { approved: false, issues: ['O-1 was never refunded'], severity: 'blocking' };

  /** A run whose verifiers answer, in turn, with `verdicts`; `null` answers in prose only. */
  function script(verdicts: (Record<string, unknown> | null)[]) {
    let verifier = 0;
    setScript(async function* (session) {
      if (session.prompt.includes('You are the planning step')) {
        yield* answerWith(session, PLAN);
      } else if (session.prompt.includes('You are the verifier')) {
        const verdict = verifier < verdicts.length ? verdicts[verifier] : APPROVE;
        verifier += 1;
        const read = await session.callTool('mcp__shop__get_order', { id: 'O-1' });
        yield toolUse('mcp__shop__get_order', { id: 'O-1' });
        yield toolResult(read);
        yield* verdict === null ? proseOnly('Looks fine to me, I think.') : answerWith(session, verdict);
      } else if (session.prompt.includes('<issues_found>')) {
        yield* useTool(session, 'mcp__shop__refund', 'O-1', 'Refunded O-1 after review.');
      } else {
        yield assistant('Checked O-1; nothing to do.');
        yield success({ text: 'Checked O-1; nothing to do.' });
      }
    });
  }

  it('verifies against state through the schema and approves', async () => {
    script([APPROVE]);
    const ctx = makeCtx(makeEnv());
    const strategy = createPlanExecuteVerifyStrategy();

    const outcome = await strategy.run(ctx);

    expect(outcome.phases.map((p) => p.phase)).toEqual(['plan', 'execute', 'verify-1']);
    const verifier = sessions().find((s) => s.prompt.includes('You are the verifier'));
    // Read-only tools and the structured-output tool, nothing that mutates.
    expect(verifier?.tools).toEqual([STRUCTURED_OUTPUT_TOOL, 'mcp__shop__get_order']);
    expect(failures(strategy, ctx, outcome)).toEqual([]);
  });

  it('sends a rejected execution back for revision, then verifies the revision', async () => {
    script([REJECT, APPROVE]);
    const env = makeEnv();
    const ctx = makeCtx(env);
    const strategy = createPlanExecuteVerifyStrategy();

    const outcome = await strategy.run(ctx);

    expect(outcome.phases.map((p) => p.phase)).toEqual(['plan', 'execute', 'verify-1', 'revise-1', 'verify-2']);
    expect(env.journal.filter((entry) => entry.name === 'refund')).toHaveLength(1);
    expect(outcome.finalText).toBe('Refunded O-1 after review.');
    expect(failures(strategy, ctx, outcome)).toEqual([]);
    expect(checkNamed(fidelityOf(strategy, ctx, outcome), 'plan-execute-verify.loop').detail).toBe(
      '1 revision, each called for by a verdict',
    );
  });

  it('recovers a verdict the verifier gave in prose by asking once more', async () => {
    script([null, REJECT, APPROVE]);
    const ctx = makeCtx(makeEnv());
    const strategy = createPlanExecuteVerifyStrategy();

    const outcome = await strategy.run(ctx);

    expect(outcome.phases.map((p) => p.phase)).toEqual([
      'plan',
      'execute',
      'verify-1',
      'verify-1-retry',
      'revise-1',
      'verify-2',
    ]);
    // The miss was recovered, so neither the harness nor the strategy objects.
    expect(failures(strategy, ctx, outcome)).toEqual([]);
  });

  it('fails integrity, never approving, when no verdict can be read even on the retry', async () => {
    script([null, null]);
    const env = makeEnv();
    const ctx = makeCtx(env);
    const strategy = createPlanExecuteVerifyStrategy();

    const outcome = await strategy.run(ctx);

    expect(outcome.phases.map((p) => p.phase)).toEqual(['plan', 'execute', 'verify-1', 'verify-1-retry']);
    expect(failures(strategy, ctx, outcome).map((check) => check.id)).toEqual([
      HARNESS_CHECK.structuredOutput,
      HARNESS_CHECK.notDegraded,
      'plan-execute-verify.verdicts',
    ]);
  });
});

describe('gated-execute through the real runQuery', () => {
  /** The reviewer answers each review with the next of `decisions`; `null` answers in prose only. */
  function reviewerSays(decisions: ({ decision: 'allow' | 'deny'; reason: string } | null)[]) {
    let review = 0;
    return async function* (session: FakeSession) {
      const decision = review < decisions.length ? decisions[review] : { decision: 'allow', reason: 'fine' };
      review += 1;
      const read = await session.callTool('mcp__shop__get_order', { id: 'O-1' });
      yield toolUse('mcp__shop__get_order', { id: 'O-1' });
      yield toolResult(read);
      yield* decision === null ? proseOnly('I suppose it is fine.') : answerWith(session, decision);
    };
  }

  it('reviews a change of state before it runs, and lets reads straight through', async () => {
    const reviewer = reviewerSays([{ decision: 'allow', reason: 'O-1 is paid and eligible.' }]);
    setScript(async function* (session) {
      if (session.prompt.includes('You are the action reviewer')) {
        yield* reviewer(session);
        return;
      }
      const read = await session.callTool('mcp__shop__get_order', { id: 'O-1' });
      yield toolUse('mcp__shop__get_order', { id: 'O-1' });
      yield toolResult(read);
      yield* useTool(session, 'mcp__shop__refund', 'O-1', 'Refunded O-1.');
    });
    const env = makeEnv();
    const ctx = makeCtx(env);
    const strategy = createGatedExecuteStrategy();

    const outcome = await strategy.run(ctx);

    // One review, for the refund; the executor's read was not reviewed.
    expect(outcome.phases.map((p) => p.phase)).toEqual(['execute', 'review-1']);
    expect(env.journal.map((entry) => entry.name)).toEqual(['get_order', 'get_order', 'refund']);
    expect(outcome.phases[1]?.meta).toEqual({
      tool: 'mcp__shop__refund',
      toolUseId: 'toolu_mcp__shop__refund',
      decision: 'allow',
      source: 'schema',
      reason: 'O-1 is paid and eligible.',
    });
    expect(outcome.subagentCount).toBe(1);
    expect(outcome.finalText).toBe('Refunded O-1.');

    const [executor, reviewSession] = sessions();
    expect(executor?.options.maxBudgetUsd).toBeCloseTo(0.9 * EXECUTOR_BUDGET_SHARE, 10);
    expect(reviewSession?.prompt).toContain('tool: refund\ninput: {"id":"O-1"}');
    expect(reviewSession?.tools).toEqual([STRUCTURED_OUTPUT_TOOL, 'mcp__shop__get_order']);
    // The reviewer's cost is the run's cost.
    expect(ctx.budget.spentUsd).toBeCloseTo(0.02, 10);
    expect(failures(strategy, ctx, outcome)).toEqual([]);
  });

  it('hands a denial back to the executor as the tool’s result, so it can adapt', async () => {
    const reviewer = reviewerSays([
      { decision: 'deny', reason: 'O-1 was paid by voucher; refund to the voucher, not the card.' },
      { decision: 'allow', reason: 'Voucher refund is correct.' },
    ]);
    const seen: string[] = [];
    setScript(async function* (session) {
      if (session.prompt.includes('You are the action reviewer')) {
        yield* reviewer(session);
        return;
      }
      const first = await session.callTool('mcp__shop__refund', { id: 'O-1' });
      yield toolUse('mcp__shop__refund', { id: 'O-1' });
      yield toolResult(first);
      seen.push(first.text);
      yield* useTool(session, 'mcp__shop__refund', 'O-1-voucher', 'Refunded O-1 to the voucher.');
    });
    const env = makeEnv();
    const ctx = makeCtx(env);
    const strategy = createGatedExecuteStrategy();

    const outcome = await strategy.run(ctx);

    expect(seen).toEqual([
      'Denied by the action reviewer: O-1 was paid by voucher; refund to the voucher, not the card. ' +
        'Nothing was changed.',
    ]);
    // Only the allowed refund reached the world.
    expect(env.journal.filter((entry) => entry.name === 'refund').map((entry) => entry.args)).toEqual([
      { id: 'O-1-voucher' },
    ]);
    expect(outcome.phases.map((p) => [p.phase, p.meta?.decision])).toEqual([
      ['execute', undefined],
      ['review-1', 'deny'],
      ['review-2', 'allow'],
    ]);
    // The second reviewer knows what the first decided.
    expect(sessions()[2]?.prompt).toContain('denied refund {"id":"O-1"} — O-1 was paid by voucher');
    // A review denial is the architecture's decision, not a sandbox violation.
    expect(ctx.trace.events.some((e) => e.kind === 'tool_denied')).toBe(false);
    expect(failures(strategy, ctx, outcome)).toEqual([]);
  });

  it('denies an action whose review gives no readable decision, and fails integrity', async () => {
    const reviewer = reviewerSays([null]);
    setScript(async function* (session) {
      if (session.prompt.includes('You are the action reviewer')) {
        yield* reviewer(session);
        return;
      }
      yield* useTool(session, 'mcp__shop__refund', 'O-1', 'Could not refund O-1.');
    });
    const env = makeEnv();
    const ctx = makeCtx(env);
    const strategy = createGatedExecuteStrategy();

    const outcome = await strategy.run(ctx);

    expect(env.journal.some((entry) => entry.name === 'refund')).toBe(false);
    expect(outcome.phases[1]?.degraded).toBe('no decision could be read; the action was denied unreviewed');
    expect(failures(strategy, ctx, outcome).map((check) => check.id)).toEqual([
      HARNESS_CHECK.structuredOutput,
      HARNESS_CHECK.notDegraded,
      'gated-execute.decisions',
    ]);
  });

  it('would catch a change of state that ran without a review', async () => {
    // A single agent is exactly that: the gated checks applied to its run.
    setScript(async function* (session) {
      yield* useTool(session, 'mcp__shop__refund', 'O-1', 'Refunded O-1.');
    });
    const ctx = makeCtx(makeEnv());
    const outcome = await createSingleStrategy().run(ctx);

    const checks = createGatedExecuteStrategy().fidelityChecks?.({
      task: ctx.task,
      env: ctx.env,
      outcome,
      trace: ctx.trace.events,
    });
    expect(checks?.find((check) => check.id === 'gated-execute.reviewed')).toEqual({
      id: 'gated-execute.reviewed',
      ok: false,
      detail: 'refund ran 1 time, 0 allowed by a review',
    });
  });

  it('runs as a single agent, on the whole budget, when nothing can change state', async () => {
    setScript(async function* (session) {
      yield* useTool(session, 'mcp__shop__get_order', 'O-1', 'O-1 is paid.');
    });
    const env = { ...makeEnv() };
    env.allowedTools = [...env.readOnlyTools];
    const ctx = makeCtx(env);
    const strategy = createGatedExecuteStrategy();

    const outcome = await strategy.run(ctx);

    expect(outcome.phases.map((p) => p.phase)).toEqual(['execute']);
    expect(sessions()[0]?.options.maxBudgetUsd).toBeCloseTo(0.9, 10);
    expect(sessions()[0]?.prompt).not.toContain('reviewer');
    expect(failures(strategy, ctx, outcome)).toEqual([]);
  });
});

describe('a call that fails at the API', () => {
  /** A session the API turns away: the CLI's stand-in message, then an error "success". */
  async function* overloaded() {
    const text = 'Repeated 529 Overloaded errors';
    yield assistant(text, { model: '<synthetic>', error: 'overloaded', usage: {} });
    yield success({ text, isError: true, costUsd: 0 });
  }

  /** Every check the run failed, the runner's and the strategy's. */
  function failedIds(strategy: Strategy, ctx: RunContext, outcome: StrategyOutcome): string[] {
    return failures(strategy, ctx, outcome).map((check) => check.id);
  }

  it('halts the run: the siblings in flight are aborted and nothing more is started', async () => {
    setScript(async function* (session) {
      if (session.prompt.includes('You are proposer 2')) {
        yield* overloaded();
        return;
      }
      // Proposers 1 and 3 are still investigating when proposer 2 fails.
      yield assistant('Looking at the order first.');
      await session.untilAborted();
    });
    const ctx = makeCtx(makeEnv());
    const strategy = createProposeSelectStrategy();

    const outcome = await strategy.run(ctx);

    // No selector and no executor were paid for a run that cannot be ranked.
    expect(sessions()).toHaveLength(3);
    expect(outcome.phases.map((p) => [p.phase, p.subtype])).toEqual([
      ['propose-1', 'aborted'],
      ['propose-2', 'success'],
      ['propose-3', 'aborted'],
    ]);
    expect(outcome.phases[1]?.apiError?.kind).toBe('overloaded');
    // The run is an API failure, and only that: the architecture is not
    // blamed for the phases the failure kept from running.
    expect(failedIds(strategy, ctx, outcome)).toEqual([HARNESS_CHECK.api]);
  });

  it('starts no later phase after a sequential phase fails', async () => {
    setScript(async function* (session) {
      if (session.prompt.includes('split the work only')) {
        yield* overloaded();
        return;
      }
      yield* useTool(session, 'mcp__shop__refund', 'O-1', 'Refunded O-1.');
    });
    const ctx = makeCtx(makeEnv());
    const strategy = createOrchestratorWorkersStrategy();

    const outcome = await strategy.run(ctx);

    expect(outcome.phases.map((p) => p.phase)).toEqual(['decompose']);
    expect(sessions()).toHaveLength(1);
    expect(failedIds(strategy, ctx, outcome)).toEqual([HARNESS_CHECK.api]);
  });

  it('stops an executor whose review failed, and denies the action unreviewed', async () => {
    let refund: ToolOutcome | undefined;
    setScript(async function* (session) {
      if (session.prompt.includes('You are the action reviewer')) {
        yield* overloaded();
        return;
      }
      refund = await session.callTool('mcp__shop__refund', { id: 'O-1' });
      yield toolUse('mcp__shop__refund', { id: 'O-1' });
      yield toolResult(refund);
      // The executor would carry on here; the halt ends it instead.
      await session.untilAborted();
    });
    const env = makeEnv();
    const ctx = makeCtx(env);
    const strategy = createGatedExecuteStrategy();

    const outcome = await strategy.run(ctx);

    expect(refund?.denied).toBe(true);
    expect(env.journal).toEqual([]);
    expect(outcome.phases.map((p) => [p.phase, p.subtype])).toEqual([
      ['execute', 'aborted'],
      ['review-1', 'success'],
    ]);
    expect(failedIds(strategy, ctx, outcome)).toEqual([HARNESS_CHECK.api]);
  });
});
