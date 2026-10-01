import { describe, expect, it } from 'vitest';

import {
  callKeys,
  costAt,
  describeSubtype,
  normalizeError,
  packLanes,
  shortToolName,
  timelineFromPhases,
  timelineFromTrace,
} from '../lib/timeline';
import type { TraceEvent } from '../lib/records';
import { buildViewGroups, summarizeInput } from '../lib/traceView';
import { phase } from './fixtures';

/**
 * A miniature of `debate-select__airline-easy__r1` from the first published
 * run set, with the shapes that mattered: three proposers started together,
 * two of them without their tool server; the selector's structured reply was
 * denied by the guard; the executor ran normally.
 */
function postmortemTrace(): TraceEvent[] {
  const events: Omit<TraceEvent, 'seq'>[] = [];
  const add = (event: Omit<TraceEvent, 'seq'>) => events.push(event);
  const proposer = (n: number, connected: boolean, end: number) => {
    const base = { phase: `propose-${n}`, depth: 1, agent: `proposer-${n}` };
    add({ ...base, tMs: n, kind: 'phase_start', text: `Proposal ${n}` });
    add({ ...base, tMs: n, kind: 'user', text: 'Propose one course of action.' });
    add({
      ...base,
      tMs: 700 + n,
      kind: 'system_init',
      meta: {
        tools: connected ? ['mcp__airline__get_reservation', 'mcp__airline__add_baggage'] : [],
        mcpServers: [
          ...(n === 3 ? [{ name: 'claude.ai Gmail', status: 'needs-auth' }] : []),
          { name: 'airline', status: connected ? 'connected' : 'failed' },
        ],
      },
    });
    if (connected) {
      add({ ...base, tMs: 3000, kind: 'tool_call', toolName: 'mcp__airline__get_reservation', toolUseId: 'tu1', toolInput: { reservationId: 'R1042' } });
      add({ ...base, tMs: 3100, kind: 'tool_result', toolUseId: 'tu1', text: 'Reservation R1042' });
    }
    add({ ...base, tMs: end - 10, kind: 'assistant_text', text: '## Findings\n**silver** tier' });
    add({ ...base, tMs: end - 5, kind: 'result', text: '## Findings\n**silver** tier', costUsd: 0.01 * n, meta: { subtype: 'success', numTurns: 1 } });
    add({ ...base, tMs: end, kind: 'phase_end', costUsd: 0.01 * n, meta: { subtype: 'success', turns: connected ? 4 : 1 } });
  };
  proposer(1, true, 16_766);
  proposer(2, false, 3_917);
  proposer(3, false, 28_372);

  const select = { phase: 'select', depth: 0 };
  add({ ...select, tMs: 28_372, kind: 'phase_start', text: 'Select' });
  add({ ...select, tMs: 42_443, kind: 'tool_call', toolName: 'StructuredOutput', toolUseId: 'tu9', toolInput: { winnerIndex: 1 } });
  add({ ...select, tMs: 42_451, kind: 'tool_denied', toolName: 'StructuredOutput', toolInput: { winnerIndex: 1 }, isError: true, text: "Blocked by sandbox guard: StructuredOutput is not part of this task's toolset." });
  add({ ...select, tMs: 42_457, kind: 'tool_result', toolUseId: 'tu9', isError: true, text: 'The tool "StructuredOutput" is not available.' });
  add({ ...select, tMs: 42_514, kind: 'result', isError: true, costUsd: 0.056, meta: { subtype: 'error_max_turns', numTurns: 2 } });
  add({ ...select, tMs: 43_046, kind: 'error', isError: true, text: 'Claude Code returned an error result: Reached maximum number of turns (1)' });
  add({ ...select, tMs: 43_046, kind: 'phase_end', costUsd: 0.056, meta: { subtype: 'error_max_turns', turns: 2 } });

  const execute = { phase: 'execute', depth: 0 };
  add({ ...execute, tMs: 43_050, kind: 'phase_start', text: 'Execute' });
  add({ ...execute, tMs: 50_000, kind: 'tool_call', toolName: 'mcp__airline__add_baggage', toolUseId: 'tu10', toolInput: { reservationId: 'R1042', bags: 2 } });
  add({ ...execute, tMs: 50_100, kind: 'tool_result', toolUseId: 'tu10', isError: true, text: 'too many bags' });
  add({ ...execute, tMs: 54_884, kind: 'phase_end', costUsd: 0.034, meta: { subtype: 'success', turns: 6 } });

  // Concurrent calls interleave by time, as they do in a real trace.
  return events
    .map((event, index) => ({ event, index }))
    .sort((a, b) => a.event.tMs - b.event.tMs || a.index - b.index)
    .map(({ event }, seq) => ({ ...event, seq }));
}

