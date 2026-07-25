import Link from 'next/link';

import { EmptyState } from '../components/EmptyState';
import { LeaderboardView } from '../components/LeaderboardView';
import { PageHeader, Stat } from '../components/Layout';
import { SyntheticBanner } from '../components/RunSetMeta';
import { buildLeaderboardViews, formatUsd, hasResults, loadRunSet } from '../lib/data';

export default async function LeaderboardPage() {
  const data = await loadRunSet();
  if (!hasResults(data)) return <EmptyState />;

  const views = buildLeaderboardViews(data.summary, data.catalog, data.records);
  const taskCount = new Set(data.records.map((record) => record.taskId)).size;

  return (
    <>
      <SyntheticBanner manifest={data.manifest} />

      <PageHeader
        eyebrow="Leaderboard"
        title="Which harness architecture actually wins?"
        lede="Five agent architectures, one task set, the same tooling and the same budget. Score is the weighted assertion grid for tool-use tasks and a judged rubric plus citation integrity for research tasks; every mean carries a bootstrap interval, because three repeats do not settle an argument."
        aside={
          <div className="flex gap-8">
            <Stat label="Runs" value={data.records.length} />
            <Stat label="Tasks" value={taskCount} />
            <Stat
              label="Spent"
              value={formatUsd(data.summary.totals.costUsd)}
              hint={`+ ${formatUsd(data.summary.totals.judgeCostUsd)} judging`}
            />
          </div>
        }
      />

      <LeaderboardView views={views} />

      <nav className="mt-10 flex flex-wrap gap-x-6 gap-y-2 border-t border-rule pt-5 text-[13px]">
        <Link href="/pareto" className="text-accent underline-offset-2 hover:underline">
          Score against cost →
        </Link>
        <Link href="/matrix" className="text-accent underline-offset-2 hover:underline">
          Strategy × task matrix →
        </Link>
      </nav>
    </>
  );
}
