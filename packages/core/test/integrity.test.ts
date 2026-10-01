import { describe, expect, it } from 'vitest';

import {
  HARNESS_CHECK,
  STRUCTURED_OUTPUT_TOOL,
  actingCallOutOfTurns,
  apiErrorsOf,
  harnessChecks,
  integrityOf,
  tracedCalls,
} from '@arena/core';
import type { ApiError, IntegrityCheck, PhaseRecord, TraceEvent } from '@arena/core';

/**
 * The runner's own integrity checks, over hand-built traces shaped like the
 * ones `runQuery` writes. Each failure here is one the first published run set
 * contained and nothing reported.
 */

let seq = 0;

function event(callId: string | undefined, phase: string, rest: Omit<TraceEvent, 'seq' | 'tMs' | 'phase' | 'depth'>): TraceEvent {
  return { seq: seq++, tMs: 0, phase, depth: 0, ...(callId ? { callId } : {}), ...rest };
}

interface CallShape {
  callId?: string;
  phase?: string;
  /** Tools listed at init; omit `init` entirely with `noInit`. */
  tools?: string[];
  servers?: { name: string; status: string }[];
  expected?: string[] | null;
  subtype?: string;
  denied?: string[];
  structuredMissing?: boolean;
  apiError?: ApiError;
  noInit?: boolean;
  noEnd?: boolean;
}

/** The events one `runQuery` call leaves in a trace. */
function call(shape: CallShape = {}): TraceEvent[] {
  const callId = shape.callId ?? 'call-1';
  const phase = shape.phase ?? 'main';
  const servers = shape.servers ?? [{ name: 'airline', status: 'connected' }];
  const events: TraceEvent[] = [event(callId, phase, { kind: 'phase_start' })];
  if (!shape.noInit) {
    events.push(
      event(callId, phase, {
        kind: 'system_init',
        meta: { tools: shape.tools ?? ['mcp__airline__get_reservation'], mcpServers: servers },
      }),
    );
  }
  for (const tool of shape.denied ?? []) {
    events.push(event(callId, phase, { kind: 'tool_denied', toolName: tool }));
  }
  if (!shape.noEnd) {
    const expected = shape.expected === undefined ? servers.map((s) => s.name) : shape.expected;
    events.push(
      event(callId, phase, {
        kind: 'phase_end',
        meta: {
          subtype: shape.subtype ?? 'success',
          ...(expected !== null ? { mcpServersExpected: expected } : {}),
          ...(shape.structuredMissing ? { structuredMissing: true } : {}),
          ...(shape.apiError ? { apiError: shape.apiError } : {}),
        },
      }),
    );
  }
  return events;
}

function check(checks: IntegrityCheck[], id: string): IntegrityCheck {
  const found = checks.find((c) => c.id === id);
  if (!found) throw new Error(`no check ${id}`);
  return found;
}

const phase = (overrides: Partial<PhaseRecord> = {}): PhaseRecord => ({
  phase: 'main',
  label: 'main',
  startedAtMs: 0,
  durationMs: 1,
  costUsd: 0,
  turns: 1,
  toolCalls: 0,
  model: 'm',
  aborted: false,
  ...overrides,
});

const RATE_LIMIT: ApiError = { kind: 'rate_limit', retryable: true, message: 'Rate limit reached', status: 429 };

