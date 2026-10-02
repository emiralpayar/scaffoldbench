import type { CSSProperties } from 'react';

import { formatDelta } from '../../lib/format';
import { modelShortName } from '../../lib/models';
import type { TaskDelta } from '../../lib/strategies';
import Link from '../Link';

export interface ModelDeltas {
  model: string;
  deltas: TaskDelta[];
}

const TIE = 0.0005;

/**
 * Task by task, how much an architecture scored above or below a single
 * agent, one column per model. The mean in the standing table hides whether a
 * gain is spread across tasks or comes from one; here each task is a bar
 * from a shared zero, to the right when the architecture scored higher. Rows
 * share one order across models, best average first, so a column reads
 * against the next. Sign is carried by the number and the side of the line,
 * never by colour alone.
 */
export function TaskDeltaGrid({ models }: { models: readonly ModelDeltas[] }) {
  const tasks = new Map<string, { title: string; difficulty: string; deltas: number[] }>();
  for (const { deltas } of models) {
    for (const delta of deltas) {
      const task = tasks.get(delta.taskId) ?? { title: delta.title, difficulty: delta.difficulty, deltas: [] };
      task.deltas.push(delta.delta);
      tasks.set(delta.taskId, task);
    }
  }
  const order = [...tasks.entries()]
    .map(([taskId, task]) => ({ taskId, ...task, mean: task.deltas.reduce((a, b) => a + b, 0) / task.deltas.length }))
    .sort((a, b) => b.mean - a.mean || a.taskId.localeCompare(b.taskId));
  const byModel = new Map(models.map(({ model, deltas }) => [model, new Map(deltas.map((d) => [d.taskId, d]))]));

  if (order.length === 0) return null;

  return (
    <figure>
      <div
        role="table"
        aria-label="Score difference from a single agent, by task and model"
        className="rounded-[14px] border border-rule bg-surface text-[0.875rem]"
        style={{ '--models': models.length } as CSSProperties}
      >
        <div
          role="rowgroup"
          className="sticky top-0 z-10 rounded-t-[13px] border-b border-rule bg-surface/95 backdrop-blur sm:static sm:bg-surface sm:backdrop-blur-none"
        >
          <div role="row" className="grid grid-cols-1 lg:grid-cols-[minmax(14rem,28rem)_minmax(0,1fr)]">
            <div role="columnheader" className="hidden px-4 py-3 lg:block">
              <span className="eyebrow">Task</span>
            </div>
            <div className="grid grid-cols-[repeat(var(--models),minmax(0,1fr))]">
              {models.map(({ model }) => (
                <div key={model} role="columnheader" className="px-3 py-3 text-center text-[0.8125rem] text-ink">
                  {modelShortName(model)}
                </div>
              ))}
            </div>
          </div>
        </div>
        <div role="rowgroup">
          {order.map((task) => (
            <div
              role="row"
              key={task.taskId}
              className="grid grid-cols-1 border-b border-rule last:border-0 lg:grid-cols-[minmax(14rem,28rem)_minmax(0,1fr)]"
            >
              <div role="rowheader" className="min-w-0 px-4 pb-1 pt-3 lg:py-2.5">
                <Link href={`/tasks/${task.taskId}/`} className="block min-w-0 text-ink hover:underline">
                  {task.title}
                </Link>
                <span className="eyebrow block !text-[0.6875rem]">{task.difficulty}</span>
              </div>
              <div className="grid grid-cols-[repeat(var(--models),minmax(0,1fr))] pb-2.5 lg:pb-0">
                {models.map(({ model }) => {
                  const delta = byModel.get(model)?.get(task.taskId);
                  return (
                    <div role="cell" key={model} className="flex items-center px-2 sm:px-3 lg:py-2.5">
                      {delta ? <Bar delta={delta.delta} label={`${modelShortName(model)}: ${describe(delta.delta)} on ${task.title}`} /> : (
                        <span className="mx-auto text-muted">
                          <span aria-hidden>–</span>
                          <span className="sr-only">not run on both</span>
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
      <figcaption className="mt-3 text-[0.8125rem] leading-relaxed text-muted">
        Mean score of the architecture minus a single agent’s, over the repeats both completed, on a shared zero from −1 to
        +1. Runs that were excluded are left out.
      </figcaption>
    </figure>
  );
}

function describe(delta: number): string {
  if (Math.abs(delta) < TIE) return 'level with a single agent';
  return `${formatDelta(delta, 2)} against a single agent`;
}

function Bar({ delta, label }: { delta: number; label: string }) {
  const tie = Math.abs(delta) < TIE;
  const width = Math.min(Math.abs(delta), 1) * 50;
  return (
    <span className="flex w-full flex-col-reverse items-stretch gap-1 sm:flex-row sm:items-center sm:gap-2" title={label}>
      <span aria-hidden className="relative h-3 w-full min-w-0 sm:flex-1">
        <span className="absolute inset-y-0 left-1/2 w-px bg-axis" />
        {tie ? (
          <span className="absolute left-1/2 top-1/2 h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-muted" />
        ) : (
          <span
            className="absolute inset-y-[2px] rounded-[2px]"
            style={{
              background: delta > 0 ? 'var(--good)' : 'var(--bad)',
              ...(delta > 0 ? { left: '50%' } : { right: '50%' }),
              width: `${Math.max(width, 1.5)}%`,
            }}
          />
        )}
      </span>
      <span className={`num shrink-0 text-center text-[0.75rem] sm:w-11 sm:text-right ${tie ? 'text-muted' : 'text-ink'}`} aria-hidden>
        {tie ? '0' : formatDelta(delta, 2)}
      </span>
      <span className="sr-only">{label}</span>
    </span>
  );
}
