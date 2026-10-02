import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { ArchitectureGlyph } from '../../../../components/ArchitectureGlyph';
import { CheckRateList } from '../../../../components/health/CheckRateList';
import { PageHeader } from '../../../../components/Layout';
import { RunSetBanner } from '../../../../components/RunSetMeta';
import { ModelSwitcher } from '../../../../components/leaderboard/ModelSwitcher';
import { StageCostBars } from '../../../../components/strategies/StageCostBars';
import type { Standing } from '../../../../components/strategies/StandingTable';
import { StandingTable } from '../../../../components/strategies/StandingTable';
import { StrategyScroller } from '../../../../components/strategies/StrategyScroller';
import { RunExplorer } from '../../../../components/timeline/RunExplorer';
import { TimelineChart } from '../../../../components/timeline/TimelineChart';
import { ARCHITECTURES, architectureColor, architectureInfo, architectureName } from '../../../../lib/architectures';
import type { ArchitectureId } from '../../../../lib/architectures';
import { DESIGNS } from '../../../../lib/designs';
import { leaderboardRows } from '../../../../lib/leaderboard';
import { modelShortName } from '../../../../lib/models';
import { isRankable } from '../../../../lib/records';
import { analysisFor } from '../../../../lib/server/analysis';
import { loadRepresentativeRun } from '../../../../lib/server/replays';
import { loadRunSet } from '../../../../lib/server/runSet';
import { sourceUrl } from '../../../../lib/site';
import { harnessCheckRates, ownCheckRates, stageCosts } from '../../../../lib/strategies';
import { timelineFromPhases, timelineFromTrace } from '../../../../lib/timeline';
import { buildViewGroups, trimGroups } from '../../../../lib/traceView';
import { formatInt } from '../../../../lib/format';
import { runReceipts } from '../../../../lib/postmortem';
import { schematicTimeline } from '../../../../lib/schematic';

interface Params {
  params: Promise<{ id: string }>;
}

/** Where each design lives in `packages/strategies`. */
const SOURCE: Record<ArchitectureId, string> = {
  single: 'packages/strategies/src/single.ts',
  'plan-execute': 'packages/strategies/src/planExecute.ts',
  'orchestrator-workers': 'packages/strategies/src/orchestratorWorkers.ts',
  'plan-execute-verify': 'packages/strategies/src/planExecuteVerify.ts',
  'propose-select': 'packages/strategies/src/proposeSelect.ts',
  'gated-execute': 'packages/strategies/src/gatedExecute.ts',
};

export function generateStaticParams(): { id: string }[] {
  return ARCHITECTURES.map((info) => ({ id: info.id }));
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { id } = await params;
  const info = architectureInfo(id);
  return {
    title: info ? `${info.name}: how it runs and what it costs` : id,
    description: info
      ? `${info.summary} The stages of the design, where a run's money goes, and the fidelity checks that prove it ran.`
      : undefined,
  };
}

