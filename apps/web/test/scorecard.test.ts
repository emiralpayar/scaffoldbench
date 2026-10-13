/**
 * The landing page's claims, held to the committed flagship run set: the
 * headline numbers and the H1–H6 verdicts in docs/PREREGISTRATION.md, as
 * reported in results/scaffold-or-scale-v1/REPORT.md. If the analysis or the
 * records change, these fail before the page can say something new.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import type { SiteAnalysis } from '../lib/analysis';
import { analyzeForSite } from '../lib/analysis';
import { FEATURED_RUNS } from '../lib/featuredRuns';
import type { RunRecord } from '../lib/records';
import { headline, scorecard } from '../lib/scorecard';
import { readRunSet, resultsRoot } from '../lib/server/runSet';

const RUN_SET = 'scaffold-or-scale-v1';
const present = existsSync(path.join(resultsRoot(), RUN_SET, 'runs'));

describe.runIf(present)(`the landing page's claims about ${RUN_SET}`, () => {
  let analysis: SiteAnalysis;
  let records: RunRecord[];

  beforeAll(async () => {
    const data = await readRunSet(resultsRoot(), RUN_SET);
    records = data?.records ?? [];
    analysis = analyzeForSite(records);
  }, 120_000);

  it('finds no scaffold that beats a single agent, and every one costlier', () => {
    const h = headline(analysis);
    expect(h.scaffoldsBetter).toBe(0);
    expect(h.scaffoldContrasts).toBe(15);
    expect(h.costlier).toBe(15);
    expect(h.costMin).toBeCloseTo(1.34, 2);
    expect(h.costMax).toBeCloseTo(4.77, 2);
  });

  it('prices one model step up against the best small-model scaffold', () => {
    const h = headline(analysis);
    expect(h.step?.scoreGain).toBeCloseTo(0.129, 3);
    // Paired geometric-mean ratio, like every cost ratio on the site (the ratio of
    // the two mean costs, $0.116 / $0.091, is 1.27).
    expect(h.step?.costRatio).toBeCloseTo(1.24, 2);
    expect(h.bestSmall?.costRatio).toBeCloseTo(4.34, 2);
    expect(h.bestSmall?.strategyId).toBe('propose-select');
    expect(h.bestSmall?.verdict).toBe('inconclusive');
    expect(h.bestSmall?.scoreGain).toBeCloseTo(0.038, 3);
  });

  it('finds Sonnet plan-execute equivalent to Opus single at about 0.64x the cost', () => {
    const m = headline(analysis).match;
    expect(m?.strategyId).toBe('plan-execute');
    expect(m?.model).toBe('claude-sonnet-5-5');
    expect(m?.verdict).toBe('equivalent');
    expect(m?.scoreDelta.mean).toBeCloseTo(-0.006, 3);
    expect(m?.costRatio).toBeCloseTo(0.64, 2);
  });

  it('grades H1-H6 as the report does', () => {
    const card = scorecard(analysis, records);
    expect(card?.map((h) => [h.id, h.badge])).toEqual([
      ['H1', 'not-supported'],
      ['H2', 'consistent'],
      ['H3', 'supported'],
      ['H4', 'not-supported'],
      ['H5', 'partial'],
      ['H6', 'not-supported'],
    ]);
    expect(card?.[4]?.result).toMatch(/^3 of 6/);
  });

  it('features only runs that exist, with the scores their captions quote', () => {
    const byId = new Map(records.map((r) => [r.runId, r]));
    for (const featured of FEATURED_RUNS) expect(byId.has(featured.runId), featured.runId).toBe(true);
    expect(byId.get('claude-haiku-4-5-20251001__gated-execute__airline-hard__r1')?.score).toBe(0);
    expect(byId.get('claude-haiku-4-5-20251001__single__airline-hard__r1')?.costUsd).toBeCloseTo(0.031, 3);
    expect(byId.get('claude-haiku-4-5-20251001__single__airline-easy__r1')?.score).toBeCloseTo(0.429, 3);
    expect(byId.get('claude-haiku-4-5-20251001__propose-select__airline-easy__r1')?.score).toBe(1);
    expect(byId.get('claude-sonnet-5-5__plan-execute-verify__ecommerce-hard__r1')?.score).toBe(1);
  });
});
