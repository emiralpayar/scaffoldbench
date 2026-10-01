/**
 * Simulation checks of the inference: does a 95% interval cover 95% of the
 * time, and does a verdict that should be wrong 5% of the time stay there?
 *
 * Every simulation is seeded, so these are deterministic regression tests,
 * not flaky ones. Sizes are kept small for CI; the bounds leave room for the
 * Monte Carlo error of a few hundred replications (the standard error of a
 * coverage near 0.95 over 300 trials is about 0.013).
 *
 * docs/STATISTICS.md quotes these scenarios at 2,000 trials with the default
 * 10,000 bootstrap replicates. To reproduce its table:
 *
 *   ARENA_SIM_TRIALS=2000 npx vitest run packages/core/test/analysisSimulation.test.ts \
 *     --testTimeout=1200000
 *
 * (about two minutes, most of it the leaderboard simulation).
 */

import { describe, expect, it } from 'vitest';
import {
  analyzeRunSet,
  bootstrapCI,
  bootstrapMeans,
  expandedPercentileInterval,
  makeRng,
  normalCdf,
  normalQuantile,
  pairedTest,
  quantileSorted,
  resolveVerdicts,
  summarizeRuns,
  wilsonInterval,
} from '@arena/core';
import type { InferenceSettings, RunRecord } from '@arena/core';

function gaussian(rng: () => number): () => number {
  return () => {
    let u = 0;
    while (u === 0) u = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
  };
}

const SCALE = Number(process.env.ARENA_SIM_TRIALS) || 0;
const ITERATIONS = SCALE ? 10_000 : 1_000;
const trialsOr = (ciDefault: number) => SCALE || ciDefault;

/** Print a measured rate when running at documentation scale. */
function report(label: string, rate: number): number {
  if (SCALE) console.log(`[${SCALE} trials] ${label}: ${rate.toFixed(3)}`);
  return rate;
}

const settings: InferenceSettings = { iterations: ITERATIONS, seed: 0xa11ce, alpha: 0.05, minClusters: 5 };

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

/**
 * BCa interval for a mean (Efron & Tibshirani 1993, ch. 14), only to compare
 * against: bias correction from the replicates, acceleration from the jackknife.
 */
function bcaInterval(values: number[], sorted: Float64Array, alpha: number): { low: number; high: number } {
  const n = values.length;
  const mean = values.reduce((a, v) => a + v, 0) / n;
  let below = 0;
  for (const r of sorted) if (r < mean) below += 1;
  const z0 = normalQuantile(Math.min(1 - 1 / sorted.length, Math.max(1 / sorted.length, below / sorted.length)));
  const jack = values.map((v) => (mean * n - v) / (n - 1));
  const jackMean = jack.reduce((a, v) => a + v, 0) / n;
  let num = 0;
  let den = 0;
  for (const j of jack) {
    num += (jackMean - j) ** 3;
    den += (jackMean - j) ** 2;
  }
  const a = den === 0 ? 0 : num / (6 * den ** 1.5);
  const level = (z: number) => normalCdf(z0 + (z0 + z) / (1 - a * (z0 + z)));
  return {
    low: quantileSorted(sorted, level(normalQuantile(alpha / 2))),
    high: quantileSorted(sorted, level(normalQuantile(1 - alpha / 2))),
  };
}

/** Lumpy differences at the margin: A always scores 1, B loses `penalty` with probability 0.05 / penalty. */
function lumpyCells(rng: () => number, tasks: number, repeats: number, penalty: number): number[][] {
  return Array.from({ length: tasks }, () =>
    Array.from({ length: repeats }, () => (rng() < 0.05 / penalty ? penalty : 0)),
  );
}