describe('timelineFromTrace', () => {
  const timeline = timelineFromTrace(postmortemTrace());
  const call = (phaseName: string) => timeline.calls.find((c) => c.phase === phaseName);

  it('puts parallel calls on one clock, overlapping, in start order', () => {
    expect(timeline.calls.map((c) => c.phase)).toEqual(['propose-1', 'propose-2', 'propose-3', 'select', 'execute']);
    const [p1, p2, p3] = timeline.calls;
    expect(p1?.startMs).toBe(1);
    expect(p2 && p1 && p2.startMs < p1.endMs).toBe(true);
    expect(p3?.endMs).toBe(28_372);
    expect(p1?.depth).toBe(1);
    expect(call('select')?.depth).toBe(0);
  });

  it('flags a call whose tool server never connected, and foreign connectors apart', () => {
    expect(call('propose-1')?.serversDown).toEqual([]);
    expect(call('propose-2')?.serversDown).toEqual(['airline']);
    expect(call('propose-2')?.toolsOffered).toBe(0);
    expect(call('propose-3')?.foreignServers).toEqual(['claude.ai Gmail']);
    expect(call('propose-3')?.serversDown).toEqual(['airline']);
  });

  it('turns a denied harness tool into a red notch and the call into a failure', () => {
    const select = call('select');
    expect(select?.ticks.map((tick) => tick.kind)).toEqual(['denied', 'error']);
    expect(select?.status).toBe('failed');
    expect(select?.subtype).toBe('error_max_turns');
    expect(select?.ticks[1]?.label).toBe('Stopped at its limit of 1 turn');
  });

  it('keeps tool errors apart from denials', () => {
    expect(call('execute')?.ticks).toEqual([
      expect.objectContaining({ kind: 'tool-error', label: 'add_baggage' }),
    ]);
    expect(call('execute')?.status).toBe('ok');
  });

  it('steps the cost series at each call end', () => {
    expect(timeline.totalCostUsd).toBeCloseTo(0.01 + 0.02 + 0.03 + 0.056 + 0.034, 9);
    expect(costAt(timeline, 0)).toBe(0);
    expect(costAt(timeline, 3_917)).toBeCloseTo(0.02, 9);
    expect(costAt(timeline, 60_000)).toBeCloseTo(timeline.totalCostUsd, 9);
    expect(timeline.durationMs).toBe(54_884);
  });

  it('separates two calls that reuse a phase name in a legacy trace', () => {
    const events: TraceEvent[] = [
      { seq: 0, tMs: 0, phase: 'verify', depth: 0, kind: 'phase_start', text: 'Verify' },
      { seq: 1, tMs: 10, phase: 'verify', depth: 0, kind: 'phase_end' },
      { seq: 2, tMs: 20, phase: 'verify', depth: 0, kind: 'phase_start', text: 'Verify again' },
      { seq: 3, tMs: 30, phase: 'verify', depth: 0, kind: 'phase_end' },
    ];
    expect([...new Set(callKeys(events).values())]).toEqual(['verify#1', 'verify#2']);
    expect(timelineFromTrace(events).calls.map((c) => c.label)).toEqual(['Verify', 'Verify again']);
  });

  it('prefers callId when a current trace records one', () => {
    const events: TraceEvent[] = [
      { seq: 0, tMs: 0, phase: 'worker', callId: 'c1', depth: 1, kind: 'phase_start' },
      { seq: 1, tMs: 1, phase: 'worker', callId: 'c2', depth: 1, kind: 'phase_start' },
      { seq: 2, tMs: 5, phase: 'worker', callId: 'c1', depth: 1, kind: 'phase_end', meta: { subtype: 'success', mcpServersExpected: ['airline'] } },
    ];
    expect(timelineFromTrace(events).calls.map((c) => c.key)).toEqual(['c1', 'c2']);
  });

  it('marks degraded phases from the phase records', () => {
    const events: TraceEvent[] = [{ seq: 0, tMs: 0, phase: 'plan', depth: 0, kind: 'phase_start' }];
    const [planCall] = timelineFromTrace(events, [phase({ phase: 'plan', label: 'Plan', degraded: 'empty-plan' })]).calls;
    expect(planCall?.degraded).toBe('empty-plan');
    expect(planCall?.label).toBe('Plan');
  });
});

