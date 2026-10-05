import { describe, expect, it } from 'vitest';

import { analyzeRunSet } from '@arena/core';

import { analyzeForSite, describeMethod, summarizeHealth } from '../lib/analysis';
import { isRankable } from '../lib/records';
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

/** Deterministic noise in [-0.02, 0.02], different for each salt, so no two tasks move alike. */
const jitter = (t: number, r: number, salt = 0) => (((t * 7 + r * 3 + salt * 2) % 5) - 2) * 0.01;

describe('analyzeForSite', () => {
  it('finds a consistent paired improvement that marginal intervals would hide', () => {
    // Task difficulty varies wildly (0.1 … 0.9), so each architecture's own
    // interval is wide. The candidate is about 0.08 better on every task and
    // repeat, which only a paired comparison can see.
    const base = (t: number) => 0.05 + t * 0.09;
    const records = grid(
      [
        { strategyId: 'single', cost: 0.1, score: (t, r) => base(t) + jitter(t, r) },
        { strategyId: 'plan-execute', cost: 0.2, score: (t, r) => base(t) + 0.08 + jitter(t, r, 1) },
      ],
      10,
    );

    const analysis = analyzeForSite(records);
    const model = analysis.models[0];
    const single = model?.architectures.find((a) => a.strategyId === 'single');
    const plan = model?.architectures.find((a) => a.strategyId === 'plan-execute');
    const contrast = model?.contrasts.find((c) => c.strategyId === 'plan-execute');

    // Marginally the intervals overlap…
    expect(single?.score.ci && plan?.score.ci && plan.score.ci.low < single.score.ci.high).toBe(true);
    // …but the paired difference is decisive, with a real interval.
    expect(contrast?.scoreDelta.mean).toBeCloseTo(0.08, 1);
    expect(contrast?.scoreDelta.ci?.low).toBeGreaterThan(0);
    expect(contrast?.verdict).toBe('better');
    expect(contrast?.caveat).toBeUndefined();
    expect(contrast?.costRatio.mean).toBeCloseTo(2, 9);
    expect(contrast?.costVerdict).toBe('worse');
    expect(contrast?.pairs).toBe(30);
    expect(contrast?.tasks).toBe(10);
  });

  it('gives no interval, and says why, where every task moved by the same amount', () => {
    // Exactly 0.08 better on every task and repeat: there is no spread to resample.
    const base = (t: number) => 0.1 + t * 0.16;
    const records = grid([
      { strategyId: 'single', cost: 0.1, score: (t) => base(t) },
      { strategyId: 'plan-execute', cost: 0.2, score: (t) => base(t) + 0.08 },
    ]);
    const contrast = analyzeForSite(records).models[0]?.contrasts[0];

    expect(contrast?.scoreDelta.mean).toBeCloseTo(0.08, 9);
    // Never a zero-width interval standing in for one.
    expect(contrast?.scoreDelta.ci).toBeNull();
    expect(contrast?.caveat).toBe('no-variation');
    // Cost doubled on every cell: the same shape, and still the exact mean.
    expect(contrast?.costRatio.mean).toBeCloseTo(2, 9);
    expect(contrast?.costRatio.ci).toBeNull();
  });

  it('withholds every verdict from a contrast with too few tasks', () => {
    const records = grid(
      [
        { strategyId: 'single', cost: 0.1, score: (t, r) => 0.2 + t * 0.1 + jitter(t, r) },
        { strategyId: 'plan-execute', cost: 0.2, score: (t, r) => 0.7 + t * 0.1 + jitter(t, r, 1) },
      ],
      3,
    );
    const contrast = analyzeForSite(records).models[0]?.contrasts[0];
    expect(contrast?.caveat).toBe('too-few-tasks');
    expect(contrast?.verdict).toBe('inconclusive');
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
    expect(contrast?.scoreDelta.ci?.low).toBeLessThan(-0.15);
    expect(contrast?.scoreDelta.ci?.high).toBeGreaterThan(0.15);
    expect(contrast?.verdict).toBe('inconclusive');
  });

  it('adds nothing of its own to core: the contrasts are core\'s, number for number', () => {
    const records = grid(
      [
        { strategyId: 'single', cost: 0.1, score: (t, r) => 0.3 + t * 0.06 + jitter(t, r) },
        { strategyId: 'plan-execute', cost: 0.15, score: (t, r) => 0.4 + t * 0.06 + jitter(t, r, 1) },
        { strategyId: 'gated-execute', cost: 0.12, score: (t, r) => 0.3 + t * 0.06 + jitter(t, r, 2) },
      ],
      12,
    );
    const site = analyzeForSite(records);
    const core = analyzeRunSet(records);
    const coreModel = core.models[0];
    const model = site.models[0];

    for (const c of model?.contrasts ?? []) {
      const score = coreModel?.vsBaseline.find((x) => x.metric === 'score' && x.a.strategyId === c.strategyId);
      const cost = coreModel?.vsBaseline.find((x) => x.metric === 'cost' && x.a.strategyId === c.strategyId);
      expect(c.scoreDelta).toEqual({ mean: score?.estimate, ci: score?.ci });
      expect(c.verdict).toBe(score?.verdict);
      expect(c.pAdjusted).toBe(score?.pAdjusted);
      expect(c.costRatio).toEqual({ mean: cost?.estimate, ci: cost?.ci });
      expect(c.costVerdict).toBe(cost?.verdict);
    }
    for (const a of model?.architectures ?? []) {
      const s = coreModel?.strategies.find((x) => x.strategyId === a.strategyId);
      expect(a.score).toEqual({ mean: s?.score.value, ci: s?.score.ci });
      expect(a.passRate).toEqual({ mean: s?.passRate.value, ci: s?.passRate.ci });
      expect(a.runs).toBe(s?.runs);
    }
    expect(site.settings).toEqual(core.settings);
    expect(site.confidence).toBeCloseTo(0.95, 12);
    expect(site.margin).toBe(core.settings.margins.score);
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
    // The site's count and core's agree on what was left out.
    expect(analyzeRunSet(poisoned).health).toMatchObject({ included: 34, excluded: 2 });
    expect(poisoned.filter(isRankable)).toHaveLength(34);
  });

  it('keeps models apart and contrasts each architecture with single on the next model up', () => {
    const records = grid(
      [
        { strategyId: 'single', model: 'claude-haiku-4-5-20251001', cost: 0.02, score: (t, r) => 0.5 + t * 0.03 + jitter(t, r) },
        { strategyId: 'plan-execute-verify', model: 'claude-haiku-4-5-20251001', cost: 0.05, score: (t, r) => 0.8 + t * 0.02 + jitter(t, r, 1) },
        { strategyId: 'single', model: 'claude-sonnet-5-5', cost: 0.1, score: (t, r) => 0.7 + t * 0.02 + jitter(t, r, 2) },
      ],
      10,
    );

    const analysis = analyzeForSite(records);
    expect(analysis.models.map((m) => m.model)).toEqual([
      'claude-haiku-4-5-20251001',
      'claude-sonnet-5-5',
    ]);

    const scaffold = analysis.scale.find((s) => s.strategyId === 'plan-execute-verify');
    expect(scaffold?.nextModel).toBe('claude-sonnet-5-5');
    expect(scaffold?.scoreDelta.mean).toBeGreaterThan(0.05);
    expect(scaffold?.costRatio.mean).toBeCloseTo(0.5, 9);
    // The ratio is the same on every cell, so there is no interval; the verdict still stands.
    expect(scaffold?.costRatio.ci).toBeNull();
    expect(scaffold?.verdict).toBe('better');
    expect(scaffold?.costVerdict).toBe('better');

    const scale = analysis.scale.find((s) => s.strategyId === 'single');
    expect(scale?.scoreDelta.mean).toBeLessThan(-0.1);
    expect(scale?.verdict).toBe('worse');
  });

  it('is deterministic', () => {
    const records = grid([
      { strategyId: 'single', cost: 0.1, score: (t, r) => ((t * 7 + r * 3) % 10) / 10 },
      { strategyId: 'gated-execute', cost: 0.2, score: (t, r) => ((t * 5 + r) % 10) / 10 },
    ]);
    expect(analyzeForSite(records)).toEqual(analyzeForSite([...records].reverse()));
  });

  it('lists a model whose every run was excluded nowhere, and counts its runs in health', () => {
    const records = [
      ...grid([{ strategyId: 'single', cost: 0.1, score: () => 1 }]),
      run({ runId: 'opus', model: 'claude-opus-5-5', integrity: { ok: false, checks: [{ id: 'x', ok: false }] } }),
    ];
    const analysis = analyzeForSite(records);
    expect(analysis.models.map((m) => m.model)).toEqual(['claude-sonnet-5-5']);
    expect(analysis.health.integrityFailed).toBe(1);
  });

  it('describes core\'s method, with this run\'s settings, and no other', () => {
    const method = analyzeForSite([]).method;
    expect(method).toMatch(/whole tasks are resampled/);
    expect(method).toMatch(/cluster bootstrap of 10,000 replicates/);
    expect(method).toMatch(/Holm-adjusted within its family/);
    expect(method).toMatch(/two one-sided tests/);
    expect(method).toMatch(/±0\.05 of score \(×\/÷1\.1 for cost and latency\)/);
    expect(method).toMatch(/fewer than 5 tasks no verdict is drawn/);
    expect(method).not.toMatch(/Bonferroni|2,000/);

    const custom = describeMethod({ ...analyzeRunSet([]).settings, iterations: 500, alpha: 0.1, minTasks: 8 });
    expect(custom).toMatch(/500 replicates/);
    expect(custom).toMatch(/90% intervals/);
    expect(custom).toMatch(/any false call in a family at 10%/);
    expect(custom).toMatch(/fewer than 8 tasks/);
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
    const records = grid(
      [
        { strategyId: 'single', cost: 0.1, score: (t, r) => 0.5 + ((t * 7 + r) % 3) * 0.01 },
        { strategyId: 'plan-execute', cost: 0.2, score: (t, r) => 0.8 + ((t * 5 + r) % 3) * 0.01 },
        { strategyId: 'gated-execute', cost: 0.2, score: (t, r) => (t % 2 === 0 ? 0.95 : 0.35) + r * 0.001 },
      ],
      12,
    );
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

  it('reads each pair in the site\'s architecture order, flipping core\'s orientation and interval', () => {
    // Core lists the stronger arm first; the site lists `single` first.
    const records = grid(
      [
        { strategyId: 'single', cost: 0.1, score: (t, r) => 0.3 + t * 0.04 + jitter(t, r) },
        { strategyId: 'plan-execute', cost: 0.2, score: (t, r) => 0.6 + t * 0.04 + jitter(t, r, 1) },
      ],
      12,
    );
    const [model] = analyzeForSite(records).models;
    const [pair] = model?.pairwise ?? [];
    const core = analyzeRunSet(records).models[0]?.pairwise.find((c) => c.metric === 'score');

    expect(core?.a.strategyId).toBe('plan-execute');
    expect(pair).toMatchObject({ a: 'single', b: 'plan-execute', verdict: 'worse', winner: 'b' });
    expect(pair?.scoreDelta.mean).toBeCloseTo(-(core?.estimate ?? 0), 12);
    expect(pair?.scoreDelta.ci?.low).toBeCloseTo(-(core?.ci?.high ?? 0), 12);
    expect(pair?.scoreDelta.ci?.high).toBeCloseTo(-(core?.ci?.low ?? 0), 12);
    expect(model?.ranks.map((entry) => [entry.strategyId, entry.rank])).toEqual([
      ['plan-execute', 1],
      ['single', 2],
    ]);
  });

  it('takes the frontier from core: an arm is dropped only when another is shown to beat it', () => {
    const records = grid(
      [
        { strategyId: 'single', cost: 0.04, score: (t, r) => 0.6 + jitter(t, r) },
        // A hair lower and a hair dearer than single on means, but nothing separates the two.
        { strategyId: 'plan-execute', cost: 0.04, score: (t, r) => 0.598 + jitter(t, r, 1) },
        // Clearly worse and clearly dearer.
        { strategyId: 'gated-execute', cost: 0.2, score: (t, r) => 0.3 + jitter(t, r, 2) },
      ],
      20,
    ).map((record) =>
      record.strategyId === 'plan-execute'
        ? { ...record, costUsd: record.costUsd * (1.005 + jitter(Number(record.taskId.slice(1)), 1, 1) * 3) }
        : record,
    );
    const [model] = analyzeForSite(records).models;
    expect(model?.frontier).toEqual(expect.arrayContaining(['single', 'plan-execute']));
    expect(model?.frontier).not.toContain('gated-execute');
    expect(model?.frontierTied).toEqual(['plan-execute']);
    // On means alone plan-execute trails single (lower score, dearer), so it is off.
    expect(model?.meanFrontier).toEqual(['single']);
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
