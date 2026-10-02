import type { Metadata } from 'next';

import { ActOne } from '../components/landing/ActOne';
import { ActTwo } from '../components/landing/ActTwo';
import { Explore } from '../components/landing/Explore';
import type { HeroFact, HeroRace } from '../components/landing/Hero';
import { Hero } from '../components/landing/Hero';
import { TrustTiles } from '../components/landing/TrustTiles';
import { analyzeForSite } from '../lib/analysis';
import { ARCHITECTURES, architectureColor, architectureInfo, architectureName } from '../lib/architectures';
import { formatInt } from '../lib/format';
import { modelShortName } from '../lib/models';
import { derivePostmortem } from '../lib/postmortem';
import { isRankable } from '../lib/records';
import { loadHeroRace } from '../lib/server/replays';
import type { RaceGroup } from '../lib/server/replays';
import { loadPostmortemRunSet, loadRunSet } from '../lib/server/runSet';
import { schematicTimeline } from '../lib/schematic';
import { absoluteUrl } from '../lib/site';
import { timelineFromTrace } from '../lib/timeline';

// Title, description and social card come from the root layout.
export const metadata: Metadata = { alternates: { canonical: absoluteUrl('/') } };

export default async function HomePage() {
  const [published, evidence, recorded] = await Promise.all([
    loadRunSet(),
    loadPostmortemRunSet(),
    loadHeroRace(),
  ]);

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
        race={heroRace(recorded)}
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

/**
 * The race under the headline: recorded runs of one task when a verified
 * (or, under ARENA_DEMO, synthetic) set has their traces, else the
 * schematic, labelled as such and carrying no numbers.
 */
function heroRace(group: RaceGroup | null): HeroRace {
  if (!group) {
    return {
      recorded: false,
      speed: 6,
      lanes: ARCHITECTURES.map((info) => ({
        strategyId: info.id,
        name: info.name,
        shape: info.shape,
        color: architectureColor(info.id),
        timeline: schematicTimeline(info.id),
      })),
      title: 'How each design spends a task',
      note: 'Schematic: the calls each design makes, on an invented clock',
    };
  }
  const synthetic = group.data.verification === 'synthetic';
  return {
    recorded: true,
    speed: 8,
    lanes: group.runs.map(({ record, trace }) => ({
      strategyId: record.strategyId,
      name: architectureName(record.strategyId),
      shape: architectureInfo(record.strategyId)?.shape ?? '',
      color: architectureColor(record.strategyId),
      timeline: timelineFromTrace(trace, record.phases),
      outcome: {
        score: record.score,
        passed: record.passed,
        costUsd: record.costUsd,
        latencyMs: record.latencyMs,
        runId: record.runId,
      },
    })),
    title: <>Same task, {group.runs.length} harnesses: {group.taskTitle}</>,
    note: `${synthetic ? 'Synthetic replay' : 'Replay'} · ${modelShortName(group.model)} · repeat ${group.repeat}`,
  };
}