describe('interval coverage', () => {
  it('keeps the expanded percentile interval near 95% at 9 tasks, where plain percentile and BCa fall short', () => {
    const rng = makeRng(101);
    const normal = gaussian(rng);
    let expanded = 0;
    let plain = 0;
    let bca = 0;
    const trials = trialsOr(300);
    for (let s = 0; s < trials; s++) {
      const values = Array.from({ length: 9 }, () => 0.1 * normal());
      const sorted = bootstrapMeans(values, ITERATIONS, s + 1);
      const ci = expandedPercentileInterval(sorted, values.length, 0.95)!;
      if (ci.low <= 0 && 0 <= ci.high) expanded += 1;
      if (quantileSorted(sorted, 0.025) <= 0 && 0 <= quantileSorted(sorted, 0.975)) plain += 1;
      const b = bcaInterval(values, sorted, 0.05);
      if (b.low <= 0 && 0 <= b.high) bca += 1;
    }
    report('coverage, 9 tasks, plain percentile', plain / trials);
    report('coverage, 9 tasks, BCa', bca / trials);
    expect(report('coverage, 9 tasks, expanded percentile', expanded / trials)).toBeGreaterThan(0.9);
    expect(expanded).toBeGreaterThan(plain);
    expect(expanded).toBeGreaterThan(bca);
  });

  it('keeps that lead on paired pass/fail differences', () => {
    // Task pass probability ~ U(0.6, 1), the same for both arms; 9 tasks x 3.
    const rng = makeRng(150);
    let expanded = 0;
    let plain = 0;
    let bca = 0;
    let usable = 0;
    const trials = trialsOr(300);
    for (let s = 0; s < trials; s++) {
      const values = Array.from({ length: 9 }, () => {
        const p = 0.6 + 0.4 * rng();
        let d = 0;
        for (let r = 0; r < 3; r++) d += (rng() < p ? 1 : 0) - (rng() < p ? 1 : 0);
        return d / 3;
      });
      if (values.every((v) => v === values[0])) continue; // no verdict is attempted on these
      usable += 1;
      const sorted = bootstrapMeans(values, ITERATIONS, s + 1);
      const ci = expandedPercentileInterval(sorted, values.length, 0.95)!;
      if (ci.low <= 0 && 0 <= ci.high) expanded += 1;
      if (quantileSorted(sorted, 0.025) <= 0 && 0 <= quantileSorted(sorted, 0.975)) plain += 1;
      const b = bcaInterval(values, sorted, 0.05);
      if (b.low <= 0 && 0 <= b.high) bca += 1;
    }
    report('coverage, paired pass/fail 9 tasks x 3, plain percentile', plain / usable);
    report('coverage, paired pass/fail 9 tasks x 3, BCa', bca / usable);
    expect(report('coverage, paired pass/fail 9 tasks x 3, expanded', expanded / usable)).toBeGreaterThan(0.9);
    expect(expanded).toBeGreaterThan(bca);
  });

  it('covers at 20 tasks', () => {
    const rng = makeRng(202);
    const normal = gaussian(rng);
    let covered = 0;
    const trials = trialsOr(300);
    for (let s = 0; s < trials; s++) {
      const values = Array.from({ length: 20 }, () => 0.1 * normal());
      const ci = expandedPercentileInterval(bootstrapMeans(values, ITERATIONS, s + 1), 20, 0.95)!;
      if (ci.low <= 0 && 0 <= ci.high) covered += 1;
    }
    expect(report('coverage, 20 tasks, expanded percentile', covered / trials)).toBeGreaterThan(0.91);
  });

  it('accounts for clustering: iid intervals over runs undercover when tasks differ', () => {
    // 9 tasks x 2 repeats, task means spread far more than repeats do (ICC ~ 0.9).
    const rng = makeRng(303);
    const normal = gaussian(rng);
    let clustered = 0;
    let iid = 0;
    const trials = trialsOr(300);
    for (let s = 0; s < trials; s++) {
      const taskMeans: number[] = [];
      const runs: number[] = [];
      for (let t = 0; t < 9; t++) {
        const mu = 0.3 * normal();
        const reps = [mu + 0.1 * normal(), mu + 0.1 * normal()];
        runs.push(...reps);
        taskMeans.push((reps[0]! + reps[1]!) / 2);
      }
      const ci = expandedPercentileInterval(bootstrapMeans(taskMeans, ITERATIONS, s + 1), 9, 0.95)!;
      if (ci.low <= 0 && 0 <= ci.high) clustered += 1;
      const legacy = bootstrapCI(runs, { iterations: ITERATIONS, seed: s + 1 });
      if (legacy.low <= 0 && 0 <= legacy.high) iid += 1;
    }
    expect(report('coverage, 9 tasks x 2 clustered, task bootstrap', clustered / trials)).toBeGreaterThan(0.9);
    expect(report('coverage, 9 tasks x 2 clustered, legacy iid over runs', iid / trials)).toBeLessThan(0.85);
  });
});

