import Link from 'next/link';
import type { ReactNode } from 'react';

import { architectureName, compareArchitectures } from '../../lib/architectures';
import type { AnatomyRow } from '../../lib/derive';
import {
  architectureMeans,
  assertionPassRates,
  findTask,
  modelView,
  strategyLabel,
  taskAnatomy,
} from '../../lib/derive';
import { formatFailureMode, formatPercent, formatScore, formatUsd, joinList } from '../../lib/format';
import { modelLabel, modelShortName } from '../../lib/models';
import type { RunRecord, TaskInfo } from '../../lib/records';
import { isRankable } from '../../lib/records';
import type { RunSetData } from '../../lib/server/runSet';
import { trapTable } from '../../lib/traps';
import { Field, PageHeader, Tag } from '../Layout';
import { RunSetBanner } from '../RunSetMeta';
import { ArchitectureKey } from '../charts/ArchitectureColumns';
import { FailureGrid } from '../charts/FailureGrid';
import { TrapHeatmap } from '../charts/TrapHeatmap';
import { ModelSwitcher } from '../leaderboard/ModelSwitcher';
import { RunsTable, TaskStrategyTable } from '../TaskTables';
import type { StrategyCellRow } from '../TaskTables';
import { OutcomeGrid } from './OutcomeGrid';

/**
 * A task, laid out for the question "who solved it, and where did the others
 * lose it": the prediction written before the run beside what happened, every
 * run of every architecture on every model, the traps it declared, and the
 * graded items each architecture missed.
 */
