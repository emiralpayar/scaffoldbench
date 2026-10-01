import Link from 'next/link';

import type { SiteAnalysis } from '../../lib/analysis';
import { describeModel, describeUnverifiedModel, paretoPoints, payoffData } from '../../lib/chartData';
import { leaderboardRows, scoreDomain } from '../../lib/leaderboard';
import { modelLabel, modelShortName } from '../../lib/models';
import { isRankable } from '../../lib/records';
import type { RunSetData } from '../../lib/server/runSet';
import { PageHeader } from '../Layout';
import { RunSetBanner } from '../RunSetMeta';
import { PayoffSmallMultiples } from '../charts/PayoffChart';
import { ParetoPlot } from '../charts/ScatterCharts';
import { HealthStrip } from './HealthStrip';
import { LeaderboardTable } from './LeaderboardTable';
import { ModelSwitcher } from './ModelSwitcher';
import { PairMatrix } from './PairMatrix';

/** Where each model's results live; the scaffold-or-scale view sits beside them. */
export function resultsSwitcher(models: readonly string[], current: string | 'scale') {
  return [
    ...models.map((model) => ({
      href: `/results/${model}/`,
      label: modelShortName(model),
      current: current === model,
    })),
    ...(models.length > 1 ? [{ href: '/results/scale/', label: 'Scaffold or scale?', current: current === 'scale' }] : []),
  ];
}

/**
 * One model's results: what they are computed over, the ranked leaderboard
 * with intervals, the pairs behind the ranks, and the two pictures a choice
 * is made on (does the structure pay, and score against cost).
 */
export function ModelResults({
  data,
  analysis,
  model,
}: {
  data: RunSetData;
  analysis: SiteAnalysis;
  model: string;
}) {
  const scoped = analysis.models.find((m) => m.model === model);
  // Without fidelity checks a row may not be the design it is named after,
  // so no rank or verdict is drawn from it.
  const verified = data.verification !== 'unverified';
  const records = data.records.filter((record) => record.model === model);
  const retried = records.filter((record) => (record.attempts ?? 1) > 1).length;

  const header = (
    <>
      <RunSetBanner data={data} />
      <PageHeader
        eyebrow={`Results · ${modelLabel(model)}`}
        title={
          <>
            Every architecture on {modelShortName(model)}
          </>
        }
        lede={
          verified
            ? 'Ranked by paired comparison: an architecture ranks below another only when, task by task and repeat by repeat, it scores reliably lower. Ties are shown as ties. Every number carries an interval bootstrapped over tasks.'
            : 'The numbers each architecture produced on this model, with intervals bootstrapped over tasks. This run set carries no fidelity checks, so nothing is ranked and no verdict is drawn.'
        }
      />
      <div className="-mt-4 mb-8">
        <ModelSwitcher items={resultsSwitcher(data.models, model)} />
      </div>
    </>
  );

  if (!scoped) {
    return (
      <>
        {header}
        <p className="prose-serif max-w-2xl">
          No run on {modelShortName(model)} can be ranked: every one was excluded. The health strip on the{' '}
          <Link href="/health/" className="link">
            harness health
          </Link>{' '}
          page says why.
        </p>
      </>
    );
  }

  const rows = leaderboardRows(scoped, analysis.baselineId, { ranked: verified });
  const domain = scoreDomain(rows);
  const baseline = scoped.architectures.find((arch) => arch.strategyId === analysis.baselineId);
  const payoff = payoffData({ ...analysis, models: [scoped] });

  return (
    <>
      {header}

      <HealthStrip health={scoped.health} verified={verified} retried={retried} />

      <p className="prose-serif mb-8 max-w-3xl text-[1.1875rem] text-ink">
        {verified ? describeModel(scoped) : describeUnverifiedModel(scoped)}
      </p>

      <section aria-labelledby="board-title" className="mb-16">
        <h2 id="board-title" className="sr-only">
          Leaderboard
        </h2>
        <LeaderboardTable rows={rows} domain={domain} {...(baseline ? { reference: baseline.score.mean } : {})} />
        <p className="mt-3 text-[0.8125rem] leading-relaxed text-muted">
          Dot: mean score over tasks. Whisker: its interval. The thin vertical line is the single agent&apos;s mean.
          {domain[0] > 0 || domain[1] < 1 ? ` The axis is zoomed to ${domain[0].toFixed(2)}–${domain[1].toFixed(2)}.` : ''}{' '}
          Runs: ranked of recorded, with the rest excluded and counted above.
        </p>
      </section>

      {verified && scoped.pairwise.length > 0 ? (
        <section aria-labelledby="pairs-title" className="mb-16 grid gap-8 lg:grid-cols-[minmax(0,19rem)_minmax(0,1fr)]">
          <div>
            <h2 id="pairs-title" className="h2 text-ink">
              Why these ranks
            </h2>
            <p className="prose-serif mt-4">
              Each cell is the paired score difference, row minus column, over the tasks and repeats both ran. ▲ and ▼
              mark the pairs whose interval, widened for the {scoped.pairwise.length} comparisons made at once,
              excludes zero. Everything else is a tie.
            </p>
          </div>
          <PairMatrix model={scoped} order={rows.map((row) => row.strategyId)} />
        </section>
      ) : null}

      <section aria-labelledby="pay-title" className="mb-16">
        <h2 id="pay-title" className="h2 mb-8 max-w-3xl text-ink">
          Does the structure pay for itself on {modelShortName(model)}<span className="kern-q">?</span>
        </h2>
        <div className="grid gap-6 xl:grid-cols-2">
          {payoff.panels.length > 0 ? (
            <div className="card min-w-0 p-5 sm:p-6">
              <PayoffSmallMultiples data={payoff} method={analysis.method} single />
            </div>
          ) : null}
          <div className="card min-w-0 p-5 sm:p-6">
            <ParetoPlot points={paretoPoints(scoped)} model={modelShortName(model)} />
          </div>
        </div>
      </section>

      <p className="max-w-3xl text-[0.8125rem] leading-relaxed text-muted">
        {analysis.method} Computed over {records.filter(isRankable).length} ranked runs of {records.length} on this model.
      </p>

      <nav aria-label="More results" className="mt-10 flex flex-wrap gap-x-6 gap-y-2 border-t border-rule pt-5 text-[0.9375rem]">
        {data.models.length > 1 ? (
          <Link href="/results/scale/" className="link">
            Scaffold or scale: every model on one plane →
          </Link>
        ) : null}
        <Link href={`/matrix/${model}/`} className="link">
          Every run, task by task →
        </Link>
        <Link href="/methodology/" className="link">
          How the numbers are made →
        </Link>
      </nav>
    </>
  );
}
