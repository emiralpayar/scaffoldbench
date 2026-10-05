import { describe, expect, it } from 'vitest';
import { summarizeRuns } from '@scaffoldbench/core';
import type { FailureMode, RunRecord, TaskCategory } from '@scaffoldbench/core';

let counter = 0;

function run(overrides: Partial<RunRecord> = {}): RunRecord {
  counter += 1;
  return {
    runId: `run-${counter}`,
    runSetId: 'set-1',
    taskId: 'airline-easy',
    taskTitle: 'Airline easy',
    taskCategory: 'tool-use' as TaskCategory,
    taskWorld: 'airline',
    taskDifficulty: 'easy',
    strategyId: 'single',
    model: 'claude-opus-5',
    effort: 'high',
    repeat: 1,
    startedAt: '2026-07-25T00:00:00.000Z',
    finishedAt: '2026-07-25T00:00:10.000Z',
    latencyMs: 10_000,
    score: 1,
    passed: true,
    breakdown: [],
    penalties: [],
    failureMode: 'none' as FailureMode,
    scoreMetadata: {},
    costUsd: 0.1,
    judgeCostUsd: 0,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    },
    turns: 3,
    toolCalls: 4,
    deniedToolCalls: 0,
    subagentCount: 0,
    phases: [],
    finalText: '',
    ...overrides,
  };
}