export default async function StrategyPage({ params }: Params) {
  const { id } = await params;
  const info = architectureInfo(id);
  if (!info || info.id !== id) notFound();
  const design = DESIGNS[info.id];
  const color = architectureColor(info.id);
  const index = ARCHITECTURES.indexOf(info);
  const previous = ARCHITECTURES[index - 1];
  const next = ARCHITECTURES[index + 1];

  const data = await loadRunSet();
  const mine = data?.records.filter((record) => record.strategyId === info.id) ?? [];
  const ranked = mine.filter(isRankable);
  const verified = data ? data.verification !== 'unverified' : false;
  const analysis = data && mine.length > 0 ? analysisFor(data) : null;
  const costs = stageCosts(ranked, info.id);
  const own = ownCheckRates(mine, info.id);
  const harness = harnessCheckRates(mine);
  const harnessFailed = harness.some((rate) => rate.ok < rate.total);
  const representative = mine.length > 0 ? await loadRepresentativeRun(info.id) : null;
  const source = sourceUrl(SOURCE[info.id]);

  const standings: Standing[] = (analysis?.models ?? []).flatMap((model) => {
    const row = leaderboardRows(model, analysis?.baselineId ?? 'single', { ranked: verified }).find(
      (candidate) => candidate.strategyId === info.id,
    );
    return row ? [{ model: model.model, row, of: model.architectures.length }] : [];
  });

  return (
    <>
      {data ? <RunSetBanner data={data} /> : null}

      <PageHeader
        eyebrow="Architecture"
        title={
          <span className="flex flex-wrap items-center gap-x-5 gap-y-3">
            <ArchitectureGlyph id={info.id} width={96} />
            <span>{info.name}</span>
          </span>
        }
        lede={design.question}
      />
      <div className="-mt-4 mb-10">
        <ModelSwitcher
          label="Architecture"
          items={ARCHITECTURES.map((a) => ({ href: `/strategies/${a.id}/`, label: a.name, current: a.id === info.id }))}
        />
      </div>

      <p className="prose-serif mb-16 max-w-3xl text-[1.1875rem] text-ink">{info.summary}</p>

      <section aria-labelledby="runs-title" className="mb-24">
        <h2 id="runs-title" className="h2 mb-10 max-w-3xl text-ink">
          How it runs
        </h2>
        <StrategyScroller
          id={info.id}
          steps={design.stages.map((stage) => ({
            id: stage.id,
            title: stage.title,
            nodes: stage.nodes,
            tools: stage.tools,
            parallel: !!stage.parallel,
            body: stage.body,
          }))}
        />
        <div className="mt-10 max-w-3xl rounded-[14px] border border-rule bg-surface px-5 py-4">
          <p className="eyebrow">Where it can fail quietly</p>
          <p className="prose-serif mt-2 !text-[1rem]">{design.risk}</p>
        </div>
      </section>

      {mine.length === 0 ? (
        <p className="prose-serif max-w-2xl rounded-[14px] border border-dashed border-rule-strong p-6">
          {data
            ? `No run of ${info.name} is in the published run set, so there are no costs, fidelity rates or runs to show here.`
            : 'No run set is published in this build, so there are no costs, fidelity rates or runs to show here.'}
        </p>
      ) : (
        <>
          {standings.length > 0 ? (
            <section aria-labelledby="standing-title" className="mb-24">
              <h2 id="standing-title" className="h2 mb-3 max-w-3xl text-ink">
                What the structure buys
              </h2>
              <p className="prose-serif mb-8 max-w-3xl">
                {!verified
                  ? 'This run set carries no fidelity checks, so nothing proves the runs below executed this design and no comparison is drawn from them. They are the numbers the runs produced.'
                  : info.id === 'single'
                    ? 'The control. Every other architecture is measured as a difference from these numbers, task by task and repeat by repeat.'
                    : `${info.name} against a single agent on the same tasks and repeats, on each model. The interval is on the paired difference, so it is as wide as the evidence is thin.`}
              </p>
              <StandingTable standings={standings} verified={verified} />
            </section>
          ) : null}

          {costs.length > 0 ? (
            <section aria-labelledby="cost-title" className="mb-24">
              <h2 id="cost-title" className="h2 mb-3 max-w-3xl text-ink">
                Where the money goes
              </h2>
              <p className="prose-serif mb-8 max-w-3xl">
                A run of {info.name} is {design.stages.length === 1 ? 'one call' : `${design.stages.length} stages`}.
                This is what each one costs, so the price of the structure is separate from the price of the work.
              </p>
              <StageCostBars strategyId={info.id} costs={costs} />
            </section>
          ) : null}

          <section aria-labelledby="fidelity-title" className="mb-24">
            <h2 id="fidelity-title" className="h2 mb-3 max-w-3xl text-ink">
              Did it run as designed?
            </h2>
            <p className="prose-serif mb-8 max-w-3xl">
              {own.length === 0 && harness.length === 0
                ? 'The runs of this architecture predate the fidelity checks, so nothing here proves each one executed its design.'
                : 'Each check is recorded with every run. A run that fails one is excluded from every ranking and counted, never scored.'}
            </p>
            <div className="grid gap-8 lg:grid-cols-2">
              <div className="card min-w-0 px-5 py-2 sm:px-6">
                <h3 className="eyebrow pt-4 !text-ink-2">The design’s own checks</h3>
                <CheckRateList rates={own} />
              </div>
              <details className="card min-w-0 self-start px-5 py-4 sm:px-6" open={harnessFailed}>
                <summary className="eyebrow !text-ink-2">
                  The harness’s checks
                  <span className="ml-3 normal-case tracking-normal text-muted">
                    {harness.length === 0
                      ? 'none recorded'
                      : harnessFailed
                        ? `${harness.filter((rate) => rate.ok < rate.total).length} of ${harness.length} failed at least once`
                        : `all ${harness.length} held in every run`}
                  </span>
                </summary>
                <div className="mt-2">
                  <CheckRateList rates={harness} />
                </div>
              </details>
            </div>
            <p className="mt-4 text-[0.875rem]">
              <Link href="/health/" className="link">
                Harness health across every architecture →
              </Link>
            </p>
          </section>

          {representative ? (
            <section aria-labelledby="run-title" className="mb-24">
              <h2 id="run-title" className="h2 mb-3 max-w-3xl text-ink">
                A run of it
              </h2>
              <p className="prose-serif mb-8 max-w-3xl">
                {info.name} on <em>{representative.record.taskTitle}</em> with {modelShortName(representative.record.model)},
                repeat {representative.record.repeat}.{' '}
                {representative.record.integrity
                  ? representative.record.passed
                    ? 'It passed.'
                    : `It scored ${representative.record.score.toFixed(3)}.`
                  : ''}
              </p>
              {representative.record.integrity ? null : <LegacyReceipts record={representative.record} />}
              <Representative run={representative} color={color} name={architectureName(info.id)} />
              <p className="mt-4 text-[0.875rem]">
                <Link href={`/runs/${representative.record.runId}/`} className="link">
                  The whole run, message by message →
                </Link>
              </p>
            </section>
          ) : null}

          <p className="mb-10 text-[0.8125rem] text-muted">
            {formatInt(ranked.length)} ranked runs of {formatInt(mine.length)} recorded.
          </p>
        </>
      )}

      <nav aria-label="Other architectures" className="flex flex-wrap items-center justify-between gap-4 border-t border-rule pt-6 text-[0.9375rem]">
        <span>
          {previous ? (
            <Link href={`/strategies/${previous.id}/`} className="link">
              ← {previous.name}
            </Link>
          ) : null}
        </span>
        <span className="flex flex-wrap items-center gap-x-6 gap-y-2">
          <Link href="/strategies/" className="link">
            All six designs
          </Link>
          {source ? (
            <a href={source} className="link">
              Source: <code className="code-inline">{SOURCE[info.id]}</code>
            </a>
          ) : null}
        </span>
        <span>
          {next ? (
            <Link href={`/strategies/${next.id}/`} className="link">
              {next.name} →
            </Link>
          ) : null}
        </span>
      </nav>
    </>
  );
}

