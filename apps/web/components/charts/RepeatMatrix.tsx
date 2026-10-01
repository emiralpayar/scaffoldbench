import Link from 'next/link';
import type { CSSProperties } from 'react';

import { architectureName } from '../../lib/architectures';
import type { RepeatCell, RunOutcome } from '../../lib/derive';
import type { Difficulty } from '../../lib/records';
import { ArchitectureGlyph } from '../ArchitectureGlyph';

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

/**
 * Every run as a square, per task and architecture: pass, partial, fail, or
 * excluded and why. At three repeats a mean hides whether a cell is "always
 * 0.67" or "one perfect run and one zero"; the squares show which, and each
 * one links to its trace. Outcome is carried by fill pattern as well as
 * colour, so it survives greyscale and colour blindness.
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
      <div className="scroll-x rounded-[14px] border border-rule bg-surface">
        <table className="w-full border-collapse text-[0.875rem]">
          <thead>
            <tr className="border-b border-rule">
              <th scope="col" className="sticky left-0 z-10 bg-surface px-4 py-3 text-left align-bottom">
                <span className="eyebrow">Task</span>
              </th>
              {architectures.map((id) => (
                <th key={id} scope="col" className="px-2 py-3 align-bottom font-normal">
                  <span className="flex flex-col items-center gap-1.5">
                    <ArchitectureGlyph id={id} width={34} />
                    <span className="whitespace-nowrap text-[0.75rem] text-ink-2">{architectureName(id)}</span>
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {tasks.map((task) => (
              <tr key={task.id} className="border-b border-rule last:border-0">
                <th scope="row" className="sticky left-0 z-10 max-w-[15rem] bg-surface px-4 py-2.5 text-left font-normal">
                  <Link href={`/tasks/${task.id}/`} className="block min-w-0">
                    <span className="block truncate text-ink hover:underline">{task.title}</span>
                    <span className="eyebrow block !text-[0.6875rem]">
                      {task.world} · {task.difficulty}
                    </span>
                  </Link>
                </th>
                {architectures.map((id) => {
                  const runs = cells[`${id}::${task.id}`] ?? [];
                  return (
                    <td key={id} className="px-2 py-2.5 text-center">
                      {runs.length === 0 ? (
                        <span className="text-muted" title="not run">
                          –
                        </span>
                      ) : (
                        <span className="inline-flex gap-[3px]">
                          {runs.map((run) => (
                            <Link
                              key={run.runId}
                              href={`/runs/${run.runId}/`}
                              title={`${architectureName(id)} · ${task.title} · repeat ${run.repeat}: ${OUTCOME[run.outcome].label}, score ${run.score.toFixed(3)}`}
                              aria-label={`Repeat ${run.repeat}: ${OUTCOME[run.outcome].label}, score ${run.score.toFixed(3)}`}
                              className="block h-3 w-3 rounded-[3px] border transition-transform hover:scale-125"
                              style={OUTCOME[run.outcome].style}
                            />
                          ))}
                        </span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <figcaption className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-[0.8125rem] text-ink-2">
        {(Object.keys(OUTCOME) as RunOutcome[]).map((outcome) => (
          <span key={outcome} className="inline-flex items-center gap-1.5">
            <span aria-hidden className="block h-3 w-3 rounded-[3px] border" style={OUTCOME[outcome].style} />
            {OUTCOME[outcome].label}
          </span>
        ))}
        <span className="text-muted">One square per run; each links to its trace.</span>
      </figcaption>
    </figure>
  );
}
