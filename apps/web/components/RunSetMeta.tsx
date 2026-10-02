
import { formatDuration, formatUsd } from '../lib/format';
import { modelShortName } from '../lib/models';
import type { RunSetData } from '../lib/server/runSet';
import { POSTMORTEM_RUN_SET_ID, loadRunSet } from '../lib/server/runSet';
import Link from './Link';

/**
 * What kind of numbers the page is showing, said before any of them.
 *
 * Fabricated data must be impossible to mistake for a measurement, so the
 * synthetic banner is loud and unconditional. A legacy run set recorded
 * before the fidelity gate is shown too, but flagged: its architectures were
 * never proven to have run as designed.
 */
export function RunSetBanner({ data }: { data: Pick<RunSetData, 'verification' | 'runSetId'> }) {
  if (data.verification === 'synthetic') {
    return (
      <div role="note" className="banner banner-warn mb-8">
        <p className="banner-title">Synthetic data — not a measurement</p>
        <p className="banner-body">
          Every number on this page was fabricated by{' '}
          <code className="code-inline">scripts/generate-demo-data.ts</code> so the interface can
          be built and reviewed without spending anything. Do not quote it.
        </p>
      </div>
    );
  }

  if (data.verification === 'unverified') {
    const retracted = data.runSetId === POSTMORTEM_RUN_SET_ID;
    return (
      <div role="note" className="banner banner-bad mb-8">
        <p className="banner-title">
          {retracted ? 'Retracted run set' : 'Unverified run set'} — recorded before the fidelity gate
        </p>
        {retracted ? (
          <p className="banner-body">
            Its traces showed that most of its architectures never ran as designed, so none of its
            comparisons mean what they say. It is kept as evidence, not as results.{' '}
            <Link href="/postmortem/" className="link">
              Read the post-mortem
            </Link>
            .
          </p>
        ) : (
          <p className="banner-body">
            Its records carry no integrity checks, so nothing here proves that each architecture
            executed its design. Treat every comparison on this page as unconfirmed.
          </p>
        )}
      </div>
    );
  }

  return null;
}

/** Provenance strip: which run set this is and under what conditions it ran. */
export async function RunSetFooter() {
  const data = await loadRunSet();
  if (!data) return null;

  const { manifest, runSetId, records, models } = data;
  const facts: [string, string][] = [
    ['run set', runSetId],
    [models.length === 1 ? 'model' : 'models', models.map(modelShortName).join(', ') || '—'],
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
    <section aria-label="Provenance" className="border-t border-rule">
      <div className="container-page py-8">
        <p className="eyebrow mb-4">Provenance of the numbers on this page</p>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 lg:grid-cols-5">
          {facts.map(([label, value]) => (
            <div key={label} className="min-w-0">
              <dt className="eyebrow">{label}</dt>
              <dd className="num mt-0.5 truncate text-[13px] text-ink-2" title={value}>
                {value}
              </dd>
            </div>
          ))}
        </dl>
        <p className="mt-5 max-w-3xl text-[13px] leading-relaxed text-muted">
          Cost excludes judge calls, which are tracked separately so a scoring model never
          flatters or penalises an architecture. Every figure on this site is read from{' '}
          <code className="code-inline">results/</code> at build time.
        </p>
      </div>
    </section>
  );
}
