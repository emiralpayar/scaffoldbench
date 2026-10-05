'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { PhaseRecord, Penalty, ScoreItem, TraceEvent } from '@scaffoldbench/core';

import { architectureName } from '../lib/architectures';
import { FULL_CREDIT, formatDuration, formatFailureMode, formatScore, formatUsd } from '../lib/format';
import { withBasePath } from '../lib/site';

export interface LiveOption {
  id: string;
  label: string;
  hint?: string;
}

interface LiveResult {
  runId: string;
  score: number;
  passed: boolean;
  failureMode: string;
  costUsd: number;
  latencyMs: number;
  turns: number;
  toolCalls: number;
  deniedToolCalls: number;
  subagentCount: number;
  breakdown: ScoreItem[];
  penalties: Penalty[];
  finalText: string;
  phases: PhaseRecord[];
}

/**
 * One task, one architecture, one run, on the visitor's own key, streamed.
 * Only rendered when the site is built in server mode; the options come from
 * the server's own rules (`lib/server/live.ts`), so the form cannot offer
 * what the route would refuse.
 */
export function LiveRunner({
  tasks,
  strategies,
  models,
  defaultModel,
  limits,
}: {
  tasks: LiveOption[];
  strategies: LiveOption[];
  models: LiveOption[];
  defaultModel: string;
  /** The server's per-run caps, as a sentence. */
  limits: string;
}) {
  const [apiKey, setApiKey] = useState('');
  const [taskId, setTaskId] = useState(tasks[0]?.id ?? '');
  const [strategyId, setStrategyId] = useState(strategies[0]?.id ?? '');
  const [model, setModel] = useState(defaultModel);

  const [running, setRunning] = useState(false);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(0);
  const [events, setEvents] = useState<TraceEvent[]>([]);
  const [result, setResult] = useState<LiveResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const keyHelp = useId();

  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [running]);

  const stop = useCallback(() => {
    // Aborting the request closes the stream. The server hands its request
    // signal to the runner; see app/api/live/route.live.ts for what that stops.
    abortRef.current?.abort();
    abortRef.current = null;
    setRunning(false);
  }, []);

  const start = useCallback(async () => {
    setEvents([]);
    setResult(null);
    setError(null);
    setRunning(true);
    setStartedAt(Date.now());
    setNow(Date.now());

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const response = await fetch(withBasePath('/api/live'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ apiKey, taskId, strategyId, model }),
        signal: controller.signal,
      });

      if (!response.ok || !response.body) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        setError(payload?.error ?? `The request failed (${response.status}).`);
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // SSE frames are separated by a blank line; comment frames are heartbeats.
        const frames = buffer.split('\n\n');
        buffer = frames.pop() ?? '';

        for (const frame of frames) {
          const lines = frame.split('\n');
          const name = lines.find((line) => line.startsWith('event: '))?.slice(7).trim();
          const data = lines.find((line) => line.startsWith('data: '))?.slice(6);
          if (!name || data === undefined) continue;
          let payload: unknown;
          try {
            payload = JSON.parse(data);
          } catch {
            continue;
          }
          if (name === 'trace') setEvents((previous) => [...previous, payload as TraceEvent]);
          else if (name === 'result') setResult(payload as LiveResult);
          else if (name === 'error') setError((payload as { message?: string }).message ?? 'The run failed.');
        }
      }
    } catch (caught) {
      if ((caught as Error).name !== 'AbortError') {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  }, [apiKey, taskId, strategyId, model]);

  const canRun = apiKey.trim().startsWith('sk-ant-') && taskId !== '' && strategyId !== '';

  return (
    <div className="flex flex-col gap-8">
      <form
        className="card flex flex-col gap-5 p-5 sm:p-6"
        onSubmit={(event) => {
          event.preventDefault();
          if (canRun && !running) void start();
        }}
      >
        <div className="grid gap-4 md:grid-cols-3">
          <Select label="Task" value={taskId} onChange={setTaskId} options={tasks} />
          <Select label="Architecture" value={strategyId} onChange={setStrategyId} options={strategies} />
          <Select label="Model" value={model} onChange={setModel} options={models} />
        </div>

        <div>
          <label htmlFor="live-key" className="eyebrow mb-1.5 block">
            Your Anthropic API key
          </label>
          <input
            id="live-key"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder="sk-ant-…"
            aria-describedby={keyHelp}
            className="w-full rounded-[10px] border border-rule-strong bg-plane px-3 py-2.5 font-mono text-[0.875rem] text-ink outline-none focus:border-focus"
          />
          <p id={keyHelp} className="mt-2 max-w-2xl text-[0.8125rem] leading-relaxed text-muted">
            The run is billed to this key and to no other. It is sent with this request, handed to the
            model subprocess, and never stored; the server clears its own credentials first. {limits}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <button type="submit" disabled={!canRun || running} className="btn btn-primary disabled:cursor-not-allowed disabled:opacity-40">
            {running ? 'Running…' : 'Run once'}
          </button>
          {running ? (
            <button type="button" onClick={stop} className="btn btn-secondary">
              Stop
            </button>
          ) : null}
          <span role="status" aria-live="polite" className="num text-[0.8125rem] text-muted">
            {running && startedAt
              ? `${formatDuration(Math.max(0, now - startedAt))} · ${events.length} event${events.length === 1 ? '' : 's'}`
              : ''}
          </span>
        </div>
      </form>

      {error ? (
        <p role="alert" className="banner banner-bad text-[0.9375rem] text-bad">
          {error}
        </p>
      ) : null}

      {result ? <ResultPanel result={result} strategyId={strategyId} /> : null}
      {events.length > 0 ? <EventFeed events={events} /> : null}
    </div>
  );
}

