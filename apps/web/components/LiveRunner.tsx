'use client';

import { useCallback, useRef, useState } from 'react';
import type { PhaseRecord, Penalty, ScoreItem, TraceEvent } from '@arena/core';

export interface LiveOption {
  id: string;
  label: string;
  hint?: string;
}

export interface LiveRunnerProps {
  tasks: LiveOption[];
  strategies: LiveOption[];
}

interface LiveResult {
  runId: string;
  score: number;
  passed: boolean;
  failureMode: string;
  costUsd: number;
  judgeCostUsd: number;
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

const MODELS = [
  { id: 'claude-sonnet-5', label: 'Sonnet 5 — cheapest' },
  { id: 'claude-opus-5', label: 'Opus 5' },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5 — fastest' },
];

export function LiveRunner({ tasks, strategies }: LiveRunnerProps) {
  const [apiKey, setApiKey] = useState('');
  const [taskId, setTaskId] = useState(tasks[0]?.id ?? '');
  const [strategyId, setStrategyId] = useState(strategies[0]?.id ?? '');
  const [model, setModel] = useState(MODELS[0]?.id ?? 'claude-sonnet-5');

  const [running, setRunning] = useState(false);
  const [events, setEvents] = useState<TraceEvent[]>([]);
  const [result, setResult] = useState<LiveResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setRunning(false);
  }, []);

  const start = useCallback(async () => {
    setEvents([]);
    setResult(null);
    setError(null);
    setRunning(true);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const response = await fetch('/api/live', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ apiKey, taskId, strategyId, model }),
        signal: controller.signal,
      });

      if (!response.ok || !response.body) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        setError(payload?.error ?? `The request failed (${response.status}).`);
        setRunning(false);
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // SSE frames are separated by a blank line.
        const frames = buffer.split('\n\n');
        buffer = frames.pop() ?? '';

        for (const frame of frames) {
          const nameLine = frame.split('\n').find((line) => line.startsWith('event: '));
          const dataLine = frame.split('\n').find((line) => line.startsWith('data: '));
          if (!nameLine || !dataLine) continue;

          const name = nameLine.slice(7).trim();
          let payload: unknown;
          try {
            payload = JSON.parse(dataLine.slice(6));
          } catch {
            continue;
          }

          if (name === 'trace') {
            setEvents((previous) => [...previous, payload as TraceEvent]);
          } else if (name === 'result') {
            setResult(payload as LiveResult);
          } else if (name === 'error') {
            setError((payload as { message?: string }).message ?? 'The run failed.');
          }
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
        className="flex flex-col gap-5 rounded-[3px] border border-rule bg-surface p-5"
        onSubmit={(event) => {
          event.preventDefault();
          if (canRun && !running) void start();
        }}
      >
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Task">
            <Select value={taskId} onChange={setTaskId} options={tasks} />
          </Field>
          <Field label="Architecture">
            <Select value={strategyId} onChange={setStrategyId} options={strategies} />
          </Field>
          <Field label="Model">
            <Select value={model} onChange={setModel} options={MODELS} />
          </Field>
        </div>

        <Field label="Your Anthropic API key">
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder="sk-ant-..."
            className="w-full rounded-[2px] border border-rule bg-plane px-3 py-2 font-mono text-[13px] text-ink outline-none focus:border-accent"
          />
          <p className="mt-2 text-[12px] leading-relaxed text-muted">
            The run is billed to this key and to no other. It is sent with this request, handed
            to the model subprocess, and never stored — the server explicitly clears its own
            credentials first, so a run here cannot fall back to the operator&apos;s account.
            Capped at $0.50 and four minutes.
          </p>
        </Field>

        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={!canRun || running}
            className="rounded-[2px] bg-accent px-4 py-2 text-[13px] text-white transition-opacity disabled:opacity-40"
          >
            {running ? 'Running…' : 'Run once'}
          </button>
          {running ? (
            <button
              type="button"
              onClick={stop}
              className="rounded-[2px] border border-rule px-3 py-2 text-[13px] text-ink-2 hover:bg-sunken"
            >
              Stop
            </button>
          ) : null}
          {running ? (
            <span className="font-mono text-[12px] text-muted">
              {events.length} event{events.length === 1 ? '' : 's'}
            </span>
          ) : null}
        </div>
      </form>

      {error ? (
        <p className="rounded-[3px] border border-bad/40 bg-bad/8 px-4 py-3 text-[13px] text-bad">
          {error}
        </p>
      ) : null}

      {result ? <ResultPanel result={result} /> : null}

      {events.length > 0 ? <EventFeed events={events} /> : null}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block font-mono text-[11px] uppercase tracking-[0.14em] text-muted">
        {label}
      </span>
      {children}
    </label>
  );
}

