import { existsSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { derivePostmortem } from '../lib/postmortem';
import { POSTMORTEM_RUN_SET_ID, readRunSet, resultsRoot } from '../lib/server/runSet';
import { phase, run } from './fixtures';

describe('derivePostmortem', () => {
  it('marks an architecture that ran clean as designed', () => {
    const report = derivePostmortem('set', [run({ phases: [phase({ phase: 'main' })] })]);
    expect(report.rows[0]?.ranAsDesigned).toBe(true);
    expect(report.rows[0]?.receipts).toEqual([]);
    expect(report.degraded).toBe(0);
  });

  it('counts a planner that errored in every run and marks the plan node dead', () => {
    const records = [1, 2].map((repeat) =>
      run({
        runId: `plan-execute__a__r${repeat}`,
        strategyId: 'plan-execute',
        repeat,
        phases: [
          phase({ phase: 'plan', error: 'Reached maximum number of turns (1)' }),
          phase({ phase: 'execute' }),
        ],
      }),
    );
    const row = derivePostmortem('set', records).rows[0];

    expect(row?.ranAsDesigned).toBe(false);
    expect(row?.deadNodes).toEqual(['plan']);
    expect(row?.receipts[0]).toMatchObject({ count: 2, of: 2, unit: 'runs' });
  });

  it('does not mark a node dead when the failure was intermittent', () => {
    const records = [
      run({ strategyId: 'plan-execute', phases: [phase({ phase: 'plan', error: 'boom' })] }),
      run({ strategyId: 'plan-execute', repeat: 2, phases: [phase({ phase: 'plan' })] }),
    ];
    const row = derivePostmortem('set', records).rows[0];
    expect(row?.receipts[0]).toMatchObject({ count: 1, of: 2 });
    expect(row?.deadNodes).toEqual([]);
  });

  it('counts idle proposers per proposal, not per run', () => {
    const proposers = (calls: [number, number, number]) =>
      calls.map((toolCalls, i) => phase({ phase: `propose-${i + 1}`, toolCalls }));
    const records = [1, 2].map((repeat) =>
      run({
        strategyId: 'propose-select',
        repeat,
        phases: [...proposers([3, 0, 0]), phase({ phase: 'select' }), phase({ phase: 'execute' })],
      }),
    );
    const row = derivePostmortem('set', records).rows[0];

    expect(row?.receipts).toEqual([
      expect.objectContaining({ count: 4, of: 6, unit: 'proposals' }),
    ]);
    expect(row?.deadNodes.sort()).toEqual(['p2', 'p3']);
  });

  it('flags a verifier that sent nothing back even though runs were wrong', () => {
    const records = [
      run({ strategyId: 'plan-execute-verify', score: 1, phases: [phase({ phase: 'verify' })] }),
      run({ strategyId: 'plan-execute-verify', repeat: 2, score: 0.5, phases: [phase({ phase: 'verify' })] }),
    ];
    const row = derivePostmortem('set', records).rows[0];
    expect(row?.deadNodes).toContain('verify');
    expect(row?.receipts.some((r) => /including the 1 that scored below 1.0/.test(r.label))).toBe(true);
  });
});

/**
 * The landing page states these numbers as fact, so they are pinned against
 * the committed evidence. Skipped only in a checkout whose results/ was cleared.
 */
const evidence = path.join(resultsRoot(), POSTMORTEM_RUN_SET_ID);

describe.skipIf(!existsSync(evidence))('the committed post-mortem run set', () => {
  it('shows four of five architectures failing to run as designed', async () => {
    const data = await readRunSet(resultsRoot(), POSTMORTEM_RUN_SET_ID);
    if (!data) throw new Error('evidence run set unreadable');
    const report = derivePostmortem(data.runSetId, data.records);
    const byId = Object.fromEntries(report.rows.map((row) => [row.strategyId, row]));

    expect(data.verification).toBe('unverified');
    expect(report.runs).toBe(90);
    expect(report.degraded).toBe(4);
    expect(byId.single?.ranAsDesigned).toBe(true);

    expect(byId['plan-execute']?.receipts[0]).toMatchObject({ count: 18, of: 18 });
    expect(byId['plan-execute-verify']?.deadNodes.sort()).toEqual(['plan', 'verify']);
    expect(byId['orchestrator-workers']?.receipts).toEqual([
      expect.objectContaining({ count: 18, of: 18, label: 'the decomposition phase ended in an error' }),
      expect.objectContaining({ count: 18, of: 18, label: 'the task went to a single worker' }),
    ]);
    // Recorded as debate-select; the site reads it under its current name.
    expect(byId['propose-select']?.receipts).toEqual([
      expect.objectContaining({ count: 36, of: 54, unit: 'proposals' }),
      expect.objectContaining({ count: 18, of: 18 }),
    ]);
    expect(report.runsWithDenials).toBe(70);
  });
});
