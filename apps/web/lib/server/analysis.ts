/**
 * The site's analysis of a run set, computed once per build process.
 *
 * Every results page asks for the same bootstrap; recomputing it per page
 * would cost seconds per page on a large set and could not change the
 * answer, because the analysis is seeded and deterministic.
 */

import type { SiteAnalysis } from '../analysis';
import { analyzeForSite } from '../analysis';
import type { RunSetData } from './runSet';

const cache = new Map<string, SiteAnalysis>();

export function analysisFor(data: Pick<RunSetData, 'runSetId' | 'records'>): SiteAnalysis {
  // In development the files can change between requests.
  if (process.env.NODE_ENV === 'development') return analyzeForSite(data.records);
  let analysis = cache.get(data.runSetId);
  if (!analysis) {
    analysis = analyzeForSite(data.records);
    cache.set(data.runSetId, analysis);
  }
  return analysis;
}
