import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@anthropic-ai/claude-agent-sdk')>();
  const fake = await import('./support/fakeClaudeCode');
  return { ...actual, query: fake.fakeQuery };
});

import {
  BudgetTracker,
  SCHEMA_MIN_TURNS,
  STRUCTURED_OUTPUT_TOOL,
  TraceCollector,
  createJournaledToolServer,
  runQuery,
} from '@arena/core';
import type { RunContext, Task, TaskEnvironment, ToolCall } from '@arena/core';
import {
  assistant,
  errorResult,
  resetFake,
  sessions,
  setScript,
  sleep,
  success,
  toolResult,
  toolUse,
} from './support/fakeClaudeCode';

/**
 * `runQuery` driven end to end against a scripted SDK.
 *
 * Every test here goes through the real `runQuery`, the real sandbox guard and
 * real MCP server instances; only the model is scripted. Each one pins a
 * failure that shipped in the first published run set or would have shipped
 * with it: a harness that denied its own structured-output tool, parallel
 * phases left without tools, API errors graded as answers, aborted calls
 * charged nothing, budgets overspent by concurrent calls, and usage or text
 * borrowed from a sibling call.
 */

const MODEL = 'claude-haiku-4-5-20251001';
const PLAN = { steps: ['look up the order', 'refund it'], rationale: 'refund policy allows it' };
const PLAN_SCHEMA = {
  type: 'object',
  properties: { steps: { type: 'array', items: { type: 'string' } }, rationale: { type: 'string' } },
  required: ['steps', 'rationale'],
};

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
        handler: (args: { id: string }) => `order ${args.id}: paid`,
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

function makeCtx(
  options: { maxCostUsd?: number; signal?: AbortSignal; env?: TaskEnvironment } = {},
): RunContext {
  return {
    runId: 'run-1',
    task: { maxTurns: 6 } as Task,
    strategyId: 'test',
    model: MODEL,
    effort: 'low',
    env: options.env ?? makeEnv(),
    cwd: '/tmp',
    signal: options.signal ?? new AbortController().signal,
    budget: new BudgetTracker({ maxCostUsd: options.maxCostUsd ?? 1, maxWallClockMs: 60_000 }),
    trace: new TraceCollector(),
    systemPrompt: 'You are under test.',
  };
}

afterEach(() => resetFake());

describe('structured output', () => {
  it('lets a tool-less schema phase answer through the StructuredOutput tool', async () => {
    setScript(async function* (session) {
      const call = await session.callTool(STRUCTURED_OUTPUT_TOOL, PLAN);
      yield toolUse(STRUCTURED_OUTPUT_TOOL, PLAN);
      yield toolResult(call);
      if (call.denied) yield errorResult('error_max_turns', { errors: ['denied'] });
      else yield success({ structured: PLAN });
    });
    const ctx = makeCtx();

    const outcome = await runQuery(ctx, {
      phase: 'plan',
      prompt: 'plan it',
      allowedTools: [],
      outputSchema: PLAN_SCHEMA,
      maxTurns: 1,
    });

    expect(outcome.structured).toEqual(PLAN);
    expect(outcome.structuredMissing).toBe(false);
    expect(outcome.deniedToolCalls).toBe(0);
    expect(ctx.trace.events.some((e) => e.kind === 'tool_denied')).toBe(false);
    // The structured reply is the answer, not a tool call against the task.
    expect(outcome.toolCalls).toBe(0);

    const { options, tools } = sessions()[0]!;
    expect(options.allowedTools).toEqual([STRUCTURED_OUTPUT_TOOL]);
    expect(options.tools).toEqual([STRUCTURED_OUTPUT_TOOL]);
    expect(tools).toEqual([STRUCTURED_OUTPUT_TOOL]);
    // Room to retry a reply that fails validation.
    expect(options.maxTurns).toBe(SCHEMA_MIN_TURNS);
  });

  it('flags a schema phase that came back without structured output', async () => {
    setScript(async function* () {
      yield assistant('Here is my plan in prose.');
      yield errorResult('error_max_turns');
    });

    const outcome = await runQuery(makeCtx(), {
      phase: 'plan',
      prompt: 'plan it',
      allowedTools: [],
      outputSchema: PLAN_SCHEMA,
    });

    expect(outcome.structured).toBeUndefined();
    expect(outcome.structuredMissing).toBe(true);
    expect(outcome.subtype).toBe('error_max_turns');
  });

  it('does not offer StructuredOutput to a phase without a schema', async () => {
    setScript(async function* (session) {
      const call = await session.callTool(STRUCTURED_OUTPUT_TOOL, {});
      yield toolUse(STRUCTURED_OUTPUT_TOOL, {});
      yield toolResult(call);
      yield success({ text: 'done' });
    });

    const outcome = await runQuery(makeCtx(), { phase: 'main', prompt: 'go' });

    expect(sessions()[0]!.options.allowedTools).not.toContain(STRUCTURED_OUTPUT_TOOL);
    expect(sessions()[0]!.tools).not.toContain(STRUCTURED_OUTPUT_TOOL);
    expect(outcome.deniedToolCalls).toBe(1);
    expect(outcome.structuredMissing).toBe(false);
  });
});

