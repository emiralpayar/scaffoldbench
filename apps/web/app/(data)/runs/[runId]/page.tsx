import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { ArchitectureGlyph } from '../../../../components/ArchitectureGlyph';
import { EmptyState } from '../../../../components/EmptyState';
import { Panel, Tag, Verdict } from '../../../../components/Layout';
import { Markdown } from '../../../../components/Markdown';
import { PenaltyList, PhaseTable, ScoreBreakdown, ScoreMetadata } from '../../../../components/RunDetail';
import { IntegrityList, RunReceipts } from '../../../../components/RunIntegrity';
import { RunSetBanner } from '../../../../components/RunSetMeta';
import { RunExplorer } from '../../../../components/timeline/RunExplorer';
import { TimelineChart } from '../../../../components/timeline/TimelineChart';
import { architectureColor, architectureName } from '../../../../lib/architectures';
import { buildPhaseRows, findRun } from '../../../../lib/derive';
import { formatDuration, formatFailureMode, formatInt, formatScore, formatUsd } from '../../../../lib/format';
import { modelShortName } from '../../../../lib/models';
import { EMPTY_PARAM, loadRunSet, loadTrace } from '../../../../lib/server/runSet';
import { normalizeError, timelineFromPhases, timelineFromTrace } from '../../../../lib/timeline';
import { buildViewGroups } from '../../../../lib/traceView';

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
  const data = await loadRunSet();
  const record = data ? findRun(data.records, runId) : undefined;
  if (!record) return { title: runId };
  return {
    title: `${architectureName(record.strategyId)} on ${record.taskTitle}, repeat ${record.repeat}`,
    description: `The trace, timeline and score of run ${runId}: ${architectureName(record.strategyId)} on "${record.taskTitle}" with ${modelShortName(record.model)}.`,
  };
}

export default async function RunPage({ params }: Params) {
  const { runId } = await params;
  const data = await loadRunSet();
  if (!data || data.records.length === 0) return <EmptyState />;

  const record = findRun(data.records, runId);
  if (!record) notFound();

  const trace = await loadTrace(data, record);
  const color = architectureColor(record.strategyId);
  const name = architectureName(record.strategyId);
  // Phase records written before the v1 runner timed parallel phases from
  // when they were *recorded*, not when they started, so without a trace
  // their timeline would draw parallel work as sequential. Only a record
  // carrying integrity checks comes from the runner that fixed it.
  const phaseTimeline =
    !trace && record.integrity && record.phases.length > 0 ? timelineFromPhases(record.phases) : null;
  const timeline = trace ? timelineFromTrace(trace, record.phases) : phaseTimeline;
  const groups = trace ? buildViewGroups(trace) : [];
  const totalInput =
    record.usage.inputTokens + record.usage.cacheReadInputTokens + record.usage.cacheCreationInputTokens;

  return (
    <>
      <RunSetBanner data={data} />

      <header className="mb-8 grid gap-6 border-b border-rule pb-8 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
        <div className="min-w-0">
          <p className="eyebrow flex flex-wrap items-center gap-x-2 gap-y-1">
            <span>Run</span>
            <span aria-hidden>·</span>
            <span>{modelShortName(record.model)}</span>
            <span aria-hidden>·</span>
            <span>repeat {record.repeat}</span>
          </p>
          <h1 className="h1 mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-ink">
            <ArchitectureGlyph id={record.strategyId} width={64} />
            <span>
              {name} <span className="text-ink-2">on</span>{' '}
              <Link href={`/tasks/${record.taskId}/`} className="link-quiet">
                {record.taskTitle}
              </Link>
            </span>
          </h1>
          <p className="mt-3 font-mono text-[0.8125rem] text-muted [overflow-wrap:anywhere]">{record.runId}</p>
        </div>
        <div className="flex flex-wrap items-end gap-x-8 gap-y-4">
          <div>
            <p className="eyebrow">Score</p>
            <p className="num mt-1 text-[2rem] leading-none text-ink">{formatScore(record.score)}</p>
          </div>
          <div className="pb-1">
            {record.failureMode === 'api_error' ? (
              <span className="chip-quiet">lost to the API</span>
            ) : (
              <Verdict state={record.passed ? 'pass' : record.score > 0 ? 'partial' : 'fail'}>
                {record.passed ? 'passed' : formatFailureMode(record.failureMode)}
              </Verdict>
            )}
          </div>
          <IntegrityBadge record={record} />
        </div>
      </header>

      <nav aria-label="Related" className="mb-8 flex flex-wrap items-center gap-2">
        <Link href={`/strategies/${record.strategyId}/`} className="chip hover:border-ink-2">
          {name} →
        </Link>
        <Link href={`/tasks/${record.taskId}/`} className="chip hover:border-ink-2">
          Task: {record.taskId} →
        </Link>
        <Tag>{record.taskCategory}</Tag>
        <Tag>{record.taskDifficulty}</Tag>
        <Tag>{record.effort} effort</Tag>
      </nav>

      <RunReceipts data={data} record={record} />

      <dl className="mb-10 grid grid-cols-2 gap-x-6 gap-y-5 rounded-[14px] border border-rule bg-surface p-5 sm:grid-cols-3 lg:grid-cols-6">
        <Metric label="Cost" value={formatUsd(record.costUsd)} hint={record.judgeCostUsd > 0 ? `+ ${formatUsd(record.judgeCostUsd)} judging` : undefined} />
        <Metric
          label="Latency"
          value={formatDuration(record.latencyMs)}
          hint={record.setupMs !== undefined ? `setup ${formatDuration(record.setupMs)}, grading ${formatDuration(record.gradingMs ?? 0)}` : undefined}
        />
        <Metric label="Turns" value={String(record.turns)} />
        <Metric
          label="Tool calls"
          value={String(record.toolCalls)}
          hint={record.deniedToolCalls > 0 ? `${record.deniedToolCalls} denied by the guard` : undefined}
          tone={record.deniedToolCalls > 0 ? 'bad' : undefined}
        />
        <Metric label="Subagents" value={String(record.subagentCount)} />
        <Metric
          label="Tokens in / out"
          value={`${compact(totalInput)} / ${compact(record.usage.outputTokens)}`}
          hint={`${formatInt(record.usage.cacheReadInputTokens)} read from cache`}
        />
        {record.attempts && record.attempts > 1 ? (
          <Metric label="Attempts" value={String(record.attempts)} hint="retried after API errors" />
        ) : null}
      </dl>

      {record.integrity ? (
        <Panel title="Did the design run?" note={record.integrity.ok ? 'every check held' : 'excluded from rankings'}>
          <IntegrityList integrity={record.integrity} />
        </Panel>
      ) : null}

      {record.error ? (
        <Panel title="Harness error">
          <p className="text-[0.9375rem] text-bad">{normalizeError(record.error)}</p>
          {normalizeError(record.error) !== record.error.trim() ? (
            <pre className="detail-pre mt-3">{record.error}</pre>
          ) : null}
        </Panel>
      ) : null}

      <section aria-labelledby="trace-title" className="mb-10">
        <div className="mb-4 flex flex-wrap items-baseline justify-between gap-3">
          <h2 id="trace-title" className="h3 text-ink">
            {trace ? 'The run, call by call' : 'Phases'}
          </h2>
          {trace ? (
            <p className="text-[0.8125rem] text-muted">
              {trace.length} recorded events, folded into {groups.reduce((n, g) => n + g.items.length, 0)}
            </p>
          ) : null}
        </div>
        {trace && timeline ? (
          <RunExplorer
            timeline={timeline}
            groups={groups}
            color={color}
            label={`Timeline of ${name} on ${record.taskTitle}: one row per model call.`}
          />
        ) : (
          <NoTrace record={record} phaseTimeline={phaseTimeline} color={color} />
        )}
      </section>

      <div className="grid gap-x-8 lg:grid-cols-2">
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
      </div>

      <Panel title="Final answer">
        {record.finalText.trim() ? (
          <Markdown source={record.finalText} className="!text-[0.9375rem]" />
        ) : (
          <p className="text-[0.875rem] text-muted">The run produced no final text.</p>
        )}
      </Panel>
    </>
  );
}