export function TaskView({ data, taskId, model }: { data: RunSetData; taskId: string; model: string }) {
  const task = findTask(data.catalog, taskId);
  if (!task) return null;

  const view = modelView(data.records, model);
  const taskRecords = data.records.filter((record) => record.taskId === taskId);
  const here = view.records.filter((record) => record.taskId === taskId);
  const ranked = view.ranked.filter((record) => record.taskId === taskId);
  const architectures = [...new Set(taskRecords.map((record) => record.strategyId))].sort(compareArchitectures);
  const unverified = data.verification === 'unverified';
  const means = architectureMeans(ranked, taskId);
  const anatomy = taskAnatomy(ranked, taskId);
  const traps = trapTable(task, ranked);
  const assertions = assertionPassRates(ranked, taskId);
  const labels = Object.fromEntries(
    data.catalog.strategies.map((strategy) => [strategy.id, strategyLabel(data.catalog, strategy.id)]),
  );
  const strategyRows: StrategyCellRow[] = view.summary.cells
    .filter((cell) => cell.taskId === taskId)
    .map((cell) => ({ strategyId: cell.strategyId, label: strategyLabel(data.catalog, cell.strategyId), cell }))
    .sort((a, b) => b.cell.meanScore - a.cell.meanScore);
  const failureModes = countFailureModes(here);
  const passRate = ranked.length === 0 ? null : ranked.filter((record) => record.passed).length / ranked.length;

  return (
    <>
      <RunSetBanner data={data} />

      <PageHeader
        eyebrow={`${task.category} · ${task.world}`}
        title={task.title}
        aside={
          <div className="flex flex-wrap items-center gap-2">
            <Tag>{task.difficulty}</Tag>
            {task.tags
              .filter((tag) => tag !== task.difficulty && tag !== task.world)
              .map((tag) => (
                <Tag key={tag}>{tag}</Tag>
              ))}
          </div>
        }
      />

      {data.models.length > 1 ? (
        <div className="-mt-4 mb-8">
          <ModelSwitcher
            items={data.models.map((m) => ({ href: `/tasks/${taskId}/${m}/`, label: modelShortName(m), current: m === model }))}
          />
        </div>
      ) : null}

      <dl className="mb-14 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Field label="Task id">{task.id}</Field>
        <Field label="Turn limit">{task.maxTurns || '—'}</Field>
        <Field label={`Runs on ${modelShortName(model)}`}>
          {ranked.length}
          {here.length !== ranked.length ? <span className="text-muted"> of {here.length}</span> : null}
        </Field>
        <Field label="Pass rate">{passRate === null ? '—' : formatPercent(passRate)}</Field>
      </dl>

      {task.hypothesis ? (
        <Hypothesis task={task} means={means} model={model} unverified={unverified} />
      ) : null}

      <section aria-labelledby="outcomes-title" className="mb-20">
        <h2 id="outcomes-title" className="h2 mb-3 max-w-3xl text-ink">
          Who solved it
        </h2>
        <p className="prose-serif mb-8 max-w-3xl">
          {outcomeSentence(means, model, unverified)} The same task, every architecture, every model: one square per
          run.
        </p>
        <OutcomeGrid
          taskId={taskId}
          taskTitle={task.title}
          records={taskRecords}
          architectures={architectures}
          models={data.models}
          current={model}
        />
      </section>

      <section aria-labelledby="task-title" className="mb-20 grid gap-8 lg:grid-cols-2">
        <div className="min-w-0">
          <h2 id="task-title" className="h3 mb-3 text-ink">
            The prompt every architecture was handed
          </h2>
          <Text>{task.prompt || 'This run set did not record the prompt for this task.'}</Text>
        </div>
        {task.policy ? (
          <div className="min-w-0">
            <h2 className="h3 mb-1 text-ink">The domain policy</h2>
            <p className="mb-3 text-[0.8125rem] text-muted">
              Appended to the system prompt for every architecture, so none of them gets a rules advantage.
            </p>
            <Text>{task.policy}</Text>
          </div>
        ) : null}
      </section>

      {traps ? (
        <section aria-labelledby="traps-title" className="mb-20">
          <h2 id="traps-title" className="h2 mb-3 max-w-3xl text-ink">
            The traps it sets
          </h2>
          <p className="prose-serif mb-8 max-w-3xl">
            A trap is a specific way to go wrong, declared before any run and tied to the assertions or rules that
            register it. A trap fired in a run when one of those failed. On {modelShortName(model)}:
          </p>
          <ArchitectureKey architectures={traps.architectures} className="mb-4" />
          <TrapHeatmap table={traps} title={task.title} href={`/tasks/${taskId}/${model}/`} />
        </section>
      ) : null}

      <section aria-labelledby="anatomy-title" className="mb-20">
        <h2 id="anatomy-title" className="h2 mb-3 max-w-3xl text-ink">
          Where it was lost
        </h2>
        <p className="prose-serif mb-8 max-w-3xl">
          {anatomySentence(anatomy.rows, assertions, model)} A score says an architecture lost points. This says which
          ones: for each graded item, the runs that earned less than full credit, out of the runs that count.
        </p>
        {anatomy.rows.length === 0 ? (
          <p className="max-w-3xl text-[0.9375rem] text-muted">
            This task is graded by a judge against a rubric, and this run set recorded no itemised breakdown for it.
          </p>
        ) : (
          <>
            <ArchitectureKey architectures={anatomy.architectures} className="mb-4" />
            <FailureGrid
              title={`Graded items on ${modelShortName(model)}`}
              summary="runs that fell short, of runs that count"
              rowHeading="Graded item"
              ariaLabel={`Graded items of ${task.title}, by architecture: runs that fell short, of runs that count`}
              architectures={anatomy.architectures}
              rows={anatomy.rows.map((row) => ({
                id: `${row.kind}:${row.id}`,
                title: row.label,
                detail: row.kind === 'rule' ? 'A rule: breaching it multiplies the score down.' : `weight ${row.weight ?? 1}`,
                cells: row.cells,
              }))}
              describe={(id, row, cell) => `${architectureName(id)} fell short of "${row.title}" in ${cell.count} of ${cell.runs} runs`}
            />
          </>
        )}
        {failureModes.length > 0 ? (
          <p className="mt-6 flex flex-wrap items-baseline gap-x-6 gap-y-2 text-[0.8125rem] text-ink-2">
            <span className="eyebrow">How the failures failed</span>
            {failureModes.map(([mode, count]) => (
              <span key={mode} className="inline-flex items-baseline gap-2">
                <span className="num text-ink">{count}</span>
                <span className="text-muted">{formatFailureMode(mode)}</span>
              </span>
            ))}
          </p>
        ) : null}
      </section>

      <section aria-labelledby="numbers-title" className="mb-20">
        <h2 id="numbers-title" className="h2 mb-8 max-w-3xl text-ink">
          In numbers, on {modelLabel(model)}
        </h2>
        <div className="card p-4">
          <TaskStrategyTable rows={strategyRows} />
        </div>
      </section>

      <details className="card mb-4 overflow-hidden">
        <summary className="flex flex-wrap items-baseline justify-between gap-3 px-5 py-4">
          <span className="eyebrow !text-ink-2">Every run on {modelShortName(model)}</span>
          <span className="text-[0.8125rem] text-muted">
            {here.length} runs · {formatUsd(here.reduce((sum, record) => sum + record.costUsd, 0))} spent
          </span>
        </summary>
        <div className="border-t border-rule p-4">
          <RunsTable records={here} labels={labels} />
        </div>
      </details>
    </>
  );
}