describe('error rates of the four-way verdict', () => {
  it('calls a difference under the null at most about 5% of the time', () => {
    const normal = gaussian(makeRng(404));
    let falsePositives = 0;
    const trials = trialsOr(300);
    for (let s = 0; s < trials; s++) {
      const v = verdictOf(scoreCells(normal, 20, 3, 0), 0.05);
      if (v === 'better' || v === 'worse') falsePositives += 1;
    }
    expect(report('false difference, no effect, 20 tasks x 3', falsePositives / trials)).toBeLessThan(0.08);
  });

  it('calls equivalence at most about 5% of the time when the true gap equals the margin', () => {
    const normal = gaussian(makeRng(505));
    let falseEquivalence = 0;
    const trials = trialsOr(300);
    for (let s = 0; s < trials; s++) {
      if (verdictOf(scoreCells(normal, 20, 3, 0.05), 0.05) === 'equivalent') falseEquivalence += 1;
    }
    expect(report('false equivalence, gap = margin, 20 tasks x 3', falseEquivalence / trials)).toBeLessThan(0.08);
  });

  it('holds that line when differences are rare and lumpy', () => {
    // The true gap equals the margin, but it arrives as rare large jumps — the
    // case where a bootstrap sees too little spread. Pass/fail (penalty 1, with
    // the binary floor) at 60 tasks, and partial-credit score penalties of
    // 0.5 at 30 tasks and 0.25 at 9 x 2 (the published run set's shape).
    const rng = makeRng(606);
    const trials = trialsOr(300);
    for (const [penalty, tasks, repeats] of [
      [1, 60, 3],
      [0.5, 30, 3],
      [0.25, 9, 2],
    ] as const) {
      let falseEquivalence = 0;
      for (let s = 0; s < trials; s++) {
        if (verdictOf(lumpyCells(rng, tasks, repeats, penalty), 0.05, penalty === 1) === 'equivalent') falseEquivalence += 1;
      }
      const label = `false equivalence, lumpy gap = margin (penalty ${penalty}), ${tasks} tasks x ${repeats}`;
      expect(report(label, falseEquivalence / trials)).toBeLessThan(0.08);
    }
  });

  it('needs on the order of 100 tasks to show 5-point pass equivalence, even for identical arms', () => {
    // Both arms pass 95% of runs on every task: the truth is "equivalent".
    const rng = makeRng(909);
    const cells = (tasks: number) =>
      Array.from({ length: tasks }, () =>
        Array.from({ length: 3 }, () => (rng() < 0.95 ? 1 : 0) - (rng() < 0.95 ? 1 : 0)),
      );
    const trials = trialsOr(200);
    const rates: number[] = [];
    for (const tasks of [60, 100]) {
      let shown = 0;
      for (let s = 0; s < trials; s++) if (verdictOf(cells(tasks), 0.05, true) === 'equivalent') shown += 1;
      rates.push(report(`power to show pass equivalence (±5 points), identical arms at 95%, ${tasks} tasks x 3`, shown / trials));
    }
    expect(rates[0]).toBeLessThan(0.6);
    expect(rates[1]).toBeGreaterThan(rates[0]!);
  });

  it('detects a 10-point effect on 20 tasks most of the time', () => {
    const normal = gaussian(makeRng(707));
    let detected = 0;
    const trials = trialsOr(100);
    for (let s = 0; s < trials; s++) if (verdictOf(scoreCells(normal, 20, 3, 0.1), 0.05) === 'better') detected += 1;
    expect(report('power, 10-point effect, 20 tasks x 3', detected / trials)).toBeGreaterThan(0.8);
  });
});

