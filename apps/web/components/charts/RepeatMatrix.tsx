import Link from 'next/link';
import type { CSSProperties } from 'react';

import { architectureName } from '../../lib/architectures';
import type { RepeatCell, RunOutcome } from '../../lib/derive';
import { formatDuration, formatFailureMode, formatScore, formatUsd } from '../../lib/format';
import type { Difficulty } from '../../lib/records';
import { ArchitectureColumnHeader, ArchitectureKey, architectureGridClass } from './ArchitectureColumns';
import { Readout } from './Readout';

const OUTCOME: Record<RunOutcome, { label: string; style: CSSProperties }> = {
  pass: {
    label: 'passed',
    style: { background: 'var(--good)', borderColor: 'var(--good)' },
  },
  partial: {
    label: 'partial credit',
    style: {
      background: 'linear-gradient(135deg, var(--warn) 0 50%, transparent 50% 100%)',
      borderColor: 'var(--warn)',
    },
  },
  fail: {
    label: 'failed',
    style: { background: 'transparent', borderColor: 'var(--bad)', borderWidth: 2 },
  },
  excluded: {
    label: 'excluded: integrity check failed',
    style: {
      background:
        'repeating-linear-gradient(135deg, var(--muted) 0 1.5px, transparent 1.5px 4px)',
      borderColor: 'var(--muted)',
    },
  },
  api_error: {
    label: 'excluded: API error',
    style: { background: 'transparent', borderColor: 'var(--muted)', borderStyle: 'dotted', borderWidth: 2 },
  },
};

export interface RepeatMatrixTask {
  id: string;
  title: string;
  difficulty: Difficulty;
  world: string;
}

/** The task heading gets a column of its own only from `lg`. */
const ROW = architectureGridClass('lg:grid-cols-[minmax(13rem,19rem)_repeat(var(--arch-count),minmax(0,1fr))]');

/**
 * Every run as a square, per task and architecture: pass, partial, fail, or
 * excluded and why. At three repeats a mean hides whether a cell is "always
 * 0.67" or "one perfect run and one zero"; the squares show which, and each
 * one links to its run. Outcome is carried by fill pattern as well as
 * colour, so it survives greyscale and colour blindness.
 *
 * A grid with table semantics rather than a <table>, so that on a phone each
 * task's heading can sit above its six cells and every architecture stays in
 * view without a sideways scroll; the glyph headings then stick to the top
 * of the screen while the tasks scroll under them.
 */
export function RepeatMatrix({
  tasks,
  architectures,
  cells,
}: {
  tasks: RepeatMatrixTask[];
  architectures: string[];
  /** Keyed by `${architecture}::${taskId}`. */
  cells: Record<string, RepeatCell[]>;
}) {
  return (
    <figure>
      <ArchitectureKey architectures={architectures} className="mb-4" />
      <Readout prompt="Point at a square or tab to it to read its run. Each square opens its run.">
        <div
          role="table"
          aria-label="Every run, one square per repeat, by task and architecture"
          className="rounded-[14px] border border-rule bg-surface text-[0.875rem]"
          style={{ '--arch-count': architectures.length } as CSSProperties}
        >
          <div
            role="rowgroup"
            className="sticky top-0 z-10 rounded-t-[13px] border-b border-rule bg-surface/95 backdrop-blur sm:static sm:bg-surface sm:backdrop-blur-none"
          >
            <div role="row" className={ROW}>
              <div role="columnheader" className="sr-only lg:not-sr-only">
                <span className="flex h-full items-end px-4 py-3">
                  <span className="eyebrow">Task</span>
                </span>
              </div>
              {architectures.map((id) => (
                <ArchitectureColumnHeader key={id} id={id} />
              ))}
            </div>
          </div>
          <div role="rowgroup">
            {tasks.map((task) => (
              <div role="row" key={task.id} className={`${ROW} border-b border-rule last:border-0`}>
                <div role="rowheader" className="col-span-full min-w-0 px-4 pb-1 pt-3 lg:col-span-1 lg:py-2.5">
                  <Link href={`/tasks/${task.id}/`} title={task.title} className="group block min-w-0">
                    <span className="block text-ink group-hover:underline lg:truncate">{task.title}</span>
                    <span className="eyebrow block !text-[0.6875rem]">
                      {task.world} · {task.difficulty}
                    </span>
                  </Link>
                </div>
                {architectures.map((id) => (
                  <div role="cell" key={id} className="flex items-center justify-center px-1 pb-3 pt-1.5 lg:py-2.5">
                    <Squares runs={cells[`${id}::${task.id}`] ?? []} architecture={id} task={task.title} />
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      </Readout>
      <figcaption className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-[0.8125rem] text-ink-2">
        {(Object.keys(OUTCOME) as RunOutcome[]).map((outcome) => (
          <span key={outcome} className="inline-flex items-center gap-1.5">
            <span aria-hidden className="block h-3 w-3 rounded-[3px] border" style={OUTCOME[outcome].style} />
            {OUTCOME[outcome].label}
          </span>
        ))}
        <span className="text-muted">One square per run; each opens its run.</span>
      </figcaption>
    </figure>
  );
}

function Squares({ runs, architecture, task }: { runs: RepeatCell[]; architecture: string; task: string }) {
  if (runs.length === 0) {
    return (
      <span className="text-muted">
        <span aria-hidden>–</span>
        <span className="sr-only">not run</span>
      </span>
    );
  }
  const name = architectureName(architecture);
  return (
    <span className="flex flex-wrap justify-center gap-[3px]">
      {runs.map((run) => (
        <Link
          key={run.runId}
          href={`/runs/${run.runId}/`}
          data-readout-title={`${name} on ${task}, repeat ${run.repeat}`}
          data-readout-detail={detailOf(run)}
          aria-label={`${name}, repeat ${run.repeat}: ${detailOf(run)}`}
          className="block h-3 w-3 rounded-[3px] border transition-transform hover:scale-125 focus-visible:scale-125 sm:h-3.5 sm:w-3.5"
          style={OUTCOME[run.outcome].style}
        />
      ))}
    </span>
  );
}

function detailOf(run: RepeatCell): string {
  const parts = [
    OUTCOME[run.outcome].label,
    `score ${formatScore(run.score)}`,
    formatUsd(run.costUsd),
    formatDuration(run.latencyMs),
  ];
  if (run.outcome !== 'pass' && run.failureMode !== 'none') parts.push(formatFailureMode(run.failureMode));
  return parts.join(' · ');
}
