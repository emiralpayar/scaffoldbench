import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { analyzeRunSet, comparisonVerdict, summarizeRuns } from '@arena/core';
import type { Contrast, RunRecord } from '@arena/core';

/**
 * The first published run set, re-analyzed. Its architectures were degraded
 * by harness bugs, so these numbers are evidence about the statistics, not
 * about the architectures: they pin what docs/STATISTICS.md says the paired
 * analysis finds in it, and what the overlap rule missed.
 */
const RUN_SET = '2026-07-25T20-18-35Z-3fs5';
const runsDir = fileURLToPath(new URL(`../../../results/${RUN_SET}/runs/`, import.meta.url));
const records: RunRecord[] = readdirSync(runsDir)
  .filter((file) => file.endsWith('.json'))
  .sort()
  .map((file) => JSON.parse(readFileSync(`${runsDir}${file}`, 'utf8')) as RunRecord);

const SCAFFOLDS = ['plan-execute', 'orchestrator-workers', 'plan-execute-verify', 'debate-select'];

const analysis = analyzeRunSet(records);
const model = analysis.models[0]!;

function vsSingle(metric: string, strategyId: string): Contrast {
  const found = model.vsBaseline.find((c) => c.metric === metric && c.a.strategyId === strategyId);
  if (!found) throw new Error(`no ${metric} contrast for ${strategyId}`);
  return found;
}