function Select({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (value: string) => void;
  options: LiveOption[];
}) {
  return (
    <select
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className="w-full rounded-[2px] border border-rule bg-plane px-3 py-2 text-[13px] text-ink outline-none focus:border-accent"
    >
      {options.map((option) => (
        <option key={option.id} value={option.id}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

function ResultPanel({ result }: { result: LiveResult }) {
  return (
    <section className="rounded-[3px] border border-rule bg-surface p-5">
      <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2">
        <span
          className={`font-mono text-[15px] ${result.passed ? 'text-good' : 'text-bad'}`}
        >
          {result.passed ? '✔ passed' : '✕ failed'} · score {result.score.toFixed(3)}
        </span>
        <Stat label="cost" value={`$${result.costUsd.toFixed(4)}`} />
        <Stat label="latency" value={`${(result.latencyMs / 1000).toFixed(1)}s`} />
        <Stat label="turns" value={String(result.turns)} />
        <Stat label="tool calls" value={String(result.toolCalls)} />
        {result.subagentCount > 0 ? (
          <Stat label="subagents" value={String(result.subagentCount)} />
        ) : null}
        {result.deniedToolCalls > 0 ? (
          <Stat label="blocked by guard" value={String(result.deniedToolCalls)} />
        ) : null}
        {result.failureMode !== 'none' ? (
          <Stat label="failure" value={result.failureMode} />
        ) : null}
      </div>

      {result.breakdown.length > 0 ? (
        <ul className="mt-4 flex flex-col gap-1.5 border-t border-rule pt-4">
          {result.breakdown.map((item) => (
            <li key={item.id} className="flex items-baseline gap-2 text-[13px]">
              <span className={item.earned >= 1 ? 'text-good' : 'text-bad'}>
                {item.earned >= 1 ? '✔' : '✕'}
              </span>
              <span className="text-ink-2">{item.label}</span>
              {item.earned > 0 && item.earned < 1 ? (
                <span className="font-mono text-[12px] text-muted">
                  {(item.earned * 100).toFixed(0)}%
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {result.penalties.map((penalty) => (
        <p key={penalty.id} className="mt-3 text-[13px] text-bad">
          Rule violated — {penalty.label}
        </p>
      ))}

      {result.finalText ? (
        <details className="mt-4 border-t border-rule pt-4">
          <summary className="cursor-pointer text-[13px] text-ink-2">Final answer</summary>
          <p className="mt-2 whitespace-pre-wrap font-serif text-[14px] leading-relaxed text-ink">
            {result.finalText}
          </p>
        </details>
      ) : null}
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <span className="font-mono text-[12px] text-muted">
      {label} <span className="text-ink">{value}</span>
    </span>
  );
}

function EventFeed({ events }: { events: TraceEvent[] }) {
  return (
    <section>
      <h2 className="mb-3 font-mono text-[11px] uppercase tracking-[0.14em] text-muted">
        Trace
      </h2>
      <ol className="flex flex-col gap-1 overflow-x-auto">
        {events.map((event) => (
          <li
            key={event.seq}
            className="flex gap-3 border-l-2 py-0.5 pl-3 text-[13px]"
            style={{
              marginLeft: `${event.depth * 1.25}rem`,
              borderColor: event.isError ? 'var(--bad)' : 'var(--rule)',
            }}
          >
            <span className="w-14 shrink-0 font-mono text-[11px] text-muted">
              {(event.tMs / 1000).toFixed(1)}s
            </span>
            <span className="w-28 shrink-0 truncate font-mono text-[11px] text-muted">
              {event.agent ?? event.phase}
            </span>
            <span className="min-w-0 flex-1">{describe(event)}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

function describe(event: TraceEvent): React.ReactNode {
  switch (event.kind) {
    case 'tool_call':
      return (
        <span className="font-mono text-[12px] text-accent">
          → {event.toolName}
          {event.toolInput ? (
            <span className="text-muted"> {truncate(JSON.stringify(event.toolInput), 120)}</span>
          ) : null}
        </span>
      );
    case 'tool_result':
      return (
        <span className={`font-mono text-[12px] ${event.isError ? 'text-bad' : 'text-muted'}`}>
          ← {truncate(event.text ?? '', 140)}
        </span>
      );
    case 'tool_denied':
      return (
        <span className="font-mono text-[12px] text-bad">
          ⨯ blocked by the sandbox guard: {event.toolName}
        </span>
      );
    case 'assistant_text':
      return <span className="text-ink">{truncate(event.text ?? '', 400)}</span>;
    case 'thinking':
      return <span className="italic text-muted">{truncate(event.text ?? '', 200)}</span>;
    case 'phase_start':
      return (
        <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-ink-2">
          {event.text ?? event.phase}
        </span>
      );
    case 'error':
      return <span className="text-bad">{truncate(event.text ?? '', 300)}</span>;
    default:
      return <span className="text-muted">{event.kind}</span>;
  }
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}
