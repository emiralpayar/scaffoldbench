import Link from 'next/link';
import type { ReactNode } from 'react';

import type { Estimate, PairedVerdict } from '../../lib/analysis';
import { architectureName } from '../../lib/architectures';
import { linearTicks } from '../../lib/charts';
import { formatDelta, formatDuration, formatMultiple, formatScore, formatUsd, joinList } from '../../lib/format';
import type { LeaderRow } from '../../lib/leaderboard';
import { rankLabel } from '../../lib/leaderboard';
import { ArchitectureGlyph } from '../ArchitectureGlyph';

const VERDICT: Record<PairedVerdict | 'control', { text: string; className: string }> = {
  better: { text: 'better', className: 'chip-good' },
  worse: { text: 'worse', className: 'chip-bad' },
  equivalent: { text: 'equivalent', className: 'chip-quiet' },
  inconclusive: { text: 'not separable', className: 'chip-quiet' },
  control: { text: 'control', className: 'chip-quiet' },
};

/**
 * The leaderboard of one model: a forest plot that is also a table.
 *
 * Every row carries its interval on one shared, zoomed axis, so overlap is
 * the first thing the eye reads; ranks come from paired comparisons and a
 * shared rank is written "=2" and grouped, never ordered by a difference the
 * data does not support. Cost and latency carry their intervals too. On a
 * phone each row becomes a card with the same numbers.
 */
