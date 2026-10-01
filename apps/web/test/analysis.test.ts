import { describe, expect, it } from 'vitest';

import { analyzeForSite, pairRuns, summarizeHealth, verdictFor, wilson } from '../lib/analysis';
import type { RunRecord } from '../lib/records';
import { run } from './fixtures';

/** One run per (strategy, task, repeat), with a score function and a cost. */
function grid(
  spec: { strategyId: string; model?: string; cost: number; score: (task: number, repeat: number) => number }[],
  tasks = 6,
  repeats = 3,
): RunRecord[] {
  const records: RunRecord[] = [];
  for (const s of spec) {
    for (let t = 0; t < tasks; t++) {
      for (let r = 1; r <= repeats; r++) {
        const score = s.score(t, r);
        records.push(
          run({
            runId: `${s.strategyId}__t${t}__${s.model ?? 'm'}__r${r}`,
            strategyId: s.strategyId,
            model: s.model ?? 'claude-sonnet-5-5',
            taskId: `t${t}`,
            repeat: r,
            score,
            passed: score >= 0.999,
            costUsd: s.cost,
            integrity: { ok: true, checks: [] },
          }),
        );
      }
    }
  }
  return records;
}

describe('verdictFor', () => {
  it('calls a tight interval inside the margin equivalent, even when it excludes zero', () => {
    expect(verdictFor({ mean: 0.01, low: 0.005, high: 0.02 }, 0.05)).toBe('equivalent');
  });

  it('separates better, worse and inconclusive by where the interval sits', () => {
    expect(verdictFor({ mean: 0.2, low: 0.1, high: 0.3 }, 0.05)).toBe('better');
    expect(verdictFor({ mean: -0.2, low: -0.3, high: -0.1 }, 0.05)).toBe('worse');
    expect(verdictFor({ mean: 0.05, low: -0.1, high: 0.2 }, 0.05)).toBe('inconclusive');
  });
});

describe('wilson', () => {
  it('never returns the degenerate [1, 1] a percentile bootstrap gives for 18/18', () => {
    const interval = wilson(18, 18);
    expect(interval.mean).toBe(1);
    expect(interval.high).toBe(1);
    // Clopper–Pearson gives 0.815 here; Wilson is a little tighter but far from 1.
    expect(interval.low).toBeGreaterThan(0.8);
    expect(interval.low).toBeLessThan(0.86);
  });

  it('is empty for no trials', () => {
    expect(wilson(0, 0)).toEqual({ mean: 0, low: 0, high: 0 });
  });
});

describe('pairRuns', () => {
  it('matches by task and repeat and leaves unmatched runs out', () => {
    const candidate = [
      run({ taskId: 'a', repeat: 1, score: 1 }),
      run({ taskId: 'a', repeat: 2, score: 0 }),
      run({ taskId: 'b', repeat: 1, score: 1 }),
    ];
    const baseline = [run({ taskId: 'a', repeat: 1, score: 0.5 }), run({ taskId: 'b', repeat: 3 })];

    const paired = pairRuns(candidate, baseline);
    expect(paired.pairs).toBe(1);
    expect(paired.tasks.map((t) => t.taskId)).toEqual(['a']);
    expect(paired.tasks[0]?.score).toEqual([[1, 0.5]]);
  });
});

