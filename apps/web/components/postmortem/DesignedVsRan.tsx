import { architectureName } from '../../lib/architectures';
import { formatScore } from '../../lib/format';
import type { PostmortemRow } from '../../lib/postmortem';
import { ArchitectureGlyph } from '../ArchitectureGlyph';

/**
 * Each architecture as designed beside the same architecture as it ran, with
 * the dead steps struck through and the receipts, which are counts over the
 * committed run records, next to the score the leaderboard gave it anyway.
 */
export function DesignedVsRan({ rows, className = '' }: { rows: readonly PostmortemRow[]; className?: string }) {
  return (
    <div className={`card overflow-hidden ${className}`}>
      <div className="hidden grid-cols-[minmax(0,15rem)_minmax(0,1fr)_7rem] gap-6 border-b border-rule px-6 py-3 md:grid">
        <span className="eyebrow">Designed → as it ran</span>
        <span className="eyebrow">What the run records show</span>
        <span className="eyebrow text-right">Scored</span>
      </div>
      <ol>
        {rows.map((row) => (
          <li
            key={row.strategyId}
            className="grid gap-4 border-b border-rule px-5 py-6 last:border-0 sm:px-6 md:grid-cols-[minmax(0,15rem)_minmax(0,1fr)_7rem] md:items-center md:gap-6"
          >
            <div className="flex items-center gap-3">
              <ArchitectureGlyph id={row.strategyId} width={72} title={`${architectureName(row.strategyId)} as designed`} />
              <span aria-hidden className="text-muted">
                →
              </span>
              <ArchitectureGlyph
                id={row.strategyId}
                width={72}
                dead={row.deadNodes}
                title={
                  row.deadNodes.length > 0
                    ? `${architectureName(row.strategyId)} as it ran: ${row.deadNodes.length} step${row.deadNodes.length === 1 ? '' : 's'} never did their job`
                    : `${architectureName(row.strategyId)} as it ran: as designed`
                }
              />
            </div>
            <div className="min-w-0">
              <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="text-[1.0625rem] font-medium text-ink">{architectureName(row.strategyId)}</span>
                {row.ranAsDesigned ? (
                  <span className="chip !border-good/50 !text-good">ran as designed</span>
                ) : (
                  <span className="chip !border-bad/50 !text-bad">did not run as designed</span>
                )}
              </p>
              {row.receipts.length > 0 ? (
                <ul className="mt-2 space-y-1 text-[0.9375rem] leading-snug text-ink-2">
                  {row.receipts.map((receipt) => (
                    <li key={receipt.label} className="flex gap-2">
                      <span className="num shrink-0 text-ink">
                        {receipt.count}/{receipt.of}
                      </span>
                      <span>
                        {receipt.unit === 'proposals' ? 'proposals ' : 'runs: '}
                        {receipt.label}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-2 text-[0.9375rem] text-ink-2">
                  The control: one agent, nothing to skip. It ran as designed in {row.runs}/{row.runs} runs.
                </p>
              )}
            </div>
            <div className="flex items-baseline gap-2 md:block md:text-right">
              <span className="eyebrow md:hidden">Scored</span>
              <span className="num text-[1.375rem] text-ink">{formatScore(row.meanScore)}</span>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