export function LeaderboardTable({
  rows,
  domain,
  reference,
}: {
  rows: LeaderRow[];
  domain: [number, number];
  /** The control's mean, drawn as a line through every track. */
  reference?: number;
}) {
  const ticks = linearTicks(domain, 4);
  const ranked = rows.some((row) => row.rank !== null);

  return (
    <div>
      {/* Wide: one table. */}
      <div className="hidden overflow-hidden rounded-[14px] border border-rule bg-surface lg:block">
        <table className="w-full border-collapse text-[0.875rem]">
          <caption className="sr-only">
            Mean score with its interval, pass rate, cost, latency and the paired difference from a single agent,
            per architecture{ranked ? ', in rank order; a shared rank is written with an equals sign' : ''}.
          </caption>
          <thead>
            <tr className="border-b border-rule text-left">
              <Th className="w-14 pl-5">Rank</Th>
              <Th>Architecture</Th>
              <Th className="w-[24%] min-w-[12rem]">
                <span className="sr-only">Score interval</span>
                <span aria-hidden className="relative block h-4">
                  {ticks.map((tick) => (
                    <span
                      key={tick}
                      className="num absolute -translate-x-1/2 text-[0.6875rem] normal-case tracking-normal"
                      style={{ left: pos(tick, domain) }}
                    >
                      {tick.toFixed(2)}
                    </span>
                  ))}
                </span>
              </Th>
              <Th className="text-right">Score</Th>
              <Th className="text-right">Pass</Th>
              <Th className="text-right">Cost / run</Th>
              <Th className="text-right">Latency</Th>
              <Th className="text-right">vs single</Th>
              <Th className="pr-5 text-right">Runs</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => {
              const newGroup = index > 0 && row.rank !== rows[index - 1]?.rank;
              return (
                <tr key={row.strategyId} className={`${newGroup ? 'border-t-2 border-rule-strong' : index > 0 ? 'border-t border-rule' : ''}`}>
                  <td className="py-3 pl-5 align-middle">
                    <RankBadge row={row} />
                  </td>
                  <th scope="row" className="py-3 pr-3 text-left align-middle font-normal">
                    <Link href={`/strategies/${row.strategyId}/`} className="group flex items-center gap-3">
                      <ArchitectureGlyph id={row.strategyId} width={38} className="shrink-0" />
                      <span className="flex flex-col items-start gap-1">
                        <span className="whitespace-nowrap text-ink group-hover:underline">{row.label}</span>
                        {row.onFrontier ? (
                          <span className="chip-quiet" title="On the mean score-against-cost frontier for this model">
                            frontier
                          </span>
                        ) : null}
                      </span>
                    </Link>
                  </th>
                  <td className="px-3 py-3 align-middle">
                    <Track estimate={row.score} domain={domain} color={row.color} ticks={ticks} {...(reference !== undefined ? { reference } : {})} />
                  </td>
                  <td className="px-3 py-3 text-right align-middle">
                    <Value main={formatScore(row.score.mean)} sub={`${formatScore(row.score.low)}–${formatScore(row.score.high)}`} strong />
                  </td>
                  <td className="px-3 py-3 text-right align-middle">
                    <Value main={pct(row.passRate.mean)} sub={`${pct(row.passRate.low)}–${pct(row.passRate.high)}`} />
                  </td>
                  <td className="px-3 py-3 text-right align-middle">
                    <Value main={formatUsd(row.costUsd.mean)} sub={`${formatUsd(row.costUsd.low)}–${formatUsd(row.costUsd.high)}`} />
                  </td>
                  <td className="px-3 py-3 text-right align-middle">
                    <Value main={formatDuration(row.latencyMs.mean)} sub={`${seconds(row.latencyMs.low)}–${formatDuration(row.latencyMs.high)}`} />
                  </td>
                  <td className="px-3 py-3 text-right align-middle">
                    <VersusSingle row={row} ranked={ranked} />
                  </td>
                  <td className="py-3 pr-5 text-right align-middle">
                    <RunsCell row={row} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Narrow: one card per architecture, same numbers. */}
      <ol className="flex flex-col gap-3 lg:hidden" aria-label="Architectures in rank order">
        {rows.map((row) => (
          <li key={row.strategyId} className="card p-4">
            <div className="flex items-center gap-3">
              <RankBadge row={row} />
              <Link href={`/strategies/${row.strategyId}/`} className="flex min-w-0 flex-1 items-center gap-2.5">
                <ArchitectureGlyph id={row.strategyId} width={34} className="shrink-0" />
                <span className="truncate text-[1rem] font-medium text-ink">{row.label}</span>
              </Link>
              <span className="text-right">
                <span className="num block text-[1.375rem] leading-none text-ink">{formatScore(row.score.mean)}</span>
                <span className="num text-[0.6875rem] text-muted">
                  {formatScore(row.score.low)}–{formatScore(row.score.high)}
                </span>
              </span>
            </div>
            <div className="mt-3">
              <Track estimate={row.score} domain={domain} color={row.color} ticks={ticks} {...(reference !== undefined ? { reference } : {})} />
            </div>
            <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2.5 border-t border-rule pt-3 text-[0.8125rem] sm:grid-cols-4">
              <Small label="Pass">
                {pct(row.passRate.mean)} <span className="text-muted">({pct(row.passRate.low)}–{pct(row.passRate.high)})</span>
              </Small>
              <Small label="Cost / run">
                {formatUsd(row.costUsd.mean)} <span className="text-muted">({formatUsd(row.costUsd.low)}–{formatUsd(row.costUsd.high)})</span>
              </Small>
              <Small label="Latency">
                {formatDuration(row.latencyMs.mean)}{' '}
                <span className="text-muted">
                  ({seconds(row.latencyMs.low)}–{formatDuration(row.latencyMs.high)})
                </span>
              </Small>
              <Small label="Runs">
                <RunsCell row={row} />
              </Small>
            </dl>
            <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-rule pt-3 text-[0.8125rem]">
              <span className="eyebrow !text-[0.6875rem]">vs single</span>
              <VersusSingle row={row} ranked={ranked} inline />
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

function Th({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <th scope="col" className={`eyebrow whitespace-nowrap px-3 py-3 font-normal !text-[0.6875rem] ${className}`}>
      {children}
    </th>
  );
}

function RankBadge({ row }: { row: LeaderRow }) {
  const label = rankLabel(row);
  const words =
    row.rank === null
      ? 'Not ranked: this run set has no fidelity checks.'
      : [
          row.tied ? `Rank ${row.rank}, shared.` : `Rank ${row.rank}.`,
          row.below.length > 0 ? `Reliably below ${joinList(row.below.map(architectureName))}.` : '',
          row.above.length > 0 ? `Reliably above ${joinList(row.above.map(architectureName))}.` : '',
          row.below.length === 0 && row.above.length === 0 ? 'Not separable from any other architecture.' : '',
        ]
          .filter(Boolean)
          .join(' ');
  return (
    <span
      title={words}
      className={`num inline-flex h-8 min-w-8 items-center justify-center rounded-full px-1.5 text-[0.8125rem] ${
        row.rank === 1 ? 'bg-ink text-plane' : row.rank === null ? 'text-muted' : 'border border-rule-strong text-ink'
      }`}
    >
      <span aria-hidden>{label}</span>
      <span className="sr-only">{words}</span>
    </span>
  );
}

function Track({
  estimate,
  domain,
  color,
  ticks,
  reference,
}: {
  estimate: Estimate;
  domain: [number, number];
  color: string;
  ticks: number[];
  reference?: number;
}) {
  const left = pos(estimate.low, domain);
  const right = pos(estimate.high, domain);
  return (
    <span aria-hidden className="relative block h-7">
      {ticks.map((tick) => (
        <span key={tick} className="absolute inset-y-0 w-px bg-[var(--grid)]" style={{ left: pos(tick, domain) }} />
      ))}
      {reference !== undefined ? (
        <span className="absolute inset-y-0 w-px bg-ink-2/60" style={{ left: pos(reference, domain) }} />
      ) : null}
      <span
        className="absolute top-1/2 h-[3px] -translate-y-1/2 rounded-full"
        style={{ left, width: `calc(${right} - ${left})`, background: color, opacity: 0.85 }}
      />
      <span className="absolute top-1/2 h-3 w-[2px] -translate-x-1/2 -translate-y-1/2 rounded-full" style={{ left, background: color }} />
      <span className="absolute top-1/2 h-3 w-[2px] -translate-x-1/2 -translate-y-1/2 rounded-full" style={{ left: right, background: color }} />
      <span
        className="absolute top-1/2 h-[15px] w-[15px] -translate-x-1/2 -translate-y-1/2 rounded-full border-[2.5px] border-[var(--surface)]"
        style={{ left: pos(estimate.mean, domain), background: color }}
      />
    </span>
  );
}

function Value({ main, sub, strong = false }: { main: string; sub: string; strong?: boolean }) {
  return (
    <span className="num inline-flex flex-col items-end whitespace-nowrap leading-tight">
      <span className={strong ? 'text-[0.9375rem] text-ink' : 'text-ink-2'}>{main}</span>
      <span className="mt-0.5 text-[0.6875rem] text-muted">{sub}</span>
    </span>
  );
}

function VersusSingle({ row, ranked, inline = false }: { row: LeaderRow; ranked: boolean; inline?: boolean }) {
  if (row.verdict === 'control') return <span className={VERDICT.control.className}>{VERDICT.control.text}</span>;
  if (!row.delta) return <span className="text-muted">—</span>;
  const verdict = row.verdict && ranked ? VERDICT[row.verdict] : { text: 'no verdict', className: 'chip-quiet' };
  return (
    <span
      className={`inline-flex whitespace-nowrap ${inline ? 'flex-wrap items-center gap-x-2.5 gap-y-1' : 'flex-col items-end gap-1'}`}
    >
      <span className="flex items-center gap-2">
        <span className="num text-ink" title={`${formatDelta(row.delta.low)} to ${formatDelta(row.delta.high)}`}>
          {formatDelta(row.delta.mean)}
        </span>
        <span className={verdict.className}>{verdict.text}</span>
      </span>
      {row.costRatio ? (
        <span className="num text-[0.6875rem] text-muted">{formatMultiple(row.costRatio.mean)} the cost</span>
      ) : null}
    </span>
  );
}

function RunsCell({ row }: { row: LeaderRow }) {
  const excluded = row.total - row.ranked;
  const detail = [
    row.integrityFailed > 0 ? `${row.integrityFailed} failed a fidelity check` : '',
    row.apiErrors > 0 ? `${row.apiErrors} lost to API errors` : '',
  ]
    .filter(Boolean)
    .join(', ');
  return (
    <span
      className={`num ${excluded > 0 ? 'text-warn' : 'text-ink-2'}`}
      title={excluded > 0 ? `${excluded} of ${row.total} excluded: ${detail}` : 'Every run was ranked'}
    >
      {row.ranked}/{row.total}
    </span>
  );
}

function Small({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="eyebrow !text-[0.625rem]">{label}</dt>
      <dd className="num mt-0.5 text-ink-2">{children}</dd>
    </div>
  );
}

function pos(value: number, domain: [number, number]): string {
  const [lo, hi] = domain;
  const clamped = Math.min(hi, Math.max(lo, value));
  return `${(((clamped - lo) / (hi - lo || 1)) * 100).toFixed(3)}%`;
}

function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function seconds(ms: number): string {
  return ms < 60_000 ? `${(ms / 1000).toFixed(1)}` : formatDuration(ms);
}