/** The prediction, in its own words, and what the numbers say next to it. */
function Hypothesis({
  task,
  means,
  model,
  unverified,
}: {
  task: TaskInfo;
  means: { strategyId: string; mean: number; runs: number }[];
  model: string;
  unverified: boolean;
}) {
  const top = means[0];
  const single = means.find((m) => m.strategyId === 'single');
  return (
    <section aria-labelledby="hypothesis-title" className="mb-20 grid gap-x-12 gap-y-6 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
      <div>
        <p className="eyebrow">Pre-registered hypothesis</p>
        <h2 id="hypothesis-title" className="sr-only">
          Hypothesis
        </h2>
        <blockquote className="mt-3 border-l-2 border-ink pl-5 font-serif text-[1.375rem] leading-snug text-ink [text-wrap:pretty]">
          {task.hypothesis}
        </blockquote>
        <p className="mt-4 text-[0.8125rem] leading-relaxed text-muted">
          Written when the task was written, before any run. It is a prediction in words, so read it against what
          happened rather than trusting a verdict drawn for you.
        </p>
      </div>
      <div className="rounded-[14px] border border-rule bg-surface px-5 py-4">
        <p className="eyebrow">What happened on {modelShortName(model)}</p>
        {top && !unverified ? (
          <ul className="mt-3 space-y-2 text-[0.9375rem] leading-snug text-ink-2">
            <li>
              Highest mean score: <span className="text-ink">{architectureName(top.strategyId)}</span>{' '}
              <span className="num">{formatScore(top.mean)}</span>
            </li>
            {single && top.strategyId !== 'single' ? (
              <li>
                A single agent: <span className="num text-ink">{formatScore(single.mean)}</span>
              </li>
            ) : null}
            <li>
              Lowest:{' '}
              <span className="text-ink">{architectureName(means[means.length - 1]?.strategyId ?? '')}</span>{' '}
              <span className="num">{formatScore(means[means.length - 1]?.mean ?? 0)}</span>
            </li>
          </ul>
        ) : (
          <p className="mt-3 text-[0.9375rem] leading-snug text-ink-2">
            {unverified
              ? 'This run set carries no fidelity checks, so no outcome is read against the prediction.'
              : 'No run on this model counts.'}
          </p>
        )}
        <p className="mt-3 text-[0.75rem] leading-snug text-muted">
          Means over the runs that count; intervals and verdicts are on the results page.
        </p>
      </div>
    </section>
  );
}

function Text({ children }: { children: ReactNode }) {
  return (
    <div className="card p-5">
      <p className="whitespace-pre-line font-serif text-[1rem] leading-relaxed text-ink-2 [overflow-wrap:anywhere]">
        {children}
      </p>
    </div>
  );
}

function outcomeSentence(
  means: { strategyId: string; mean: number }[],
  model: string,
  unverified: boolean,
): string {
  const top = means[0];
  const bottom = means[means.length - 1];
  if (!top || !bottom || unverified) return '';
  const best = means.filter((m) => top.mean - m.mean < 0.0005).map((m) => architectureName(m.strategyId));
  if (best.length === means.length) {
    return `On ${modelShortName(model)}, every architecture averages ${formatScore(top.mean)}: this task does not separate them.`;
  }
  return `On ${modelShortName(model)}, ${joinList(best)} ${best.length === 1 ? 'scores' : 'score'} highest at ${formatScore(top.mean)} and ${architectureName(bottom.strategyId)} lowest at ${formatScore(bottom.mean)}.`;
}

function anatomySentence(
  rows: readonly AnatomyRow[],
  assertions: readonly { id: string; label: string; passRate: number }[],
  model: string,
): string {
  const missed = rows
    .map((row) => {
      const cells = Object.values(row.cells);
      const runs = cells.reduce((sum, cell) => sum + cell.runs, 0);
      return { row, rate: runs === 0 ? 0 : cells.reduce((sum, cell) => sum + cell.count, 0) / runs };
    })
    .sort((a, b) => b.rate - a.rate)[0];
  if (!missed || missed.rate === 0) {
    return rows.length > 0 ? `On ${modelShortName(model)}, no architecture fell short of any graded item.` : '';
  }
  const label = assertions.find((a) => a.id === missed.row.id)?.label ?? missed.row.label;
  return `On ${modelShortName(model)}, the item most often missed is “${label}”, by ${formatPercent(missed.rate)} of runs.`;
}

function countFailureModes(records: readonly RunRecord[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const record of records) {
    if (!isRankable(record) || record.failureMode === 'none') continue;
    counts.set(record.failureMode, (counts.get(record.failureMode) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}