/**
 * A run recorded before the fidelity checks has only its own records to
 * vouch for it, so say what they admit to: the same receipts its run page
 * gives. Without this, showing it as "a run of" the design would be a claim
 * the records do not support.
 */
function LegacyReceipts({ record }: { record: Parameters<typeof runReceipts>[0] }) {
  const receipts = runReceipts(record);
  return (
    <div role="note" className="banner banner-bad mb-6 max-w-3xl">
      <p className="banner-title">Recorded before the fidelity checks</p>
      <p className="banner-body">
        {receipts.length === 0
          ? 'Nothing in its records shows a problem, but nothing proves the design ran either.'
          : 'By its own records, this run did not run as designed:'}
      </p>
      {receipts.length > 0 ? (
        <ul className="mt-2 list-disc space-y-1 pl-5 text-[0.9375rem] leading-snug text-ink-2">
          {receipts.map((receipt) => (
            <li key={receipt}>{receipt}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * The run, as the most it can be shown: the explorer when its trace is in
 * this build, else the phases as a timeline when the run came from the
 * runner that timed parallel phases correctly, else the design's schematic,
 * labelled as one.
 */
function Representative({
  run,
  color,
  name,
}: {
  run: NonNullable<Awaited<ReturnType<typeof loadRepresentativeRun>>>;
  color: string;
  name: string;
}) {
  const { record, trace } = run;
  if (trace && trace.length > 0) {
    return (
      <RunExplorer
        timeline={timelineFromTrace(trace, record.phases)}
        groups={trimGroups(buildViewGroups(trace))}
        color={color}
        label={`Timeline of ${name} on ${record.taskTitle}: one row per model call.`}
      />
    );
  }
  if (record.integrity && record.phases.length > 0) {
    return (
      <div className="card p-5">
        <TimelineChart
          timeline={timelineFromPhases(record.phases)}
          color={color}
          label={`Phases of ${name} on ${record.taskTitle}, from the run record.`}
        />
        <p className="mt-3 text-[0.8125rem] text-muted">
          Drawn from the phase records: timing and cost per call. This run’s trace is not in this build.
        </p>
      </div>
    );
  }
  const schematic = schematicTimeline(architectureInfo(record.strategyId)?.id ?? 'single');
  return (
    <div className="card p-5">
      <TimelineChart timeline={schematic} color={color} label={`Schematic of ${name}: the calls the design makes, on an invented clock.`} />
      <p className="mt-3 text-[0.8125rem] text-muted">
        Schematic, not a recording: this run’s trace is not in this build, and its phase records predate the
        runner that times parallel calls correctly.
      </p>
    </div>
  );
}
