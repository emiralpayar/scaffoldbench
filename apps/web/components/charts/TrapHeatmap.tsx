import Link from 'next/link';
import type { CSSProperties } from 'react';

import { architectureName } from '../../lib/architectures';
import type { TrapTable } from '../../lib/traps';
import { ArchitectureColumnHeader, architectureGridClass } from './ArchitectureColumns';

/** The trap heading gets a column of its own only from `lg`. */
const ROW = architectureGridClass('lg:grid-cols-[minmax(14rem,20rem)_repeat(var(--arch-count),minmax(0,1fr))]');

/**
 * How often each architecture fell into each of a task's declared traps.
 *
 * Exception emphasis: a trap nobody fell into is a quiet cell, and the warm
 * wash deepens with the share of runs that fell in, so the cells worth
 * reading are the ones that stand out. The wash sits behind the text at a
 * capped opacity so the count stays legible on it in both themes.
 *
 * `architectures` fixes the columns, so several tables on one page line up
 * with each other and with the matrix above them; an architecture with no
 * ranked run on this task gets a dash. Columns are headed by glyphs alone on
 * a phone, so the page should carry an `ArchitectureKey`.
 */
export function TrapHeatmap({
  table,
  title,
  href,
  architectures = table.architectures,
}: {
  table: TrapTable;
  title: string;
  href: string;
  architectures?: readonly string[];
}) {
  return (
    <figure className="rounded-[14px] border border-rule bg-surface">
      <figcaption className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-rule px-4 py-3 sm:px-5">
        <Link href={href} className="text-[0.9375rem] text-ink hover:underline">
          {title}
        </Link>
        <span className="text-[0.8125rem] text-muted">
          {table.rows.length} trap{table.rows.length === 1 ? '' : 's'} · runs that fell in, of runs ranked
        </span>
      </figcaption>
      <div
        role="table"
        aria-label={`Traps in ${title}, by architecture: runs that fell in, of runs ranked`}
        className="text-[0.8125rem]"
        style={{ '--arch-count': architectures.length } as CSSProperties}
      >
        <div role="rowgroup" className="border-b border-rule">
          <div role="row" className={ROW}>
            <div role="columnheader" className="sr-only lg:not-sr-only">
              <span className="flex h-full items-end px-5 py-3">
                <span className="eyebrow !text-[0.6875rem]">Trap</span>
              </span>
            </div>
            {architectures.map((id) => (
              <ArchitectureColumnHeader key={id} id={id} glyphWidth={28} />
            ))}
          </div>
        </div>
        <div role="rowgroup">
          {table.rows.map((row) => (
            <div role="row" key={row.trap.id} className={`${ROW} border-b border-rule last:border-0`}>
              <div role="rowheader" className="col-span-full min-w-0 px-4 pb-1.5 pt-3 sm:px-5 lg:col-span-1 lg:py-2.5">
                <span className="block font-mono text-[0.75rem] text-ink">{row.trap.id}</span>
                <span className="mt-0.5 block text-[0.75rem] leading-snug text-ink-2">{row.trap.description}</span>
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
                      <Count fired={cell.fired} runs={cell.runs} label={`${architectureName(id)} fell into ${row.trap.id} in ${cell.fired} of ${cell.runs} runs`} />
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

function Count({ fired, runs, label }: { fired: number; runs: number; label: string }) {
  const rate = fired / runs;
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
        {fired}/{runs}
      </span>
      <span className="sr-only">{label}</span>
    </span>
  );
}