describe(`published run set ${RUN_SET}`, () => {
  it('is one model, 9 tasks x 2 repeats, 5 strategies, with no integrity records', () => {
    expect(records).toHaveLength(90);
    expect(analysis.models.map((m) => m.model)).toEqual(['claude-sonnet-5']);
    expect(model.tasks).toBe(9);
    expect(model.repeats).toBe(2);
    expect(model.strategies).toHaveLength(5);
    expect(analysis.health.excluded).toBe(0);
    expect(analysis.health.integrity.unchecked).toBe(90);
  });

  it('has most of its cost and latency variance between tasks, not between repeats', () => {
    // One-way ICC(1) by task: (MSB − MSW) / (MSB + (k − 1)·MSW), k repeats per task.
    const icc = (values: (r: RunRecord) => number, strategyId: string) => {
      const byTask = new Map<string, number[]>();
      for (const r of records.filter((x) => x.strategyId === strategyId)) {
        byTask.set(r.taskId, [...(byTask.get(r.taskId) ?? []), values(r)]);
      }
      const groups = [...byTask.values()];
      const k = groups[0]!.length;
      const means = groups.map((g) => g.reduce((a, v) => a + v, 0) / k);
      const grand = means.reduce((a, v) => a + v, 0) / groups.length;
      const msb = (k * means.reduce((a, v) => a + (v - grand) ** 2, 0)) / (groups.length - 1);
      const msw =
        groups.reduce((a, g, i) => a + g.reduce((b, v) => b + (v - means[i]!) ** 2, 0), 0) / (groups.length * (k - 1));
      return (msb - msw) / (msb + (k - 1) * msw);
    };
    const strategies = [...SCAFFOLDS, 'single'];
    const cost = strategies.map((s) => icc((r) => r.costUsd, s));
    const latency = strategies.map((s) => icc((r) => r.latencyMs, s));
    expect(Math.min(...cost)).toBeCloseTo(0.83, 2);
    expect(Math.max(...cost)).toBeCloseTo(0.97, 2);
    expect(Math.min(...latency)).toBeCloseTo(0.9, 2);
    expect(Math.max(...latency)).toBeCloseTo(0.96, 2);
  });

  it('finds every scaffold costlier and slower than single in every paired cell', () => {
    const single = new Map(
      records.filter((r) => r.strategyId === 'single').map((r) => [`${r.taskId}#${r.repeat}`, r]),
    );
    for (const strategyId of SCAFFOLDS) {
      const runs = records.filter((r) => r.strategyId === strategyId);
      expect(runs).toHaveLength(18);
      for (const r of runs) {
        const base = single.get(`${r.taskId}#${r.repeat}`)!;
        expect(r.costUsd).toBeGreaterThan(base.costUsd);
        expect(r.latencyMs).toBeGreaterThan(base.latencyMs);
      }
    }
  });

  it('calls every scaffold worse than single on cost and latency, after Holm', () => {
    const expected: Record<string, [number, number, number]> = {
      'plan-execute': [1.44, 1.33, 1.58],
      'orchestrator-workers': [1.85, 1.66, 2.04],
      'plan-execute-verify': [2.11, 1.89, 2.33],
      'debate-select': [3.94, 3.23, 4.72],
    };
    for (const strategyId of SCAFFOLDS) {
      const cost = vsSingle('cost', strategyId);
      const [estimate, low, high] = expected[strategyId]!;
      expect(cost.estimate).toBeCloseTo(estimate, 2);
      expect(cost.ci!.low).toBeCloseTo(low, 2);
      expect(cost.ci!.high).toBeCloseTo(high, 2);
      expect(cost.cells).toBe(18);
      // Nine tasks all moving one way: the exact sign-flip p is 2/2^9, and
      // Holm over the four baseline contrasts multiplies it by four.
      expect(cost.pValue).toBe(2 / 2 ** 9);
      expect(cost.pAdjusted).toBe(4 * (2 / 2 ** 9));
      expect(cost.verdict).toBe('worse');
      expect(vsSingle('latency', strategyId).verdict).toBe('worse');
    }
  });

  it('can say nothing about score or pass rate: one task of nine differed at all', () => {
    for (const c of model.pairwise.concat(model.vsBaseline)) {
      if (c.metric !== 'score' && c.metric !== 'pass') continue;
      expect(c.verdict).toBe('inconclusive');
      expect(['no-variation', 'few-informative-tasks']).toContain(c.caveat);
    }
    // single lost the restock assertion once (score 0.818) where debate-select
    // scored 1: one cell of 18, averaged within its task and then over 9 tasks.
    const lost = records.find((r) => r.strategyId === 'single' && !r.passed)!;
    const debate = vsSingle('score', 'debate-select');
    expect(debate.estimate).toBeCloseTo((1 - lost.score) / 2 / 9, 12);
    expect(debate.ci!.low).toBe(0);
    expect(debate.ci!.high).toBeCloseTo(0.04, 2);
  });

  it('gives the 18/18 arm a Wilson interval instead of [1, 1]', () => {
    const debate = model.strategies.find((s) => s.strategyId === 'debate-select')!;
    expect(debate.passRate.value).toBe(1);
    // Nine tasks, so Wilson(9, 9); the 18 runs alone would claim [0.824, 1].
    expect(debate.passRate.ci!.low).toBeCloseTo(0.701, 3);
    expect(debate.score.ciMethod).toBe('wilson');
    expect(summarizeRuns(records).strategies.find((s) => s.strategyId === 'debate-select')!.score.ciLow).toBe(1);
  });

  it('keeps every arm on the frontier: only cost separates them', () => {
    const status = Object.fromEntries(model.frontier.map((f) => [f.arm.strategyId, f.status]));
    expect(status).toEqual({
      'debate-select': 'frontier',
      single: 'frontier',
      'plan-execute': 'tied',
      'plan-execute-verify': 'tied',
      'orchestrator-workers': 'tied',
    });
    expect(summarizeRuns(records).paretoStrategyIds.sort()).toEqual(['debate-select', 'single']);
  });

  it('shows what the overlap rule missed: the cheapest scaffold is not separable from single', () => {
    const legacy = summarizeRuns(records);
    const pick = (id: string) => legacy.strategies.find((s) => s.strategyId === id)!;
    expect(legacy.pairwise.every((p) => p.verdict === 'inconclusive')).toBe(true);
    expect(comparisonVerdict(pick('plan-execute').costUsd, pick('single').costUsd)).toBe('inconclusive');
    expect(comparisonVerdict(pick('plan-execute').latencyMs, pick('single').latencyMs)).toBe('inconclusive');
    expect(vsSingle('cost', 'plan-execute').verdict).toBe('worse');

    // Over all ten pairs: overlap separates 6 on cost and 5 on latency; paired + Holm 9 of each.
    for (const [metric, overlapSeparates] of [['cost', 6], ['latency', 5]] as const) {
      let overlap = 0;
      for (const p of model.pairwise.filter((c) => c.metric === metric)) {
        const a = pick(p.a.strategyId);
        const b = pick(p.b.strategyId);
        const verdict =
          metric === 'cost' ? comparisonVerdict(a.costUsd, b.costUsd) : comparisonVerdict(a.latencyMs, b.latencyMs);
        if (verdict !== 'inconclusive') overlap += 1;
      }
      const paired = model.pairwise.filter((c) => c.metric === metric && (c.verdict === 'better' || c.verdict === 'worse'));
      expect(overlap).toBe(overlapSeparates);
      expect(paired).toHaveLength(9);
    }
  });
});