describe('summarizeRuns', () => {
  it('handles an empty result set', () => {
    const summary = summarizeRuns([]);
    expect(summary.strategies).toEqual([]);
    expect(summary.cells).toEqual([]);
    expect(summary.pairwise).toEqual([]);
    expect(summary.totals.runs).toBe(0);
  });

  it('groups by strategy and sorts by mean score', () => {
    const summary = summarizeRuns([
      run({ strategyId: 'single', score: 0.2 }),
      run({ strategyId: 'single', score: 0.4 }),
      run({ strategyId: 'orchestrator-workers', score: 0.9 }),
      run({ strategyId: 'orchestrator-workers', score: 0.95 }),
    ]);

    expect(summary.strategies.map((s) => s.strategyId)).toEqual([
      'orchestrator-workers',
      'single',
    ]);
    expect(summary.strategies[0]?.score.mean).toBeCloseTo(0.925);
    expect(summary.strategies[1]?.runs).toBe(2);
  });

  it('computes pass rate from the passed flag, not the score', () => {
    const summary = summarizeRuns([
      run({ score: 1, passed: true }),
      run({ score: 0.99, passed: false }),
      run({ score: 0, passed: false }),
    ]);
    expect(summary.strategies[0]?.passRate).toBeCloseTo(1 / 3);
  });

  it('reports score per dollar', () => {
    const summary = summarizeRuns([
      run({ strategyId: 'cheap', score: 0.8, costUsd: 0.1 }),
      run({ strategyId: 'pricey', score: 0.9, costUsd: 1.0 }),
    ]);
    const cheap = summary.strategies.find((s) => s.strategyId === 'cheap');
    const pricey = summary.strategies.find((s) => s.strategyId === 'pricey');

    expect(cheap?.scorePerDollar).toBeCloseTo(8);
    expect(pricey?.scorePerDollar).toBeCloseTo(0.9);
  });

  it('reports zero score-per-dollar when a run somehow cost nothing', () => {
    const summary = summarizeRuns([run({ costUsd: 0, score: 1 })]);
    expect(summary.strategies[0]?.scorePerDollar).toBe(0);
  });

  it('builds one cell per strategy and task pair', () => {
    const summary = summarizeRuns([
      run({ strategyId: 'a', taskId: 't1', score: 1 }),
      run({ strategyId: 'a', taskId: 't2', score: 0 }),
      run({ strategyId: 'b', taskId: 't1', score: 0.5 }),
    ]);

    expect(summary.cells).toHaveLength(3);
    const cell = summary.cells.find((c) => c.strategyId === 'a' && c.taskId === 't2');
    expect(cell?.meanScore).toBe(0);
    expect(cell?.runs).toBe(1);
  });

  it('counts failure modes per strategy and overall', () => {
    const summary = summarizeRuns([
      run({ failureMode: 'none' }),
      run({ failureMode: 'policy_violation' }),
      run({ failureMode: 'policy_violation' }),
      run({ failureMode: 'timeout' }),
    ]);

    expect(summary.totals.failureModes).toEqual({
      none: 1,
      policy_violation: 2,
      timeout: 1,
    });
    expect(summary.strategies[0]?.failureModes.policy_violation).toBe(2);
  });

  it('sums attempted sandbox escapes', () => {
    const summary = summarizeRuns([
      run({ deniedToolCalls: 2 }),
      run({ deniedToolCalls: 3 }),
    ]);
    expect(summary.strategies[0]?.deniedToolCalls).toBe(5);
  });

  it('marks overlapping comparisons inconclusive', () => {
    const summary = summarizeRuns([
      run({ strategyId: 'a', score: 0.5 }),
      run({ strategyId: 'a', score: 0.6 }),
      run({ strategyId: 'a', score: 0.55 }),
      run({ strategyId: 'b', score: 0.52 }),
      run({ strategyId: 'b', score: 0.58 }),
      run({ strategyId: 'b', score: 0.54 }),
    ]);

    expect(summary.pairwise).toHaveLength(1);
    expect(summary.pairwise[0]?.verdict).toBe('inconclusive');
  });

  it('calls a winner when the intervals are cleanly separated', () => {
    const summary = summarizeRuns([
      ...[0.95, 0.96, 0.94].map((score) => run({ strategyId: 'good', score })),
      ...[0.1, 0.12, 0.09].map((score) => run({ strategyId: 'bad', score })),
    ]);
    const verdict = summary.pairwise[0];
    expect(verdict?.a).toBe('good');
    expect(verdict?.verdict).toBe('a-better');
    expect(verdict?.meanDelta).toBeGreaterThan(0.7);
  });

  it('keeps a cheap-and-good strategy on the Pareto frontier and drops the dominated one', () => {
    const summary = summarizeRuns([
      run({ strategyId: 'cheap-good', score: 0.9, costUsd: 0.1 }),
      run({ strategyId: 'dominated', score: 0.5, costUsd: 0.5 }),
      run({ strategyId: 'pricey-best', score: 0.99, costUsd: 2.0 }),
    ]);

    expect(summary.paretoStrategyIds).toContain('cheap-good');
    expect(summary.paretoStrategyIds).toContain('pricey-best');
    expect(summary.paretoStrategyIds).not.toContain('dominated');
  });

  it('splits summaries by task category', () => {
    const summary = summarizeRuns([
      run({ strategyId: 'a', taskCategory: 'tool-use', score: 1 }),
      run({ strategyId: 'a', taskCategory: 'research', taskId: 'research-easy', score: 0 }),
    ]);

    expect(summary.byCategory['tool-use'][0]?.score.mean).toBe(1);
    expect(summary.byCategory.research[0]?.score.mean).toBe(0);
  });

  it('leaves runs that failed integrity or hit an api error out of the rankings', () => {
    const summary = summarizeRuns([
      run({ strategyId: 'a', score: 0.2 }),
      run({ strategyId: 'a', score: 1, integrity: { ok: false, checks: [{ id: 'plan-non-empty', ok: false }] } }),
      run({ strategyId: 'b', score: 0.9, failureMode: 'api_error' }),
      run({ strategyId: 'c', score: 0.4, integrity: { ok: true, checks: [] } }),
    ]);

    expect(summary.strategies.map((s) => s.strategyId)).toEqual(['c', 'a']);
    expect(summary.strategies.find((s) => s.strategyId === 'a')?.score.mean).toBe(0.2);
    expect(summary.cells).toHaveLength(2);
    expect(summary.totals.runs).toBe(4);
    expect(summary.totals.excludedRuns).toBe(2);
    expect(summary.totals.failureModes).toEqual({ none: 3, api_error: 1 });
  });

  it('tracks judge cost separately from strategy cost', () => {
    const summary = summarizeRuns([
      run({ costUsd: 0.2, judgeCostUsd: 0.05 }),
      run({ costUsd: 0.3, judgeCostUsd: 0.05 }),
    ]);

    expect(summary.totals.costUsd).toBeCloseTo(0.5);
    expect(summary.totals.judgeCostUsd).toBeCloseTo(0.1);
    expect(summary.strategies[0]?.totalCostUsd).toBeCloseTo(0.5);
  });
});
