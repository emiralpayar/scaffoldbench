import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { EmptyState } from '../../../components/EmptyState';
import { Field, PageHeader, Panel, Tag } from '../../../components/Layout';
import { SyntheticBanner } from '../../../components/RunSetMeta';
import type { StrategyCellRow } from '../../../components/TaskTables';
import {
  AssertionTable,
  RunsTable,
  TaskStrategyTable,
} from '../../../components/TaskTables';
import {
  assertionPassRates,
  findTask,
  formatFailureMode,
  formatPercent,
  formatUsd,
  hasResults,
  loadRunSet,
  selectRunsForTask,
  strategyLabel,
} from '../../../lib/data';

interface Params {
  params: Promise<{ taskId: string }>;
}

export async function generateStaticParams(): Promise<{ taskId: string }[]> {
  const data = await loadRunSet();
  return (data?.catalog.tasks ?? []).map((task) => ({ taskId: task.id }));
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { taskId } = await params;
  const data = await loadRunSet();
  const task = data ? findTask(data.catalog, taskId) : undefined;
  return {
    title: task ? `${task.title} (${task.id})` : taskId,
    description: task?.prompt || `Per-strategy results for task ${taskId}.`,
  };
}

export default async function TaskPage({ params }: Params) {
  const { taskId } = await params;
  const data = await loadRunSet();
  if (!hasResults(data)) return <EmptyState />;

  const task = findTask(data.catalog, taskId);
  if (!task) notFound();

  const records = selectRunsForTask(data.records, taskId);
  const assertions = assertionPassRates(data.records, taskId);
  const labels = Object.fromEntries(
    data.catalog.strategies.map((strategy) => [strategy.id, strategy.label]),
  );

  const strategyRows: StrategyCellRow[] = data.summary.cells
    .filter((cell) => cell.taskId === taskId)
    .map((cell) => ({
      strategyId: cell.strategyId,
      label: strategyLabel(data.catalog, cell.strategyId),
      cell,
    }))
    .sort((a, b) => b.cell.meanScore - a.cell.meanScore);

  const failureModes = countFailureModes(records);

  return (
    <>
      <SyntheticBanner manifest={data.manifest} />

      <PageHeader
        eyebrow={`${task.category} · ${task.world}`}
        title={task.title}
        aside={
          <div className="flex flex-wrap items-center gap-2">
            <Tag>{task.difficulty}</Tag>
            <Tag>{task.category}</Tag>
            {task.tags.map((tag) => (
              <Tag key={tag}>{tag}</Tag>
            ))}
          </div>
        }
      />

      <div className="mb-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Task id">{task.id}</Field>
        <Field label="Max turns">{task.maxTurns || '—'}</Field>
        <Field label="Runs">{records.length}</Field>
        <Field label="Pass rate">
          {records.length === 0
            ? '—'
            : formatPercent(records.filter((record) => record.passed).length / records.length)}
        </Field>
      </div>

      <Panel title="Prompt handed to the agent">
        <pre className="scroll-x whitespace-pre-wrap break-words font-serif text-[15px] leading-relaxed text-ink-2">
          {task.prompt || 'This run set did not record the prompt for this task.'}
        </pre>
      </Panel>

      {task.policy ? (
        <Panel
          title="Policy"
          note="Appended to the system prompt for every strategy, so no architecture gets a rules advantage."
        >
          <pre className="scroll-x whitespace-pre-wrap break-words font-serif text-[15px] leading-relaxed text-ink-2">
            {task.policy}
          </pre>
        </Panel>
      ) : null}

      <Panel title="Per-strategy results" bleed>
        <div className="p-4">
          <TaskStrategyTable rows={strategyRows} />
        </div>
      </Panel>

      <Panel
        title="Assertions"
        note={`How often each graded assertion held across all ${records.length} runs`}
        bleed
      >
        <div className="p-4">
          <AssertionTable stats={assertions} />
        </div>
      </Panel>

      {failureModes.length > 0 ? (
        <Panel title="How the failures failed">
          <ul className="flex flex-wrap gap-x-6 gap-y-2 text-[13px]">
            {failureModes.map(([mode, count]) => (
              <li key={mode} className="flex items-baseline gap-2">
                <span className="num text-ink">{count}</span>
                <span className="text-muted">{formatFailureMode(mode)}</span>
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}

      <Panel
        title="Every run"
        note={`${formatUsd(records.reduce((sum, record) => sum + record.costUsd, 0))} spent on this task`}
        bleed
      >
        <div className="p-4">
          <RunsTable records={records} labels={labels} />
        </div>
      </Panel>
    </>
  );
}

function countFailureModes(records: readonly { failureMode: string }[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const record of records) {
    if (record.failureMode === 'none') continue;
    counts.set(record.failureMode, (counts.get(record.failureMode) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}
