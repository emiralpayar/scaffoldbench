import type { ReactNode } from 'react';

import type { TraceEvent } from '@arena/core';

import { formatDuration, formatUsd, groupTraceByPhase, indexToolResults } from '../lib/data';
import { Tag } from './Layout';

const KIND_LABEL: Record<string, string> = {
  phase_start: 'phase start',
  phase_end: 'phase end',
  user: 'user',
  assistant_text: 'assistant',
  thinking: 'thinking',
  tool_call: 'tool',
  tool_result: 'tool result',
  tool_denied: 'denied',
  system_init: 'init',
  result: 'result',
  note: 'note',
  error: 'error',
};

/** Left indent per nesting level, in pixels. */
const INDENT = 22;

/**
 * The run timeline, bucketed into phases with subagent threads nested under
 * the main one. Reading the architecture off the trace is the whole point of
 * this view: a plan-execute run and an orchestrator run look different here in
 * a way no summary row conveys.
 */
export function TraceTimeline({ events }: { events: readonly TraceEvent[] }) {
  const groups = groupTraceByPhase(events);
  const results = indexToolResults(events);

  if (groups.length === 0) {
    return <p className="text-[13px] text-muted">The trace file contained no events.</p>;
  }

  return (
    <ol className="space-y-3">
      {groups.map((group) => (
        <li
          key={group.phase}
          style={{ marginLeft: group.depth * INDENT }}
          className={`rounded-[3px] border-l-2 pl-3 ${
            group.depth > 0 ? 'border-accent/40 bg-sunken/50' : 'border-rule'
          }`}
        >
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-1.5">
            <span className="font-mono text-[12px] text-ink">{group.phase}</span>
            {group.depth > 0 ? (
              <Tag tone="accent">
                subagent · depth {group.depth}
                {group.agent ? ` · ${group.agent}` : ''}
              </Tag>
            ) : null}
            <span className="num text-[11px] text-muted">
              {formatDuration(group.startMs)} → {formatDuration(group.endMs)} ·{' '}
              {group.events.length} events
            </span>
          </div>

          <ol className="space-y-1.5 pb-2">
            {group.events.map((event) => (
              <li key={event.seq}>
                <TraceRow event={event} result={resultFor(event, results)} />
              </li>
            ))}
          </ol>
        </li>
      ))}
    </ol>
  );
}

function resultFor(
  event: TraceEvent,
  results: Record<string, TraceEvent>,
): TraceEvent | undefined {
  if (event.kind !== 'tool_call' || !event.toolUseId) return undefined;
  return results[event.toolUseId];
}

function TraceRow({ event, result }: { event: TraceEvent; result?: TraceEvent }) {
  // A paired result is rendered under the call that produced it; showing it
  // again in sequence would double every tool interaction.
  if (event.kind === 'tool_result' && event.toolUseId) return null;

  const failed = !!event.isError || event.kind === 'error' || event.kind === 'tool_denied';

  return (
    <div className="grid grid-cols-[3.4rem_6.2rem_minmax(0,1fr)] items-baseline gap-2">
      <span className="num text-[11px] text-muted">{formatDuration(event.tMs)}</span>
      <span className={`eyebrow truncate ${failed ? '!text-bad' : ''}`}>
        {KIND_LABEL[event.kind] ?? event.kind}
      </span>

      <div className="min-w-0">
        {event.kind === 'tool_call' ? (
          <ToolCall event={event} result={result} />
        ) : (
          <TextBody event={event} failed={failed} />
        )}
      </div>
    </div>
  );
}

function TextBody({ event, failed }: { event: TraceEvent; failed: boolean }) {
  const cost = event.costUsd ? ` · ${formatUsd(event.costUsd)}` : '';
  const text = event.text?.trim();

  if (!text) {
    const subtype = event.meta?.subtype;
    return (
      <span className="num text-[11px] text-muted">
        {typeof subtype === 'string' ? subtype : '—'}
        {cost}
      </span>
    );
  }

  return (
    <p
      className={`whitespace-pre-wrap break-words text-[12.5px] leading-snug ${
        failed ? 'text-bad' : event.kind === 'thinking' ? 'italic text-muted' : 'text-ink-2'
      }`}
    >
      {text}
      {cost ? <span className="num text-[11px] text-muted">{cost}</span> : null}
    </p>
  );
}

function ToolCall({ event, result }: { event: TraceEvent; result?: TraceEvent }) {
  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="font-mono text-[12.5px] text-ink">{event.toolName ?? 'unknown tool'}</span>
        {result?.isError ? <Tag tone="bad">error</Tag> : null}
      </div>

      {event.toolInput === undefined ? null : (
        <Disclosure summary="arguments">
          <Json value={event.toolInput} />
        </Disclosure>
      )}

      {result ? (
        <Disclosure summary={result.isError ? 'result (error)' : 'result'}>
          <pre className="whitespace-pre-wrap break-words">{result.text ?? '(empty)'}</pre>
        </Disclosure>
      ) : null}
    </div>
  );
}

/** `<details>` keeps the trace viewer collapsible without shipping any JavaScript. */
function Disclosure({ summary, children }: { summary: string; children: ReactNode }) {
  return (
    <details className="mt-1">
      <summary className="eyebrow inline-flex hover:!text-ink-2">{summary}</summary>
      <div className="scroll-x mt-1 max-h-64 overflow-y-auto rounded-[2px] border border-rule bg-sunken p-2 font-mono text-[11.5px] leading-relaxed text-ink-2">
        {children}
      </div>
    </details>
  );
}

function Json({ value }: { value: unknown }) {
  let text: string;
  try {
    text = JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    text = String(value);
  }
  return <pre className="whitespace-pre-wrap break-words">{text}</pre>;
}
