import type { Metadata, Viewport } from 'next';

import { ActOne } from '../components/landing/ActOne';
import { ActTwo } from '../components/landing/ActTwo';
import { Explore } from '../components/landing/Explore';
import { FeaturedTraces } from '../components/landing/FeaturedTraces';
import type { HeroCopy, HeroRace, HeroStat } from '../components/landing/Hero';
import { Hero } from '../components/landing/Hero';
import { Result } from '../components/landing/Result';
import { Observation, Scorecard } from '../components/landing/Scorecard';
import { TrustTiles } from '../components/landing/TrustTiles';
import { analyzeForSite } from '../lib/analysis';
import { ARCHITECTURES, architectureColor, architectureInfo, architectureName } from '../lib/architectures';
import type { SiteAnalysis } from '../lib/analysis';
import { formatInt } from '../lib/format';
import { modelShortName } from '../lib/models';
import { DARK } from '../lib/palette';
import { derivePostmortem } from '../lib/postmortem';
import type { RunRecord } from '../lib/records';
import { isRankable } from '../lib/records';
import type { Headline } from '../lib/scorecard';
import { headline as headlineOf, scorecard, signed, times } from '../lib/scorecard';
import { featuredRuns, tracedCount } from '../lib/server/featured';
import { loadHeroRace } from '../lib/server/replays';
import type { RaceGroup } from '../lib/server/replays';
import { loadPostmortemRunSet, loadRunSet } from '../lib/server/runSet';
import { schematicTimeline } from '../lib/schematic';
import { absoluteUrl } from '../lib/site';
import { timelineFromTrace } from '../lib/timeline';

// Title, description and social card come from the root layout.
export const metadata: Metadata = { alternates: { canonical: absoluteUrl('/') } };

// The page opens on the dark hero in both themes, so the browser's own bar should match it.
export const viewport: Viewport = { themeColor: DARK.plane };

export default async function HomePage() {
  const [published, evidence, recorded] = await Promise.all([
    loadRunSet(),
    loadPostmortemRunSet(),
    loadHeroRace(),
  ]);

  // Act 2 is drawn only from a run set whose records all carry the fidelity
  // verdict (or, under SCAFFOLDBENCH_DEMO, from synthetic data that says so loudly).
  const chartable =
    published && published.records.length > 0 && published.verification !== 'unverified'
      ? published
      : null;
  const analysis = chartable ? analyzeForSite(chartable.records) : null;
  const postmortem = evidence ? derivePostmortem(evidence.runSetId, evidence.records) : null;

  const headline = analysis ? headlineOf(analysis) : null;
  const hypotheses = analysis && chartable ? scorecard(analysis, chartable.records) : null;
  const runs = chartable ? chartable.records.filter(isRankable).length : 0;
  const synthetic = chartable?.verification === 'synthetic';

  return (
    <>
      {synthetic ? (
        <div role="note" className="border-b border-warn/50 bg-warn/10 px-4 py-2.5 text-center text-[0.875rem] text-ink">
          <strong className="font-mono text-[0.75rem] uppercase tracking-[0.12em] text-warn">
            Synthetic demo data
          </strong>{' '}
          — every number below is fabricated to build the site. Do not quote it.
        </div>
      ) : null}
      <Hero
        copy={heroCopy(analysis, headline, runs)}
        stats={analysis && headline ? heroStats(analysis, headline) : []}
        race={heroRace(recorded)}
        {...(synthetic ? { note: 'These numbers come from synthetic demo data, not a measurement.' } : {})}
      />
      {analysis && headline && chartable ? (
        <Result analysis={analysis} headline={headline} ceiling={ceilingTasks(chartable.records, analysis.models[analysis.models.length - 1]?.model)} />
      ) : null}
      {hypotheses && chartable ? <Scorecard hypotheses={hypotheses} runSetId={chartable.runSetId} /> : null}
      {analysis && headline?.match ? <Observation match={headline.match} margin={analysis.margin} /> : null}
      {chartable ? (
        <FeaturedTraces runs={featuredRuns(chartable)} traced={tracedCount(chartable)} total={chartable.records.length} />
      ) : null}
      <ActTwo analysis={analysis} synthetic={synthetic} showScale={!headline} />
      <ActOne postmortem={postmortem} {...(evidence?.manifest ? { createdAt: evidence.manifest.createdAt } : {})} />
      <TrustTiles />
      <Explore />
    </>
  );
}

