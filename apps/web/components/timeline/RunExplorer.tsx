'use client';

import type { RefObject } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { formatDuration, formatUsd } from '../../lib/format';
import type { Timeline, TimelineCall } from '../../lib/timeline';
import { costAt } from '../../lib/timeline';
import type { ViewGroup, ViewItem } from '../../lib/traceView';
import { joinGroups } from '../../lib/traceView';
import { EventDetail } from './EventDetail';
import type { Selection } from './EventList';
import { EventList, ItemSummary } from './EventList';
import { TimelineChart } from './TimelineChart';
import { useReducedMotion } from './useReducedMotion';

export type ExplorerView = 'explore' | 'replay';

/**
 * A recorded run, explored or replayed.
 *
 * Explore: the swimlane over the whole run, then the deduplicated event list
 * with a detail panel. Replay: the same swimlane drawn up to a playhead that
 * moves at 1× or 8× real time, with the events appearing as they happened.
 * Both read the same two structures, built on the server from the trace.
 */
export function RunExplorer({
  timeline,
  groups,
  color,
  label,
  initialView = 'explore',
  autoplay = false,
}: {
  timeline: Timeline;
  groups: ViewGroup[];
  color: string;
  label: string;
  initialView?: ExplorerView;
  autoplay?: boolean;
}) {
  const [view, setView] = useState<ExplorerView>(initialView);
  const pairs = useMemo(() => joinGroups(timeline.calls, groups), [timeline, groups]);
  const root = useRef<HTMLDivElement>(null);
  const playback = usePlayback(timeline.durationMs, initialView === 'replay' && autoplay, root);
  // An event picked in the replay opens in Explore, selected.
  const [inspecting, setInspecting] = useState<Selection | null>(null);

  return (
    <div ref={root} className="card overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-rule px-4 py-3 sm:px-5">
        <div role="group" aria-label="View" className="segmented">
          {(['explore', 'replay'] as const).map((id) => (
            <button
              key={id}
              type="button"
              aria-pressed={view === id}
              onClick={() => {
                setView(id);
                if (id === 'explore') {
                  playback.pause();
                  setInspecting(null);
                }
              }}
              className="segmented-item"
            >
              {id === 'explore' ? 'Explore' : 'Replay'}
            </button>
          ))}
        </div>
        <p className="num text-[0.75rem] text-muted">
          {timeline.calls.length} call{timeline.calls.length === 1 ? '' : 's'} · {formatDuration(timeline.durationMs)} ·{' '}
          {formatUsd(timeline.totalCostUsd)}
        </p>
      </div>

      {view === 'explore' ? (
        <Explore timeline={timeline} pairs={pairs} color={color} label={label} {...(inspecting ? { initial: inspecting } : {})} />
      ) : (
        <Replay
          timeline={timeline}
          pairs={pairs}
          color={color}
          label={label}
          playback={playback}
          onInspect={(selection) => {
            playback.pause();
            setInspecting(selection);
            setView('explore');
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Explore
// ---------------------------------------------------------------------------

function Explore({
  timeline,
  pairs,
  color,
  label,
  initial,
}: {
  timeline: Timeline;
  pairs: { call: TimelineCall; group: ViewGroup }[];
  color: string;
  label: string;
  /** What to open on: an event picked in the replay. */
  initial?: Selection;
}) {
  // Open on what was asked for, else on the first thing that went wrong, if anything did.
  const firstProblem = pairs.find(
    ({ call }) => call.status === 'failed' || call.serversDown.length > 0 || call.degraded,
  );
  const [selection, setSelection] = useState<Selection | null>(
    initial ?? (firstProblem ? { key: firstProblem.call.key } : null),
  );

  useEffect(() => {
    if (!initial) return;
    const id = initial.seq === undefined ? `call-${initial.key}` : `event-${initial.seq}`;
    document.getElementById(id)?.scrollIntoView({ block: 'center' });
  }, [initial]);
  const [open, setOpen] = useState<Set<string>>(() => new Set(pairs.map(({ call }) => call.key)));

  const toggle = useCallback((key: string) => {
    setOpen((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const selectCall = useCallback((call: TimelineCall) => {
    setSelection({ key: call.key });
    setOpen((previous) => new Set(previous).add(call.key));
    document.getElementById(`call-${call.key}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, []);

  const detail = (target: Selection) => {
    const pair = pairs.find(({ call }) => call.key === target.key);
    if (!pair) return null;
    const item = target.seq === undefined ? undefined : pair.group.items.find((i) => i.seq === target.seq);
    return <EventDetail call={pair.call} group={pair.group} {...(item ? { item } : {})} />;
  };

  return (
    <>
      <div className="border-b border-rule px-4 py-5 sm:px-5">
        <TimelineChart
          timeline={timeline}
          color={color}
          label={label}
          {...(selection ? { selectedKey: selection.key } : {})}
          onSelect={selectCall}
        />
        <Legend />
      </div>
      <div className="grid grid-cols-[minmax(0,1fr)] gap-6 bg-plane/40 px-3 py-5 sm:px-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,25rem)]">
        <EventList
          pairs={pairs}
          selection={selection}
          onSelect={setSelection}
          open={open}
          onToggle={toggle}
          renderDetail={detail}
        />
        <aside aria-label="Selected event" className="hidden lg:block">
          <div className="sticky top-20 max-h-[calc(100dvh-6rem)] overflow-y-auto rounded-[12px] border border-rule bg-surface p-5">
            {selection ? (
              detail(selection)
            ) : (
              <p className="text-[0.875rem] leading-relaxed text-muted">
                Select a call in the swimlane or an event in the list to see everything recorded about it: the
                arguments, the answer, what the guard refused.
              </p>
            )}
          </div>
        </aside>
      </div>
    </>
  );
}

function Legend() {
  return (
    <ul className="mt-4 flex flex-wrap gap-x-5 gap-y-2 text-[0.75rem] text-ink-2">
      <li className="flex items-center gap-1.5">
        <span aria-hidden className="legend-tick bg-ink-2" />
        tool call
      </li>
      <li className="flex items-center gap-1.5">
        <span aria-hidden className="legend-tick legend-tick-tall bg-bad" />
        denied by the guard
      </li>
      <li className="flex items-center gap-1.5">
        <span aria-hidden className="legend-tick legend-tick-tall bg-warn" />
        tool returned an error
      </li>
      <li className="flex items-center gap-1.5">
        <span aria-hidden className="legend-swatch legend-toolless" />
        shown no tools (reasoning only)
      </li>
      <li className="flex items-center gap-1.5">
        <span aria-hidden className="legend-swatch legend-blind" />
        lost its tools (server failed)
      </li>
      <li className="flex items-center gap-1.5">
        <span aria-hidden className="legend-swatch legend-failed" />
        failed
      </li>
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

interface Playback {
  t: number;
  playing: boolean;
  speed: 1 | 8;
  duration: number;
  play: () => void;
  pause: () => void;
  seek: (t: number) => void;
  setSpeed: (speed: 1 | 8) => void;
}

function usePlayback(duration: number, autoplay: boolean, root: RefObject<HTMLElement | null>): Playback {
  const reduced = useReducedMotion();
  const [t, setT] = useState(autoplay ? 0 : duration);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<1 | 8>(8);
  const tRef = useRef(t);
  tRef.current = t;

  // Autoplay only for readers who have not asked for less motion; they get
  // the finished run and a play button. It starts when the player is on
  // screen: a replay lower on the page would otherwise have ended unseen.
  useEffect(() => {
    if (!autoplay) return;
    if (reduced) {
      setT(duration);
      return;
    }
    const element = root.current;
    if (!element || typeof IntersectionObserver === 'undefined') {
      setPlaying(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        setPlaying(true);
        observer.disconnect();
      },
      // Not the bottom quarter of the screen: a player only peeking in is not yet being read.
      { rootMargin: '0px 0px -25% 0px' },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [autoplay, reduced, duration, root]);

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

  return {
    t,
    playing,
    speed,
    duration,
    play: () => {
      if (tRef.current >= duration) {
        tRef.current = 0;
        setT(0);
      }
      setPlaying(true);
    },
    pause: () => setPlaying(false),
    seek: (value: number) => {
      tRef.current = value;
      setT(value);
    },
    setSpeed,
  };
}

function Replay({
  timeline,
  pairs,
  color,
  label,
  playback,
  onInspect,
}: {
  timeline: Timeline;
  pairs: { call: TimelineCall; group: ViewGroup }[];
  color: string;
  label: string;
  playback: Playback;
  /** Open one event in Explore. */
  onInspect: (selection: Selection) => void;
}) {
  const { t } = playback;
  const feed = useMemo(() => {
    const items: { call: TimelineCall; item: ViewItem }[] = [];
    for (const { call, group } of pairs) for (const item of group.items) items.push({ call, item });
    return items.sort((a, b) => a.item.tMs - b.item.tMs || a.item.seq - b.item.seq);
  }, [pairs]);
  const shown = feed.filter(({ item }) => item.tMs <= t);
  const box = useRef<HTMLOListElement>(null);

  useEffect(() => {
    const element = box.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [shown.length]);

  return (
    <div className="flex flex-col gap-5 px-4 py-5 sm:px-5">
      <ReplayControls playback={playback} spent={costAt(timeline, t)} />
      <TimelineChart timeline={timeline} color={color} label={label} playhead={t} />
      <section aria-label="Events so far" className="rounded-[12px] border border-rule bg-plane/50">
        <p className="eyebrow flex items-center justify-between border-b border-rule px-4 py-2 !text-[0.6875rem]">
          <span>Events as they happened</span>
          <span className="num normal-case tracking-normal">
            {shown.length} / {feed.length}
          </span>
        </p>
        <ol ref={box} tabIndex={0} aria-label="Events so far, scrollable" className="max-h-[22rem] overflow-y-auto">
          {shown.length === 0 ? <li className="px-4 py-3 text-[0.8125rem] text-muted">Nothing has happened yet.</li> : null}
          {shown.map(({ call, item }) => (
            <li key={item.seq} className={`border-b border-rule/60 last:border-0 ${call.depth > 0 ? 'bg-sunken/40' : ''}`}>
              <button
                type="button"
                onClick={() => onInspect({ key: call.key, seq: item.seq })}
                title="Open this event in Explore"
                className="grid w-full cursor-pointer grid-cols-[3.25rem_minmax(0,1fr)] gap-x-3 px-4 py-2 text-left hover:bg-sunken/70"
              >
                <span className="num pt-0.5 text-[0.6875rem] text-muted">{formatDuration(item.tMs)}</span>
                <span className="min-w-0">
                  <span className="eyebrow mb-1 block !text-[0.6875rem]">{call.label}</span>
                  <ItemSummary item={item} />
                </span>
              </button>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}

export function ReplayControls({ playback, spent }: { playback: Playback; spent: number }) {
  const { t, playing, speed, duration } = playback;
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
      <button
        type="button"
        onClick={playing ? playback.pause : playback.play}
        className="btn btn-primary !min-h-0 !px-4 !py-2"
        aria-label={playing ? 'Pause the replay' : t >= duration ? 'Replay from the start' : 'Play the replay'}
      >
        <span aria-hidden className="w-3 text-center">
          {playing ? '❚❚' : t >= duration ? '↺' : '▶'}
        </span>
        {playing ? 'Pause' : t >= duration ? 'Replay' : 'Play'}
      </button>
      <div role="group" aria-label="Speed" className="segmented">
        {([1, 8] as const).map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={speed === value}
            onClick={() => playback.setSpeed(value)}
            className="segmented-item num"
          >
            {value}×
          </button>
        ))}
      </div>
      <label className="flex min-w-[12rem] flex-1 items-center gap-3">
        <span className="sr-only">Position in the run</span>
        <input
          type="range"
          min={0}
          max={duration}
          step={Math.max(1, Math.round(duration / 500))}
          value={Math.round(t)}
          onChange={(event) => {
            playback.pause();
            playback.seek(Number(event.target.value));
          }}
          className="scrubber w-full"
        />
      </label>
      <span className="num whitespace-nowrap text-[0.8125rem] text-ink-2" role="timer" aria-live="off">
        {formatDuration(t)} / {formatDuration(duration)}
      </span>
      <span className="num whitespace-nowrap text-[0.8125rem] text-ink">
        <span className="eyebrow mr-1.5 !text-[0.6875rem]">spent</span>
        {formatUsd(spent)}
      </span>
    </div>
  );
}