describe('harnessChecks', () => {
  it('passes a healthy run, naming every check it made', () => {
    const checks = harnessChecks({ trace: call(), phases: [phase()] });

    expect(checks.map((c) => c.id)).toEqual([
      HARNESS_CHECK.runCompleted,
      HARNESS_CHECK.api,
      HARNESS_CHECK.callsEnded,
      HARNESS_CHECK.harnessTools,
      HARNESS_CHECK.mcpConnected,
      HARNESS_CHECK.mcpHermetic,
      HARNESS_CHECK.structuredOutput,
      HARNESS_CHECK.notDegraded,
    ]);
    expect(integrityOf(checks).ok).toBe(true);
  });

  it('fails a run whose strategy, environment or grader threw', () => {
    const checks = harnessChecks({ trace: [], phases: [], runError: 'strategy blew up' });
    expect(check(checks, HARNESS_CHECK.runCompleted)).toEqual({
      id: HARNESS_CHECK.runCompleted,
      ok: false,
      detail: 'strategy blew up',
    });
  });

  it('fails a harness that denied its own structured-output tool', () => {
    // The first run set's planners, decomposers and selectors, every one.
    const trace = call({ phase: 'plan', tools: [STRUCTURED_OUTPUT_TOOL], denied: [STRUCTURED_OUTPUT_TOOL] });
    const result = check(harnessChecks({ trace, phases: [] }), HARNESS_CHECK.harnessTools);

    expect(result.ok).toBe(false);
    expect(result.detail).toBe('plan (call-1): StructuredOutput was offered, then denied');
  });

  it('fails a denial of a tool the session itself offered', () => {
    const trace = call({ tools: ['mcp__airline__cancel'], denied: ['mcp__airline__cancel'] });
    expect(check(harnessChecks({ trace, phases: [] }), HARNESS_CHECK.harnessTools).ok).toBe(false);
  });

  it('does not blame the harness for refusing a tool it never offered', () => {
    // The guard doing its job: the model reached for a tool outside its phase.
    const trace = call({ tools: ['mcp__airline__get_reservation'], denied: ['mcp__airline__cancel', 'Bash'] });
    expect(check(harnessChecks({ trace, phases: [] }), HARNESS_CHECK.harnessTools).ok).toBe(true);
  });

  it('fails a call whose tool server did not connect', () => {
    // The first run set's proposers 2 and 3, every one.
    const trace = [
      ...call({ callId: 'call-1', phase: 'propose-1' }),
      ...call({ callId: 'call-2', phase: 'propose-2', servers: [{ name: 'airline', status: 'failed' }] }),
      ...call({ callId: 'call-3', phase: 'propose-3', servers: [], expected: ['airline'] }),
    ];
    const result = check(harnessChecks({ trace, phases: [] }), HARNESS_CHECK.mcpConnected);

    expect(result.ok).toBe(false);
    expect(result.detail).toBe('propose-2 (call-2): airline failed; propose-3 (call-3): airline missing');
  });

  it('fails a call that loaded a server the harness did not give it', () => {
    const trace = call({
      servers: [
        { name: 'airline', status: 'connected' },
        { name: 'claude.ai Gmail', status: 'needs-auth' },
      ],
      expected: ['airline'],
    });
    const checks = harnessChecks({ trace, phases: [] });

    expect(check(checks, HARNESS_CHECK.mcpHermetic)).toMatchObject({
      ok: false,
      detail: 'main (call-1) also loaded claude.ai Gmail',
    });
    expect(check(checks, HARNESS_CHECK.mcpConnected).ok).toBe(true);
  });

  it('skips the server checks for traces that never recorded what was expected', () => {
    const trace = call({ servers: [{ name: 'claude.ai Gmail', status: 'needs-auth' }], expected: null });
    const checks = harnessChecks({ trace, phases: [] });
    expect(check(checks, HARNESS_CHECK.mcpConnected).ok).toBe(true);
    expect(check(checks, HARNESS_CHECK.mcpHermetic).ok).toBe(true);
  });

  it.each([
    ['finished', 'success'],
    ['ran out of turns', 'error_max_turns'],
    ['exhausted its schema retries', 'error_max_structured_output_retries'],
  ])('fails a schema call that %s without structured output', (_label, subtype) => {
    const trace = call({ phase: 'select', subtype, structuredMissing: true });
    const result = check(harnessChecks({ trace, phases: [] }), HARNESS_CHECK.structuredOutput);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain(`select (call-1) returned no structured output (${subtype})`);
  });

  it.each(['aborted', 'skipped', 'error_max_budget_usd'])(
    'does not fail a schema call the run’s own limits cut short (%s)',
    (subtype) => {
      const trace = call({ subtype, structuredMissing: true });
      const checks = harnessChecks({ trace, phases: [] });
      expect(check(checks, HARNESS_CHECK.structuredOutput).ok).toBe(true);
      expect(check(checks, HARNESS_CHECK.callsEnded).ok).toBe(true);
    },
  );

  it.each([
    ['crashed', 'main (call-1) ended crashed'],
    ['no_result', 'main (call-1) ended no_result'],
    ['error_during_execution', 'main (call-1) ended error_during_execution'],
  ])('fails a call that ended %s', (subtype, detail) => {
    const result = check(harnessChecks({ trace: call({ subtype }), phases: [] }), HARNESS_CHECK.callsEnded);
    expect(result).toMatchObject({ ok: false, detail });
  });

  it('fails a call that never recorded its end', () => {
    const result = check(harnessChecks({ trace: call({ noEnd: true }), phases: [] }), HARNESS_CHECK.callsEnded);
    expect(result).toMatchObject({ ok: false, detail: 'main (call-1) never finished' });
  });

  it('puts an API failure on the API check alone', () => {
    const trace = call({ subtype: 'success', structuredMissing: true, apiError: RATE_LIMIT });
    const checks = harnessChecks({ trace, phases: [] });

    expect(check(checks, HARNESS_CHECK.api)).toMatchObject({
      ok: false,
      detail: 'main (call-1): rate_limit 429: Rate limit reached',
    });
    expect(check(checks, HARNESS_CHECK.callsEnded).ok).toBe(true);
    expect(check(checks, HARNESS_CHECK.structuredOutput).ok).toBe(true);
  });

  it('falls back on the phase records for an API failure the trace does not show', () => {
    const checks = harnessChecks({ trace: [], phases: [phase({ phase: 'execute', apiError: RATE_LIMIT })] });
    expect(check(checks, HARNESS_CHECK.api)).toMatchObject({
      ok: false,
      detail: 'execute: rate_limit 429: Rate limit reached',
    });
  });

  it('fails a phase a strategy marked degraded', () => {
    const checks = harnessChecks({
      trace: call(),
      phases: [phase({ phase: 'select', degraded: 'selection unreadable; kept proposal 1' })],
    });
    expect(check(checks, HARNESS_CHECK.notDegraded)).toMatchObject({
      ok: false,
      detail: 'select: selection unreadable; kept proposal 1',
    });
  });

  it('checks grading only for graded runs, and fails it only when every call failed', () => {
    const ungraded = harnessChecks({ trace: [], phases: [] });
    expect(ungraded.some((c) => c.id === HARNESS_CHECK.judge)).toBe(false);

    const partly = harnessChecks({ trace: [], phases: [], judge: { calls: 3, failures: 2 } });
    expect(check(partly, HARNESS_CHECK.judge).ok).toBe(true);

    const outage = harnessChecks({ trace: [], phases: [], judge: { calls: 3, failures: 3 } });
    expect(check(outage, HARNESS_CHECK.judge)).toMatchObject({
      ok: false,
      detail: 'all 3 grading calls failed',
    });
  });

  it('names at most three offenders', () => {
    const trace = Array.from({ length: 5 }, (_, i) =>
      call({ callId: `call-${i + 1}`, phase: `worker-${i + 1}`, servers: [{ name: 'airline', status: 'failed' }] }),
    ).flat();
    const result = check(harnessChecks({ trace, phases: [] }), HARNESS_CHECK.mcpConnected);
    expect(result.detail).toMatch(/worker-3 \(call-3\): airline failed; and 2 more$/);
  });
});

