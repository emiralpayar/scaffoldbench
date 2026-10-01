import { ActOne } from '../components/landing/ActOne';
import { ActTwo } from '../components/landing/ActTwo';
import { Explore } from '../components/landing/Explore';
import type { HeroFact } from '../components/landing/Hero';
import { Hero } from '../components/landing/Hero';
import { TrustTiles } from '../components/landing/TrustTiles';
import { analyzeForSite } from '../lib/analysis';
import { formatInt } from '../lib/format';
import { derivePostmortem } from '../lib/postmortem';
import { isRankable } from '../lib/records';
import { loadPostmortemRunSet, loadRunSet } from '../lib/server/runSet';

export default async function HomePage() {
  const [published, evidence] = await Promise.all([loadRunSet(), loadPostmortemRunSet()]);

  // Act 2 is drawn only from a run set whose records all carry the fidelity
  // verdict (or, under ARENA_DEMO, from synthetic data that says so loudly).
  const chartable =
    published && published.records.length > 0 && published.verification !== 'unverified'
      ? published
      : null;
  const analysis = chartable ? analyzeForSite(chartable.records) : null;
  const postmortem = evidence ? derivePostmortem(evidence.runSetId, evidence.records) : null;

  const facts: HeroFact[] = chartable
    ? [
        { label: 'Runs', value: formatInt(chartable.records.filter(isRankable).length) },
        { label: 'Models', value: String(chartable.models.length) },
        {
          label: 'Architectures',
          value: String(new Set(chartable.records.map((r) => r.strategyId)).size),
        },
        { label: 'Tasks', value: String(new Set(chartable.records.map((r) => r.taskId)).size) },
      ]
    : [];

  return (
    <>
      {chartable?.verification === 'synthetic' ? (
        <div role="note" className="border-b border-warn/50 bg-warn/10 px-4 py-2.5 text-center text-[0.875rem] text-ink">
          <strong className="font-mono text-[0.75rem] uppercase tracking-[0.12em] text-warn">
            Synthetic demo data
          </strong>{' '}
          — every number below is fabricated to build the site. Do not quote it.
        </div>
      ) : null}
      <Hero
        facts={facts}
        {...(chartable?.verification === 'synthetic'
          ? { note: 'These counts come from synthetic demo data, not a measurement.' }
          : {})}
      />
      <ActOne postmortem={postmortem} {...(evidence?.manifest ? { createdAt: evidence.manifest.createdAt } : {})} />
      <ActTwo analysis={analysis} synthetic={chartable?.verification === 'synthetic'} />
      <TrustTiles />
      <Explore />
    </>
  );
}
