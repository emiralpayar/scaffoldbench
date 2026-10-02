'use client';

import { useState } from 'react';

import { formatScore } from '../../lib/format';
import type { Timeline } from '../../lib/timeline';
import type { ViewGroup } from '../../lib/traceView';
import { ArchitectureGlyph } from '../ArchitectureGlyph';
import Link from '../Link';
import { RunExplorer } from './RunExplorer';

export interface ReplayEntry {
  runId: string;
  strategyId: string;
  name: string;
  color: string;
  timeline: Timeline;
  groups: ViewGroup[];
  score: number;
  passed: boolean;
  /**
   * Where the whole run can be read: its page when the published run set has
   * one, its record in the repository when the replay is of another set, and
   * nothing when neither exists.
   */
  href?: string | undefined;
}

/**
 * Recorded runs of one task, one architecture at a time: pick a design and
 * watch its run play back at 8× real time.
 */
export function ReplayGallery({ entries, initial }: { entries: ReplayEntry[]; initial: string }) {
  const [selected, setSelected] = useState(initial);
  const entry = entries.find((e) => e.runId === selected) ?? entries[0];
  if (!entry) return null;

  return (
    <div className="flex flex-col gap-5">
      <div role="group" aria-label="Architecture to replay" className="flex flex-wrap gap-2">
        {entries.map((option) => {
          const checked = option.runId === entry.runId;
          return (
            <button
              key={option.runId}
              type="button"
              aria-pressed={checked}
              onClick={() => setSelected(option.runId)}
              className={`flex cursor-pointer items-center gap-2.5 rounded-full border py-1.5 pl-2 pr-3.5 text-[0.875rem] transition-colors ${
                checked ? 'border-ink bg-surface text-ink' : 'border-rule-strong text-ink-2 hover:border-ink-2 hover:text-ink'
              }`}
            >
              <ArchitectureGlyph id={option.strategyId} width={30} />
              {option.name}
              <span className={`num text-[0.75rem] ${option.passed ? 'text-good' : 'text-muted'}`}>
                {formatScore(option.score)}
              </span>
            </button>
          );
        })}
      </div>
      <RunExplorer
        key={entry.runId}
        timeline={entry.timeline}
        groups={entry.groups}
        color={entry.color}
        label={`Replay of ${entry.name}: one row per model call.`}
        initialView="replay"
        autoplay
      />
      <p className="text-[0.875rem] text-ink-2">
        {entry.href?.startsWith('/') ? 'Every message, tool call and denial of this run is on its own page: ' : 'This run: '}
        {entry.href?.startsWith('/') ? (
          <Link href={entry.href} className="link font-mono text-[0.8125rem]">
            {entry.runId}
          </Link>
        ) : entry.href ? (
          <a href={entry.href} className="link font-mono text-[0.8125rem]">
            {entry.runId}
          </a>
        ) : (
          <span className="font-mono text-[0.8125rem]">{entry.runId}</span>
        )}
      </p>
    </div>
  );
}
