import type { CSSProperties } from 'react';

import { architectureName } from '../../lib/architectures';
import { repeatCells } from '../../lib/derive';
import { formatScore } from '../../lib/format';
import { modelShortName } from '../../lib/models';
import type { RunRecord } from '../../lib/records';
import { isRankable } from '../../lib/records';
import { ArchitectureGlyph } from '../ArchitectureGlyph';
import { OutcomeLegend, RunSquares } from '../charts/RepeatMatrix';
import { Readout } from '../charts/Readout';
import Link from '../Link';

/**
 * One task, every architecture on every model: a square per repeat, and the
 * mean score of the runs that count. It is the cross-model view of the
 * matrix for one task, and the one that shows whether the task has any
 * headroom to separate designs on a stronger model.
 *
 * The model the page is reading is washed and its heading opens that model's
 * view of the task. The best mean in each model's column is set in bold, so
 * the winner is a fact of the grid and not an impression of it.
 */
export function OutcomeGrid({
  taskId,
  taskTitle,
  records,
  architectures,
  models,
  current,
}: {
  taskId: string;
  taskTitle: string;
  records: readonly RunRecord[];
  architectures: readonly string[];
  models: readonly string[];
  current: string;
}) {
  const meanOf = (architecture: string, model: string): number | null => {
    const ranked = records.filter(
      (record) => record.strategyId === architecture && record.model === model && isRankable(record),
    );
    return ranked.length === 0 ? null : ranked.reduce((sum, record) => sum + record.score, 0) / ranked.length;
  };
  const best = Object.fromEntries(
    models.map((model) => [model, Math.max(...architectures.map((a) => meanOf(a, model) ?? -1))]),
  );
  const flagged = records.some(
    (record) => !record.integrity && repeatCells([record], record.strategyId, taskId).some((cell) => cell.legacyProblems > 0),
  );
  const columns = `repeat(${models.length}, minmax(0, 1fr))`;

  return (
    <figure>
      <Readout prompt="Point at a square or tab to it to read its run. Each square opens its run.">
        <div
          role="table"
          aria-label={`${taskTitle}: every run, by architecture and model`}
          className="rounded-[14px] border border-rule bg-surface text-[0.875rem]"
          style={{ '--cols': columns } as CSSProperties}
        >
          <div
            role="rowgroup"
            className="sticky top-0 z-10 rounded-t-[13px] border-b border-rule bg-surface/95 backdrop-blur sm:static sm:bg-surface sm:backdrop-blur-none"
          >
            <div role="row" className="grid grid-cols-[var(--cols)] lg:grid-cols-[minmax(12rem,16rem)_minmax(0,1fr)]">
              <div role="columnheader" className="hidden px-4 py-3 lg:block">
                <span className="eyebrow">Architecture</span>
              </div>
              <div className="col-span-full grid grid-cols-[var(--cols)] lg:col-span-1">
                {models.map((model) => (
                  <div
                    key={model}
                    role="columnheader"
                    className={`px-2 py-3 text-center ${model === current && models.length > 1 ? 'bg-sunken' : ''}`}
                  >
                    <Link
                      href={`/tasks/${taskId}/${model}/`}
                      className="link text-[0.8125rem] text-ink"
                      {...(model === current ? { 'aria-current': 'page' as const } : {})}
                    >
                      {modelShortName(model)}
                    </Link>
                  </div>
                ))}
              </div>
            </div>
          </div>
          <div role="rowgroup">
            {architectures.map((architecture) => (
              <div
                role="row"
                key={architecture}
                className="grid grid-cols-1 border-b border-rule last:border-0 lg:grid-cols-[minmax(12rem,16rem)_minmax(0,1fr)]"
              >
                <div role="rowheader" className="flex items-center gap-3 px-4 pb-1 pt-3 lg:py-3">
                  <ArchitectureGlyph id={architecture} width={34} decorative />
                  <Link href={`/strategies/${architecture}/`} className="text-ink hover:underline">
                    {architectureName(architecture)}
                  </Link>
                </div>
                <div className="grid grid-cols-[var(--cols)]">
                  {models.map((model) => {
                    const mean = meanOf(architecture, model);
                    return (
                      <div
                        role="cell"
                        key={model}
                        className={`flex flex-col items-center justify-center gap-0.5 px-1 pb-2.5 pt-0.5 lg:py-2 ${
                          model === current && models.length > 1 ? 'bg-sunken' : ''
                        }`}
                      >
                        <RunSquares
                          runs={repeatCells(records.filter((r) => r.model === model), architecture, taskId)}
                          architecture={architecture}
                          task={`${taskTitle} (${modelShortName(model)})`}
                        />
                        <span
                          className={`num text-[0.8125rem] ${
                            mean !== null && mean === best[model] ? 'font-semibold text-ink' : 'text-ink-2'
                          }`}
                        >
                          {mean === null ? '—' : formatScore(mean)}
                          <span className="sr-only"> mean score of the runs that count</span>
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>
      </Readout>
      <OutcomeLegend flagged={flagged} />
    </figure>
  );
}
