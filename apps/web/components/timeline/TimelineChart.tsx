import type { CSSProperties } from 'react';

import { niceStep } from '../../lib/charts';
import { formatDuration, formatUsd } from '../../lib/format';
import type { Timeline, TimelineCall, TimelineTick } from '../../lib/timeline';
import { describeSubtype } from '../../lib/timeline';

/**
 * A run's model calls as a swimlane on one clock: one row per call, parallel
 * calls visibly side by side, subagents indented under the main thread, tool
 * calls as ticks, the guard's denials as red notches, and the run's spend as
 * a step line along the bottom.
 *
 * Plain HTML with percentage positions rather than a fixed-size SVG, so the
 * labels stay at their real size from a phone to a wide screen. No hooks, so
 * it renders on the server (strategy pages) and inside the client-side
 * explorer and replay, which pass `playhead` to hide what has not happened
 * yet and `onSelect` to make rows clickable.
 */
export function TimelineChart({
  timeline,
  color,
  playhead,
  selectedKey,
  onSelect,
  label,
}: {
  timeline: Timeline;
  /** The run's architecture colour; every bar wears it. */
  color: string;
  /** Milliseconds into the run; anything later is not drawn. Absent: the whole run. */
  playhead?: number;
  selectedKey?: string;
  onSelect?: (call: TimelineCall) => void;
  /** Accessible name for the figure. */
  label: string;
}) {
  const duration = Math.max(1, timeline.durationMs);
  const pct = (ms: number) => `${((Math.min(Math.max(ms, 0), duration) / duration) * 100).toFixed(3)}%`;
  const ticks = axisTicks(duration);
  const now = playhead ?? duration;

  return (
    <figure aria-label={label} className="timeline min-w-0">
      <div className="grid grid-cols-[minmax(0,1fr)] gap-y-1 sm:grid-cols-[minmax(7.5rem,11rem)_minmax(0,1fr)_auto] sm:gap-x-4">
        {/* Axis */}
        <span className="hidden sm:block" />
        <div className="relative h-5" aria-hidden>
          {ticks.map((tick) => (
            <span
              key={tick}
              className={`num absolute top-0 text-[0.6875rem] text-muted ${tick === 0 ? '' : '-translate-x-1/2'}`}
              style={{ left: pct(tick) }}
            >
              {axisLabel(tick, duration)}
            </span>
          ))}
        </div>
        <span className="hidden sm:block" />

        {timeline.calls.map((call) => (
          <Row
            key={call.key}
            call={call}
            color={color}
            pct={pct}
            now={now}
            ticks={ticks}
            selected={selectedKey === call.key}
            {...(onSelect ? { onSelect } : {})}
          />
        ))}

        {/* Spend */}
        <span className="eyebrow hidden self-center sm:block">Spend</span>
        <CostLine timeline={timeline} pct={pct} now={now} ticks={ticks} />
        <span className="num hidden self-center text-right text-[0.75rem] text-ink-2 sm:block">
          {formatUsd(spentBy(timeline, now))}
        </span>
      </div>
    </figure>
  );
}

function Row({
  call,
  color,
  pct,
  now,
  ticks,
  selected,
  onSelect,
}: {
  call: TimelineCall;
  color: string;
  pct: (ms: number) => string;
  now: number;
  ticks: number[];
  selected: boolean;
  onSelect?: (call: TimelineCall) => void;
}) {
  const started = now >= call.startMs;
  const running = started && now < call.endMs;
  const end = Math.min(call.endMs, now);
  const blind = call.serversDown.length > 0;
  const words = rowWords(call);

  const labelCell = (
    <span className="flex min-w-0 items-center gap-1.5 text-[0.8125rem] leading-tight">
      {call.depth > 0 ? (
        <span aria-hidden className="text-muted">
          ↳
        </span>
      ) : null}
      <span className={`truncate ${started ? 'text-ink' : 'text-muted'}`}>{call.label}</span>
      {blind && started ? <span className="chip-bad">no tools</span> : null}
      {call.degraded && !running && started ? <span className="chip-warn">fell back</span> : null}
    </span>
  );

  const track = (
    <span className="relative block h-[22px]">
      <Gridlines ticks={ticks} pct={pct} />
      {started ? (
        <span
          className={`tl-bar ${call.depth > 0 ? 'tl-bar-sub' : ''} tl-${call.status} ${
            blind ? 'tl-blind' : call.toolsOffered === 0 ? 'tl-toolless' : ''
          } ${
            call.degraded ? 'tl-degraded' : ''
          } ${running ? 'tl-running' : ''}`}
          style={
            {
              left: pct(call.startMs),
              width: `calc(${pct(end)} - ${pct(call.startMs)})`,
              '--bar': color,
            } as CSSProperties
          }
        >
          {call.ticks
            .filter((tick) => tick.tMs <= now)
            .map((tick) => (
              <Tick key={tick.seq} tick={tick} call={call} end={end} />
            ))}
        </span>
      ) : null}
    </span>
  );

  const numbers = (
    <span className="num hidden whitespace-nowrap text-right text-[0.75rem] text-muted sm:block">
      {started && !running ? `${formatDuration(call.endMs - call.startMs)} · ${formatUsd(call.costUsd)}` : ''}
    </span>
  );

  const content = (
    <>
      {labelCell}
      {track}
      {numbers}
    </>
  );

  const rowClass = `col-span-full grid grid-cols-subgrid items-center gap-y-0.5 rounded-[6px] px-1 -mx-1 ${
    selected ? 'bg-sunken ring-1 ring-rule-strong' : ''
  }`;

  if (onSelect) {
    return (
      <button
        type="button"
        onClick={() => onSelect(call)}
        aria-pressed={selected}
        aria-label={`${call.label}: ${words}`}
        title={words}
        className={`${rowClass} cursor-pointer text-left transition-colors hover:bg-sunken/70`}
      >
        {content}
      </button>
    );
  }
  return (
    <div className={rowClass} title={words}>
      <span className="sr-only">
        {call.label}: {words}
      </span>
      <span aria-hidden className="contents">
        {content}
      </span>
    </div>
  );
}