describe('timelineFromPhases', () => {
  it('lays phase records on a clock that starts at the first phase', () => {
    const timeline = timelineFromPhases([
      phase({ phase: 'decompose', startedAtMs: 1_000, durationMs: 500 }),
      phase({ phase: 'worker-1', startedAtMs: 1_500, durationMs: 2_000 }),
      phase({ phase: 'worker-2', startedAtMs: 1_520, durationMs: 1_000, subtype: 'error_max_turns' }),
    ]);
    expect(timeline.source).toBe('phases');
    expect(timeline.calls.map((c) => [c.phase, c.startMs, c.endMs, c.status])).toEqual([
      ['decompose', 0, 500, 'ok'],
      ['worker-1', 500, 2_500, 'ok'],
      ['worker-2', 520, 1_520, 'limit'],
    ]);
  });
});

describe('packLanes', () => {
  it('opens subagent rows under the main line and closes them again', () => {
    const timeline = timelineFromTrace(postmortemTrace());
    const { lanes, laneOf } = packLanes(timeline.calls);
    expect(lanes).toBe(3);
    expect(laneOf.get('propose-1#1')).toBe(0);
    expect(laneOf.get('propose-2#1')).toBe(1);
    expect(laneOf.get('propose-3#1')).toBe(2);
    expect(laneOf.get('select#1')).toBe(0);
    expect(laneOf.get('execute#1')).toBe(0);
  });
});

describe('buildViewGroups', () => {
  const groups = buildViewGroups(postmortemTrace());
  const group = (key: string) => groups.find((g) => g.key === key);

  it('folds a tool call, its answer and any denial into one item', () => {
    const select = group('select#1');
    expect(select?.items.map((item) => item.kind)).toEqual(['tool', 'error']);
    const tool = select?.items[0];
    expect(tool?.kind === 'tool' && tool.denied?.reason).toMatch(/Blocked by sandbox guard/);
    expect(tool?.kind === 'tool' && tool.result?.isError).toBe(true);
    expect(tool?.kind === 'tool' && tool.name).toBe('StructuredOutput');
  });

  it('drops the closing result when it repeats the last message', () => {
    expect(group('propose-1#1')?.items.map((item) => item.kind)).toEqual(['prompt', 'tool', 'say']);
  });

  it('summarises the session instead of listing the init event', () => {
    const session = group('propose-2#1')?.session;
    expect(session?.tools).toEqual([]);
    expect(session?.servers).toEqual([{ name: 'airline', status: 'failed' }]);
    expect(group('propose-1#1')?.session?.tools).toEqual(['get_reservation', 'add_baggage']);
  });

  it('normalises the SDK error text and keeps the raw text beside it', () => {
    const error = group('select#1')?.items[1];
    expect(error).toMatchObject({
      kind: 'error',
      message: 'Stopped at its limit of 1 turn',
      raw: 'Claude Code returned an error result: Reached maximum number of turns (1)',
    });
  });
});

describe('words', () => {
  it('shortens MCP tool names and leaves harness tools alone', () => {
    expect(shortToolName('mcp__airline__get_reservation')).toBe('get_reservation');
    expect(shortToolName('StructuredOutput')).toBe('StructuredOutput');
  });

  it('describes how a call ended', () => {
    expect(describeSubtype('error_max_turns')).toBe('turn limit');
    expect(describeSubtype('error_something_new')).toBe('something new');
    expect(normalizeError('Claude Code returned an error result: Reached maximum number of turns (3)')).toBe(
      'Stopped at its limit of 3 turns',
    );
  });

  it('summarises tool arguments on one line', () => {
    expect(summarizeInput({ reservationId: 'R1042', bags: 2 })).toBe('R1042, 2');
    expect(summarizeInput({ note: 'x'.repeat(200) }, 10)).toHaveLength(10);
  });
});
