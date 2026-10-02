import Link from 'next/link';

import type { PairedVerdict } from '../../lib/analysis';
import { formatDelta, formatMultiple, formatPercent, formatScore, formatUsd } from '../../lib/format';
import type { LeaderRow } from '../../lib/leaderboard';
import { rankLabel } from '../../lib/leaderboard';
import { modelShortName } from '../../lib/models';
import { ScrollRegion } from '../ScrollRegion';

const VERDICT: Record<PairedVerdict | 'control', { text: string; className: string }> = {
  better: { text: 'better than single', className: 'chip-good' },
  worse: { text: 'worse than single', className: 'chip-bad' },
  equivalent: { text: 'equivalent to single', className: 'chip-quiet' },
  inconclusive: { text: 'not separable from single', className: 'chip-quiet' },
  control: { text: 'the control', className: 'chip-quiet' },
};

export interface Standing {
  model: string;
  row: LeaderRow;
  /** Architectures on this model, so a rank reads as "2 of 6". */
  of: number;
}

/**
 * One architecture's standing on each model: where it ranks, its score and
 * cost with intervals, and the paired difference from a single agent. The
 * full board of every architecture on a model is one link away.
 */
export function StandingTable({ standings, verified }: { standings: readonly Standing[]; verified: boolean }) {
  return (
    <>
      <StandingCards standings={standings} verified={verified} />
      <StandingGrid standings={standings} verified={verified} />
    </>
  );
}

/** On a phone, one card per model, so every number is on screen without a sideways scroll. */
function StandingCards({ standings, verified }: { standings: readonly Standing[]; verified: boolean }) {
  return (
    <ul className="space-y-3 md:hidden">
      {standings.map(({ model, row, of }) => (
        <li key={model} className="card p-4">
          <div className="flex items-baseline justify-between gap-3">
            <Link href={`/results/${model}/`} className="link text-[1rem] text-ink">
              {modelShortName(model)}
            </Link>
            <span className="num text-[0.875rem] text-ink">
              {verified && row.rank !== null ? (
                <>
                  {rankLabel(row)} <span className="text-muted">of {of}</span>
                </>
              ) : null}
            </span>
          </div>
          <dl className="mt-3 grid grid-cols-3 gap-3">
            <div>
              <dt className="eyebrow !text-[0.6875rem]">Score</dt>
              <dd className="num mt-1 text-ink">{formatScore(row.score.mean)}</dd>
              {verified ? (
                <dd className="num text-[0.6875rem] text-muted">
                  {formatScore(row.score.low)}–{formatScore(row.score.high)}
                </dd>
              ) : null}
            </div>
            <div>
              <dt className="eyebrow !text-[0.6875rem]">Cost / run</dt>
              <dd className="num mt-1 text-ink">{formatUsd(row.costUsd.mean)}</dd>
              <dd className="num text-[0.6875rem] text-muted">
                {row.costRatio ? `${formatMultiple(row.costRatio.mean)} single` : 'baseline'}
              </dd>
            </div>
            <div>
              <dt className="eyebrow !text-[0.6875rem]">Ranked</dt>
              <dd className="num mt-1 text-ink">
                {row.ranked}/{row.total}
              </dd>
            </div>
          </dl>
          <p className="mt-3 border-t border-rule pt-3">
            {verified && row.verdict ? (
              <>
                <span className={VERDICT[row.verdict].className}>{VERDICT[row.verdict].text}</span>
                {row.delta ? (
                  <span className="num mt-1.5 block text-[0.75rem] text-ink-2">
                    {formatDelta(row.delta.mean)} [{formatDelta(row.delta.low)}, {formatDelta(row.delta.high)}]
                  </span>
                ) : null}
              </>
            ) : (
              <span className="text-[0.8125rem] text-muted">no verdict without fidelity checks</span>
            )}
          </p>
        </li>
      ))}
    </ul>
  );
}

function StandingGrid({ standings, verified }: { standings: readonly Standing[]; verified: boolean }) {
  return (
    <div className="card hidden overflow-hidden md:block">
      <ScrollRegion label="This architecture’s standing on each model">
        <table className="w-full min-w-[40rem] border-collapse text-[0.875rem]">
          <caption className="sr-only">
            Rank, score, cost and paired difference from a single agent, for this architecture on each model.
          </caption>
          <thead>
            <tr className="border-b border-rule text-left">
              {['Model', 'Rank', 'Score', 'Cost per run', 'Against a single agent', 'Ranked runs'].map((heading, i) => (
                <th
                  key={heading}
                  scope="col"
                  className={`eyebrow px-4 py-3 font-normal !text-[0.6875rem] ${i === 0 ? 'pl-5' : ''} ${i >= 1 && i <= 3 ? 'text-right' : ''}`}
                >
                  {heading}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {standings.map(({ model, row, of }) => (
              <tr key={model} className="border-t border-rule align-top">
                <th scope="row" className="py-3.5 pl-5 pr-4 text-left font-normal">
                  <Link href={`/results/${model}/`} className="link text-ink">
                    {modelShortName(model)}
                  </Link>
                </th>
                <td className="num px-4 py-3.5 text-right text-ink">
                  {verified && row.rank !== null ? (
                    <>
                      {rankLabel(row)} <span className="text-muted">of {of}</span>
                    </>
                  ) : (
                    '—'
                  )}
                </td>
                <td className="px-4 py-3.5 text-right">
                  <span className="num block text-ink">{formatScore(row.score.mean)}</span>
                  {verified ? (
                    <span className="num block text-[0.75rem] text-muted">
                      {formatScore(row.score.low)}–{formatScore(row.score.high)}
                    </span>
                  ) : null}
                </td>
                <td className="px-4 py-3.5 text-right">
                  <span className="num block text-ink">{formatUsd(row.costUsd.mean)}</span>
                  <span className="num block text-[0.75rem] text-muted">
                    {row.costRatio ? `${formatMultiple(row.costRatio.mean)} single` : 'the baseline'}
                  </span>
                </td>
                <td className="px-4 py-3.5">
                  {verified && row.verdict ? (
                    <>
                      <span className={VERDICT[row.verdict].className}>{VERDICT[row.verdict].text}</span>
                      {row.delta ? (
                        <span className="num mt-1 block text-[0.75rem] text-ink-2">
                          {formatDelta(row.delta.mean)} [{formatDelta(row.delta.low)}, {formatDelta(row.delta.high)}]
                        </span>
                      ) : null}
                    </>
                  ) : (
                    <span className="text-muted">no verdict without fidelity checks</span>
                  )}
                </td>
                <td className="num px-4 py-3.5 text-right text-ink-2">
                  {row.ranked}/{row.total}
                  <span className="block text-[0.75rem] text-muted">
                    {row.total > 0 ? formatPercent(row.ranked / row.total) : '—'}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </ScrollRegion>
    </div>
  );
}