describe('MCP servers', () => {
  it('gives each concurrent call its own connected server over one shared world', async () => {
    setScript(async function* (session) {
      const call = await session.callTool('mcp__shop__get_order', { id: session.prompt });
      yield toolUse('mcp__shop__get_order', { id: session.prompt });
      yield toolResult(call);
      await sleep(15); // keep both sessions open at once
      yield success({ text: call.text });
    });
    const ctx = makeCtx();
    const maxBudgetUsd = ctx.budget.availableUsd / 3;

    const outcomes = await Promise.all(
      ['A', 'B', 'C'].map((id) => runQuery(ctx, { phase: `worker-${id}`, prompt: id, maxBudgetUsd })),
    );

    for (const outcome of outcomes) {
      expect(outcome.mcpServers).toEqual([{ name: 'shop', status: 'connected' }]);
      expect(outcome.mcpServersExpected).toEqual(['shop']);
    }
    expect(outcomes.map((o) => o.text)).toEqual([
      'order A: paid',
      'order B: paid',
      'order C: paid',
    ]);
    // Three instances, one journal.
    const instances = sessions().map((s) => (s.options.mcpServers?.shop as { instance?: unknown }).instance);
    expect(new Set(instances).size).toBe(3);
    expect(ctx.env.journal.map((entry) => entry.args.id).sort()).toEqual(['A', 'B', 'C']);
  });

  it('would leave concurrent calls sharing one server instance without tools', async () => {
    // The fake connects servers the way the SDK does, so it reproduces the
    // failure the factory exists to prevent. Without this, the test above
    // could pass for the wrong reason.
    setScript(async function* () {
      await sleep(15);
      yield success({ text: 'done' });
    });
    const env = makeEnv();
    const shared = env.createMcpServers();
    const ctx = makeCtx({ env: { ...env, createMcpServers: () => shared } });

    const [first, second] = await Promise.all([
      runQuery(ctx, { phase: 'propose-1', prompt: '1', maxBudgetUsd: 0.5 }),
      runQuery(ctx, { phase: 'propose-2', prompt: '2', maxBudgetUsd: 0.5 }),
    ]);

    expect(first?.mcpServers).toEqual([{ name: 'shop', status: 'connected' }]);
    expect(second?.mcpServers).toEqual([{ name: 'shop', status: 'failed' }]);
    expect(sessions().find((s) => s.prompt === '2')?.tools).toEqual([]);
  });

  it('shows a tool-less phase no task tools at all', async () => {
    setScript(async function* () {
      yield success({ text: 'synthesis' });
    });

    const outcome = await runQuery(makeCtx(), { phase: 'synthesize', prompt: 's', allowedTools: [] });

    expect(sessions()[0]!.options.mcpServers).toEqual({});
    expect(sessions()[0]!.tools).toEqual([]);
    expect(outcome.mcpServersExpected).toEqual([]);
  });

  it('shows a read-only phase only the read-only tools', async () => {
    setScript(async function* (session) {
      const refund = await session.callTool('mcp__shop__refund', { id: 'A' });
      yield toolUse('mcp__shop__refund', { id: 'A' });
      yield toolResult(refund);
      yield success({ text: refund.text });
    });
    const ctx = makeCtx();

    await runQuery(ctx, { phase: 'verify', prompt: 'v', allowedTools: [...ctx.env.readOnlyTools] });

    expect(sessions()[0]!.tools).toEqual(['mcp__shop__get_order']);
    expect(ctx.env.journal).toEqual([]);
  });

  it('starts every call hermetically, with nothing but the harness’s own surface', async () => {
    setScript(async function* () {
      yield success({ text: 'ok' });
    });
    const ctx = makeCtx();

    await runQuery(ctx, { phase: 'main', prompt: 'go' });

    const { options } = sessions()[0]!;
    expect(options.strictMcpConfig).toBe(true);
    expect(options.settings).toEqual({ disableClaudeAiConnectors: true });
    expect(options.settingSources).toEqual([]);
    expect(options.permissionMode).toBe('dontAsk');
    expect(options.persistSession).toBe(false);
    expect(options.tools).toEqual([]);
    expect(Object.keys(options.mcpServers ?? {})).toEqual(['shop']);
    const end = ctx.trace.events.find((e) => e.kind === 'phase_end');
    expect(end?.meta?.mcpServers).toEqual([{ name: 'shop', status: 'connected' }]);
    expect(end?.meta?.mcpServersExpected).toEqual(['shop']);
  });

  it('runs nothing as a child of the Claude Code session the benchmark may run inside', async () => {
    // What a Claude Code session puts in the environment of what it starts.
    vi.stubEnv('CLAUDECODE', '1');
    vi.stubEnv('CLAUDE_CODE_ENTRYPOINT', 'cli');
    vi.stubEnv('CLAUDE_CODE_CHILD_SESSION', '1');
    vi.stubEnv('CLAUDE_CODE_MESSAGING_SOCKET', '/tmp/host.sock');
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-host');
    setScript(async function* () {
      yield success({ text: 'ok' });
    });
    const visitor = { PATH: '/usr/bin', ANTHROPIC_API_KEY: 'sk-ant-visitor', CLAUDECODE: '1' };

    try {
      await runQuery(makeCtx(), { phase: 'host', prompt: 'go' });
      await runQuery({ ...makeCtx(), subprocessEnv: visitor }, { phase: 'visitor', prompt: 'go' });
    } finally {
      vi.unstubAllEnvs();
    }

    const [host, visited] = sessions().map((s) => s.options.env ?? {});
    for (const name of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_CHILD_SESSION']) {
      expect(host).not.toHaveProperty(name);
    }
    expect(host).not.toHaveProperty('CLAUDE_CODE_MESSAGING_SOCKET');
    expect(host?.ANTHROPIC_API_KEY).toBe('sk-ant-host');
    expect(host?.PATH).toBe(process.env.PATH);
    expect(visited).toEqual({ PATH: '/usr/bin', ANTHROPIC_API_KEY: 'sk-ant-visitor' });
  });
});