describe('tracedCalls', () => {
  it('reassembles interleaved calls by call id, ignoring events that carry none', () => {
    const a = call({ callId: 'call-1', phase: 'propose-1' });
    const b = call({ callId: 'call-2', phase: 'propose-2', denied: ['Bash'] });
    const interleaved = [a[0]!, b[0]!, a[1]!, b[1]!, b[2]!, a[2]!, b[3]!, event(undefined, 'runner', { kind: 'note' })];

    const calls = tracedCalls(interleaved);
    expect(calls.map((c) => [c.callId, c.phase, c.end?.subtype, c.deniedTools])).toEqual([
      ['call-1', 'propose-1', 'success', []],
      ['call-2', 'propose-2', 'success', ['Bash']],
    ]);
  });
});

describe('actingCallOutOfTurns', () => {
  const acting = ['mcp__airline__cancel'];

  it('finds a call that ran out of turns holding a tool that acts on the task', () => {
    const trace = [
      ...call({ callId: 'call-1', phase: 'plan', tools: [], subtype: 'error_max_turns' }),
      ...call({
        callId: 'call-2',
        phase: 'execute',
        tools: ['mcp__airline__get_reservation', 'mcp__airline__cancel'],
        subtype: 'error_max_turns',
      }),
    ];
    expect(actingCallOutOfTurns(tracedCalls(trace), acting)?.phase).toBe('execute');
  });

  it('ignores a planner or a read-only call that ran out of turns', () => {
    const trace = [
      ...call({ callId: 'call-1', phase: 'plan', tools: [], subtype: 'error_max_turns' }),
      ...call({ callId: 'call-2', phase: 'propose-1', tools: ['mcp__airline__get_reservation'], subtype: 'error_max_turns' }),
      ...call({ callId: 'call-3', phase: 'execute', tools: ['mcp__airline__cancel'], subtype: 'success' }),
    ];
    expect(actingCallOutOfTurns(tracedCalls(trace), acting)).toBeUndefined();
  });
});

describe('apiErrorsOf', () => {
  it('puts rejected credentials first, then failures a retry cannot fix, then transient ones', () => {
    const auth: ApiError = { kind: 'auth', retryable: false, message: 'Invalid API key' };
    const invalid: ApiError = { kind: 'invalid_request', retryable: false, message: 'bad model', status: 404 };
    const trace = [
      ...call({ callId: 'call-1', apiError: RATE_LIMIT }),
      ...call({ callId: 'call-2', apiError: invalid }),
    ];

    expect(apiErrorsOf(tracedCalls(trace), [phase({ apiError: auth })])).toEqual([auth, invalid, RATE_LIMIT]);
  });
});
