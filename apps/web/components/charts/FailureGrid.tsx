import type { CSSProperties, ReactNode } from 'react';

import Link from '../Link';
import { ArchitectureColumnHeader, architectureGridClass } from './ArchitectureColumns';

export interface FailureCell {
  /** Runs that fell in, or missed, or whatever the grid counts. */
  count: number;
  runs: number;
}

export interface FailureRow {
  id: string;
  /** The row's name; an identifier is set in the data face. */
  title: string;
  mono?: boolean;
  detail?: string;
  /** Keyed by architecture id. */
  cells: Record<string, FailureCell>;
}

/** The row heading gets a column of its own only from `lg`. */
const ROW = architectureGridClass('lg:grid-cols-[minmax(14rem,20rem)_repeat(var(--arch-count),minmax(0,1fr))]');

/**
 * Rows by architecture, each cell a count of runs out of runs: how often
 * each architecture fell into each trap, or missed each graded assertion.
 *
 * Exception emphasis: a row nobody failed is a quiet cell, and the warm wash
 * deepens with the share of runs that failed, so the cells worth reading are
 * the ones that stand out. The wash sits behind the text at a capped opacity
 * so the count stays legible on it in both themes.
 *
 * `architectures` fixes the columns, so several grids on one page line up
 * with each other; an architecture with no ranked run gets a dash. Columns
 * are headed by glyphs alone on a phone, so the page should carry an
 * `ArchitectureKey`.
 */
export function FailureGrid({
  rows,
  architectures,
  title,
  href,
  summary,
  rowHeading,
  ariaLabel,
  describe,
}: {
  rows: readonly FailureRow[];
  architectures: readonly string[];
  title: ReactNode;
  href?: string;
  summary: string;
  rowHeading: string;
  ariaLabel: string;
  /** The words for one cell, for assistive technology and the tooltip. */
  describe: (architecture: string, row: FailureRow, cell: FailureCell) => string;
}) {
  return (
    <figure className="rounded-[14px] border border-rule bg-surface">
      <figcaption className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-rule px-4 py-3 sm:px-5">
        {href ? (
          <Link href={href} className="text-[0.9375rem] text-ink hover:underline">
            {title}
          </Link>
        ) : (
          <span className="text-[0.9375rem] text-ink">{title}</span>
        )}
        <span className="text-[0.8125rem] text-muted">{summary}</span>
      </figcaption>
      <div
        role="table"
        aria-label={ariaLabel}
        className="text-[0.8125rem]"
        style={{ '--arch-count': architectures.length } as CSSProperties}
      >
        <div role="rowgroup" className="border-b border-rule">
          <div role="row" className={ROW}>
            <div role="columnheader" className="sr-only lg:not-sr-only">
              <span className="flex h-full items-end px-5 py-3">
                <span className="eyebrow !text-[0.6875rem]">{rowHeading}</span>
              </span>
            </div>
            {architectures.map((id) => (
              <ArchitectureColumnHeader key={id} id={id} glyphWidth={28} />
            ))}
          </div>
        </div>
        <div role="rowgroup">
          {rows.map((row) => (
            <div role="row" key={row.id} className={`${ROW} border-b border-rule last:border-0`}>
              <div role="rowheader" className="col-span-full min-w-0 px-4 pb-1.5 pt-3 sm:px-5 lg:col-span-1 lg:py-2.5">
                <span className={`block text-[0.75rem] text-ink ${row.mono ? 'font-mono' : 'leading-snug'}`}>{row.title}</span>
                {row.detail ? <span className="mt-0.5 block text-[0.75rem] leading-snug text-ink-2">{row.detail}</span> : null}
              </div>
              {architectures.map((id) => {
                const cell = row.cells[id];
                return (
                  <div role="cell" key={id} className="flex items-center justify-center px-1 pb-3 pt-1 lg:py-2">
                    {!cell || cell.runs === 0 ? (
                      <span className="text-muted">
                        <span aria-hidden>–</span>
                        <span className="sr-only">no ranked runs</span>
                      </span>
                    ) : (
                      <Count count={cell.count} runs={cell.runs} label={describe(id, row, cell)} />
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </figure>
  );
}

function Count({ count, runs, label }: { count: number; runs: number; label: string }) {
  const rate = count / runs;
  return (
    <span
      className="relative isolate inline-flex h-9 w-full max-w-[5.5rem] items-center justify-center rounded-[6px]"
      title={label}
    >
      <span
        aria-hidden
        className="absolute inset-0 -z-10 rounded-[6px]"
        style={{ background: 'var(--bad)', opacity: rate === 0 ? 0 : 0.1 + rate * 0.32 }}
      />
      <span aria-hidden className={`num ${rate === 0 ? 'text-muted' : 'text-ink'}`}>
        {count}/{runs}
      </span>
      <span className="sr-only">{label}</span>
    </span>
  );
}