describe('analyzeForSite', () => {
  it('finds a consistent paired improvement that marginal intervals would hide', () => {
    // Task difficulty varies wildly (0.1 … 0.9), so each architecture's own
    // interval is wide. The candidate is exactly 0.08 better on every task and
    // repeat, which only a paired comparison can see.
    const base = (t: number) => 0.1 + t * 0.16;
    const records = grid([
      { strategyId: 'single', cost: 0.1, score: (t) => base(t) },
      { strategyId: 'plan-execute', cost: 0.2, score: (t) => base(t) + 0.08 },
    ]);

    const analysis = analyzeForSite(records);
    const model = analysis.models[0];
    const single = model?.architectures.find((a) => a.strategyId === 'single');
    const plan = model?.architectures.find((a) => a.strategyId === 'plan-execute');
    const contrast = model?.contrasts.find((c) => c.strategyId === 'plan-execute');

    // Marginally the intervals overlap…
    expect(single && plan && plan.score.low < single.score.high).toBe(true);
    // …but the paired difference is exact and decisive.
    expect(contrast?.scoreDelta.mean).toBeCloseTo(0.08, 9);
    expect(contrast?.scoreDelta.low).toBeCloseTo(0.08, 9);
    expect(contrast?.verdict).toBe('better');
    expect(contrast?.costRatio.mean).toBeCloseTo(2, 9);
    expect(contrast?.pairs).toBe(18);
    expect(contrast?.tasks).toBe(6);
  });

  it('bootstraps over tasks, so a task-level effect yields a wide interval', () => {
    // Half the tasks gain 0.4, half lose 0.4: the mean difference is zero and
    // the interval must straddle it widely, not collapse because n=18 runs.
    const records = grid([
      { strategyId: 'single', cost: 0.1, score: () => 0.5 },
      { strategyId: 'plan-execute', cost: 0.1, score: (t) => (t % 2 === 0 ? 0.9 : 0.1) },
    ]);
    const contrast = analyzeForSite(records).models[0]?.contrasts[0];

    expect(contrast?.scoreDelta.mean).toBeCloseTo(0, 9);
    expect(contrast?.scoreDelta.low).toBeLessThan(-0.15);
    expect(contrast?.scoreDelta.high).toBeGreaterThan(0.15);
    expect(contrast?.verdict).toBe('inconclusive');
  });

  it('excludes integrity failures and API errors from every number and counts them', () => {
    const records = grid([
      { strategyId: 'single', cost: 0.1, score: () => 0.5 },
      { strategyId: 'plan-execute', cost: 0.1, score: () => 0.5 },
    ]);
    // Poison two plan-execute runs; they must not move the estimate.
    const poisoned = records.map((record) =>
      record.strategyId !== 'plan-execute' || record.taskId !== 't0'
        ? record
        : record.repeat === 1
          ? { ...record, score: 0, integrity: { ok: false, checks: [{ id: 'plan-non-empty', ok: false }] } }
          : record.repeat === 2
            ? { ...record, score: 0, failureMode: 'api_error' as const }
            : record,
    );

    const analysis = analyzeForSite(poisoned);
    const plan = analysis.models[0]?.architectures.find((a) => a.strategyId === 'plan-execute');

    expect(plan?.runs).toBe(16);
    expect(plan?.score.mean).toBeCloseTo(0.5, 9);
    expect(analysis.health.integrityFailed).toBe(1);
    expect(analysis.health.apiErrors).toBe(1);
    expect(analysis.health.rankable).toBe(34);
    expect(analysis.health.failedChecks).toEqual([{ id: 'plan-non-empty', count: 1 }]);
  });

  it('keeps models apart and contrasts each architecture with single on the next model up', () => {
    const records = grid([
      { strategyId: 'single', model: 'claude-haiku-4-5-20251001', cost: 0.02, score: () => 0.5 },
      { strategyId: 'plan-execute-verify', model: 'claude-haiku-4-5-20251001', cost: 0.05, score: () => 0.8 },
      { strategyId: 'single', model: 'claude-sonnet-5-5', cost: 0.1, score: () => 0.7 },
    ]);

    const analysis = analyzeForSite(records);
    expect(analysis.models.map((m) => m.model)).toEqual([
      'claude-haiku-4-5-20251001',
      'claude-sonnet-5-5',
    ]);

    const scaffold = analysis.scale.find((s) => s.strategyId === 'plan-execute-verify');
    expect(scaffold?.nextModel).toBe('claude-sonnet-5-5');
    expect(scaffold?.scoreDelta.mean).toBeCloseTo(0.1, 9);
    expect(scaffold?.costRatio.mean).toBeCloseTo(0.5, 9);
    expect(scaffold?.verdict).toBe('better');

    const scale = analysis.scale.find((s) => s.strategyId === 'single');
    expect(scale?.scoreDelta.mean).toBeCloseTo(-0.2, 9);
  });

  it('is deterministic', () => {
    const records = grid([
      { strategyId: 'single', cost: 0.1, score: (t, r) => ((t * 7 + r * 3) % 10) / 10 },
      { strategyId: 'gated-execute', cost: 0.2, score: (t, r) => ((t * 5 + r) % 10) / 10 },
    ]);
    expect(analyzeForSite(records)).toEqual(analyzeForSite([...records].reverse()));
  });

  it('describes its own method, including what it does not adjust for', () => {
    expect(analyzeForSite([]).method).toMatch(/resamples tasks/);
    expect(analyzeForSite([]).method).toMatch(/adjusted for the comparisons it makes at once \(Bonferroni\)/);
  });
});

