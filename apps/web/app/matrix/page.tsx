import type { Metadata } from 'next';

import { EmptyState } from '../../components/EmptyState';
import { PageHeader, Panel } from '../../components/Layout';
import { MatrixHeatmap } from '../../components/MatrixHeatmap';
import { SyntheticBanner } from '../../components/RunSetMeta';
import { buildMatrix, hasResults, loadRunSet, matrixKey } from '../../lib/data';

export const metadata: Metadata = {
  title: 'Strategy × task matrix',
  description: 'Mean score for every architecture on every task, as a readable heatmap.',
};

export default async function MatrixPage() {
  const data = await loadRunSet();
  if (!hasResults(data)) return <EmptyState />;

  const matrix = buildMatrix(data.summary, data.catalog);
  const hardest = [...matrix.tasks]
    .map((task) => {
      const scores = matrix.strategies
        .map((strategy) => matrix.cells[matrixKey(strategy.id, task.id)]?.meanScore)
        .filter((score): score is number => typeof score === 'number');
      const mean = scores.length === 0 ? 1 : scores.reduce((a, b) => a + b, 0) / scores.length;
      return { task, mean, covered: scores.length };
    })
    .filter((entry) => entry.covered > 0)
    .sort((a, b) => a.mean - b.mean)[0];

  return (
    <>
      <SyntheticBanner manifest={data.manifest} />

      <PageHeader
        eyebrow="Matrix"
        title="Where each architecture holds and where it breaks"
        lede="Mean score per strategy and task. An aggregate leaderboard hides the fact that architectures do not fail uniformly — a plan-and-verify loop that pays for itself on a hard multi-step refund can be dead weight on an easy lookup."
      />

      <Panel bleed>
        <div className="p-4">
          <MatrixHeatmap matrix={matrix} />
        </div>
      </Panel>

      {hardest ? (
        <p className="prose-serif max-w-3xl">
          The hardest task in this set is{' '}
          <span className="font-mono text-[14px] text-ink">{hardest.task.id}</span> —{' '}
          {hardest.task.title.toLowerCase()} — where the architectures average{' '}
          <span className="num text-ink">{hardest.mean.toFixed(2)}</span>. That column, not the
          leaderboard, is where a difference between harnesses is most likely to be real.
        </p>
      ) : null}
    </>
  );
}
