/**
 * Simulation checks of the inference: does a 95% interval cover 95% of the
 * time, and does a verdict that should be wrong 5% of the time stay there?
 *
 * Every simulation is seeded, so these are deterministic regression tests,
 * not flaky ones. Sizes are kept small for CI; the bounds leave room for the
 * Monte Carlo error of a few hundred replications (the standard error of a
 * coverage near 0.95 over 300 trials is about 0.013). docs/STATISTICS.md
 * quotes the same scenarios at larger sizes.
 */

import { describe, expect, it } from 'vitest';
import {
  analyzeRunSet,
  bootstrapCI,
  bootstrapMeans,
  expandedPercentileInterval,
  makeRng,
  pairedTest,
  quantileSorted,
  resolveVerdicts,
  summarizeRuns,
} from '@arena/core';
import type { InferenceSettings, RunRecord } from '@arena/core';

function gaussian(rng: () => number): () => number {
  return () => {
    let u = 0;
    while (u === 0) u = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
  };
}

const settings: InferenceSettings = { iterations: 1_000, seed: 0xa11ce, alpha: 0.05, minClusters: 5 };

/** Verdict of one paired contrast given its cell differences, task by task. */
function verdictOf(cells: number[][], margin: number, binary = false): string {
  const diffs = cells.map((c) => c.reduce((a, d) => a + d, 0) / c.length);
  const test = pairedTest(diffs, margin, settings, { cellDiffs: cells, binary });
  return (resolveVerdicts([test], 0.05, true)[0] as { verdict: string }).verdict;
}

/** Score-like paired cell differences: task effect ~ N(delta, 0.05²), run noise sd 0.15. */
function scoreCells(normal: () => number, tasks: number, repeats: number, delta: number): number[][] {
  return Array.from({ length: tasks }, () => {
    const effect = delta + 0.05 * normal();
    return Array.from({ length: repeats }, () => effect + 0.15 * normal());
  });
}

/** Lumpy differences at the margin: A always scores 1, B loses `penalty` with probability 0.05 / penalty. */
function lumpyCells(rng: () => number, tasks: number, repeats: number, penalty: number): number[][] {
  return Array.from({ length: tasks }, () =>
    Array.from({ length: repeats }, () => (rng() < 0.05 / penalty ? penalty : 0)),
  );
}

describe('interval coverage', () => {
  it('keeps the expanded percentile interval near 95% at 9 tasks, where plain percentile falls short', () => {
    const rng = makeRng(101);
    const normal = gaussian(rng);
    let expanded = 0;
    let plain = 0;
    const trials = 300;
    for (let s = 0; s < trials; s++) {
      const values = Array.from({ length: 9 }, () => 0.1 * normal());
      const sorted = bootstrapMeans(values, 1_000, s + 1);
      const ci = expandedPercentileInterval(sorted, values.length, 0.95)!;
      if (ci.low <= 0 && 0 <= ci.high) expanded += 1;
      if (quantileSorted(sorted, 0.025) <= 0 && 0 <= quantileSorted(sorted, 0.975)) plain += 1;
    }
    expect(expanded / trials).toBeGreaterThan(0.9);
    expect(expanded).toBeGreaterThan(plain);
  });

  it('covers at 20 tasks', () => {
    const rng = makeRng(202);
    const normal = gaussian(rng);
    let covered = 0;
    const trials = 300;
    for (let s = 0; s < trials; s++) {
      const values = Array.from({ length: 20 }, () => 0.1 * normal());
      const ci = expandedPercentileInterval(bootstrapMeans(values, 1_000, s + 1), 20, 0.95)!;
      if (ci.low <= 0 && 0 <= ci.high) covered += 1;
    }
    expect(covered / trials).toBeGreaterThan(0.91);
  });

  it('accounts for clustering: iid intervals over runs undercover when tasks differ', () => {
    // 9 tasks x 2 repeats, task means spread far more than repeats do (ICC ~ 0.9).
    const rng = makeRng(303);
    const normal = gaussian(rng);
    let clustered = 0;
    let iid = 0;
    const trials = 300;
    for (let s = 0; s < trials; s++) {
      const taskMeans: number[] = [];
      const runs: number[] = [];
      for (let t = 0; t < 9; t++) {
        const mu = 0.3 * normal();
        const reps = [mu + 0.1 * normal(), mu + 0.1 * normal()];
        runs.push(...reps);
        taskMeans.push((reps[0]! + reps[1]!) / 2);
      }
      const ci = expandedPercentileInterval(bootstrapMeans(taskMeans, 1_000, s + 1), 9, 0.95)!;
      if (ci.low <= 0 && 0 <= ci.high) clustered += 1;
      const legacy = bootstrapCI(runs, { iterations: 1_000, seed: s + 1 });
      if (legacy.low <= 0 && 0 <= legacy.high) iid += 1;
    }
    expect(clustered / trials).toBeGreaterThan(0.9);
    expect(iid / trials).toBeLessThan(0.85);
  });
});

