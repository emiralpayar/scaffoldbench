import type { Metadata } from 'next';
import Link from 'next/link';

import { EmptyState } from '../../components/EmptyState';
import { LeaderboardView } from '../../components/LeaderboardView';
import { PageHeader, Stat } from '../../components/Layout';
import { RunSetBanner } from '../../components/RunSetMeta';
import { buildLeaderboardViews, defaultModel, modelView } from '../../lib/derive';
import { formatUsd } from '../../lib/format';
import { modelShortName } from '../../lib/models';
import { loadRunSet } from '../../lib/server/runSet';

export const metadata: Metadata = {
  title: 'Results',
  description:
    'Mean score, cost and latency for every harness architecture, with bootstrap confidence intervals.',
};

export default async function ResultsPage() {
  const data = await loadRunSet();
  const model = data ? defaultModel(data.models) : undefined;
  if (!data || !model || data.records.length === 0) return <EmptyState />;

  const view = modelView(data.records, model);
  const views = buildLeaderboardViews(view.summary, data.catalog, view.ranked);
  const taskCount = new Set(view.ranked.map((record) => record.taskId)).size;
  const judgeCost = view.summary.totals.judgeCostUsd;

  return (
    <>
      <RunSetBanner data={data} />

      <PageHeader
        eyebrow={`Results · ${modelShortName(model)}`}
        title="Every architecture, one model at a time"
        lede={`Mean score per architecture on ${modelShortName(model)}${
          data.models.length > 1 ? ` (one of the ${data.models.length} models in this run set)` : ''
        }, with a bootstrap interval on every mean. Rows whose intervals overlap are not separated by this data.`}
        aside={
          <div className="flex gap-8">
            <Stat label="Runs" value={view.ranked.length} />
            <Stat label="Tasks" value={taskCount} />
            <Stat
              label="Spent"
              value={formatUsd(view.summary.totals.costUsd)}
              {...(judgeCost > 0 ? { hint: `+ ${formatUsd(judgeCost)} judging` } : {})}
            />
          </div>
        }
      />

      <LeaderboardView views={views} />

      <nav className="mt-10 flex flex-wrap gap-x-6 gap-y-2 border-t border-rule pt-5 text-[14px]">
        <Link href="/pareto/" className="link">
          Score against cost →
        </Link>
        <Link href="/matrix/" className="link">
          Architecture × task matrix →
        </Link>
      </nav>
    </>
  );
}
