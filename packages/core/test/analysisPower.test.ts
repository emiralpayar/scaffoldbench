import { describe, expect, it } from 'vitest';
import {
  estimateVarianceComponents,
  makeRng,
  minimumDetectableEffect,
  planPower,
  powerOfDesign,
  repeatsForPower,
  tasksForPower,
} from '@arena/core';
import type { RunRecord, VarianceComponents } from '@arena/core';

// Golden values were computed independently in Python (Simpson integration
// of the t density for the CDF, bisection for quantiles).

const components = (betweenTask: number, withinTask: number | null): VarianceComponents => ({
  tasks: 30,
  repeats: 2,
  betweenTask,
  withinTask,
  informativeTasks: 30,
});

describe('estimateVarianceComponents', () => {
  it('splits paired cell differences into within- and between-task variance', () => {
    // Task means 0.5, 1, 0. Within: SS 0.5 over 3 df = 1/6.
    // Between: Var(means) 0.25 minus within / 2 repeats = 1/6.
    const c = estimateVarianceComponents([
      [0, 1],
      [1, 1],
      [0, 0],
    ]);
    expect(c.tasks).toBe(3);
    expect(c.repeats).toBe(2);
    expect(c.withinTask).toBeCloseTo(1 / 6, 12);
    expect(c.betweenTask).toBeCloseTo(1 / 6, 12);
    expect(c.informativeTasks).toBe(2);
  });

  it('floors the between-task variance at zero and has no within estimate without repeats', () => {
    const noisy = estimateVarianceComponents([
      [1, -1],
      [-1, 1],
      [0.5, -0.5],
    ]);
    expect(noisy.betweenTask).toBe(0);
    const single = estimateVarianceComponents([[0.1], [0.3], [0.2]]);
    expect(single.withinTask).toBeNull();
    expect(single.betweenTask).toBeCloseTo(0.01, 12);
  });
});

describe('powerOfDesign', () => {
  it('matches the shifted-t approximation', () => {
    // Var per task 0.01 + 0.04/2 = 0.03; SE = sqrt(0.03/30); ncp = 1.581.
    const p = powerOfDesign(components(0.01, 0.04), { tasks: 30, repeats: 2, delta: 0.05, alpha: 0.05 });
    expect(p).toBeCloseTo(0.32357, 4);
  });

  it('is zero when the sign-flip guard could never reject', () => {
    // 2 / 2^5 = 0.0625 > 0.05: five tasks cannot produce a difference verdict.
    expect(powerOfDesign(components(0.0001, 0.0001), { tasks: 5, repeats: 10, delta: 1, alpha: 0.05 })).toBe(0);
    expect(powerOfDesign(components(0.0001, 0.0001), { tasks: 6, repeats: 10, delta: 1, alpha: 0.05 })).toBeGreaterThan(0.99);
  });

  it('is undefined without any variance to plan from', () => {
    expect(Number.isNaN(powerOfDesign(components(0, 0), { tasks: 30, repeats: 2, delta: 0.05, alpha: 0.05 }))).toBe(true);
  });
});

describe('planning', () => {
  it('finds the fewest repeats that reach the target power', () => {
    // Power for delta 0.08 at 30 tasks: r=3 -> 0.791, r=4 -> 0.850.
    expect(repeatsForPower(components(0.01, 0.04), { tasks: 30, delta: 0.08, alpha: 0.05, power: 0.8 })).toBe(4);
  });

  it('says when more repeats cannot help because tasks disagree', () => {
    // Between-task variance alone leaves power at 0.085 with 10 tasks.
    expect(repeatsForPower(components(0.05, 0.04), { tasks: 10, delta: 0.05, alpha: 0.05, power: 0.8 })).toBeNull();
  });

  it('finds the fewest tasks that reach the target power', () => {
    expect(tasksForPower(components(0.01, 0.04), { repeats: 2, delta: 0.1, alpha: 0.05, power: 0.8 })).toBe(26);
  });

  it('inverts power into a minimum detectable effect', () => {
    const c = components(0.01, 0.04);
    const mde = minimumDetectableEffect(c, { tasks: 30, repeats: 2, alpha: 0.05, power: 0.8 })!;
    expect(powerOfDesign(c, { tasks: 30, repeats: 2, delta: mde, alpha: 0.05 })).toBeCloseTo(0.8, 6);
    expect(minimumDetectableEffect(c, { tasks: 4, repeats: 2, alpha: 0.05, power: 0.8 })).toBeNull();
  });
});