describe('API errors', () => {
  const unsupported =
    'API Error: 400 {"type":"error","error":{"type":"invalid_request_error",' +
    '"message":"claude-haiku-4-5-20251001 does not support this model feature"}}';

  it('never lets an API error reported as success become the answer', async () => {
    setScript(async function* () {
      yield assistant(unsupported, { model: '<synthetic>', error: 'invalid_request' });
      yield success({ text: unsupported, isError: true, apiErrorStatus: 400 });
    });
    const ctx = makeCtx();

    const outcome = await runQuery(ctx, { phase: 'main', prompt: 'go' });

    expect(outcome.text).toBe('');
    expect(outcome.apiError).toMatchObject({ kind: 'invalid_request', retryable: false, status: 400 });
    expect(outcome.error).toMatch(/^API error \(invalid_request 400\)/);
    expect(ctx.trace.events.some((e) => e.kind === 'assistant_text')).toBe(false);
    expect(ctx.trace.events.some((e) => e.kind === 'error' && e.meta?.apiError)).toBe(true);
  });

  it('recognises the bare "API Error:" success an older SDK produced', async () => {
    setScript(async function* () {
      yield success({ text: unsupported });
    });

    const outcome = await runQuery(makeCtx(), { phase: 'main', prompt: 'go' });

    expect(outcome.text).toBe('');
    expect(outcome.apiError?.kind).toBe('invalid_request');
  });

  it.each([
    ['authentication_failed', 'Invalid API key · Please run /login', 'auth', false],
    ['rate_limit', 'API Error: Rate limit reached', 'rate_limit', true],
    ['overloaded', 'Repeated 529 Overloaded errors', 'overloaded', true],
    ['server_error', 'API Error: 500 Internal server error', 'server', true],
  ] as const)('classifies a %s failure', async (code, text, kind, retryable) => {
    setScript(async function* () {
      yield assistant(text, { model: '<synthetic>', error: code, usage: {} });
      yield success({ text, isError: true, costUsd: 0 });
    });

    const outcome = await runQuery(makeCtx(), { phase: 'main', prompt: 'go' });

    expect(outcome.text).toBe('');
    expect(outcome.apiError).toMatchObject({ kind, retryable });
  });

  it('treats a crashed session as an infrastructure failure', async () => {
    setScript(async function* () {
      yield assistant('Let me look.');
      throw new Error('Claude Code process exited with code 1');
    });

    const outcome = await runQuery(makeCtx(), { phase: 'main', prompt: 'go' });

    expect(outcome.subtype).toBe('crashed');
    expect(outcome.text).toBe('');
    expect(outcome.apiError).toMatchObject({ kind: 'unknown', retryable: true });
  });

  it('does not mistake an answer about rate limits for a rate limit', async () => {
    const answer = 'API clients should back off when they receive HTTP 429 (rate limit) responses.';
    setScript(async function* () {
      yield assistant(answer);
      yield success({ text: answer });
    });

    const outcome = await runQuery(makeCtx(), { phase: 'main', prompt: 'go' });

    expect(outcome.apiError).toBeUndefined();
    expect(outcome.text).toBe(answer);
  });

  it('does not blame the API for a turn the CLI carried on past a failed request', async () => {
    // A response cut off mid-stream is reported, then the CLI asks the model
    // to carry on and the turn goes on to end for a reason of its own.
    setScript(async function* () {
      yield assistant('API Error: Server error mid-response. The response above may be incomplete.', {
        model: '<synthetic>',
        error: 'server_error',
        usage: {},
      });
      yield assistant('Picking up where I left off.');
      yield errorResult('error_max_turns', { errors: ['Reached maximum number of turns (6)'] });
    });

    const outcome = await runQuery(makeCtx(), { phase: 'main', prompt: 'go' });

    expect(outcome.apiError).toBeUndefined();
    expect(outcome.subtype).toBe('error_max_turns');
    expect(outcome.text).toBe('Picking up where I left off.');
  });

  it('counts a model that ran out of room against the run, never as an API failure', async () => {
    // What the CLI streams once its own attempts to let the model carry on
    // have failed: the cut-off text, then its notice dressed as an API error,
    // then a result whose text is the notice.
    const notice =
      "API Error: Claude's response exceeded the 64000 output token maximum. To configure this " +
      'behavior, set the CLAUDE_CODE_MAX_OUTPUT_TOKENS environment variable.';
    setScript(async function* () {
      yield assistant('The first half of a very long answer', {
        usage: { input_tokens: 1_000, output_tokens: 64_000 },
      });
      yield assistant(notice, { model: '<synthetic>', error: 'max_output_tokens', usage: {} });
      yield success({ text: notice, isError: true, costUsd: 0.33 });
    });
    const ctx = makeCtx();

    const outcome = await runQuery(ctx, { phase: 'main', prompt: 'go' });

    expect(outcome.apiError).toBeUndefined();
    expect(outcome.text).toBe('The first half of a very long answer');
    expect(outcome.error).toMatch(/^output limit: Claude's response exceeded the 64000 output token maximum/);
    expect(outcome.costUsd).toBe(0.33);
    const spoken = ctx.trace.events.filter((e) => e.kind === 'assistant_text').map((e) => e.text);
    expect(spoken).toEqual(['The first half of a very long answer']);
    expect(outcome.modelStop?.reason).toBe('output_limit');
    expect(ctx.trace.events.find((e) => e.kind === 'phase_end')?.meta?.modelStop).toEqual({
      reason: 'output_limit',
    });
  });

  it('counts a context that no longer fits against the run, as the terminal reason says', async () => {
    setScript(async function* () {
      yield assistant('I have read eleven pages so far.', {
        usage: { input_tokens: 190_000, output_tokens: 50 },
      });
      yield assistant('Prompt is too long', { model: '<synthetic>', error: 'invalid_request', usage: {} });
      yield success({ text: 'Prompt is too long', isError: true, terminalReason: 'prompt_too_long' });
    });

    const outcome = await runQuery(makeCtx(), { phase: 'main', prompt: 'go' });

    expect(outcome.apiError).toBeUndefined();
    expect(outcome.modelStop).toEqual({ reason: 'context_limit', message: 'Prompt is too long' });
    expect(outcome.error).toBe('context limit: Prompt is too long');
    expect(outcome.text).toBe('I have read eleven pages so far.');
  });

  it('counts a refusal against the run, never as an API failure', async () => {
    const notice =
      "API Error: Haiku 4.5's safeguards flagged this message (https://www.anthropic.com/legal/aup).";
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
    const ctx = makeCtx();

    const outcome = await runQuery(ctx, { phase: 'main', prompt: 'go' });

    expect(outcome.apiError).toBeUndefined();
    expect(outcome.modelStop).toMatchObject({ reason: 'refusal', category: 'cyber' });
    expect(outcome.text).toBe('');
    expect(outcome.error).toMatch(/^refused: Haiku 4\.5's safeguards flagged this message/);
    expect(ctx.trace.events.find((e) => e.kind === 'phase_end')?.meta?.modelStop).toEqual({
      reason: 'refusal',
      category: 'cyber',
    });
  });

  it('does not blame the API for a call the run itself aborted', async () => {
    const parent = new AbortController();
    setScript(async function* (session) {
      setTimeout(() => parent.abort(), 5);
      yield assistant('API Error: Request was aborted.', { model: '<synthetic>', usage: {} });
      await session.untilAborted();
    });

    const outcome = await runQuery(makeCtx({ signal: parent.signal }), { phase: 'main', prompt: 'go' });

    expect(outcome.aborted).toBe(true);
    expect(outcome.subtype).toBe('aborted');
    expect(outcome.apiError).toBeUndefined();
  });
});

describe('cost of calls that never reported one', () => {
  it('charges an aborted call for the tokens it streamed', async () => {
    const parent = new AbortController();
    setScript(async function* (session) {
      yield assistant('working…', { usage: { input_tokens: 50_000, output_tokens: 5_000 } });
      setTimeout(() => parent.abort(), 5);
      await session.untilAborted();
    });
    const ctx = makeCtx({ signal: parent.signal });

    const outcome = await runQuery(ctx, { phase: 'main', prompt: 'go' });

    // Haiku 4.5 list price: $1 in, $5 out per million tokens.
    expect(outcome.aborted).toBe(true);
    expect(outcome.costEstimated).toBe(true);
    expect(outcome.costUsd).toBeCloseTo(0.05 + 0.025, 10);
    expect(ctx.budget.spentUsd).toBeCloseTo(0.075, 10);
    expect(ctx.budget.usage.inputTokens).toBe(50_000);
    expect(outcome.turns).toBe(1);
  });

  it('cuts a call off mid-stream at the run’s limit, names the limit and charges the call', async () => {
    let now = 0;
    setScript(async function* (session) {
      yield assistant('working…', { usage: { input_tokens: 10_000, output_tokens: 1_000 } });
      now = 61_000;
      yield assistant('still working…', { usage: { input_tokens: 10_000, output_tokens: 1_000 } });
      await session.untilAborted();
    });
    const ctx: RunContext = {
      ...makeCtx(),
      budget: new BudgetTracker({ maxCostUsd: 1, maxWallClockMs: 60_000, now: () => now }),
    };

    const outcome = await runQuery(ctx, { phase: 'main', prompt: 'go' });

    expect(outcome.aborted).toBe(true);
    expect(outcome.subtype).toBe('aborted');
    expect(outcome.error).toBe('aborted: run wallclock limit reached');
    expect(outcome.costEstimated).toBe(true);
    expect(outcome.costUsd).toBeCloseTo(2 * (0.01 + 0.005), 10);
  });

  it('charges a crashed call for the tokens it streamed', async () => {
    setScript(async function* () {
      yield assistant('working…', { usage: { input_tokens: 10_000, output_tokens: 0 } });
      throw new Error('socket hang up');
    });
    const ctx = makeCtx();

    const outcome = await runQuery(ctx, { phase: 'main', prompt: 'go' });

    expect(outcome.costEstimated).toBe(true);
    expect(ctx.budget.spentUsd).toBeCloseTo(0.01, 10);
    expect(outcome.apiError?.kind).toBe('server');
  });

  it('counts a response streamed in several messages once', async () => {
    const parent = new AbortController();
    setScript(async function* (session) {
      // One API response, delivered as one message per content block, with
      // usage that grows as it streams.
      yield assistant('first block', { id: 'msg_x', usage: { input_tokens: 1_000, output_tokens: 10 } });
      yield assistant('second block', { id: 'msg_x', usage: { input_tokens: 1_000, output_tokens: 400 } });
      setTimeout(() => parent.abort(), 5);
      await session.untilAborted();
    });

    const outcome = await runQuery(makeCtx({ signal: parent.signal }), { phase: 'main', prompt: 'go' });

    expect(outcome.usage).toMatchObject({ inputTokens: 1_000, outputTokens: 400 });
    expect(outcome.costUsd).toBeCloseTo((1_000 * 1 + 400 * 5) / 1e6, 10);
  });

  it('says so when a model has no known price instead of guessing', async () => {
    const parent = new AbortController();
    setScript(async function* (session) {
      yield assistant('…', { model: 'claude-unreleased-9', usage: { input_tokens: 1_000 } });
      setTimeout(() => parent.abort(), 5);
      await session.untilAborted();
    });

    const outcome = await runQuery(makeCtx({ signal: parent.signal }), { phase: 'main', prompt: 'go' });

    expect(outcome.costEstimated).toBe(true);
    expect(outcome.unpricedModels).toEqual(['claude-unreleased-9']);
    expect(outcome.costUsd).toBe(0);
    expect(outcome.usage.inputTokens).toBe(1_000);
  });

  it('prefers the reported cost and keeps the per-model breakdown, helper models included', async () => {
    setScript(async function* () {
      yield assistant('done', { model: 'claude-opus-5-5' });
      yield success({
        text: 'done',
        costUsd: 0.4,
        modelUsage: {
          'claude-opus-5-5': { inputTokens: 50_000, outputTokens: 10_000, costUSD: 0.39 },
          'claude-haiku-4-5-20251001': { inputTokens: 5_000, outputTokens: 1_000, costUSD: 0.01 },
        },
      });
    });
    const ctx = makeCtx();

    const outcome = await runQuery(ctx, { phase: 'main', prompt: 'go', model: 'claude-opus-5-5' });

    expect(outcome.costEstimated).toBe(false);
    expect(outcome.costUsd).toBe(0.4);
    expect(Object.keys(outcome.byModel).sort()).toEqual(['claude-haiku-4-5-20251001', 'claude-opus-5-5']);
    expect(outcome.byModel['claude-haiku-4-5-20251001']?.costUsd).toBe(0.01);
    expect(outcome.usage).toMatchObject({ inputTokens: 55_000, outputTokens: 11_000 });
    expect(ctx.budget.usage.inputTokens).toBe(55_000);
  });
});

describe('budget leases', () => {
  it('never hands concurrent calls more than the run has left', async () => {
    // Each call spends its whole allowance, as a runaway call would. Before
    // leases every one of four workers was handed the full $0.75 and the run
    // spent $2.80 under a $0.75 cap.
    setScript(async function* (session) {
      await sleep(5);
      yield success({ text: 'ok', costUsd: session.options.maxBudgetUsd ?? 0 });
    });
    const ctx = makeCtx({ maxCostUsd: 0.75 });
    const share = ctx.budget.availableUsd / 4;

    const outcomes = await Promise.all(
      ['1', '2', '3', '4'].map((id) =>
        runQuery(ctx, { phase: `worker-${id}`, prompt: id, maxBudgetUsd: share }),
      ),
    );

    const leased = sessions().map((s) => s.options.maxBudgetUsd ?? 0);
    expect(leased).toHaveLength(4);
    for (const amount of leased) expect(amount).toBeCloseTo(0.1875, 10);
    expect(outcomes.map((o) => o.budgetUsd)).toEqual(leased);
    expect(ctx.budget.spentUsd).toBeCloseTo(0.75, 10);
  });

  it('gives a call without a share only what is not already reserved', async () => {
    setScript(async function* (session) {
      await sleep(5);
      yield success({ text: 'ok', costUsd: session.options.maxBudgetUsd ?? 0 });
    });
    const ctx = makeCtx({ maxCostUsd: 0.75 });

    const outcomes = await Promise.all(
      ['1', '2'].map((id) => runQuery(ctx, { phase: `worker-${id}`, prompt: id })),
    );

    // The first call reserved everything, so the second is skipped rather
    // than handed money the run does not have.
    expect(outcomes[0]?.budgetUsd).toBeCloseTo(0.75, 10);
    expect(outcomes[1]?.subtype).toBe('skipped');
    expect(sessions()).toHaveLength(1);
    expect(ctx.budget.spentUsd).toBeCloseTo(0.75, 10);
  });

  it('returns an unspent reservation once the call settles', async () => {
    setScript(async function* () {
      yield success({ text: 'ok', costUsd: 0.1 });
    });
    const ctx = makeCtx({ maxCostUsd: 0.75 });

    await runQuery(ctx, { phase: 'plan', prompt: 'p' });

    expect(ctx.budget.availableUsd).toBeCloseTo(0.65, 10);
  });

  it('closes the phase of a call it skips', async () => {
    const ctx = makeCtx({ maxCostUsd: 0.01 });

    const outcome = await runQuery(ctx, { phase: 'late', prompt: 'never' });

    expect(outcome.subtype).toBe('skipped');
    expect(ctx.trace.events.map((e) => e.kind)).toEqual(['phase_start', 'phase_end']);
  });
});

describe('phase-scoped accounting', () => {
  it('charges each call its own usage when results interleave', async () => {
    setScript(async function* (session) {
      if (session.prompt === 'A') {
        yield success({ text: 'A', usage: { input_tokens: 111 } });
        await sleep(30); // A's stream stays open while B's result lands
      } else {
        await sleep(10);
        yield success({ text: 'B', usage: { input_tokens: 999 } });
      }
    });
    const ctx = makeCtx();

    const [a, b] = await Promise.all([
      runQuery(ctx, { phase: 'propose-1', prompt: 'A', maxBudgetUsd: 0.5 }),
      runQuery(ctx, { phase: 'propose-2', prompt: 'B', maxBudgetUsd: 0.5 }),
    ]);

    expect(a?.usage.inputTokens).toBe(111);
    expect(b?.usage.inputTokens).toBe(999);
    expect(ctx.budget.usage.inputTokens).toBe(1_110);
  });

  it('does not charge a crashed call the previous phase’s usage', async () => {
    setScript(async function* (session) {
      if (session.prompt === 'plan') {
        yield success({ text: 'plan', usage: { input_tokens: 4_242 } });
      } else {
        throw new Error('subprocess crashed');
      }
    });
    const ctx = makeCtx();

    await runQuery(ctx, { phase: 'plan', prompt: 'plan' });
    await runQuery(ctx, { phase: 'execute', prompt: 'execute' });

    expect(ctx.budget.usage.inputTokens).toBe(4_242);
  });

  it('salvages a truncated call’s own last words', async () => {
    setScript(async function* () {
      yield assistant('first thought');
      yield assistant('the findings so far');
      yield errorResult('error_max_turns');
    });
    const ctx = makeCtx();

    const outcome = await runQuery(ctx, { phase: 'main', prompt: 'go' });

    expect(outcome.text).toBe('the findings so far');
    expect(ctx.trace.events.some((e) => e.kind === 'note' && /recovered/.test(e.text ?? ''))).toBe(true);
  });

  it('never salvages a sibling’s text', async () => {
    setScript(async function* (session) {
      if (session.prompt === '1') {
        await sleep(5);
        yield errorResult('error_max_turns');
        await sleep(30);
      } else {
        await sleep(15);
        yield assistant('PROPOSAL FROM PROPOSER 2');
        yield success({ text: 'PROPOSAL FROM PROPOSER 2' });
      }
    });
    const ctx = makeCtx();

    const [first, second] = await Promise.all([
      runQuery(ctx, { phase: 'propose-1', prompt: '1', maxBudgetUsd: 0.5 }),
      runQuery(ctx, { phase: 'propose-2', prompt: '2', maxBudgetUsd: 0.5 }),
    ]);

    expect(second?.text).toBe('PROPOSAL FROM PROPOSER 2');
    expect(first?.text).toBe('');
  });

  it('tags every event with the call that produced it', async () => {
    setScript(async function* (session) {
      const call = await session.callTool('mcp__shop__get_order', { id: session.prompt });
      yield toolUse('mcp__shop__get_order', { id: session.prompt });
      yield toolResult(call);
      await sleep(5);
      yield assistant(`answer ${session.prompt}`);
      yield success({ text: `answer ${session.prompt}` });
    });
    const ctx = makeCtx();

    const outcomes = await Promise.all(
      ['A', 'B'].map((id) => runQuery(ctx, { phase: `p-${id}`, prompt: id, maxBudgetUsd: 0.5 })),
    );

    expect(outcomes.map((o) => o.subtype)).toEqual(['success', 'success']);
    expect(new Set(outcomes.map((o) => o.callId)).size).toBe(2);
    for (const event of ctx.trace.events) expect(event.callId).toBeDefined();
    for (const outcome of outcomes) {
      const own = ctx.trace.events.filter((e) => e.callId === outcome.callId);
      expect(own[0]?.kind).toBe('phase_start');
      expect(own.at(-1)?.kind).toBe('phase_end');
      expect(new Set(own.map((e) => e.phase)).size).toBe(1);
    }
  });
});

describe('reviewed tool calls', () => {
  it('holds a call for a reviewer that may make a model call of its own', async () => {
    setScript(async function* (session) {
      if (session.prompt === 'review') {
        // The reviewer reads state, then answers through its schema.
        const read = await session.callTool('mcp__shop__get_order', { id: 'O-1' });
        yield toolUse('mcp__shop__get_order', { id: 'O-1' });
        yield toolResult(read);
        const verdict = { allow: false };
        const call = await session.callTool(STRUCTURED_OUTPUT_TOOL, verdict);
        yield toolUse(STRUCTURED_OUTPUT_TOOL, verdict);
        yield toolResult(call);
        yield success({ structured: verdict, costUsd: 0.02 });
        return;
      }
      const refund = await session.callTool('mcp__shop__refund', { id: 'O-1' });
      yield toolUse('mcp__shop__refund', { id: 'O-1' });
      yield toolResult(refund);
      yield assistant(refund.text);
      yield success({ text: refund.text, costUsd: 0.01 });
    });
    const env = makeEnv();
    const ctx = makeCtx({ env });
    const reviewed: string[] = [];

    const outcome = await runQuery(ctx, {
      phase: 'execute',
      prompt: 'refund O-1',
      maxBudgetUsd: 0.5,
      reviewToolCall: async (call, { signal }) => {
        reviewed.push(call.toolName);
        const review = await runQuery(
          { ...ctx, signal: AbortSignal.any([ctx.signal, signal]) },
          {
            phase: 'review-1',
            prompt: 'review',
            allowedTools: [...env.readOnlyTools],
            outputSchema: { type: 'object' },
            depth: 1,
          },
        );
        return (review.structured as { allow?: boolean } | undefined)?.allow === true
          ? { allow: true }
          : { allow: false, reason: 'Denied by the reviewer: O-1 was already refunded.' };
      },
    });

    // The reviewer's own read went through: it holds the read-only tools.
    // Its read is not sent for review, because it is a separate call.
    expect(reviewed).toEqual(['mcp__shop__refund']);
    expect(env.journal.map((entry) => entry.name)).toEqual(['get_order']);
    expect(outcome.text).toBe('Denied by the reviewer: O-1 was already refunded.');
    expect(outcome.deniedToolCalls).toBe(0);
    expect(ctx.trace.events.some((e) => e.kind === 'tool_denied')).toBe(false);
    // Both calls are charged to the run.
    expect(ctx.budget.spentUsd).toBeCloseTo(0.03, 10);
  });
});

describe('effort', () => {
  it('records the effort level the CLI applied, from a tool call or the end of the reply', async () => {
    setScript(async function* (session) {
      if (session.prompt === 'act') {
        const refund = await session.callTool('mcp__shop__refund', { id: 'O-1' });
        yield toolUse('mcp__shop__refund', { id: 'O-1' });
        yield toolResult(refund);
      }
      yield assistant('Done.');
      yield success({ text: 'Done.' });
    });
    const ctx = { ...makeCtx(), model: 'claude-sonnet-5-5' };

    const acting = await runQuery(ctx, { phase: 'execute', prompt: 'act' });
    const answering = await runQuery(ctx, { phase: 'answer', prompt: 'answer', allowedTools: [] });

    expect(sessions()[0]!.options.effort).toBe('low');
    expect(acting.effectiveEffort).toBe('low');
    expect(answering.effectiveEffort).toBe('low');
    const ends = ctx.trace.events.filter((e) => e.kind === 'phase_end');
    expect(ends.map((e) => e.meta?.effectiveEffort)).toEqual(['low', 'low']);
  });

  it('records that a model without effort support was sent none, whatever was asked', async () => {
    setScript(async function* () {
      yield assistant('Done.');
      yield success({ text: 'Done.' });
    });
    const ctx = makeCtx();

    const outcome = await runQuery(ctx, { phase: 'main', prompt: 'go' });

    expect(ctx.model).toContain('haiku');
    expect(ctx.effort).toBe('low');
    expect(outcome.effectiveEffort).toBeNull();
    expect(ctx.trace.events.find((e) => e.kind === 'phase_end')?.meta?.effectiveEffort).toBeNull();
  });

  it('claims no level for a call that never got a reply to report one', async () => {
    setScript(async function* () {
      yield assistant('API Error: 529 Overloaded', { model: '<synthetic>', error: 'overloaded', usage: {} });
      yield success({ text: 'API Error: 529 Overloaded', isError: true });
    });
    const ctx = { ...makeCtx(), model: 'claude-sonnet-5-5' };

    const outcome = await runQuery(ctx, { phase: 'main', prompt: 'go' });

    expect(outcome.apiError?.kind).toBe('overloaded');
    expect(outcome).not.toHaveProperty('effectiveEffort');
    expect(ctx.trace.events.find((e) => e.kind === 'phase_end')?.meta).not.toHaveProperty('effectiveEffort');
  });
});
