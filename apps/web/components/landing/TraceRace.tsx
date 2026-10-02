'use client';

import type { CSSProperties } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { niceStep } from '../../lib/charts';
import { formatDuration, formatScore, formatUsd } from '../../lib/format';
import type { Timeline } from '../../lib/timeline';
import { costAt, packLanes } from '../../lib/timeline';
import { ArchitectureGlyph } from '../ArchitectureGlyph';
import Link from '../Link';
import { useReducedMotion } from '../timeline/useReducedMotion';

export interface RaceLane {
  strategyId: string;
  name: string;
  /** The design in words, under the name. */
  shape: string;
  color: string;
  timeline: Timeline;
  /** Present for recorded runs; a schematic has no outcome to stamp. */
  outcome?: { score: number; passed: boolean; costUsd: number; latencyMs: number; runId: string };
}

const MAIN = 8;
const SUB = 5;
const GAP = 3;

/**
 * The same task, one lane per architecture, replayed together on one clock.
 *
 * Each lane packs its architecture's model calls into rows: the main thread
 * on top, parallel subagents opening below it and closing again, tool calls
 * as notches, the guard's denials in red. It plays once when it scrolls into
 * view, stamps each lane with its result as it finishes, and then waits for
 * the reader. Readers who asked for less motion get the finished race.
 */
export function TraceRace({
  lanes,
  speed,
  recorded,
}: {
  lanes: RaceLane[];
  /** Clock multiplier: a recorded minute at 8× takes 7.5 seconds. */
  speed: number;
  /** False for the schematic: no numbers are shown, because there are none. */
  recorded: boolean;
}) {
  const duration = Math.max(1, ...lanes.map((lane) => lane.timeline.durationMs));
  const reduced = useReducedMotion();
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const started = useRef(false);
  const root = useRef<HTMLDivElement>(null);
  const tRef = useRef(0);
  tRef.current = t;

  // Play once, the first time the race is on screen.
  useEffect(() => {
    if (reduced) {
      setT(duration);
      return;
    }
    const element = root.current;
    if (!element) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting) && !started.current) {
          started.current = true;
          setPlaying(true);
        }
      },
      { threshold: 0.35 },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [reduced, duration]);

  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    let last = performance.now();
    const step = (now: number) => {
      const next = Math.min(duration, tRef.current + (now - last) * speed);
      last = now;
      tRef.current = next;
      setT(next);
      if (next >= duration) {
        setPlaying(false);
        return;
      }
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [playing, speed, duration]);

  const ticks = useMemo(() => {
    const unit = niceStep(duration / 1000, 6) * 1000;
    const out: number[] = [];
    for (let v = 0; v <= duration; v += unit) out.push(v);
    return out;
  }, [duration]);
  const pct = (ms: number) => `${((Math.min(ms, duration) / duration) * 100).toFixed(3)}%`;
  const finished = t >= duration;

  return (
    <div ref={root} className="min-w-0">
      <div className="flex flex-wrap items-center gap-3 border-b border-rule px-4 py-3 sm:px-5">
        <button
          type="button"
          onClick={() => {
            if (playing) {
              setPlaying(false);
              return;
            }
            if (finished) {
              tRef.current = 0;
              setT(0);
            }
            started.current = true;
            setPlaying(true);
          }}
          className="btn btn-secondary !min-h-0 !px-3.5 !py-1.5 text-[0.8125rem]"
          aria-label={playing ? 'Pause the race' : finished ? 'Run the race again' : 'Play the race'}
        >
          <span aria-hidden className="w-3 text-center">
            {playing ? '❚❚' : finished ? '↺' : '▶'}
          </span>
          {playing ? 'Pause' : finished ? 'Again' : 'Play'}
        </button>
        <span className="num text-[0.8125rem] text-ink-2">
          {recorded ? `${formatDuration(t)} · ${speed}× speed` : `${speed}× schematic`}
        </span>
        <span className="relative ml-auto hidden h-1 w-40 overflow-hidden rounded-full bg-rule sm:block" aria-hidden>
          <span className="absolute inset-y-0 left-0 rounded-full bg-ink-2" style={{ width: pct(t) }} />
        </span>
      </div>

      <div
        role="group"
        aria-label={
          recorded
            ? `The same task run by ${lanes.length} architectures, replayed together: ${lanes
                .map((lane) => `${lane.name} took ${formatDuration(lane.timeline.durationMs)}`)
                .join(', ')}.`
            : `A schematic of how ${lanes.length} architectures run a task: which calls run in parallel and in which order.`
        }
        className="px-4 pb-4 pt-3 sm:px-5"
      >
        <div className={`${recorded ? 'sm:grid' : ''} hidden grid-cols-[minmax(0,14rem)_minmax(0,1fr)_8.5rem] gap-x-5 pb-1`} aria-hidden>
          <span />
          <span className="relative h-4">
            {ticks.map((tick) => (
              <span
                key={tick}
                className={`num absolute top-0 text-[0.6875rem] text-muted ${tick === 0 ? '' : '-translate-x-1/2'}`}
                style={{ left: pct(tick) }}
              >
                {Math.round(tick / 1000)}s
              </span>
            ))}
          </span>
          <span />
        </div>
        <ol className="flex flex-col">
          {lanes.map((lane) => (
            <Lane key={lane.strategyId} lane={lane} t={t} pct={pct} ticks={ticks} recorded={recorded} />
          ))}
        </ol>
      </div>
    </div>
  );
}

