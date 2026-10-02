import { checkWords, isHarnessCheck } from '../lib/integrity';
import { runReceipts } from '../lib/postmortem';
import type { Integrity, RunRecord } from '../lib/records';
import type { RunSetData } from '../lib/server/runSet';

/** Every check a run recorded: what it verifies, whether it held, and why not. */
export function IntegrityList({ integrity }: { integrity: Integrity }) {
  const checks = [...integrity.checks].sort(
    (a, b) => Number(a.ok) - Number(b.ok) || Number(isHarnessCheck(b.id)) - Number(isHarnessCheck(a.id)),
  );
  return (
    <ul className="grid gap-x-8 gap-y-3 md:grid-cols-2">
      {checks.map((check) => {
        const words = checkWords(check.id);
        return (
          <li key={check.id} className="flex gap-3">
            <span aria-hidden className={`mt-0.5 font-mono text-[0.875rem] ${check.ok ? 'text-good' : 'text-bad'}`}>
              {check.ok ? '✓' : '✗'}
            </span>
            <span className="min-w-0">
              <span className="block text-[0.875rem] text-ink">
                {words.title}
                <span className="sr-only">{check.ok ? ': held' : ': failed'}</span>
              </span>
              <span className="block font-mono text-[0.6875rem] text-muted">{check.id}</span>
              {!check.ok && check.detail ? (
                <span className="mt-1 block text-[0.8125rem] leading-snug text-bad">{check.detail}</span>
              ) : (
                <span className="mt-0.5 block text-[0.8125rem] leading-snug text-ink-2">{words.means}</span>
              )}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * For a run recorded before the fidelity gate: what its own phase records
 * show went wrong. Nothing is shown for a clean run, or for a run that
 * carries integrity checks (those say it better).
 */
export function RunReceipts({ data, record }: { data: Pick<RunSetData, 'verification'>; record: RunRecord }) {
  if (record.integrity || data.verification === 'synthetic') return null;
  const receipts = runReceipts(record);
  if (receipts.length === 0) return null;
  return (
    <div role="note" className="banner banner-bad mb-8">
      <p className="banner-title">What this run&apos;s records show</p>
      <ul className="banner-body mt-1 list-disc space-y-1 pl-5">
        {receipts.map((receipt) => (
          <li key={receipt}>{receipt}</li>
        ))}
      </ul>
    </div>
  );
}
