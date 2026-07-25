import type { RunSetManifest } from '@arena/core';

import { formatDuration, formatUsd, loadRunSet } from '../lib/data';

/**
 * Fabricated data must be impossible to mistake for a measurement, so the
 * banner is loud and unconditional whenever the manifest says `synthetic`.
 */
export function SyntheticBanner({ manifest }: { manifest: RunSetManifest | null }) {
  if (!manifest?.synthetic) return null;

  return (
    <div className="mb-6 rounded-[3px] border border-warn/50 bg-warn/10 px-4 py-3">
      <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-warn">
        Synthetic data — not a measurement
      </p>
      <p className="prose-serif mt-1 !text-[14px]">
        Every number on this page was fabricated by{' '}
        <span className="font-mono text-[12.5px]">scripts/generate-demo-data.ts</span> so the
        interface can be reviewed without spending anything. Do not quote it.
        {manifest.notes ? ` ${manifest.notes}` : ''}
      </p>
    </div>
  );
}

/** Provenance strip: which run set this is and under what conditions it ran. */
export async function RunSetFooter() {
  const data = await loadRunSet();
  if (!data) return null;

  const { manifest, runSetId, records } = data;
  const facts: [string, string][] = [
    ['run set', runSetId],
    ['model', manifest?.model ?? '—'],
    ['effort', manifest?.effort ?? '—'],
    ['repeats', manifest ? String(manifest.repeats) : '—'],
    ['fixtures', manifest?.fixtureMode ?? '—'],
    ['runs', `${records.length}${manifest ? ` / ${manifest.totalRuns}` : ''}`],
    ['strategy cost', manifest ? formatUsd(manifest.totalCostUsd) : '—'],
    ['judge cost', manifest ? formatUsd(manifest.totalJudgeCostUsd) : '—'],
    ['wall clock', manifest ? formatDuration(manifest.durationMs) : '—'],
    ['git', manifest?.gitSha ? manifest.gitSha.slice(0, 10) : 'not recorded'],
  ];

  return (
    <footer className="mt-16 border-t border-rule">
      <div className="mx-auto w-full max-w-[80rem] px-5 py-6 sm:px-8">
        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 lg:grid-cols-5">
          {facts.map(([label, value]) => (
            <div key={label} className="min-w-0">
              <dt className="eyebrow">{label}</dt>
              <dd className="num mt-0.5 truncate text-[12.5px] text-ink-2" title={value}>
                {value}
              </dd>
            </div>
          ))}
        </dl>
        <p className="mt-5 max-w-3xl text-[11.5px] leading-relaxed text-muted">
          Confidence intervals are percentile bootstraps over runs with a fixed seed, so they are
          reproducible. Cost excludes judge calls, which are tracked separately so a scoring model
          never flatters or penalises a strategy. Every figure on this site is read from{' '}
          <span className="font-mono">results/</span> at build time.
        </p>
      </div>
    </footer>
  );
}
