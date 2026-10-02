import { checkWords } from '../../lib/integrity';
import type { CheckRate } from '../../lib/integrity';
import { formatInt, formatPercent } from '../../lib/format';

/**
 * How often each integrity check held, over the runs that carry it. A check
 * that always held is a quiet row; one that sometimes failed shows how often
 * and, underneath, what the latest failure said, because "which check, and
 * why" is the thing worth reading on this list.
 */
export function CheckRateList({ rates }: { rates: readonly CheckRate[] }) {
  if (rates.length === 0) {
    return <p className="text-[0.875rem] text-muted">No run here carries integrity checks.</p>;
  }
  return (
    <ul className="divide-y divide-rule">
      {rates.map((rate) => {
        const words = checkWords(rate.id);
        const failed = rate.total - rate.ok;
        return (
          <li key={rate.id} className="grid gap-x-5 gap-y-2 py-3.5 md:grid-cols-[minmax(0,1fr)_14rem] md:items-start">
            <div className="min-w-0">
              <p className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                <span className="text-[0.9375rem] text-ink">{words.title}</span>
                <code className="font-mono text-[0.6875rem] text-muted [overflow-wrap:anywhere]">{rate.id}</code>
              </p>
              <p className="mt-0.5 text-[0.8125rem] leading-snug text-ink-2">{words.means}</p>
              {failed > 0 && rate.example ? (
                <p className="mt-1.5 font-mono text-[0.75rem] leading-snug text-bad [overflow-wrap:anywhere]">
                  Latest failure: {rate.example}
                </p>
              ) : null}
            </div>
            <div className="flex items-center gap-3 md:justify-end">
              <span
                role="img"
                aria-label={`${rate.ok} of ${rate.total} runs passed`}
                className="flex h-2 w-28 shrink-0 overflow-hidden rounded-full bg-sunken"
              >
                <span className="h-full bg-good" style={{ width: `${(rate.ok / rate.total) * 100}%` }} />
                {failed > 0 ? (
                  <span
                    className="h-full"
                    style={{
                      width: `${(failed / rate.total) * 100}%`,
                      background: 'repeating-linear-gradient(135deg, var(--bad) 0 2px, transparent 2px 4px)',
                      boxShadow: 'inset 0 0 0 1px var(--bad)',
                    }}
                  />
                ) : null}
              </span>
              <span className="num w-[7.5rem] text-right text-[0.8125rem] text-ink-2">
                <span className={failed > 0 ? 'text-bad' : 'text-ink'}>
                  {formatInt(rate.ok)}/{formatInt(rate.total)}
                </span>{' '}
                <span className="text-muted">{formatPercent(rate.ok / rate.total, rate.ok === rate.total ? 0 : 1)}</span>
              </span>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
