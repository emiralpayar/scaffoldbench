import { existsSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { ACT_ONE, deriveTraceFacts, derivePostmortem } from '../lib/postmortem';
import { POSTMORTEM_RUN_SET_ID, loadTrace, readRunSet, resultsRoot } from '../lib/server/runSet';
import { event, phase, run } from './fixtures';

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
 * the committed evidence: the run records and the traces beside them. Skipped
 * only in a checkout whose results/ was cleared.
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

  it('supports every number the post-mortem page states', async () => {
    const data = await readRunSet(resultsRoot(), POSTMORTEM_RUN_SET_ID);
    if (!data) throw new Error('evidence run set unreadable');
    const { totals, rows } = derivePostmortem(data.runSetId, data.records);
    const byId = Object.fromEntries(rows.map((row) => [row.strategyId, row]));

    expect(totals.phases).toBe(ACT_ONE.phases);
    expect(data.records.length).toBe(ACT_ONE.runs);
    expect(totals.structuredPhases).toBe(ACT_ONE.structuredPhases);
    expect(totals.structuredFailed).toBe(ACT_ONE.structuredFailed);
    expect(totals.deniedToolCalls).toBe(ACT_ONE.deniedToolCalls);
    expect(totals.wastedPhases).toBe(ACT_ONE.wastedPhases);
    expect(totals.wastedCostUsd.toFixed(2)).toBe(ACT_ONE.wastedUsd.toFixed(2));
    expect(totals.costUsd.toFixed(2)).toBe(ACT_ONE.totalUsd.toFixed(2));
    expect(totals.verifiedRuns).toBe(ACT_ONE.verifiedRuns);
    expect(totals.revisedRuns).toBe(ACT_ONE.revisions);
    expect(totals.blindProposals).toBe(ACT_ONE.laterProposersWithoutTools);
    expect(byId['orchestrator-workers']?.receipts[1]).toMatchObject({ count: ACT_ONE.orchestratorRuns - ACT_ONE.fannedOut });
  });

  it('supports the counts that only the traces show, from the committed traces', async () => {
    const data = await readRunSet(resultsRoot(), POSTMORTEM_RUN_SET_ID);
    if (!data) throw new Error('evidence run set unreadable');
    const traces = [];
    for (const record of data.records) {
      const trace = await loadTrace(data, record);
      if (trace) traces.push(trace);
    }
    const facts = deriveTraceFacts(traces);

    expect(traces.length).toBe(ACT_ONE.runs);
    expect(facts.plans).toBe(ACT_ONE.plans);
    expect(facts.emptyPlans).toBe(ACT_ONE.emptyPlans);
    expect(facts.sessions).toBe(ACT_ONE.sessions);
    expect(facts.sessionsWithConnectors).toBe(ACT_ONE.sessionsWithConnectors);
    expect(facts.laterProposers).toBe(ACT_ONE.laterProposers);
    expect(facts.laterProposersWithoutTools).toBe(ACT_ONE.laterProposersWithoutTools);
    expect(facts.structuredOutputDenials).toBe(ACT_ONE.deniedToolCalls);
  });
});

describe('derivePostmortem totals', () => {
  it('counts phases that errored or ran blind as wasted, once, with their cost', () => {
    const records = [
      run({
        strategyId: 'propose-select',
        costUsd: 0.4,
        deniedToolCalls: 1,
        failureMode: 'none',
        phases: [
          phase({ phase: 'propose-1', toolCalls: 3, costUsd: 0.1 }),
          phase({ phase: 'propose-2', toolCalls: 0, costUsd: 0.1 }),
          phase({ phase: 'select', toolCalls: 0, costUsd: 0.1, error: 'maximum number of turns' }),
          phase({ phase: 'execute', toolCalls: 4, costUsd: 0.1 }),
        ],
      }),
    ];
    const { totals, rows } = derivePostmortem('set', records);

    expect(totals).toMatchObject({
      phases: 4,
      structuredPhases: 1,
      structuredFailed: 1,
      proposals: 2,
      blindProposals: 1,
      wastedPhases: 2,
      deniedToolCalls: 1,
      runsWithoutFailure: 1,
    });
    expect(totals.wastedCostUsd).toBeCloseTo(0.2);
    expect(rows[0]?.wastedUsdPerRun).toBeCloseTo(0.2);
    expect(rows[0]?.costUsdPerRun).toBeCloseTo(0.4);
  });

  it('counts the verifier runs that ever sent work back', () => {
    const records = [
      run({ strategyId: 'plan-execute-verify', phases: [phase({ phase: 'verify' })] }),
      run({ strategyId: 'plan-execute-verify', repeat: 2, phases: [phase({ phase: 'verify-1' }), phase({ phase: 'revise-1' })] }),
    ];
    expect(derivePostmortem('set', records).totals).toMatchObject({ verifiedRuns: 2, revisedRuns: 1 });
  });
});

describe('deriveTraceFacts', () => {
  const init = (phaseName: string, tools: string[], servers: string[]) =>
    event({
      kind: 'system_init',
      phase: phaseName,
      meta: { tools, mcpServers: servers.map((name) => ({ name, status: 'connected' })) },
    });

  it('reads empty plans, connectors, blind proposers and denied structured output', () => {
    const facts = deriveTraceFacts([
      [
        event({ kind: 'user', phase: 'execute', text: '<task>x</task>\n<plan>\n\n</plan>' }),
        event({ kind: 'tool_denied', phase: 'plan', toolName: 'StructuredOutput' }),
        event({ kind: 'tool_denied', phase: 'execute', toolName: 'Bash' }),
        init('plan', ['StructuredOutput', 'mcp__airline__get_flight'], ['airline', 'claude.ai Gmail']),
      ],
      [
        event({ kind: 'user', phase: 'execute', text: '<plan>1. Read it</plan>' }),
        init('propose-1', ['mcp__airline__get_flight'], ['airline']),
        init('propose-2', [], ['airline']),
        init('propose-3', ['StructuredOutput'], ['airline']),
      ],
    ]);

    expect(facts).toMatchObject({
      plans: 2,
      emptyPlans: 1,
      otherPlans: ['1. Read it'],
      sessions: 4,
      sessionsWithConnectors: 1,
      laterProposers: 2,
      laterProposersWithoutTools: 2,
      structuredOutputDenials: 1,
    });
  });
});