describe('error rates of the four-way verdict', () => {
  it('calls a difference under the null at most about 5% of the time', () => {
    const normal = gaussian(makeRng(404));
    let falsePositives = 0;
    const trials = 300;
    for (let s = 0; s < trials; s++) {
      const v = verdictOf(scoreCells(normal, 20, 3, 0), 0.05);
      if (v === 'better' || v === 'worse') falsePositives += 1;
    }
    expect(falsePositives / trials).toBeLessThan(0.08);
  });

  it('calls equivalence at most about 5% of the time when the true gap equals the margin', () => {
    const normal = gaussian(makeRng(505));
    let falseEquivalence = 0;
    const trials = 300;
    for (let s = 0; s < trials; s++) {
      if (verdictOf(scoreCells(normal, 20, 3, 0.05), 0.05) === 'equivalent') falseEquivalence += 1;
    }
    expect(falseEquivalence / trials).toBeLessThan(0.08);
  });

  it('holds that line when differences are rare and lumpy', () => {
    // The true gap equals the margin, but it arrives as rare large jumps — the
    // case where a bootstrap sees too little spread. Pass/fail (penalty 1, with
    // the binary floor) at 60 tasks, and partial-credit score penalties of
    // 0.5 at 30 tasks and 0.25 at 9 x 2 (the published run set's shape).
    const rng = makeRng(606);
    const trials = 300;
    for (const [penalty, tasks, repeats] of [
      [1, 60, 3],
      [0.5, 30, 3],
      [0.25, 9, 2],
    ] as const) {
      let falseEquivalence = 0;
      for (let s = 0; s < trials; s++) {
        if (verdictOf(lumpyCells(rng, tasks, repeats, penalty), 0.05, penalty === 1) === 'equivalent') falseEquivalence += 1;
      }
      expect(falseEquivalence / trials).toBeLessThan(0.08);
    }
  });

  it('detects a 10-point effect on 20 tasks most of the time', () => {
    const normal = gaussian(makeRng(707));
    let detected = 0;
    const trials = 100;
    for (let s = 0; s < trials; s++) if (verdictOf(scoreCells(normal, 20, 3, 0.1), 0.05) === 'better') detected += 1;
    expect(detected / trials).toBeGreaterThan(0.8);
  });
});

describe('familywise error across a leaderboard', () => {
  // Five identical strategies, 9 tasks x 2 repeats, every run passes with
  // probability 0.9 — the published run set's shape. Any verdict other than
  // inconclusive or equivalent is a false discovery.
  function identicalRunSet(rng: () => number): RunRecord[] {
    const records: RunRecord[] = [];
    for (const strategyId of ['s1', 's2', 's3', 's4', 's5']) {
      for (let t = 0; t < 9; t++) {
        for (let repeat = 1; repeat <= 2; repeat++) {
          const passed = rng() < 0.9;
          records.push({
            runId: `${strategyId}-${t}-${repeat}`,
            runSetId: 'sim',
            taskId: `task-${t}`,
            taskTitle: '',
            taskCategory: 'tool-use',
            taskWorld: 'sim',
            taskDifficulty: 'easy',
            strategyId,
            model: 'm',
            effort: 'high',
            repeat,
            startedAt: '',
            finishedAt: '',
            latencyMs: 1_000 + rng() * 100,
            score: passed ? 1 : 0.8,
            passed,
            breakdown: [],
            penalties: [],
            failureMode: passed ? 'none' : 'wrong_answer',
            scoreMetadata: {},
            costUsd: 0.05 + rng() * 0.01,
            judgeCostUsd: 0,
            usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
            turns: 1,
            toolCalls: 1,
            deniedToolCalls: 0,
            subagentCount: 0,
            phases: [],
            finalText: '',
          });
        }
      }
    }
    return records;
  }

  it('keeps false winners rare where the old overlap rule declared them often', () => {
    const rng = makeRng(808);
    let legacyAny = 0;
    let pairedAny = 0;
    const trials = 120;
    for (let s = 0; s < trials; s++) {
      const records = identicalRunSet(rng);
      if (summarizeRuns(records).pairwise.some((p) => p.verdict !== 'inconclusive')) legacyAny += 1;
      const analysis = analyzeRunSet(records, { iterations: 300, seed: s + 1 });
      const pairwise = analysis.models[0]!.pairwise.filter((c) => c.metric === 'score');
      if (pairwise.some((c) => c.verdict === 'better' || c.verdict === 'worse')) pairedAny += 1;
    }
    expect(pairedAny / trials).toBeLessThanOrEqual(0.05);
    expect(legacyAny / trials).toBeGreaterThan(0.1);
  });
});
