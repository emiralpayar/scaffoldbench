/**
 * The featured runs (see `lib/featuredRuns.ts`) that this build can replay:
 * in the published set, with their trace in the checkout. Server-only.
 */

import type { FeaturedRun } from '../featuredRuns';
import { FEATURED_RUNS } from '../featuredRuns';
import type { RunRecord } from '../records';
import type { RunSetData } from './runSet';
import { hasTrace } from './runSet';

export interface FeaturedEntry extends FeaturedRun {
  record: RunRecord;
}

export function featuredRuns(data: RunSetData | null, exclude?: string): FeaturedEntry[] {
  if (!data) return [];
  const entries: FeaturedEntry[] = [];
  for (const featured of FEATURED_RUNS) {
    if (featured.runId === exclude) continue;
    const record = data.records.find((r) => r.runId === featured.runId);
    if (record && hasTrace(data, record)) entries.push({ ...featured, record });
  }
  return entries;
}

/** How many runs of the set have a trace in this checkout. */
export function tracedCount(data: RunSetData): number {
  return data.records.filter((record) => hasTrace(data, record)).length;
}
