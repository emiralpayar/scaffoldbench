import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { EmptyState } from '../../../../components/EmptyState';
import { Field, PageHeader, Panel, Tag } from '../../../../components/Layout';
import {
  PenaltyList,
  PhaseTable,
  RunHeadline,
  ScoreBreakdown,
  ScoreMetadata,
} from '../../../../components/RunDetail';
import { RunSetBanner } from '../../../../components/RunSetMeta';
import { TraceTimeline } from '../../../../components/TraceTimeline';
import { buildPhaseRows, findRun, strategyLabel } from '../../../../lib/derive';
import { formatDuration, formatInt, formatUsd } from '../../../../lib/format';
import { modelShortName } from '../../../../lib/models';
import { EMPTY_PARAM, loadRunSet, loadTrace } from '../../../../lib/server/runSet';

interface Params {
  params: Promise<{ runId: string }>;
}

export async function generateStaticParams(): Promise<{ runId: string }[]> {
  const data = await loadRunSet();
  const ids = (data?.records ?? []).map((record) => ({ runId: record.runId }));
  // See tasks/[taskId]: an empty list fails a static export.
  return ids.length > 0 ? ids : [{ runId: EMPTY_PARAM }];
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { runId } = await params;
  return { title: runId, description: `Trace and score breakdown for run ${runId}.` };
}

export default async function RunPage({ params }: Params) {
  const { runId } = await params;
  const data = await loadRunSet();
  if (!data || data.records.length === 0) return <EmptyState />;

  const record = findRun(data.records, runId);
  if (!record) notFound();

  const trace = await loadTrace(data, record);
  const phaseRows = buildPhaseRows(record, trace ?? []);
  const subagentPhases = trace ? new Set(trace.filter((e) => e.depth > 0).map((e) => e.phase)) : null;

  return (
    <>
      <RunSetBanner data={data} />

      <PageHeader eyebrow="Run" title={record.runId} mono aside={<RunHeadline record={record} />} />

      <nav className="mb-6 flex flex-wrap items-center gap-x-4 gap-y-2 text-[13px]">
        <Link
          href={`/tasks/${record.taskId}`}
          className="text-accent underline-offset-2 hover:underline"
        >
          {record.taskTitle}
        </Link>
        <span className="text-muted">·</span>
        <span className="text-ink-2">{strategyLabel(data.catalog, record.strategyId)}</span>
        <Tag>{record.taskCategory}</Tag>
        <Tag>{record.taskDifficulty}</Tag>
        <Tag>{modelShortName(record.model)}</Tag>
        <Tag>repeat {record.repeat}</Tag>
      </nav>

      <div className="mb-8 grid gap-4 sm:grid-cols-3 lg:grid-cols-6">
        <Field label="Cost">{formatUsd(record.costUsd)}</Field>
        <Field label="Judge cost">{formatUsd(record.judgeCostUsd)}</Field>
        <Field label="Latency">{formatDuration(record.latencyMs)}</Field>
        <Field label="Turns">{record.turns}</Field>
        <Field label="Tool calls">
          {record.toolCalls}
          {record.deniedToolCalls > 0 ? (
            <span className="ml-2 text-[11px] text-bad">{record.deniedToolCalls} denied</span>
          ) : null}
        </Field>
        <Field label="Subagents">{record.subagentCount}</Field>
      </div>

      <div className="mb-8 grid gap-4 sm:grid-cols-4">
        <Field label="Input tokens">{formatInt(record.usage.inputTokens)}</Field>
        <Field label="Output tokens">{formatInt(record.usage.outputTokens)}</Field>
        <Field label="Cache read">{formatInt(record.usage.cacheReadInputTokens)}</Field>
        <Field label="Cache write">{formatInt(record.usage.cacheCreationInputTokens)}</Field>
      </div>

      {record.error ? (
        <Panel title="Harness error">
          <pre className="scroll-x whitespace-pre-wrap break-words font-mono text-[12px] text-bad">
            {record.error}
          </pre>
        </Panel>
      ) : null}

      <Panel title="Phases" bleed>
        <div className="p-4">
          <PhaseTable rows={phaseRows} />
        </div>
      </Panel>

      <Panel title="Score breakdown">
        <ScoreBreakdown breakdown={record.breakdown} />
      </Panel>

      <Panel title="Penalties">
        <PenaltyList penalties={record.penalties} />
        {Object.keys(record.scoreMetadata).length > 0 ? (
          <div className="mt-4 border-t border-rule pt-4">
            <p className="eyebrow mb-2">Scorer metadata</p>
            <ScoreMetadata metadata={record.scoreMetadata} />
          </div>
        ) : null}
      </Panel>

      <Panel title="Final answer">
        {record.finalText.trim() ? (
          <pre className="scroll-x whitespace-pre-wrap break-words font-serif text-[15px] leading-relaxed text-ink-2">
            {record.finalText}
          </pre>
        ) : (
          <p className="text-[13px] text-muted">The run produced no final text.</p>
        )}
      </Panel>

      <Panel
        title="Trace"
        note={
          trace
            ? `${trace.length} events${
                subagentPhases && subagentPhases.size > 0
                  ? ` · ${subagentPhases.size} subagent thread${subagentPhases.size === 1 ? '' : 's'}`
                  : ''
              }`
            : 'not committed'
        }
      >
        {trace ? (
          <TraceTimeline events={trace} />
        ) : (
          <div className="text-[13px] text-ink-2">
            <p>
              The trace for this run was not committed. Traces are large, so{' '}
              <span className="font-mono text-[12px]">results/*/traces/</span> is gitignored by
              default and only a representative slice is kept — the run summary above carries
              everything the leaderboard needs.
            </p>
            <p className="mt-2 text-muted">
              Re-run this cell locally to produce it:{' '}
              <span className="font-mono text-[12px] text-ink-2">
                npm run arena -- run --strategies {record.strategyId} --tasks {record.taskId}{' '}
                --repeats 1
              </span>
            </p>
          </div>
        )}
      </Panel>
    </>
  );
}
