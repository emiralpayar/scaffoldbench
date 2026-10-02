import { architectureName } from '../../lib/architectures';
import { formatPercent, formatUsd } from '../../lib/format';
import type { PostmortemRow } from '../../lib/postmortem';
import { ArchitectureGlyph } from '../ArchitectureGlyph';

/**
 * What a run cost, split into the steps that did their job and the steps
 * whose output was thrown away (they ended in an error) or guessed (a
 * proposer with no tool made no call). Widths share one scale, so a longer
 * bar is a dearer run. The hatched part is the wasted share, and it is
 * labelled in numbers too: colour is never the only carrier.
 */
export function WasteBars({ rows }: { rows: readonly PostmortemRow[] }) {
  const dearest = Math.max(...rows.map((row) => row.costUsdPerRun), 0.0001);

  return (
    <figure>
      <ul className="card divide-y divide-rule px-5 py-2 sm:px-6">
        {rows.map((row) => {
          const share = row.costUsdPerRun === 0 ? 0 : row.wastedUsdPerRun / row.costUsdPerRun;
          const name = architectureName(row.strategyId);
          return (
            <li key={row.strategyId} className="grid gap-x-5 gap-y-2 py-3.5 md:grid-cols-[minmax(0,13rem)_minmax(0,1fr)_13rem] md:items-center">
              <span className="flex min-w-0 items-center gap-3">
                <ArchitectureGlyph id={row.strategyId} width={40} decorative />
                <span className="truncate text-[0.9375rem] text-ink">{name}</span>
              </span>
              <span
                role="img"
                aria-label={`${name}: ${formatUsd(row.costUsdPerRun)} per run, of which ${formatUsd(row.wastedUsdPerRun)} on steps that failed or ran blind`}
                className="flex h-3.5 w-full overflow-hidden rounded-[4px] bg-sunken"
              >
                <span
                  className="h-full bg-ink-2"
                  style={{ width: `${((row.costUsdPerRun - row.wastedUsdPerRun) / dearest) * 100}%` }}
                />
                <span
                  className="h-full"
                  style={{
                    width: `${(row.wastedUsdPerRun / dearest) * 100}%`,
                    background: 'repeating-linear-gradient(135deg, var(--bad) 0 2px, transparent 2px 5px)',
                    boxShadow: 'inset 0 0 0 1px var(--bad)',
                  }}
                />
              </span>
              <span className="num text-[0.8125rem] text-ink-2 md:text-right">
                {formatUsd(row.costUsdPerRun)}
                {row.wastedUsdPerRun > 0 ? (
                  <span className="text-bad">
                    {' '}
                    · {formatPercent(share)} wasted
                  </span>
                ) : (
                  <span className="text-muted"> · none wasted</span>
                )}
              </span>
            </li>
          );
        })}
      </ul>
      <figcaption className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1 text-[0.8125rem] text-muted">
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden className="block h-2.5 w-4 rounded-[2px] bg-ink-2" />
          steps that did their job
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span
            aria-hidden
            className="block h-2.5 w-4 rounded-[2px]"
            style={{ background: 'repeating-linear-gradient(135deg, var(--bad) 0 2px, transparent 2px 5px)', boxShadow: 'inset 0 0 0 1px var(--bad)' }}
          />
          steps that errored, or proposed with no tool to look anything up
        </span>
      </figcaption>
    </figure>
  );
}
