import Link from 'next/link';

import { compareArchitectures } from '../../lib/architectures';
import type { RepeatCell } from '../../lib/derive';
import { recordsForModel, repeatCells, sortTasks } from '../../lib/derive';
import { formatScore } from '../../lib/format';
import { modelLabel, modelShortName } from '../../lib/models';
import type { RunRecord } from '../../lib/records';
import { isRankable } from '../../lib/records';
import type { RunSetData } from '../../lib/server/runSet';
import { trapTable } from '../../lib/traps';
import { PageHeader } from '../Layout';
import { RunSetBanner } from '../RunSetMeta';
import { ArchitectureKey } from '../charts/ArchitectureColumns';
import { RepeatMatrix } from '../charts/RepeatMatrix';
import { TrapHeatmap } from '../charts/TrapHeatmap';
import { ModelSwitcher } from '../leaderboard/ModelSwitcher';

/**
 * Every run of one model, task by task, as one square per repeat; then, for
 * the tasks that declare traps, which architecture fell into which.
 */
export function MatrixView({ data, model }: { data: RunSetData; model: string }) {
  const scoped = recordsForModel(data.records, model);
  const tasks = sortTasks(data.catalog.tasks).filter((task) => scoped.some((record) => record.taskId === task.id));
  const architectures = [...new Set(scoped.map((r) => r.strategyId))].sort(compareArchitectures);
  const hardest = hardestTask(scoped, tasks);
  const cells: Record<string, RepeatCell[]> = {};
  for (const architecture of architectures) {
    for (const task of tasks) cells[`${architecture}::${task.id}`] = repeatCells(scoped, architecture, task.id);
  }
  const ranked = scoped.filter(isRankable);
  // A run set that predates the fidelity gate ranks nothing; what its runs'
  // own records show is the only fidelity signal it has.
  const unverified = data.verification === 'unverified';
  const flagged = unverified ? Object.values(cells).flat().filter((cell) => cell.legacyProblems > 0).length : 0;
  const traps = tasks.flatMap((task) => {
    const table = trapTable(task, ranked);
    return table && table.architectures.length > 0 ? [{ task, table }] : [];
  });

  return (
    <>
      <RunSetBanner data={data} />

      <PageHeader
        eyebrow={`Where it breaks · ${modelLabel(model)}`}
        title="Every run, task by task"
        lede="An average hides whether an architecture fails a little everywhere or completely on one task. Here every run is a square, so the shape of the failure is visible, and every square opens its run."
      />
      {data.models.length > 1 ? (
        <div className="-mt-4 mb-8">
          <ModelSwitcher
            items={data.models.map((m) => ({ href: `/matrix/${m}/`, label: modelShortName(m), current: m === model }))}
          />
        </div>
      ) : null}

      {flagged > 0 ? (
        <p className="prose-serif mb-6 max-w-3xl">
          This run set predates the fidelity checks. By their own phase records,{' '}
          <span className="num text-ink">
            {flagged} of {scoped.length}
          </span>{' '}
          runs on {modelShortName(model)} did not run as designed; their squares have a corner cut off. Their scores are
          real, but they measure a different harness from the one named.
        </p>
      ) : null}

      {hardest ? (
        <p className="prose-serif mb-8 max-w-3xl">
          The hardest task on {modelShortName(model)} is{' '}
          <Link href={`/tasks/${hardest.id}/`} className="link text-ink">
            {hardest.title}
          </Link>
          , where {unverified ? 'runs' : 'ranked runs'} average{' '}
          <span className="num text-ink">{formatScore(hardest.mean)}</span> across every architecture. A difference
          between harnesses is easiest to see where the ceiling is far away.
        </p>
      ) : null}

      <RepeatMatrix
        tasks={tasks.map((task) => ({ id: task.id, title: task.title, difficulty: task.difficulty, world: task.world }))}
        architectures={architectures}
        cells={cells}
      />

      {traps.length > 0 ? (
        <section aria-labelledby="traps-title" className="mt-16">
          <h2 id="traps-title" className="h2 max-w-3xl text-ink">
            Who fell into which trap
          </h2>
          <p className="prose-serif mt-4 max-w-3xl">
            Some tasks declare their traps in advance: the specific ways a run can go wrong, each tied to the
            assertions or rules that register it. A trap fired when one of those failed. Excluded runs are left out,
            and a run that did nothing at all fires every assertion-backed trap, so read a rate beside the score.
          </p>
          <ArchitectureKey architectures={architectures} className="mt-8" />
          <div className="mt-6 flex flex-col gap-6 lg:mt-8">
            {traps.map(({ task, table }) => (
              <TrapHeatmap
                key={task.id}
                table={table}
                title={task.title}
                href={`/tasks/${task.id}/`}
                architectures={architectures}
              />
            ))}
          </div>
        </section>
      ) : null}
    </>
  );
}

function hardestTask(
  records: readonly RunRecord[],
  tasks: readonly { id: string; title: string }[],
): { id: string; title: string; mean: number } | null {
  let best: { id: string; title: string; mean: number } | null = null;
  for (const task of tasks) {
    const scores = records.filter((r) => r.taskId === task.id && isRankable(r)).map((r) => r.score);
    if (scores.length === 0) continue;
    const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
    if (!best || mean < best.mean) best = { id: task.id, title: task.title, mean };
  }
  return best;
}
