import { describe, expect, it } from 'vitest';
import { TraceCollector, normalizeSdkMessage, truncate } from '@arena/core';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

/**
 * The normalizer is deliberately permissive: the SDK's message union has 30+
 * members and grows between releases, so these tests pin the shapes we depend
 * on and prove that everything else is skipped rather than throwing.
 */
const asMessage = (value: unknown): SDKMessage => value as SDKMessage;

const ctx = { phase: 'main', depth: 0 };

describe('truncate', () => {
  it('leaves short strings alone', () => {
    expect(truncate('hello', 10)).toBe('hello');
  });

  it('marks how much was dropped', () => {
    const out = truncate('a'.repeat(30), 10);
    expect(out.startsWith('a'.repeat(10))).toBe(true);
    expect(out).toContain('truncated 20 chars');
  });
});

describe('TraceCollector', () => {
  it('assigns increasing sequence numbers and relative timestamps', () => {
    let t = 1_000;
    const trace = new TraceCollector({ now: () => t });
    trace.append({ phase: 'main', depth: 0, kind: 'note', text: 'first' });
    t = 1_250;
    trace.append({ phase: 'main', depth: 0, kind: 'note', text: 'second' });

    expect(trace.events.map((e) => e.seq)).toEqual([0, 1]);
    expect(trace.events.map((e) => e.tMs)).toEqual([0, 250]);
  });

  it('counts events by kind', () => {
    const trace = new TraceCollector();
    trace.append({ phase: 'main', depth: 0, kind: 'tool_denied', toolName: 'Bash' });
    trace.append({ phase: 'main', depth: 0, kind: 'tool_denied', toolName: 'Write' });
    trace.append({ phase: 'main', depth: 0, kind: 'note' });

    expect(trace.countOf('tool_denied')).toBe(2);
    expect(trace.countOf('tool_call')).toBe(0);
  });

  it('lists tool call names in order', () => {
    const trace = new TraceCollector();
    trace.append({ phase: 'main', depth: 0, kind: 'tool_call', toolName: 'a' });
    trace.append({ phase: 'main', depth: 0, kind: 'tool_result' });
    trace.append({ phase: 'main', depth: 0, kind: 'tool_call', toolName: 'b' });

    expect(trace.toolCallNames()).toEqual(['a', 'b']);
  });
});

