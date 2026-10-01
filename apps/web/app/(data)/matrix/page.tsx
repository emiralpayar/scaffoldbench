import type { Metadata } from 'next';

import { EmptyState } from '../../../components/EmptyState';
import { PageHeader } from '../../../components/Layout';
import { RunSetBanner } from '../../../components/RunSetMeta';
import { RepeatMatrix } from '../../../components/charts/RepeatMatrix';
import { compareArchitectures } from '../../../lib/architectures';
import type { RepeatCell } from '../../../lib/derive';
import { recordsForModel, repeatCells, sortTasks } from '../../../lib/derive';
import { formatScore } from '../../../lib/format';
import { modelShortName } from '../../../lib/models';
import type { RunRecord } from '../../../lib/records';
import { isRankable } from '../../../lib/records';
import { loadRunSet } from '../../../lib/server/runSet';

export const metadata: Metadata = {
  title: 'Where it breaks',
  description:
    'Every run of every architecture on every task, as one square per repeat: passed, partial, failed, or excluded and why.',
};

export default async function MatrixPage() {
  const data = await loadRunSet();
  if (!data || data.records.length === 0) return <EmptyState />;

  const tasks = sortTasks(data.catalog.tasks).filter((task) =>
    data.records.some((record) => record.taskId === task.id),
  );
  const architectures = [...new Set(data.records.map((r) => r.strategyId))].sort(compareArchitectures);
  const hardest = hardestTask(data.records, tasks);

  return (
    <>
      <RunSetBanner data={data} />

      <PageHeader
        eyebrow="Where it breaks"
        title="Every run, task by task"
        lede="An average hides whether an architecture fails a little everywhere or completely on one task. Here every run is a square, so the shape of the failure is visible, and every square opens its trace."
      />

      {hardest ? (
        <p className="prose-serif mb-10 max-w-3xl">
          The hardest task in this set is{' '}
          <span className="text-ink">{hardest.title}</span>, where ranked runs average{' '}
          <span className="num text-ink">{formatScore(hardest.mean)}</span> across every architecture
          and model. A difference between harnesses is easiest to see where the ceiling is far away.
        </p>
      ) : null}

      {data.models.map((model, index) => {
        const scoped = recordsForModel(data.records, model);
        const cells: Record<string, RepeatCell[]> = {};
        for (const architecture of architectures) {
          for (const task of tasks) {
            cells[`${architecture}::${task.id}`] = repeatCells(scoped, architecture, task.id);
          }
        }
        return (
          <details key={model} open={index === 0} className="group mb-6">
            <summary className="mb-4 flex items-baseline gap-3">
              <span className="h3 text-ink">{modelShortName(model)}</span>
              <span className="num text-[0.8125rem] text-muted">{scoped.length} runs</span>
            </summary>
            <RepeatMatrix
              tasks={tasks.map((task) => ({
                id: task.id,
                title: task.title,
                difficulty: task.difficulty,
                world: task.world,
              }))}
              architectures={architectures}
              cells={cells}
            />
          </details>
        );
      })}
    </>
  );
}

function hardestTask(
  records: readonly RunRecord[],
  tasks: readonly { id: string; title: string }[],
): { title: string; mean: number } | null {
  let best: { title: string; mean: number } | null = null;
  for (const task of tasks) {
    const scores = records
      .filter((r) => r.taskId === task.id && isRankable(r))
      .map((r) => r.score);
    if (scores.length === 0) continue;
    const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
    if (!best || mean < best.mean) best = { title: task.title, mean };
  }
  return best;
}