function NoTrace({
  record,
  phaseTimeline,
  color,
}: {
  record: Parameters<typeof buildPhaseRows>[0];
  phaseTimeline: ReturnType<typeof timelineFromPhases> | null;
  color: string;
}) {
  return (
    <div className="card overflow-hidden">
      {phaseTimeline ? (
        <div className="border-b border-rule px-4 py-5 sm:px-5">
          <TimelineChart
            timeline={phaseTimeline}
            color={color}
            label={`Phases of ${architectureName(record.strategyId)} on ${record.taskTitle}, from the run record.`}
          />
          <p className="mt-3 text-[0.8125rem] text-muted">
            Drawn from the phase records: timing and cost per call, no tool calls or messages.
          </p>
        </div>
      ) : null}
      <div className="p-4">
        <PhaseTable rows={buildPhaseRows(record, [])} />
      </div>
      <div className="border-t border-rule px-5 py-4 text-[0.875rem] leading-relaxed text-ink-2">
        <p>
          This run&apos;s trace is not in the repository, so the call-by-call replay is not available.
          {!record.integrity
            ? ' Its phase records come from the runner before the fidelity gate, which did not time parallel phases by when they started, so they are listed rather than drawn on a clock.'
            : ''}
        </p>
        <p className="mt-2 text-muted">
          Re-run this cell to produce one:{' '}
          <code className="code-inline">
            npm run arena -- run --strategies {record.strategyId} --tasks {record.taskId} --repeats 1
          </code>
        </p>
      </div>
    </div>
  );
}

function IntegrityBadge({ record }: { record: { integrity?: { ok: boolean } } }) {
  if (!record.integrity) {
    return (
      <span className="chip-quiet mb-1" title="Recorded before the fidelity gate existed">
        design not verified
      </span>
    );
  }
  return record.integrity.ok ? (
    <span className="chip-good mb-1">design ran as designed</span>
  ) : (
    <span className="chip-bad mb-1">fidelity check failed</span>
  );
}

function Metric({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string | undefined;
  tone?: 'bad' | undefined;
}) {
  return (
    <div className="min-w-0">
      <dt className="eyebrow">{label}</dt>
      <dd className={`num mt-1 text-[1.125rem] leading-tight ${tone === 'bad' ? 'text-bad' : 'text-ink'}`}>{value}</dd>
      {hint ? <dd className="mt-1 text-[0.75rem] leading-snug text-muted">{hint}</dd> : null}
    </div>
  );
}

function compact(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 10_000) return `${Math.round(value / 1000)}k`;
  if (value >= 1_000) return `${(value / 1000).toFixed(1)}k`;
  return String(value);
}