function Lane({
  lane,
  t,
  pct,
  ticks,
  recorded,
}: {
  lane: RaceLane;
  t: number;
  pct: (ms: number) => string;
  ticks: number[];
  recorded: boolean;
}) {
  const { lanes, laneOf } = useMemo(() => packLanes(lane.timeline.calls), [lane.timeline]);
  const top = (row: number) => (row === 0 ? 0 : MAIN + GAP + (row - 1) * (SUB + GAP));
  const height = top(lanes - 1) + (lanes > 1 ? SUB : MAIN);
  const done = t >= lane.timeline.durationMs;
  const outcome = lane.outcome;
  const denied = lane.timeline.calls.some((call) => call.ticks.some((tick) => tick.kind === 'denied' && tick.tMs <= t));

  return (
    <li className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 border-t border-rule py-3 first:border-0 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)_8.5rem] sm:gap-x-5">
      <div className="flex min-w-0 items-center gap-3">
        <ArchitectureGlyph id={lane.strategyId} width={44} className="shrink-0" />
        <div className="min-w-0">
          <p className="truncate text-[0.875rem] font-medium text-ink">{lane.name}</p>
          <p className="hidden text-[0.75rem] leading-snug text-muted sm:line-clamp-2">{lane.shape}</p>
        </div>
      </div>

      <div className="relative col-span-full row-start-2 sm:col-span-1 sm:row-start-auto" style={{ height: Math.max(height, MAIN) + 8 }}>
        {ticks.map((tick) => (
          <span key={tick} aria-hidden className="absolute inset-y-0 w-px bg-[var(--grid)]" style={{ left: pct(tick) }} />
        ))}
        {lane.timeline.calls.map((call) => {
          if (t < call.startMs) return null;
          const row = laneOf.get(call.key) ?? 0;
          const end = Math.min(call.endMs, t);
          const running = t < call.endMs;
          const blind = call.serversDown.length > 0;
          const span = Math.max(1, end - call.startMs);
          return (
            <span
              key={call.key}
              title={call.label}
              className={`tl-bar tl-${call.status} ${blind ? 'tl-blind' : call.toolsOffered === 0 ? 'tl-toolless' : ''} ${
                running ? 'tl-running' : ''
              }`}
              style={
                {
                  left: pct(call.startMs),
                  width: `calc(${pct(end)} - ${pct(call.startMs)})`,
                  top: 4 + top(row),
                  height: row === 0 ? MAIN : SUB,
                  '--bar': lane.color,
                  '--tl-fill': call.status === 'failed' ? 0.38 : row === 0 ? 1 : 0.75,
                } as CSSProperties
              }
            >
              {call.ticks
                .filter((tick) => tick.tMs <= t)
                .map((tick) => (
                  <span
                    key={tick.seq}
                    aria-hidden
                    className={`tl-tick tl-tick-${tick.kind}`}
                    style={{ left: `${(((tick.tMs - call.startMs) / span) * 100).toFixed(3)}%` }}
                  />
                ))}
            </span>
          );
        })}
      </div>

      <div className="text-right">
        {done ? (
          recorded && outcome ? (
            <Link href={`/runs/${outcome.runId}/`} className="group inline-flex flex-col items-end leading-tight">
              <span className={`num text-[0.9375rem] ${STAMP[stampOf(outcome)].className}`}>
                <span aria-hidden>{STAMP[stampOf(outcome)].glyph}</span>
                <span className="sr-only">{STAMP[stampOf(outcome)].words}, score </span> {formatScore(outcome.score)}
              </span>
              <span className="num text-[0.6875rem] text-muted group-hover:text-ink-2">
                {formatUsd(outcome.costUsd)} · {formatDuration(outcome.latencyMs)}
              </span>
            </Link>
          ) : (
            <span className="text-[0.75rem] leading-tight text-muted">{designWords(lane)}</span>
          )
        ) : recorded ? (
          <span className={`num text-[0.75rem] ${denied ? 'text-bad' : 'text-ink-2'}`}>
            {formatUsd(costAt(lane.timeline, t))}
          </span>
        ) : null}
      </div>
    </li>
  );
}

/**
 * How a finished lane is stamped. A score short of full credit is partial
 * credit, not a failure, and is drawn as the matrix draws it (amber, not red).
 */
const STAMP = {
  pass: { glyph: '✓', words: 'passed', className: 'text-good' },
  partial: { glyph: '◐', words: 'partial credit', className: 'text-warn' },
  fail: { glyph: '✗', words: 'failed', className: 'text-bad' },
} as const;

function stampOf(outcome: { passed: boolean; score: number }): keyof typeof STAMP {
  if (outcome.passed) return 'pass';
  return outcome.score > 0 ? 'partial' : 'fail';
}

/** What a schematic lane shows when it finishes: the design's shape in counts. */
function designWords(lane: RaceLane): string {
  const calls = lane.timeline.calls.length;
  const parallel = lane.timeline.calls.filter((call) => call.depth > 0).length;
  return `${calls} call${calls === 1 ? '' : 's'}${parallel > 0 ? `, ${parallel} in parallel` : ''}`;
}