describe('planPower', () => {
  function records(gap: (task: number, repeat: number) => number, costRatio = 1.3): RunRecord[] {
    const rng = makeRng(5);
    const out: RunRecord[] = [];
    for (const strategyId of ['single', 'plan-execute']) {
      for (let task = 0; task < 12; task++) {
        for (let repeat = 1; repeat <= 3; repeat++) {
          const base = 0.4 + 0.04 * task;
          const score = strategyId === 'single' ? base : base + gap(task, repeat);
          const cost = (0.05 + 0.005 * task) * (strategyId === 'single' ? 1 : costRatio * (1 + (rng() - 0.5) * 0.2));
          out.push({
            runId: `${strategyId}-${task}-${repeat}`,
            runSetId: 'set',
            taskId: `task-${String(task).padStart(2, '0')}`,
            taskTitle: '',
            taskCategory: 'tool-use',
            taskWorld: 'w',
            taskDifficulty: 'easy',
            strategyId,
            model: 'claude-sonnet-5-5',
            effort: 'high',
            repeat,
            startedAt: '',
            finishedAt: '',
            latencyMs: 1_000,
            score,
            passed: score >= 0.999,
            breakdown: [],
            penalties: [],
            failureMode: 'none',
            scoreMetadata: {},
            costUsd: cost,
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
    return out;
  }

  it('plans from the observed strategy-vs-baseline variance', () => {
    const rng = makeRng(9);
    const noisy = records(() => (rng() - 0.5) * 0.2);
    const [plan] = planPower(noisy, { metric: 'score', delta: 0.05 });
    expect(plan?.model).toBe('claude-sonnet-5-5');
    expect(plan?.contrasts.map((c) => c.strategyId)).toEqual(['plan-execute']);
    expect(plan?.pooled.tasks).toBe(12);
    expect(plan?.pooled.repeats).toBeCloseTo(3, 12);
    expect(plan?.currentPower).toBeGreaterThan(0);
    expect(plan?.currentPower).toBeLessThan(1);
    expect(plan?.minimumDetectableEffect).toBeGreaterThan(0);
    expect(plan?.warning).toBeUndefined();
    // Holm worst case: a family of 5 tests at 0.05 plans at 0.01 per test.
    const [strict] = planPower(noisy, { metric: 'score', delta: 0.05, familySize: 5 });
    expect(strict?.alphaPerTest).toBeCloseTo(0.01, 12);
    expect(strict!.minimumDetectableEffect!).toBeGreaterThan(plan!.minimumDetectableEffect!);
  });

  it('works on the ratio scale for cost', () => {
    const [plan] = planPower(records(() => 0), { metric: 'cost', delta: 1.2 });
    expect(plan?.delta).toBe(1.2);
    expect(plan?.minimumDetectableEffect).toBeGreaterThan(1);
    expect(plan?.minimumDetectableEffect).toBeLessThan(1.5);
  });

  it('refuses to plan from a run set with no variation at all', () => {
    const [plan] = planPower(records(() => 0), { metric: 'score', delta: 0.05 });
    expect(plan?.warning).toBe('no-variation');
    expect(plan?.repeatsNeeded).toBeNull();
    expect(plan?.currentPower).toBeNull();
  });

  it('warns when almost every task tied', () => {
    const [plan] = planPower(records((task, repeat) => (task === 0 && repeat === 1 ? 0.1 : 0)), {
      metric: 'score',
      delta: 0.05,
    });
    expect(plan?.pooled.informativeTasks).toBe(1);
    expect(plan?.warning).toBe('saturated');
  });

  it('skips models without the baseline', () => {
    const others = records(() => 0.01).map((r) => ({ ...r, strategyId: r.strategyId === 'single' ? 'other' : r.strategyId }));
    expect(planPower(others, { metric: 'score', delta: 0.05 })).toEqual([]);
  });
});