/** A run record carrying only what the analysis reads. */
function simRecord(fields: {
  strategyId: string;
  taskId: string;
  repeat: number;
  passed: boolean;
  score: number;
  costUsd: number;
  latencyMs: number;
}): RunRecord {
  return {
    runId: `${fields.strategyId}-${fields.taskId}-${fields.repeat}`,
    runSetId: 'sim',
    taskTitle: '',
    taskCategory: 'tool-use',
    taskWorld: 'sim',
    taskDifficulty: 'easy',
    model: 'm',
    effort: 'high',
    startedAt: '',
    finishedAt: '',
    breakdown: [],
    penalties: [],
    failureMode: fields.passed ? 'none' : 'wrong_answer',
    scoreMetadata: {},
    judgeCostUsd: 0,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
    turns: 1,
    toolCalls: 1,
    deniedToolCalls: 0,
    subagentCount: 0,
    phases: [],
    finalText: '',
    ...fields,
  };
}

describe('pass-rate interval at the ceiling', () => {
  it('covers when the task decides the outcome, where counting runs does not', () => {
    // 9 tasks x 2 repeats; a task is solved in every run or in none, and 80%
    // of tasks are solvable. 13% of run sets come out 18/18. Wilson over the
    // 18 runs then says [0.824, 1] and misses 0.8; over the 9 tasks it does not.
    const rng = makeRng(1_001);
    const truth = 0.8;
    let byTasks = 0;
    let byRuns = 0;
    const trials = trialsOr(400);
    for (let s = 0; s < trials; s++) {
      const records: RunRecord[] = [];
      for (let t = 0; t < 9; t++) {
        const passed = rng() < truth;
        for (let repeat = 1; repeat <= 2; repeat++) {
          records.push(
            simRecord({ strategyId: 'single', taskId: `task-${t}`, repeat, passed, score: passed ? 1 : 0, costUsd: 0.05, latencyMs: 1_000 }),
          );
        }
      }
      const pass = analyzeRunSet(records, { iterations: 200, seed: s + 1 }).models[0]!.strategies[0]!.passRate;
      if (pass.ci!.low <= truth && truth <= pass.ci!.high) byTasks += 1;
      // The same interval, except that 0/18 and 18/18 count runs.
      const atCeiling = pass.passed === 0 || pass.passed === pass.runs;
      const runsAtCeiling = atCeiling ? wilsonInterval(pass.passed, pass.runs) : pass.ci!;
      if (runsAtCeiling.low <= truth && truth <= runsAtCeiling.high) byRuns += 1;
    }
    expect(report('pass-rate coverage, task-decided 9 x 2, Wilson over tasks at the ceiling', byTasks / trials)).toBeGreaterThan(0.93);
    expect(report('pass-rate coverage, task-decided 9 x 2, Wilson over runs at the ceiling', byRuns / trials)).toBeLessThan(0.9);
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
          records.push(
            simRecord({
              strategyId,
              taskId: `task-${t}`,
              repeat,
              latencyMs: 1_000 + rng() * 100,
              score: passed ? 1 : 0.8,
              passed,
              costUsd: 0.05 + rng() * 0.01,
            }),
          );
        }
      }
    }
    return records;
  }

  it('keeps false winners rare where the old overlap rule declared them often', () => {
    const rng = makeRng(808);
    let legacyAny = 0;
    let pairedAny = 0;
    const trials = trialsOr(120);
    for (let s = 0; s < trials; s++) {
      const records = identicalRunSet(rng);
      if (summarizeRuns(records).pairwise.some((p) => p.verdict !== 'inconclusive')) legacyAny += 1;
      const analysis = analyzeRunSet(records, { iterations: SCALE ? ITERATIONS : 300, seed: s + 1 });
      const pairwise = analysis.models[0]!.pairwise.filter((c) => c.metric === 'score');
      if (pairwise.some((c) => c.verdict === 'better' || c.verdict === 'worse')) pairedAny += 1;
    }
    expect(report('run sets with a false winner, paired + Holm', pairedAny / trials)).toBeLessThanOrEqual(0.05);
    expect(report('run sets with a false winner, legacy overlap rule', legacyAny / trials)).toBeGreaterThan(0.1);
  });
});
