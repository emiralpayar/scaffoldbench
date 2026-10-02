import type { Metadata } from 'next';

import { EmptyState } from '../../../components/EmptyState';
import { PageHeader } from '../../../components/Layout';
import { RunSetBanner } from '../../../components/RunSetMeta';
import { resultsSwitcher } from '../../../components/leaderboard/ModelResults';
import { ModelSwitcher } from '../../../components/leaderboard/ModelSwitcher';
import { ParetoPlot } from '../../../components/charts/ScatterCharts';
import type { ModelAnalysis } from '../../../lib/analysis';
import { architectureName } from '../../../lib/architectures';
import { describeUnverifiedModel, paretoPoints } from '../../../lib/chartData';
import { formatUsd, joinList } from '../../../lib/format';
import { modelShortName } from '../../../lib/models';
import { pageMetadata } from '../../../lib/pageMetadata';
import { analysisFor } from '../../../lib/server/analysis';
import { loadRunSet } from '../../../lib/server/runSet';

export const metadata: Metadata = pageMetadata({
  title: 'Score against cost',
  description:
    'Mean score against mean cost per run for every harness architecture, with intervals on both axes and the frontier marked.',
  path: '/pareto/',
});

export default async function ParetoPage() {
  const data = await loadRunSet();
  if (!data || data.records.length === 0) return <EmptyState />;

  const analysis = analysisFor(data);

  return (
    <>
      <RunSetBanner data={data} />

      <PageHeader
        eyebrow="Score against cost"
        title={
          <>
            Which architecture should I use<span className="kern-q">?</span>
          </>
        }
        lede="Every architecture on the plane it is actually chosen on. A point is on the frontier when nothing else has a higher mean score for the same mean cost or less. The whiskers say how much that frontier can be trusted: where they overlap, the order is a statement about means only."
      />

      <div className="-mt-4 mb-10">
        <ModelSwitcher items={resultsSwitcher(data.models, 'cost')} />
      </div>

      {analysis.models.map((model) => (
        <section
          key={model.model}
          aria-labelledby={`pareto-${model.model}`}
          className="mb-16 grid grid-cols-[minmax(0,1fr)] gap-6 xl:grid-cols-[minmax(0,18rem)_minmax(0,1fr)] xl:gap-10"
        >
          {/* Beside the chart on wide screens, so the chart keeps its design width. */}
          <div>
            <h2 id={`pareto-${model.model}`} className="h2 text-ink">
              {modelShortName(model.model)}
            </h2>
            <p className="prose-serif mt-4 max-w-3xl">
              {data.verification === 'unverified' ? describeUnverifiedModel(model) : advice(model)}
            </p>
          </div>
          <div className="card self-start p-5 sm:p-6">
            <ParetoPlot points={paretoPoints(model)} model={modelShortName(model.model)} />
          </div>
        </section>
      ))}

      <p className="max-w-3xl text-[0.8125rem] leading-relaxed text-muted">{analysis.method}</p>
    </>
  );
}

/**
 * The actionable reading: the cheapest frontier point, and what the
 * intervals allow us to say about paying for more.
 */
function advice(model: ModelAnalysis): string {
  const frontier = model.architectures
    .filter((a) => model.frontier.includes(a.strategyId))
    .sort((a, b) => a.costUsd.mean - b.costUsd.mean);
  const cheapest = frontier[0];
  if (!cheapest) return 'No architecture has runs on this model.';
  const dominated = model.architectures.filter((a) => !model.frontier.includes(a.strategyId));
  const better = model.contrasts.filter((c) => c.verdict === 'better');

  const head = `On ${modelShortName(model.model)}, the mean frontier runs through ${joinList(
    frontier.map((a) => architectureName(a.strategyId)),
  )}, starting at ${formatUsd(cheapest.costUsd.mean)} a run.`;
  const off =
    dominated.length > 0
      ? ` ${joinList(dominated.map((a) => architectureName(a.strategyId)))} ${dominated.length === 1 ? 'is' : 'are'} dominated on means: something on the frontier scores at least as well for no more money.`
      : '';
  const pay =
    better.length > 0
      ? ` Only ${joinList(better.map((c) => architectureName(c.strategyId)))} ${better.length === 1 ? 'scores' : 'score'} reliably above a single agent, so ${better.length === 1 ? 'it is' : 'those are'} the only extra spend these intervals support.`
      : ' No architecture scores reliably above a single agent here, so these intervals support no extra spend.';
  return `${head}${off}${pay}`;
}
