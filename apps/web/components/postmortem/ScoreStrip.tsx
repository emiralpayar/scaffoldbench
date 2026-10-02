import { architectureColor, architectureName } from '../../lib/architectures';
import { formatScore, formatUsd } from '../../lib/format';
import type { PostmortemRow } from '../../lib/postmortem';
import { ArchitectureGlyph } from '../ArchitectureGlyph';

const AXIS: [number, number] = [0.9, 1];
const TICKS = [0.9, 0.95, 1];

/**
 * The leaderboard as it would have been published: five means on one axis,
 * so close together that no interval is needed to see they tie, and what
 * each cost to get there. The axis starts at 0.90 and says so; a bar from
 * zero would hide the thing the picture is for.
 */
export function ScoreStrip({ rows }: { rows: readonly PostmortemRow[] }) {
  const x = (value: number) => ((Math.min(Math.max(value, AXIS[0]), AXIS[1]) - AXIS[0]) / (AXIS[1] - AXIS[0])) * 100;
  const dearest = Math.max(...rows.map((row) => row.costUsdPerRun), 0);

  return (
    <figure>
      <div className="card px-5 py-6 sm:px-6">
        <div className="hidden grid-cols-[minmax(0,13rem)_minmax(0,1fr)_5.5rem_6.5rem] items-end gap-5 pb-3 md:grid">
          <span className="eyebrow">Architecture</span>
          <span className="relative h-5" aria-hidden>
            {TICKS.map((tick) => (
              <span
                key={tick}
                className={`num absolute top-0 text-[0.6875rem] text-muted ${tick === AXIS[1] ? '-translate-x-full' : '-translate-x-1/2'}`}
                style={{ left: `${x(tick)}%` }}
              >
                {tick.toFixed(2)}
              </span>
            ))}
          </span>
          <span className="eyebrow text-right">Mean score</span>
          <span className="eyebrow text-right">Cost per run</span>
        </div>
        <ul>
          {rows.map((row) => (
            <li
              key={row.strategyId}
              className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 border-t border-rule py-3.5 md:grid-cols-[minmax(0,13rem)_minmax(0,1fr)_5.5rem_6.5rem] md:gap-x-5"
            >
              <span className="flex min-w-0 items-center gap-3">
                <ArchitectureGlyph id={row.strategyId} width={40} decorative />
                <span className="truncate text-[0.9375rem] text-ink">{architectureName(row.strategyId)}</span>
              </span>
              <span className="num order-3 col-span-2 text-[0.8125rem] text-ink-2 md:hidden">
                {formatScore(row.meanScore)} · {formatUsd(row.costUsdPerRun)} per run
              </span>
              <span className="relative order-2 col-span-2 h-6 md:order-none md:col-span-1" aria-hidden>
                <span className="absolute inset-x-0 top-1/2 h-px bg-rule-strong" />
                {TICKS.map((tick) => (
                  <span
                    key={tick}
                    className="absolute top-1/2 h-2.5 w-px -translate-y-1/2 bg-rule-strong"
                    style={{ left: `${x(tick)}%` }}
                  />
                ))}
                <span
                  className="absolute top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-surface"
                  style={{ left: `${x(row.meanScore)}%`, background: architectureColor(row.strategyId) }}
                />
              </span>
              <span className="num hidden text-right text-[1.0625rem] text-ink md:block">{formatScore(row.meanScore)}</span>
              <span className="hidden md:block">
                <span className="num block text-right text-[0.875rem] text-ink-2">{formatUsd(row.costUsdPerRun)}</span>
                <span aria-hidden className="mt-1 block h-1 rounded-full bg-sunken">
                  <span
                    className="block h-full rounded-full bg-ink-2"
                    style={{ width: `${dearest === 0 ? 0 : (row.costUsdPerRun / dearest) * 100}%` }}
                  />
                </span>
              </span>
            </li>
          ))}
        </ul>
      </div>
      <figcaption className="mt-3 text-[0.8125rem] leading-relaxed text-muted">
        Mean score over the {rows[0]?.runs ?? 18} runs of each architecture. The axis starts at 0.90, not at zero:
        on a full axis the five dots are one dot.
      </figcaption>
    </figure>
  );
}