/** The headline states the result only when there is a measured one to state. */
function heroCopy(analysis: SiteAnalysis | null, headline: Headline | null, runs: number): HeroCopy {
  if (!analysis || !headline || headline.scaffoldContrasts === 0) {
    return {
      eyebrow: 'An open benchmark of agent harness architectures',
      title: (
        <>
          Does your agent scaffold <em className="italic text-ink">pay for itself?</em>
        </>
      ),
      lede: (
        <p>
          Planners, verifiers, worker pools, selectors and gates all cost tokens and time. ScaffoldBench runs six
          harness architectures on the same Claude models, tools and tasks, checks that each design actually ran, and
          reports what the extra structure buys, with an interval on every number.
        </p>
      ),
    };
  }
  const models = analysis.models.map((m) => modelShortName(m.model));
  const scaled = headline.scaffoldsBetter === 0 && headline.step !== null && headline.step.scoreGain > 0;
  return {
    eyebrow: (
      <>
        {formatInt(runs)} pre-registered runs
        <span className="max-sm:hidden">
          {' '}
          · {architectureCount(analysis)} architectures · {models.length} models
        </span>
      </>
    ),
    title: scaled ? (
      <>
        Scale beat <em className="italic text-ink">scaffold.</em>
      </>
    ) : (
      <>
        Does your agent scaffold <em className="italic text-ink">pay for itself?</em>
      </>
    ),
    lede: (
      <p>
        We ran planners, verifiers, worker pools, selectors and review gates against a plain single agent on{' '}
        {models.slice(0, -1).join(', ')} and {models[models.length - 1]}.{' '}
        {headline.scaffoldsBetter === 0
          ? 'On no model did any scaffold measurably beat the single agent'
          : `${headline.scaffoldsBetter} of ${headline.scaffoldContrasts} scaffolds measurably beat the single agent`}
        , and every one cost {headline.costMin.toFixed(1)} to {headline.costMax.toFixed(1)} times as much per task.
        {headline.step ? ' One step up in model bought more score than any scaffold did.' : ''}
      </p>
    ),
  };
}

function architectureCount(analysis: SiteAnalysis): number {
  return new Set(analysis.models.flatMap((m) => m.architectures.map((a) => a.strategyId))).size;
}

function heroStats(analysis: SiteAnalysis, h: Headline): HeroStat[] {
  const stats: HeroStat[] = [
    {
      value: `${h.scaffoldsBetter} / ${h.scaffoldContrasts}`,
      label: 'scaffolds that beat a single agent',
      detail: `${h.scaffoldContrasts / analysis.models.length} architectures × ${analysis.models.length} models, paired by task, Holm-adjusted`,
    },
    {
      value: `${times(h.costMin, 1)}–${h.costMax.toFixed(1)}`,
      label: 'what a scaffold costs per task',
      detail: `${h.costlier} of ${h.scaffoldContrasts} shown costlier than the single agent`,
    },
  ];
  if (h.step) {
    stats.push({
      value: signed(h.step.scoreGain, 2),
      label: `score from one model step up`,
      detail: `${modelShortName(h.step.from)} → ${modelShortName(h.step.to)}, single agent, at ${times(h.step.costRatio)} the cost`,
    });
  }
  if (h.bestSmall) {
    stats.push({
      value: signed(h.bestSmall.scoreGain, 2),
      label: `from the best ${modelShortName(h.bestSmall.model)} scaffold`,
      detail: `${architectureName(h.bestSmall.strategyId)}, ${h.bestSmall.verdict === 'better' ? 'separated' : 'not separable'}, at ${times(h.bestSmall.costRatio)} the cost`,
    });
  }
  return stats;
}

/** Tasks on which every architecture scored at least 0.99 (mean over repeats) on the most capable model. */
function ceilingTasks(records: readonly RunRecord[], model: string | undefined): { count: number; tasks: number } {
  const ranked = records.filter(isRankable);
  const tasks = [...new Set(ranked.map((r) => r.taskId))];
  const count = tasks.filter((task) => {
    const byArch = new Map<string, number[]>();
    for (const r of ranked) {
      if (r.taskId === task && r.model === model) byArch.set(r.strategyId, [...(byArch.get(r.strategyId) ?? []), r.score]);
    }
    return byArch.size > 0 && [...byArch.values()].every((s) => s.reduce((x, y) => x + y, 0) / s.length >= 0.99);
  }).length;
  return { count, tasks: tasks.length };
}

/**
 * The race under the headline: recorded runs of one task when a verified
 * (or, under SCAFFOLDBENCH_DEMO, synthetic) set has their traces, else the
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