describe('normalizeSdkMessage', () => {
  it('captures the init system message', () => {
    const events = normalizeSdkMessage(
      asMessage({
        type: 'system',
        subtype: 'init',
        model: 'claude-opus-5',
        tools: ['mcp__airline__get_reservation'],
        mcp_servers: [{ name: 'airline', status: 'connected' }],
        permissionMode: 'dontAsk',
      }),
      ctx,
    );

    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe('system_init');
    expect(events[0]?.meta?.model).toBe('claude-opus-5');
  });

  it('ignores non-init system messages', () => {
    expect(normalizeSdkMessage(asMessage({ type: 'system', subtype: 'other' }), ctx)).toEqual([]);
  });

  it('splits assistant content into text, thinking and tool calls', () => {
    const events = normalizeSdkMessage(
      asMessage({
        type: 'assistant',
        parent_tool_use_id: null,
        message: {
          content: [
            { type: 'thinking', thinking: 'considering options' },
            { type: 'text', text: 'Cancelling the reservation.' },
            { type: 'tool_use', id: 'tu_1', name: 'cancel_reservation', input: { id: 'R1' } },
          ],
        },
      }),
      ctx,
    );

    expect(events.map((e) => e.kind)).toEqual(['thinking', 'assistant_text', 'tool_call']);
    expect(events[2]?.toolName).toBe('cancel_reservation');
    expect(events[2]?.toolUseId).toBe('tu_1');
    expect(events[2]?.toolInput).toEqual({ id: 'R1' });
  });

  it('drops empty assistant text', () => {
    const events = normalizeSdkMessage(
      asMessage({
        type: 'assistant',
        parent_tool_use_id: null,
        message: { content: [{ type: 'text', text: '   ' }] },
      }),
      ctx,
    );
    expect(events).toEqual([]);
  });

  it('nests subagent messages one level deeper', () => {
    const events = normalizeSdkMessage(
      asMessage({
        type: 'assistant',
        parent_tool_use_id: 'tu_parent',
        message: { content: [{ type: 'text', text: 'worker output' }] },
      }),
      { phase: 'worker-1', depth: 0 },
    );
    expect(events[0]?.depth).toBe(1);
  });

  it('reads tool results out of user messages', () => {
    const events = normalizeSdkMessage(
      asMessage({
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'tu_1', content: 'reservation R1 cancelled' },
          ],
        },
      }),
      ctx,
    );

    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe('tool_result');
    expect(events[0]?.text).toBe('reservation R1 cancelled');
    expect(events[0]?.isError).toBe(false);
  });

  it('flattens block-array tool results and marks errors', () => {
    const events = normalizeSdkMessage(
      asMessage({
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tu_2',
              is_error: true,
              content: [{ type: 'text', text: 'Error: unknown reservation' }],
            },
          ],
        },
      }),
      ctx,
    );

    expect(events[0]?.isError).toBe(true);
    expect(events[0]?.text).toContain('unknown reservation');
  });

  it('captures cost and usage from a successful result', () => {
    const events = normalizeSdkMessage(
      asMessage({
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'done',
        total_cost_usd: 0.0421,
        num_turns: 6,
        stop_reason: 'end_turn',
        permission_denials: [],
        usage: {
          input_tokens: 1200,
          output_tokens: 300,
          cache_read_input_tokens: 900,
          cache_creation_input_tokens: 100,
        },
      }),
      ctx,
    );

    expect(events[0]?.kind).toBe('result');
    expect(events[0]?.costUsd).toBeCloseTo(0.0421);
    expect(events[0]?.usage?.inputTokens).toBe(1200);
    expect(events[0]?.usage?.cacheReadInputTokens).toBe(900);
    expect(events[0]?.meta?.numTurns).toBe(6);
  });

  it('records error results with their subtype', () => {
    const events = normalizeSdkMessage(
      asMessage({
        type: 'result',
        subtype: 'error_max_budget_usd',
        is_error: true,
        total_cost_usd: 1.0,
        num_turns: 3,
        stop_reason: null,
        permission_denials: [],
        errors: ['budget exhausted'],
        usage: {},
      }),
      ctx,
    );

    expect(events[0]?.isError).toBe(true);
    expect(events[0]?.meta?.subtype).toBe('error_max_budget_usd');
    expect(events[0]?.meta?.errors).toEqual(['budget exhausted']);
  });

  it('records a failed request as an error, never as the agent speaking', () => {
    const events = normalizeSdkMessage(
      asMessage({
        type: 'assistant',
        parent_tool_use_id: null,
        error: 'authentication_failed',
        message: {
          model: '<synthetic>',
          content: [{ type: 'text', text: 'Invalid API key · Please run /login' }],
        },
      }),
      ctx,
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'error', isError: true });
    expect(events[0]?.meta?.apiError).toMatchObject({ kind: 'auth', retryable: false });
  });

  it('records the CLI’s notice that the model could not finish as an error, not as speech', () => {
    const events = normalizeSdkMessage(
      asMessage({
        type: 'assistant',
        parent_tool_use_id: null,
        error: 'max_output_tokens',
        message: {
          model: '<synthetic>',
          content: [{ type: 'text', text: 'API Error: The model has reached its context window limit.' }],
        },
      }),
      ctx,
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'error',
      isError: true,
      text: 'The model has reached its context window limit.',
      meta: { modelStop: { reason: 'context_limit' } },
    });
    expect(events[0]?.meta?.apiError).toBeUndefined();
  });

  it('notes a retried API request', () => {
    const events = normalizeSdkMessage(
      asMessage({
        type: 'system',
        subtype: 'api_retry',
        attempt: 1,
        max_retries: 10,
        retry_delay_ms: 500,
        error_status: 529,
        error: 'overloaded',
      }),
      ctx,
    );

    expect(events[0]?.kind).toBe('note');
    expect(events[0]?.meta).toMatchObject({ apiRetry: true, status: 529 });
  });

  it('stamps every event with the call it belongs to', () => {
    const events = normalizeSdkMessage(
      asMessage({
        type: 'assistant',
        parent_tool_use_id: null,
        message: { content: [{ type: 'text', text: 'hello' }] },
      }),
      { ...ctx, callId: 'call-7' },
    );
    expect(events[0]?.callId).toBe('call-7');
  });

  it('skips message types it does not model', () => {
    expect(normalizeSdkMessage(asMessage({ type: 'stream_event' }), ctx)).toEqual([]);
    expect(normalizeSdkMessage(asMessage({ type: 'assistant', message: {} }), ctx)).toEqual([]);
  });
});