function Tick({ tick, call, end }: { tick: TimelineTick; call: TimelineCall; end: number }) {
  const span = Math.max(1, end - call.startMs);
  const left = `${(((tick.tMs - call.startMs) / span) * 100).toFixed(3)}%`;
  return <span aria-hidden className={`tl-tick tl-tick-${tick.kind}`} style={{ left }} title={tick.label} />;
}

function Gridlines({ ticks, pct }: { ticks: number[]; pct: (ms: number) => string }) {
  return (
    <>
      {ticks.map((tick) => (
        <span key={tick} aria-hidden className="absolute inset-y-0 w-px bg-[var(--grid)]" style={{ left: pct(tick) }} />
      ))}
    </>
  );
}

/** Cumulative spend as a step line under the lanes, drawn up to the playhead. */
function CostLine({
  timeline,
  pct,
  now,
  ticks,
}: {
  timeline: Timeline;
  pct: (ms: number) => string;
  now: number;
  ticks: number[];
}) {
  const total = Math.max(timeline.totalCostUsd, 1e-9);
  const duration = Math.max(1, timeline.durationMs);
  const points = timeline.cost.filter((point) => point.tMs <= now);
  const x = (ms: number) => (Math.min(ms, duration) / duration) * 100;
  const y = (usd: number) => 22 - (usd / total) * 20;
  let d = `M 0 ${y(0)}`;
  for (const point of points) d += ` H ${x(point.tMs)} V ${y(point.usd)}`;
  d += ` H ${x(Math.min(now, duration))}`;

  return (
    <span className="relative block h-[26px] border-t border-rule" aria-hidden>
      <Gridlines ticks={ticks} pct={pct} />
      <svg viewBox="0 0 100 24" preserveAspectRatio="none" className="absolute inset-0 h-full w-full overflow-visible">
        <path d={`${d} V 24 H 0 Z`} fill="var(--ink-2)" opacity={0.08} />
        <path d={d} fill="none" stroke="var(--ink-2)" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
      </svg>
    </span>
  );
}

function spentBy(timeline: Timeline, now: number): number {
  let usd = 0;
  for (const point of timeline.cost) if (point.tMs <= now) usd = point.usd;
  return usd;
}

function rowWords(call: TimelineCall): string {
  const parts = [
    `${formatDuration(call.startMs)} to ${formatDuration(call.endMs)}`,
    describeSubtype(call.subtype),
    `${call.toolCalls} tool call${call.toolCalls === 1 ? '' : 's'}`,
  ];
  const denied = call.ticks.filter((tick) => tick.kind === 'denied').length;
  if (denied > 0) parts.push(`${denied} denied by the guard`);
  if (call.serversDown.length > 0) parts.push(`no tools: ${call.serversDown.join(', ')} did not connect`);
  if (call.degraded) parts.push(`fell back: ${call.degraded}`);
  parts.push(formatUsd(call.costUsd));
  return parts.join(', ');
}

function axisTicks(duration: number): number[] {
  const step = niceStep(duration / 1000, 6) * 1000;
  const ticks: number[] = [];
  for (let t = 0; t <= duration + 1; t += step) ticks.push(Math.round(t));
  return ticks;
}

function axisLabel(ms: number, duration: number): string {
  if (ms === 0) return '0s';
  return duration < 10_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms / 1000)}s`;
}
