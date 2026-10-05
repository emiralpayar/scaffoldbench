import type { CSSProperties } from 'react';

import type { ForestRow } from '../../lib/chartData';
import { linearTicks, niceDomain } from '../../lib/charts';
import { boundsOf, formatRange, formatScore } from '../../lib/format';

/**
 * Mean and interval per architecture on one shared, zoomed axis.
 *
 * A 0–1 bar spends all its length on a range nobody occupies and makes 0.98
 * and 1.00 identical; a dot and whisker on a zoomed axis shows exactly the
 * overlap the reader needs to see. The zoom is always stated on the axis.
 *
 * Built from HTML with percentage positions rather than a fixed-size SVG, so
 * text stays at its real size at any width: on a phone each row becomes a
 * label line over a full-width track.
 */
export function ForestPlot({
  rows,
  title,
  domain,
  reference,
}: {
  rows: ForestRow[];
  title: string;
  /** Shared domain for small multiples; defaults to the rows' own extent. */
  domain?: [number, number];
  /** A vertical reference, e.g. the control's mean. */
  reference?: { value: number; label: string };
}) {
  if (rows.length === 0) return null;
  const [lo, hi] = domain ?? forestDomain(rows);
  const span = hi - lo || 1;
  const pct = (value: number) => `${(((Math.min(hi, Math.max(lo, value)) - lo) / span) * 100).toFixed(3)}%`;
  const ticks = linearTicks([lo, hi], 5);
  const zoomed = lo > 0 || hi < 1;

  const gridlines = (
    <>
      {ticks.map((tick) => (
        <span
          key={tick}
          aria-hidden
          className="absolute inset-y-0 w-px bg-[var(--grid)]"
          style={{ left: pct(tick) }}
        />
      ))}
      {reference ? (
        <span aria-hidden className="absolute inset-y-0 w-px bg-ink-2/70" style={{ left: pct(reference.value) }} />
      ) : null}
    </>
  );

  return (
    <figure role="group" aria-label={`${title}: mean score and interval per architecture`}>
      <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 sm:grid-cols-[minmax(8rem,12rem)_minmax(0,1fr)_auto]">
        <span className="eyebrow pb-2">Architecture</span>
        <span className="relative hidden pb-2 sm:block" aria-hidden>
          {reference ? (
            <span
              className="absolute bottom-2 -translate-x-1/2 whitespace-nowrap text-[0.6875rem] text-muted"
              style={{ left: pct(reference.value) }}
            >
              {reference.label}
            </span>
          ) : null}
        </span>
        <span className="eyebrow pb-2 text-right">Mean · interval</span>

        {rows.map((row) => (
          <div
            key={row.id}
            title={row.note}
            className="col-span-full grid grid-cols-subgrid items-center border-t border-rule/70 py-2 sm:py-0"
          >
            <span className="flex min-w-0 items-center gap-2 text-[0.875rem] text-ink">
              <span aria-hidden className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: row.color }} />
              <span className="truncate">{row.label}</span>
            </span>
            <span className="num whitespace-nowrap text-right text-[0.8125rem] text-ink-2 sm:order-last">
              <span className="text-ink">{formatScore(row.estimate.mean)}</span>
              <span className="ml-2 text-muted">{formatRange(row.estimate, formatScore)}</span>
            </span>
            <span className="relative col-span-full mt-2 block h-6 sm:col-span-1 sm:mt-0 sm:h-9">
              {gridlines}
              <Whisker
                {...(row.estimate.ci ? { left: pct(row.estimate.ci.low), right: pct(row.estimate.ci.high) } : {})}
                mean={pct(row.estimate.mean)}
                color={row.color}
              />
            </span>
          </div>
        ))}

        <span className="hidden sm:block" />
        <span className="relative col-span-full mt-1 block h-5 border-t border-axis sm:col-span-1">
          {ticks.map((tick) => (
            <span
              key={tick}
              className={`num absolute top-1 text-[0.6875rem] text-muted ${
                tick <= lo ? '' : tick >= hi ? '-translate-x-full' : '-translate-x-1/2'
              }`}
              style={{ left: pct(tick) }}
            >
              {tick.toFixed(2)}
            </span>
          ))}
        </span>
        <span className="hidden sm:block" />
      </div>
      <figcaption className="mt-3 text-right text-[0.75rem] text-muted">
        {zoomed ? `Mean score; the axis is zoomed to ${lo.toFixed(2)}–${hi.toFixed(2)}.` : 'Mean score.'}
        {reference ? ` The vertical line marks ${reference.label}'s mean.` : ''}
      </figcaption>
    </figure>
  );
}

/** The interval ends are omitted where there is no interval: only the mean is drawn. */
function Whisker({
  left,
  right,
  mean,
  color,
}: {
  left?: string;
  right?: string;
  mean: string;
  color: string;
}) {
  const cap: CSSProperties = { background: color };
  return (
    <span aria-hidden className="absolute inset-0">
      {left !== undefined && right !== undefined ? (
        <>
          <span
            className="absolute top-1/2 h-[2px] -translate-y-1/2 rounded-full"
            style={{ left, width: `calc(${right} - ${left})`, background: color, opacity: 0.9 }}
          />
          <span className="absolute top-1/2 h-2.5 w-[2px] -translate-x-1/2 -translate-y-1/2 rounded-full" style={{ ...cap, left }} />
          <span className="absolute top-1/2 h-2.5 w-[2px] -translate-x-1/2 -translate-y-1/2 rounded-full" style={{ ...cap, left: right }} />
        </>
      ) : null}
      <span
        className="absolute top-1/2 h-[14px] w-[14px] -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-[var(--surface)]"
        style={{ left: mean, background: color }}
      />
    </span>
  );
}

/** Zoom to the data, rounded outward, clamped to the 0–1 score range. */
export function forestDomain(rows: readonly ForestRow[]): [number, number] {
  const lows = rows.map((row) => boundsOf(row.estimate)[0]);
  const highs = rows.map((row) => boundsOf(row.estimate)[1]);
  const [lo, hi] = niceDomain(Math.min(...lows), Math.max(...highs), 4);
  return [Math.max(0, lo), Math.min(1, hi)];
}
