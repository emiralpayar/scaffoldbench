import { describe, expect, it } from 'vitest';

import { checkRates, checkWords, failedChecks } from '../lib/integrity';
import type { TaskInfo } from '../lib/records';
import { firedTraps, trapTable } from '../lib/traps';
import { run } from './fixtures';

const task: TaskInfo = {
  id: 'alpha',
  category: 'tool-use',
  world: 'airline',
  title: 'Alpha',
  prompt: '',
  difficulty: 'expert',
  tags: [],
  maxTurns: 10,
  traps: [
    { id: 'closed-card', description: 'Refunds to a closed card.', caughtBy: ['cash-refund', 'settled'] },
    { id: 'scope-creep', description: 'Acts on a request outside the job.', caughtBy: ['out-of-scope'] },
  ],
};

const item = (id: string, earned: number) => ({ id, label: id, weight: 1, earned });

describe('firedTraps', () => {
  it('fires on any listed assertion short of full credit, or any listed penalty', () => {
    expect(firedTraps(task, { breakdown: [item('cash-refund', 1), item('settled', 0.5)], penalties: [] })).toEqual([
      'closed-card',
    ]);
    expect(
      firedTraps(task, {
        breakdown: [item('cash-refund', 1), item('settled', 1)],
        penalties: [{ id: 'out-of-scope', label: '', kind: 'policy_violation', multiplier: 0 }],
      }),
    ).toEqual(['scope-creep']);
    expect(firedTraps(task, { breakdown: [item('cash-refund', 1), item('settled', 1)], penalties: [] })).toEqual([]);
  });

  it('fires nothing for a task with no traps', () => {
    expect(firedTraps({}, { breakdown: [item('x', 0)], penalties: [] })).toEqual([]);
  });
});

describe('trapTable', () => {
  it('counts each trap per architecture over the runs it is given', () => {
    const records = [
      run({ runId: 'a', taskId: 'alpha', strategyId: 'single', breakdown: [item('settled', 0)] }),
      run({ runId: 'b', taskId: 'alpha', strategyId: 'single', repeat: 2, breakdown: [item('settled', 1)] }),
      run({ runId: 'c', taskId: 'alpha', strategyId: 'gated-execute', breakdown: [item('settled', 1)] }),
      run({ runId: 'd', taskId: 'other', strategyId: 'gated-execute', breakdown: [item('settled', 0)] }),
    ];
    const table = trapTable(task, records);
    expect(table?.architectures).toEqual(['single', 'gated-execute']);
    expect(table?.rows[0]?.cells).toEqual({
      single: { fired: 1, runs: 2 },
      'gated-execute': { fired: 0, runs: 1 },
    });
    expect(table?.rows[0]?.total).toEqual({ fired: 1, runs: 3 });
  });

  it('has nothing to draw for a task without traps', () => {
    expect(trapTable({ ...task, traps: [] }, [])).toBeNull();
  });
});

describe('integrity checks', () => {
  it("uses the runner's words for harness checks and a readable id otherwise", () => {
    expect(checkWords('harness.mcp-connected').title).toBe('Tool servers connected');
    expect(checkWords('propose-select.proposers-grounded')).toEqual({
      title: 'Proposers grounded',
      means: 'A fidelity check declared by Propose-select.',
    });
    expect(checkWords('mystery').title).toBe('Mystery');
  });

  it('rates checks over runs that recorded them, harness checks first', () => {
    const records = [
      run({ integrity: { ok: true, checks: [{ id: 'plan-execute.plan', ok: true }, { id: 'harness.api', ok: true }] } }),
      run({
        integrity: {
          ok: false,
          checks: [
            { id: 'plan-execute.plan', ok: false, detail: 'empty plan' },
            { id: 'harness.api', ok: true },
          ],
        },
      }),
      run({}),
    ];
    expect(checkRates(records)).toEqual([
      { id: 'harness.api', ok: 2, total: 2 },
      { id: 'plan-execute.plan', ok: 1, total: 2, example: 'empty plan' },
    ]);
    expect(failedChecks(records[1] as (typeof records)[number])).toEqual([
      { id: 'plan-execute.plan', ok: false, detail: 'empty plan' },
    ]);
  });
});
