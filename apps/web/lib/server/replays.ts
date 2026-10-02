/**
 * Which recorded runs the site replays: the same task, model and repeat for
 * as many architectures as have a committed trace, so they can be raced side
 * by side on the landing page and replayed one by one on /live.
 *
 * Server-only (reads traces). Nothing here invents a run: when no set has
 * traces, callers get `null` and say so, or draw the schematic instead.
 */

import type { ReplayEntry } from '../../components/timeline/ReplayGallery';
import { architectureColor, architectureName, compareArchitectures } from '../architectures';
import { defaultModel } from '../derive';
import type { Difficulty, RunRecord, TraceEvent } from '../records';
import { pickRepresentative } from '../strategies';
import { timelineFromTrace } from '../timeline';
import { buildViewGroups, trimGroups } from '../traceView';
import type { RunSetData } from './runSet';
import { hasTrace, loadPostmortemRunSet, loadRunSet, loadTrace } from './runSet';

export interface ReplayRun {
  record: RunRecord;
  trace: TraceEvent[];
}

export interface RaceGroup {
  data: RunSetData;
  taskId: string;
  taskTitle: string;
  model: string;
  repeat: number;
  /** One run per architecture, in reading order. */
  runs: ReplayRun[];
}

const DIFFICULTY: Record<Difficulty, number> = { easy: 0, medium: 1, hard: 2, expert: 3 };

/**
 * The best (task, model, repeat) to race in a run set: the one with the most
 * architectures traced, then the harder task, the default model and the
 * first repeat. `null` when fewer than two architectures share one.
 */
export async function findRace(data: RunSetData): Promise<RaceGroup | null> {
  const groups = new Map<string, RunRecord[]>();
  for (const record of data.records) {
    if (!hasTrace(data, record)) continue;
    const key = `${record.taskId}\u0000${record.model}\u0000${record.repeat}`;
    const bucket = groups.get(key) ?? [];
    if (!bucket.some((other) => other.strategyId === record.strategyId)) bucket.push(record);
    groups.set(key, bucket);
  }

  const preferredModel = defaultModel(data.models);
  const best = [...groups.values()]
    .filter((runs) => runs.length >= 2)
    .sort((a, b) => {
      const [x, y] = [a[0] as RunRecord, b[0] as RunRecord];
      return (
        b.length - a.length ||
        DIFFICULTY[y.taskDifficulty] - DIFFICULTY[x.taskDifficulty] ||
        Number(y.model === preferredModel) - Number(x.model === preferredModel) ||
        x.repeat - y.repeat ||
        x.taskId.localeCompare(y.taskId)
      );
    })[0];
  if (!best) return null;

  const runs: ReplayRun[] = [];
  for (const record of [...best].sort((a, b) => compareArchitectures(a.strategyId, b.strategyId))) {
    const trace = await loadTrace(data, record);
    if (trace && trace.length > 0) runs.push({ record, trace });
  }
  if (runs.length < 2) return null;
  const first = runs[0]?.record as RunRecord;
  return {
    data,
    taskId: first.taskId,
    taskTitle: first.taskTitle,
    model: first.model,
    repeat: first.repeat,
    runs,
  };
}

/**
 * Recorded runs to replay on /live: the published set's if it has traces,
 * otherwise the first run set's evidence, which is labelled as retracted
 * wherever it is shown.
 */
export async function loadReplays(): Promise<RaceGroup | null> {
  const published = await loadRunSet();
  const fromPublished = published ? await findRace(published) : null;
  if (fromPublished) return fromPublished;
  const evidence = await loadPostmortemRunSet();
  return evidence && evidence.runSetId !== published?.runSetId ? findRace(evidence) : null;
}

/**
 * The race on the landing page: only from a set whose architectures are
 * proven to have run (or a synthetic one, which is bannered). A legacy set
 * is evidence for Act 1, not a picture of how the designs work.
 */
export async function loadHeroRace(): Promise<RaceGroup | null> {
  const published = await loadRunSet();
  if (!published || published.verification === 'unverified') return null;
  return findRace(published);
}

/** The first run set's race, for the post-mortem: the evidence, replayed. */
export async function loadEvidenceRace(): Promise<RaceGroup | null> {
  const evidence = await loadPostmortemRunSet();
  return evidence ? findRace(evidence) : null;
}

/** A race as the replay gallery wants it: one entry per architecture. */
export function toReplayEntries(race: Pick<RaceGroup, 'runs'>): ReplayEntry[] {
  return race.runs.map(({ record, trace }) => ({
    runId: record.runId,
    strategyId: record.strategyId,
    name: architectureName(record.strategyId),
    color: architectureColor(record.strategyId),
    timeline: timelineFromTrace(trace, record.phases),
    groups: trimGroups(buildViewGroups(trace)),
    score: record.score,
    passed: record.passed,
  }));
}

export interface RepresentativeRun {
  data: RunSetData;
  record: RunRecord;
  /** `null` when the run's trace is not in this build. */
  trace: TraceEvent[] | null;
}

/**
 * One run of an architecture to show on its page, from the published set. A
 * run with a trace is preferred over a better one without, because the point
 * of showing a run is to watch the design work.
 */
export async function loadRepresentativeRun(strategyId: string): Promise<RepresentativeRun | null> {
  const data = await loadRunSet();
  if (!data) return null;
  const traced = pickRepresentative(data.records, strategyId, defaultModel(data.models), (r) => hasTrace(data, r));
  const record = traced ?? pickRepresentative(data.records, strategyId, defaultModel(data.models));
  if (!record) return null;
  return { data, record, trace: traced ? await loadTrace(data, record) : null };
}