describe('summarizeHealth', () => {
  it('counts records that predate the fidelity gate', () => {
    const health = summarizeHealth([run({}), run({ integrity: { ok: true, checks: [] } })]);
    expect(health.withoutIntegrity).toBe(1);
    expect(health.rankable).toBe(2);
  });
});

describe('ranks', () => {
  it('shares a rank between architectures the data cannot separate', () => {
    // plan-execute is clearly above single on every task; gated-execute sits
    // between them, within noise of both.
    const records = grid([
      { strategyId: 'single', cost: 0.1, score: (t, r) => 0.5 + ((t * 7 + r) % 3) * 0.01 },
      { strategyId: 'plan-execute', cost: 0.2, score: (t, r) => 0.8 + ((t * 5 + r) % 3) * 0.01 },
      { strategyId: 'gated-execute', cost: 0.2, score: (t, r) => (t % 2 === 0 ? 0.95 : 0.35) + r * 0.001 },
    ]);
    const [model] = analyzeForSite(records).models;
    const rank = (id: string) => model?.ranks.find((entry) => entry.strategyId === id);

    expect(rank('plan-execute')).toMatchObject({ rank: 1, tied: true, above: ['single'], below: [] });
    expect(rank('gated-execute')).toMatchObject({ rank: 1, tied: true, above: [], below: [] });
    expect(rank('single')).toMatchObject({ rank: 2, tied: false, below: ['plan-execute'] });
    // Within a shared rank, the higher mean is listed first.
    expect(model?.ranks.map((entry) => entry.strategyId)).toEqual(['plan-execute', 'gated-execute', 'single']);
  });

  it('compares every pair once, on matched tasks and repeats', () => {
    const records = grid(
      ['single', 'plan-execute', 'propose-select'].map((strategyId) => ({ strategyId, cost: 0.1, score: () => 1 })),
    );
    const [model] = analyzeForSite(records).models;
    expect(model?.pairwise.map((pair) => `${pair.a}/${pair.b}`)).toEqual([
      'single/plan-execute',
      'single/propose-select',
      'plan-execute/propose-select',
    ]);
    expect(model?.pairwise.every((pair) => pair.winner === 'tie' && pair.pairs === 18)).toBe(true);
    expect(model?.ranks.every((entry) => entry.rank === 1 && entry.tied)).toBe(true);
  });

  it('counts health per model as well as for the whole set', () => {
    const records = [
      ...grid([{ strategyId: 'single', cost: 0.1, score: () => 1 }]),
      run({ runId: 'lost', model: 'claude-sonnet-5-5', failureMode: 'api_error' }),
      run({ runId: 'opus', model: 'claude-opus-5-5', integrity: { ok: false, checks: [{ id: 'x', ok: false }] } }),
    ];
    const analysis = analyzeForSite(records);
    const sonnet = analysis.models.find((m) => m.model === 'claude-sonnet-5-5');
    expect(sonnet?.health).toMatchObject({ total: 19, rankable: 18, apiErrors: 1, integrityFailed: 0 });
    expect(analysis.health).toMatchObject({ total: 20, apiErrors: 1, integrityFailed: 1 });
  });
});
