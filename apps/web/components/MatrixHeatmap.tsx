import Link from 'next/link';
import type { CSSProperties } from 'react';

import type { MatrixModel } from '../lib/data';
import { formatPercent, formatScore, matrixKey } from '../lib/data';

const RAMP_STOPS = [0, 0.25, 0.5, 0.75, 1];

function heat(t: number): CSSProperties {
  return { '--t': t.toFixed(3) } as CSSProperties;
}

/**
 * Strategy x task mean score.
 *
 * The number is the encoding; the wash behind it is the secondary one. Both
 * ends of the ramp are chosen so the ink stays legible on top of them, in
 * either theme, which is why no cell ever flips its text colour.
 */
export function MatrixHeatmap({ matrix }: { matrix: MatrixModel }) {
  const taskMeans = new Map<string, { total: number; count: number }>();
  for (const task of matrix.tasks) {
    let total = 0;
    let count = 0;
    for (const strategy of matrix.strategies) {
      const cell = matrix.cells[matrixKey(strategy.id, task.id)];
      if (!cell) continue;
      total += cell.meanScore;
      count += 1;
    }
    taskMeans.set(task.id, { total, count });
  }

  return (
    <div>
      <div className="scroll-x rounded-[3px] border border-rule bg-surface">
        <table className="border-collapse text-[12px]">
          <thead>
            <tr className="border-b border-rule">
              <th
                scope="col"
                className="eyebrow sticky left-0 z-10 min-w-[13rem] bg-surface px-3 py-2 text-left font-normal"
              >
                Strategy
              </th>
              {matrix.tasks.map((task) => (
                <th
                  key={task.id}
                  scope="col"
                  title={task.title}
                  className="min-w-[4.6rem] px-1 py-2 align-bottom font-normal"
                >
                  <Link href={`/tasks/${task.id}`} className="block hover:text-accent">
                    <span className="block text-[11px] leading-tight text-ink-2">{task.world}</span>
                    <span className="eyebrow block !tracking-[0.06em]">{task.difficulty}</span>
                  </Link>
                </th>
              ))}
              <th
                scope="col"
                className="eyebrow min-w-[3.6rem] border-l border-rule px-2 py-2 text-right font-normal"
              >
                mean
              </th>
            </tr>
          </thead>

          <tbody>
            {matrix.strategies.map((strategy) => (
              <tr key={strategy.id} className="border-b border-rule/70 last:border-0">
                <th
                  scope="row"
                  className="sticky left-0 z-10 max-w-[16rem] truncate bg-surface px-3 py-1 text-left font-normal text-ink"
                >
                  {strategy.label}
                </th>

                {matrix.tasks.map((task) => {
                  const cell = matrix.cells[matrixKey(strategy.id, task.id)];
                  if (!cell) {
                    return (
                      <td key={task.id} className="p-[1px]">
                        <div
                          title="no runs"
                          className="num flex h-8 items-center justify-center rounded-[2px] border border-dashed border-rule text-muted"
                        >
                          –
                        </div>
                      </td>
                    );
                  }
                  return (
                    <td key={task.id} className="p-[1px]">
                      <Link
                        href={`/tasks/${task.id}`}
                        style={heat(cell.meanScore)}
                        title={`${strategy.label} · ${task.title}\nmean score ${formatScore(cell.meanScore)} over ${cell.runs} runs · pass ${formatPercent(cell.passRate)}`}
                        className="heat num flex h-8 items-center justify-center rounded-[2px] text-ink hover:outline hover:outline-2 hover:-outline-offset-2 hover:outline-accent"
                      >
                        {cell.meanScore.toFixed(2)}
                      </Link>
                    </td>
                  );
                })}

                <td className="num border-l border-rule px-2 text-right text-ink-2">
                  {strategy.meanScore.toFixed(2)}
                </td>
              </tr>
            ))}
          </tbody>

          <tfoot>
            <tr className="border-t border-rule">
              <th
                scope="row"
                className="eyebrow sticky left-0 z-10 bg-surface px-3 py-2 text-left font-normal"
              >
                task mean
              </th>
              {matrix.tasks.map((task) => {
                const stat = taskMeans.get(task.id);
                return (
                  <td key={task.id} className="num px-1 py-2 text-center text-muted">
                    {stat && stat.count > 0 ? (stat.total / stat.count).toFixed(2) : '–'}
                  </td>
                );
              })}
              <td className="border-l border-rule" />
            </tr>
          </tfoot>
        </table>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-3 text-[11px] text-muted">
        <span>mean score</span>
        <span className="flex items-center gap-[2px]">
          {RAMP_STOPS.map((stop) => (
            <span
              key={stop}
              style={heat(stop)}
              className="heat num flex h-6 w-9 items-center justify-center rounded-[2px] border border-rule text-ink"
            >
              {stop.toFixed(2)}
            </span>
          ))}
        </span>
        <span>· a dashed cell was never run · every cell links to its task</span>
      </div>
    </div>
  );
}