function Select({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: LiveOption[];
}) {
  const id = useId();
  return (
    <div className="min-w-0">
      <label htmlFor={id} className="eyebrow mb-1.5 block">
        {label}
      </label>
      <select
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="w-full rounded-[10px] border border-rule-strong bg-plane px-3 py-2.5 text-[0.875rem] text-ink outline-none focus:border-focus"
      >
        {options.map((option) => (
          <option key={option.id} value={option.id}>
            {option.hint ? `${option.label} (${option.hint})` : option.label}
          </option>
        ))}
      </select>
    </div>
  );
}

function ResultPanel({ result, strategyId }: { result: LiveResult; strategyId: string }) {
  return (
    <section aria-label="Result" className="card p-5 sm:p-6">
      <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2">
        <span className={`font-mono text-[1rem] ${result.passed ? 'text-good' : 'text-bad'}`}>
          {result.passed ? '✓ passed' : '✗ failed'} · score {formatScore(result.score)}
        </span>
        <Stat label="architecture" value={architectureName(strategyId)} />
        <Stat label="cost" value={formatUsd(result.costUsd)} />
        <Stat label="latency" value={formatDuration(result.latencyMs)} />
        <Stat label="tool calls" value={String(result.toolCalls)} />
        {result.subagentCount > 0 ? <Stat label="subagents" value={String(result.subagentCount)} /> : null}
        {result.deniedToolCalls > 0 ? <Stat label="blocked by guard" value={String(result.deniedToolCalls)} /> : null}
        {result.failureMode !== 'none' ? <Stat label="failure" value={formatFailureMode(result.failureMode)} /> : null}
      </div>

      {result.breakdown.length > 0 ? (
        <ul className="mt-4 flex flex-col gap-1.5 border-t border-rule pt-4">
          {result.breakdown.map((item) => {
            const full = item.earned >= FULL_CREDIT;
            return (
              <li key={item.id} className="flex items-baseline gap-2 text-[0.875rem]">
                <span aria-hidden className={full ? 'text-good' : item.earned > 0 ? 'text-warn' : 'text-bad'}>
                  {full ? '✓' : item.earned > 0 ? '◐' : '✗'}
                </span>
                <span className="text-ink-2">{item.label}</span>
                {!full ? <span className="num text-[0.75rem] text-muted">{(item.earned * 100).toFixed(0)}%</span> : null}
              </li>
            );
          })}
        </ul>
      ) : null}

      {result.penalties.map((penalty) => (
        <p key={penalty.id} className="mt-3 text-[0.875rem] text-bad">
          Rule violated: {penalty.label}
        </p>
      ))}

      {result.finalText ? (
        <details className="mt-4 border-t border-rule pt-4">
          <summary className="text-[0.875rem] text-ink-2">Final answer</summary>
          <p className="mt-2 whitespace-pre-wrap text-[0.875rem] leading-relaxed text-ink">{result.finalText}</p>
        </details>
      ) : null}
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <span className="font-mono text-[0.75rem] text-muted">
      {label} <span className="text-ink">{value}</span>
    </span>
  );
}

function EventFeed({ events }: { events: TraceEvent[] }) {
  return (
    <section aria-label="Trace">
      <h3 className="eyebrow mb-3">Trace</h3>
      <ol className="flex flex-col gap-1">
        {events.map((event) => (
          <li
            key={event.seq}
            className="flex min-w-0 flex-col gap-0.5 border-l-2 py-0.5 pl-3 text-[0.8125rem] sm:flex-row sm:gap-3"
            style={{
              marginLeft: `${Math.min(event.depth, 3) * 1}rem`,
              borderColor: event.isError || event.kind === 'tool_denied' ? 'var(--bad)' : 'var(--rule)',
            }}
          >
            <span className="num w-14 shrink-0 text-[0.75rem] text-muted">{formatDuration(event.tMs)}</span>
            <span className="w-28 shrink-0 truncate font-mono text-[0.75rem] text-muted">{event.agent ?? event.phase}</span>
            <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{describe(event)}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

function describe(event: TraceEvent) {
  switch (event.kind) {
    case 'tool_call':
      return (
        <span className="font-mono text-[0.75rem] text-ink">
          → {shortToolName(event.toolName)}
          {event.toolInput ? <span className="text-muted"> {truncate(JSON.stringify(event.toolInput), 120)}</span> : null}
        </span>
      );
    case 'tool_result':
      return (
        <span className={`font-mono text-[0.75rem] ${event.isError ? 'text-bad' : 'text-muted'}`}>
          ← {truncate(event.text ?? '', 140)}
        </span>
      );
    case 'tool_denied':
      return <span className="font-mono text-[0.75rem] text-bad">✗ blocked by the sandbox guard: {shortToolName(event.toolName)}</span>;
    case 'assistant_text':
      return <span className="text-ink">{truncate(event.text ?? '', 400)}</span>;
    case 'thinking':
      return <span className="italic text-muted">{truncate(event.text ?? '', 200)}</span>;
    case 'phase_start':
      return <span className="font-mono text-[0.6875rem] uppercase tracking-[0.12em] text-ink-2">{event.text ?? event.phase}</span>;
    case 'error':
      return <span className="text-bad">{truncate(event.text ?? '', 300)}</span>;
    default:
      return <span className="text-muted">{event.kind}</span>;
  }
}

/** `mcp__airline__get_reservation` reads as `get_reservation`; the server is the phase's world. */
function shortToolName(name: string | undefined): string {
  if (!name) return 'unknown tool';
  const parts = name.split('__');
  return parts.length >= 3 ? parts.slice(2).join('__') : name;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}
