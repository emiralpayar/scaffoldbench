import { describe, expect, it } from 'vitest';

import { harnessCheckRates, ownCheckRates, pickRepresentative, stageCosts, taskDeltas } from '../lib/strategies';
import { phase, run } from './fixtures';

const proposeSelect = (overrides: Parameters<typeof run>[0]) => run({ strategyId: 'propose-select', ...overrides });

describe('stageCosts', () => {
  it('adds up to the mean cost of a run, stage by stage, per model', () => {
    const records = [
      proposeSelect({
        runId: 'a',
        phases: [
          phase({ phase: 'propose-1', costUsd: 0.1, toolCalls: 2 }),
          phase({ phase: 'propose-2', costUsd: 0.1, toolCalls: 2 }),
          phase({ phase: 'select', costUsd: 0.05, toolCalls: 0 }),
          phase({ phase: 'execute', costUsd: 0.15, toolCalls: 4 }),
        ],
      }),
      proposeSelect({
        runId: 'b',
        repeat: 2,
        phases: [
          phase({ phase: 'propose-1', costUsd: 0.2, toolCalls: 2 }),
          phase({ phase: 'select', costUsd: 0.05, toolCalls: 0 }),
          phase({ phase: 'execute', costUsd: 0.15, toolCalls: 2 }),
        ],
      }),
    ];
    const [model] = stageCosts(records, 'propose-select');
    const byStage = Object.fromEntries((model?.stages ?? []).map((stage) => [stage.stageId, stage]));

    expect(model?.runs).toBe(2);
    expect(byStage.propose?.costUsd).toBeCloseTo(0.2);
    expect(byStage.propose?.calls).toBeCloseTo(1.5);
    expect(byStage.select?.costUsd).toBeCloseTo(0.05);
    expect(byStage.execute?.toolCalls).toBeCloseTo(3);
    expect(model?.costUsd).toBeCloseTo(0.4);
  });

  it('keeps a phase the design does not know, under "other", so nothing goes missing', () => {
    const [model] = stageCosts(
      [run({ phases: [phase({ phase: 'main', costUsd: 0.1 }), phase({ phase: 'mystery', costUsd: 0.05 })] })],
      'single',
    );
    expect(model?.costUsd).toBeCloseTo(0.15);
    expect(model?.stages.map((stage) => stage.stageId)).toEqual(['agent', 'other']);
  });

  it('answers the current name for a recorded legacy id, and nothing for an unknown design', () => {
    expect(stageCosts([proposeSelect({ phases: [phase({ phase: 'select' })] })], 'debate-select')).toHaveLength(1);
    expect(stageCosts([run({})], 'no-such-design')).toEqual([]);
  });
});

describe('pickRepresentative', () => {
  const records = [
    proposeSelect({ runId: 'fail', passed: false, taskDifficulty: 'hard' }),
    proposeSelect({ runId: 'easy', taskDifficulty: 'easy' }),
    proposeSelect({ runId: 'hard-haiku', taskDifficulty: 'hard', model: 'claude-haiku-4-5-20251001' }),
    proposeSelect({ runId: 'hard-sonnet', taskDifficulty: 'hard' }),
    proposeSelect({
      runId: 'broken',
      taskDifficulty: 'expert',
      integrity: { ok: false, checks: [{ id: 'harness.api', ok: false }] },
    }),
    run({ runId: 'other-design', taskDifficulty: 'expert' }),
  ];

  it('prefers a healthy, passing run on the preferred model, on the harder task', () => {
    expect(pickRepresentative(records, 'propose-select', 'claude-sonnet-5-5')?.runId).toBe('hard-sonnet');
  });

  it('prefers a run that has a trace over a better one that has not', () => {
    const picked = pickRepresentative(records, 'propose-select', 'claude-sonnet-5-5', (r) => r.runId === 'easy');
    expect(picked?.runId).toBe('easy');
  });

  it('is empty for a design with no runs', () => {
    expect(pickRepresentative(records, 'gated-execute', undefined)).toBeUndefined();
  });
});

describe('check rates', () => {
  const integrity = (ok: boolean) => ({
    ok,
    checks: [
      { id: 'harness.api', ok: true },
      { id: 'propose-select.tools', ok, ...(ok ? {} : { detail: 'no tools' }) },
      { id: 'propose-select.proposals', ok: true },
    ],
  });
  const records = [proposeSelect({ integrity: integrity(true) }), proposeSelect({ repeat: 2, integrity: integrity(false) })];

  it("lists a design's own checks in the order its design declares them", () => {
    expect(ownCheckRates(records, 'propose-select').map((rate) => [rate.id, rate.ok, rate.total])).toEqual([
      ['propose-select.proposals', 2, 2],
      ['propose-select.tools', 1, 2],
    ]);
    expect(ownCheckRates(records, 'propose-select')[1]?.example).toBe('no tools');
  });

  it("keeps the runner's checks apart from the design's", () => {
    expect(harnessCheckRates(records).map((rate) => rate.id)).toEqual(['harness.api']);
  });
});

describe('taskDeltas', () => {
  const at = (strategyId: string, taskId: string, repeat: number, score: number, model = 'claude-sonnet-5-5') =>
    run({ runId: `${strategyId}-${taskId}-${repeat}-${model}`, strategyId, taskId, taskTitle: `Task ${taskId}`, repeat, score, model });

  it('is the mean paired difference from the control, over the repeats both ran', () => {
    const records = [
      at('single', 'a', 1, 0.5),
      at('single', 'a', 2, 0.5),
      at('plan-execute', 'a', 1, 1),
      at('plan-execute', 'a', 2, 0.5),
      at('single', 'b', 1, 1),
      at('plan-execute', 'b', 1, 0.25),
    ];
    const deltas = taskDeltas(records, 'plan-execute', 'claude-sonnet-5-5');
    expect(deltas.map((d) => [d.taskId, d.delta, d.pairs])).toEqual([
      ['a', 0.25, 2],
      ['b', -0.75, 1],
    ]);
  });

  it('leaves out a task the control never ran, and a repeat only one side has', () => {
    const records = [
      at('plan-execute', 'a', 1, 1),
      at('plan-execute', 'c', 1, 1),
      at('single', 'c', 2, 0),
      at('single', 'c', 1, 0.5),
      at('plan-execute', 'c', 2, 0),
    ];
    const deltas = taskDeltas(records, 'plan-execute', 'claude-sonnet-5-5');
    expect(deltas.map((d) => [d.taskId, d.delta, d.pairs])).toEqual([['c', 0.25, 2]]);
  });

  it('keeps models apart', () => {
    const records = [
      at('single', 'a', 1, 0.5, 'claude-sonnet-5-5'),
      at('plan-execute', 'a', 1, 1, 'claude-sonnet-5-5'),
      at('single', 'a', 1, 1, 'claude-opus-5-5'),
      at('plan-execute', 'a', 1, 1, 'claude-opus-5-5'),
    ];
    expect(taskDeltas(records, 'plan-execute', 'claude-opus-5-5')[0]?.delta).toBe(0);
  });
});
