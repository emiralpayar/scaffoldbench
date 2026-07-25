import type { Metadata } from 'next';

import { comparisonVerdict } from '@arena/core';

import { EmptyState } from '../../components/EmptyState';
import { PageHeader, Panel, Tag } from '../../components/Layout';
import { ParetoChart } from '../../components/ParetoChart';
import { SyntheticBanner } from '../../components/RunSetMeta';
import type { LeaderboardRow } from '../../lib/data';
import {
  buildLeaderboardRows,
  buildParetoModel,
  formatDuration,
  formatPercent,
  formatScore,
  formatUsd,
  hasResults,
  loadRunSet,
} from '../../lib/data';

export const metadata: Metadata = {
  title: 'Score against cost',
  description:
    'Mean score against mean cost per run for every harness architecture, with the Pareto frontier marked.',
};

export default async function ParetoPage() {
  const data = await loadRunSet();
  if (!hasResults(data)) return <EmptyState />;

  const rows = buildLeaderboardRows(data.summary, data.catalog, 'all');
  const model = buildParetoModel(rows);
  const advice = recommend(rows);

  return (
    <>
      <SyntheticBanner manifest={data.manifest} />

      <PageHeader
        eyebrow="Score against cost"
        title="Which architecture should I use?"
        lede="Every architecture placed on the plane it is actually chosen on. A point is on the frontier when nothing else scores at least as well for the same money or less; everything below and to the right of the line is a worse deal at every budget."
      />

      <Panel title="Mean score vs mean cost per run">
        <ParetoChart model={model} />
      </Panel>

      <Panel title="The read">
        <p className="prose-serif max-w-3xl">{advice}</p>
      </Panel>

      <Panel title="The same numbers as a table" bleed>
        <div className="scroll-x">
          <table className="w-full min-w-[48rem] border-collapse text-[13px]">
            <thead>
              <tr className="border-b border-rule">
                <th scope="col" className="eyebrow px-3 py-2 text-left font-normal">
                  Strategy
                </th>
                <th scope="col" className="eyebrow px-3 py-2 text-left font-normal">
                  Position
                </th>
                <th scope="col" className="eyebrow px-3 py-2 text-right font-normal">
                  Mean score
                </th>
                <th scope="col" className="eyebrow px-3 py-2 text-right font-normal">
                  95% CI
                </th>
                <th scope="col" className="eyebrow px-3 py-2 text-right font-normal">
                  Cost / run
                </th>
                <th scope="col" className="eyebrow px-3 py-2 text-right font-normal">
                  Latency
                </th>
                <th scope="col" className="eyebrow px-3 py-2 text-right font-normal">
                  Pass
                </th>
                <th scope="col" className="eyebrow px-3 py-2 text-right font-normal">
                  Score / $
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.strategyId} className="border-b border-rule/70 last:border-0">
                  <td className="px-3 py-2 text-ink">{row.label}</td>
                  <td className="px-3 py-2">
                    {row.onFrontier ? (
                      <Tag tone="accent">◆ frontier</Tag>
                    ) : (
                      <Tag>dominated</Tag>
                    )}
                  </td>
                  <td className="num px-3 py-2 text-right text-ink">
                    {formatScore(row.score.mean)}
                  </td>
                  <td className="num px-3 py-2 text-right text-muted">
                    {formatScore(row.score.ciLow)}–{formatScore(row.score.ciHigh)}
                  </td>
                  <td className="num px-3 py-2 text-right text-ink-2">
                    {formatUsd(row.costUsd.mean)}
                  </td>
                  <td className="num px-3 py-2 text-right text-ink-2">
                    {formatDuration(row.latencyMs.mean)}
                  </td>
                  <td className="num px-3 py-2 text-right text-ink-2">
                    {formatPercent(row.passRate)}
                  </td>
                  <td className="num px-3 py-2 text-right text-ink-2">
                    {row.scorePerDollar > 0 ? row.scorePerDollar.toFixed(1) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </>
  );
}

/**
 * The actionable answer is not "the highest mean" — it is the cheapest option
 * this data cannot show to be worse than the highest mean.
 */
function recommend(rows: readonly LeaderboardRow[]): string {
  const best = rows[0];
  if (!best) return 'No runs yet.';
  if (rows.length === 1) {
    return `Only ${best.label} has runs in this set, so the plane has nothing to compare it against.`;
  }

  const contenders = rows
    .filter((row) => comparisonVerdict(best.score, row.score) === 'inconclusive')
    .sort((a, b) => a.costUsd.mean - b.costUsd.mean);
  const cheapest = contenders[0] ?? best;

  const headline =
    cheapest.strategyId === best.strategyId
      ? `${best.label} tops the plane at ${formatScore(best.score.mean)} for ${formatUsd(best.costUsd.mean)} a run, and nothing cheaper comes within its confidence interval.`
      : `${best.label} has the highest mean at ${formatScore(best.score.mean)}, but ${cheapest.label} — ${formatScore(cheapest.score.mean)} at ${formatUsd(cheapest.costUsd.mean)} a run, ${(best.costUsd.mean / Math.max(cheapest.costUsd.mean, 1e-9)).toFixed(1)}× cheaper — is not separable from it at this sample size. Take the cheaper one until more repeats say otherwise.`;

  const dominated = rows.filter((row) => !row.onFrontier);
  const tail =
    dominated.length === 0
      ? ' Every architecture in this set is on the frontier somewhere.'
      : ` ${dominated.map((row) => row.label).join(', ')} ${dominated.length === 1 ? 'is' : 'are'} off the frontier: another architecture matches or beats ${dominated.length === 1 ? 'it' : 'them'} for no more money, so ${dominated.length === 1 ? 'it has' : 'they have'} no budget at which ${dominated.length === 1 ? 'it is' : 'they are'} the right choice.`;

  const latency =
    best.latencyMs.mean > 0
      ? ` Wall clock is the axis this plane omits: the leader takes ${formatDuration(best.latencyMs.mean)} a run against ${formatDuration(cheapest.latencyMs.mean)} for the cheaper option.`
      : '';

  return `${headline}${tail}${latency}`;
}
