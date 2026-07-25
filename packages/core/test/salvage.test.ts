import { describe, expect, it } from 'vitest';
import { TraceCollector } from '@arena/core';
import type { RunContext, TraceEvent } from '@arena/core';

/**
 * A turn cut short by the turn cap or the budget returns an error result with
 * no text. Discarding the run at that point throws away everything the agent
 * produced — on a research task that has meant a dozen genuine page fetches
 * scoring zero for want of a closing message. `runQuery` recovers the last
 * assistant text instead.
 *
 * The recovery itself is a small private helper, so these tests pin the
 * behaviour it has to implement, against the same trace shapes `runQuery`
 * produces.
 */
function lastAssistantText(events: readonly TraceEvent[], fromIndex: number): string | undefined {
  for (let i = events.length - 1; i >= fromIndex; i--) {
    const event = events[i];
    if (event?.kind === 'assistant_text' && event.text && event.text.trim() !== '') {
      return event.text;
    }
  }
  return undefined;
}

function traceWith(entries: Array<Partial<TraceEvent> & { kind: TraceEvent['kind'] }>) {
  const trace = new TraceCollector();
  for (const entry of entries) {
    trace.append({ phase: 'main', depth: 0, ...entry });
  }
  return trace;
}

describe('recovering a truncated turn', () => {
  it('returns the most recent assistant text', () => {
    const trace = traceWith([
      { kind: 'assistant_text', text: 'first thought' },
      { kind: 'tool_call', toolName: 'fetch_page' },
      { kind: 'assistant_text', text: 'the findings so far' },
    ]);
    expect(lastAssistantText(trace.events, 0)).toBe('the findings so far');
  });

  it('ignores tool results, which are not the agent speaking', () => {
    const trace = traceWith([
      { kind: 'assistant_text', text: 'analysis' },
      { kind: 'tool_result', text: 'a page body that must not become the answer' },
    ]);
    expect(lastAssistantText(trace.events, 0)).toBe('analysis');
  });

  it('skips whitespace-only messages', () => {
    const trace = traceWith([
      { kind: 'assistant_text', text: 'real content' },
      { kind: 'assistant_text', text: '   ' },
    ]);
    expect(lastAssistantText(trace.events, 0)).toBe('real content');
  });

  it('returns undefined when the agent never spoke', () => {
    const trace = traceWith([
      { kind: 'phase_start' },
      { kind: 'tool_call', toolName: 'search' },
      { kind: 'tool_result', text: 'results' },
    ]);
    expect(lastAssistantText(trace.events, 0)).toBeUndefined();
  });

  it('does not reach back into an earlier phase', () => {
    const trace = traceWith([
      { kind: 'assistant_text', text: 'text from the planning phase' },
      { kind: 'phase_start', text: 'execute' },
      { kind: 'tool_call', toolName: 'charge_fee' },
    ]);
    // The execute phase begins at index 1; its own output is what may be
    // salvaged, never the previous phase's.
    expect(lastAssistantText(trace.events, 1)).toBeUndefined();
    expect(lastAssistantText(trace.events, 0)).toBe('text from the planning phase');
  });

  it('handles an empty window', () => {
    const trace = traceWith([{ kind: 'assistant_text', text: 'earlier' }]);
    expect(lastAssistantText(trace.events, trace.events.length)).toBeUndefined();
  });
});

describe('RunContext shape used by the recovery path', () => {
  it('exposes trace events as an indexable, ordered list', () => {
    const trace = traceWith([
      { kind: 'assistant_text', text: 'a' },
      { kind: 'assistant_text', text: 'b' },
    ]);
    const ctx = { trace } as unknown as RunContext;
    expect(ctx.trace.events).toHaveLength(2);
    expect(ctx.trace.events[0]?.seq).toBe(0);
    expect(ctx.trace.events[1]?.seq).toBe(1);
  });
});
