import { describe, expect, it } from 'vitest';

import type { StrategyInfo, TraceEvent } from '@arena/core';

import {
  assertionPassRates,
  buildCatalog,
  buildPhaseRows,
  defaultModel,
  groupTraceByPhase,
  indexToolResults,
  modelView,
  parseTraceLines,
  repeatCells,
  runOutcome,
  selectRunsForTask,
  sortTasks,
} from '../lib/derive';
import { formatDuration, formatUsd } from '../lib/format';
import type { TaskInfo } from '../lib/records';
import { event, phase, run } from './fixtures';

function strategyInfo(id: string, label: string): StrategyInfo {
  return { id, label, description: `${label} description.` };
}

function taskInfo(overrides: Partial<TaskInfo> & Pick<TaskInfo, 'id'>): TaskInfo {
  return {
    category: 'tool-use',
    world: 'airline',
    title: overrides.id,
    prompt: 'do the thing',
    difficulty: 'easy',
    tags: [],
    maxTurns: 10,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Catalog and ordering
// ---------------------------------------------------------------------------

describe('buildCatalog', () => {
  it('returns empty collections from every derivation on no data', () => {
    expect(selectRunsForTask([], 'alpha')).toEqual([]);
    expect(assertionPassRates([], 'alpha')).toEqual([]);
    expect(groupTraceByPhase([])).toEqual([]);
    expect(indexToolResults([])).toEqual({});
    expect(parseTraceLines('')).toEqual([]);
    expect(buildCatalog(null, [])).toEqual({ strategies: [], tasks: [] });
  });

  it('tolerates a missing catalog by reconstructing it from run records', () => {
    const catalog = buildCatalog(null, [run({})]);

    expect(catalog.strategies.map((s) => s.id)).toEqual(['single']);
    expect(catalog.tasks.map((t) => t.id)).toEqual(['alpha']);
    // A reconstructed task has no prompt to show; the page must not claim one.
    expect(catalog.tasks[0]?.prompt).toBe('');
  });

  it('keeps catalog entries and appends strategies seen only in the records', () => {
    const catalog = buildCatalog(
      { strategies: [strategyInfo('single', 'Single agent')], tasks: [taskInfo({ id: 'alpha' })] },
      [run({}), run({ strategyId: 'ghost', runId: 'ghost__alpha__r1' })],
    );

    expect(catalog.strategies.map((s) => s.id)).toEqual(['single', 'ghost']);
    expect(catalog.strategies[0]?.label).toBe('Single agent');
    expect(catalog.tasks).toHaveLength(1);
  });

  it('renames a legacy catalog entry instead of listing it twice', () => {
    const catalog = buildCatalog(
      { strategies: [strategyInfo('debate-select', 'Parallel proposals')], tasks: [] },
      [run({ strategyId: 'propose-select' })],
    );
    expect(catalog.strategies.map((s) => s.id)).toEqual(['propose-select']);
  });
});

describe('sortTasks', () => {
  it('orders tool use before research, then world, then difficulty up to expert', () => {
    const sorted = sortTasks([
      taskInfo({ id: 'r', category: 'research', world: 'web' }),
      taskInfo({ id: 'a-expert', difficulty: 'expert' }),
      taskInfo({ id: 'a-hard', difficulty: 'hard' }),
      taskInfo({ id: 'e-easy', world: 'ecommerce' }),
      taskInfo({ id: 'a-easy' }),
    ]);
    expect(sorted.map((t) => t.id)).toEqual(['a-easy', 'a-hard', 'a-expert', 'e-easy', 'r']);
  });
});

// ---------------------------------------------------------------------------
// Model scoping and per-repeat outcomes
// ---------------------------------------------------------------------------

describe('modelView', () => {
  it('never pools models and ranks only rankable runs', () => {
    const records = [
      run({ model: 'claude-haiku-4-5-20251001', score: 0 }),
      run({ runId: 'b', score: 1 }),
      run({ runId: 'c', score: 0, failureMode: 'api_error' }),
    ];
    const view = modelView(records, 'claude-sonnet-5-5');

    expect(view.records).toHaveLength(2);
    expect(view.ranked.map((r) => r.runId)).toEqual(['b']);
    expect(view.summary.strategies[0]?.score.mean).toBe(1);
  });

  it('defaults to the middle model so a single-model view is neither the cheapest nor the dearest', () => {
    expect(defaultModel(['claude-haiku-4-5-20251001', 'claude-sonnet-5-5', 'claude-opus-5-5'])).toBe(
      'claude-sonnet-5-5',
    );
    expect(defaultModel(['claude-sonnet-5'])).toBe('claude-sonnet-5');
    expect(defaultModel([])).toBeUndefined();
  });
});

describe('runOutcome', () => {
  it('keeps exclusions apart from failures', () => {
    expect(runOutcome(run({}))).toBe('pass');
    expect(runOutcome(run({ passed: false, score: 0.5 }))).toBe('partial');
    expect(runOutcome(run({ passed: false, score: 0 }))).toBe('fail');
    expect(runOutcome(run({ failureMode: 'api_error', passed: false, score: 0 }))).toBe('api_error');
    expect(
      runOutcome(run({ integrity: { ok: false, checks: [] }, passed: true })),
    ).toBe('excluded');
  });

  it('lists one cell per repeat, in repeat order', () => {
    const cells = repeatCells(
      [run({ runId: 'r2', repeat: 2, score: 0 , passed: false}), run({ runId: 'r1' }), run({ runId: 'x', taskId: 'beta' })],
      'single',
      'alpha',
    );
    expect(cells.map((c) => [c.runId, c.outcome])).toEqual([
      ['r1', 'pass'],
      ['r2', 'fail'],
    ]);
  });

  it('carries what the readout says about each run', () => {
    const [cell] = repeatCells(
      [run({ passed: false, score: 0.5, costUsd: 0.25, latencyMs: 4_200, failureMode: 'wrong_answer' })],
      'single',
      'alpha',
    );
    expect(cell).toMatchObject({ outcome: 'partial', score: 0.5, costUsd: 0.25, latencyMs: 4_200, failureMode: 'wrong_answer' });
  });

  it('flags a legacy run whose own records show it did not run as designed', () => {
    const errored = { phases: [phase({ phase: 'plan', label: 'Plan', error: 'Reached maximum number of turns (1)' })] };
    const [legacy] = repeatCells([run({ strategyId: 'plan-execute', ...errored })], 'plan-execute', 'alpha');
    expect(legacy?.outcome).toBe('pass');
    expect(legacy?.legacyProblems).toBe(1);

    // A run with an integrity verdict is judged by it, never by the legacy reading.
    const [checked] = repeatCells(
      [run({ strategyId: 'plan-execute', integrity: { ok: true, checks: [] }, ...errored })],
      'plan-execute',
      'alpha',
    );
    expect(checked?.legacyProblems).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Assertion pass rates
// ---------------------------------------------------------------------------

describe('assertionPassRates', () => {
  const records = [
    run({
      runId: 'single__alpha__r1',
      breakdown: [
        { id: 'state', label: 'Final state', weight: 2, earned: 1 },
        { id: 'side', label: 'No side effects', weight: 1, earned: 1 },
      ],
    }),
    run({
      runId: 'single__alpha__r2',
      repeat: 2,
      breakdown: [
        { id: 'state', label: 'Final state', weight: 2, earned: 1 },
        { id: 'side', label: 'No side effects', weight: 1, earned: 0.5 },
      ],
    }),
    run({
      runId: 'plan__alpha__r1',
      strategyId: 'plan-execute',
      breakdown: [
        { id: 'state', label: 'Final state', weight: 2, earned: 0 },
        { id: 'side', label: 'No side effects', weight: 1, earned: 0 },
      ],
    }),
    run({
      runId: 'single__beta__r1',
      taskId: 'beta',
      breakdown: [{ id: 'other', label: 'Other task', weight: 1, earned: 1 }],
    }),
  ];

  it('counts full credit per assertion across every run of that task only', () => {
    const stats = assertionPassRates(records, 'alpha');

    expect(stats.map((s) => s.id)).toEqual(['state', 'side']);

    const state = stats[0];
    expect(state?.runs).toBe(3);
    expect(state?.passed).toBe(2);
    expect(state?.passRate).toBeCloseTo(2 / 3, 6);
    expect(state?.meanEarned).toBeCloseTo(2 / 3, 6);
    expect(state?.weight).toBe(2);

    const side = stats[1];
    expect(side?.runs).toBe(3);
    // 0.5 is credit, not a pass.
    expect(side?.passed).toBe(1);
    expect(side?.partial).toBe(1);
    expect(side?.passRate).toBeCloseTo(1 / 3, 6);
    expect(side?.meanEarned).toBeCloseTo(0.5, 6);
  });

  it('selects and orders the runs for a task by architecture order then repeat', () => {
    const selected = selectRunsForTask(records, 'alpha');

    // Known architectures come in registry order; an unknown id sorts after them.
    expect(selected.map((r) => r.runId)).toEqual([
      'single__alpha__r1',
      'single__alpha__r2',
      'plan__alpha__r1',
    ]);
  });

  it('ignores runs whose breakdown is empty', () => {
    expect(assertionPassRates([run({ breakdown: [] })], 'alpha')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Trace grouping
// ---------------------------------------------------------------------------

describe('groupTraceByPhase', () => {
  const events: TraceEvent[] = [
    event({ seq: 0, tMs: 0, phase: 'plan', kind: 'phase_start' }),
    event({ seq: 1, tMs: 100, phase: 'plan', kind: 'assistant_text', text: 'thinking' }),
    event({ seq: 2, tMs: 200, phase: 'execute', kind: 'phase_start' }),
    event({ seq: 3, tMs: 300, phase: 'worker-1', depth: 1, agent: 'worker-1', kind: 'assistant_text' }),
    event({ seq: 4, tMs: 400, phase: 'execute', kind: 'tool_call', toolName: 'get', toolUseId: 'tu_1' }),
    event({ seq: 5, tMs: 500, phase: 'plan', kind: 'phase_end' }),
  ];

  it('preserves first-appearance order of phases and event order inside them', () => {
    const groups = groupTraceByPhase(events);

    expect(groups.map((g) => g.phase)).toEqual(['plan', 'execute', 'worker-1']);
    expect(groups[0]?.events.map((e) => e.seq)).toEqual([0, 1, 5]);
    expect(groups[1]?.events.map((e) => e.seq)).toEqual([2, 4]);
  });

  it('spans each phase from its first to its last event', () => {
    const groups = groupTraceByPhase(events);

    expect(groups[0]?.startMs).toBe(0);
    expect(groups[0]?.endMs).toBe(500);
    expect(groups[1]?.startMs).toBe(200);
    expect(groups[1]?.endMs).toBe(400);
  });

  it('carries the nesting depth and agent of subagent phases', () => {
    const groups = groupTraceByPhase(events);

    expect(groups[0]?.depth).toBe(0);
    expect(groups[2]?.depth).toBe(1);
    expect(groups[2]?.agent).toBe('worker-1');
    expect(groups[0]?.agent).toBeUndefined();
  });

  it('takes the shallowest depth seen, so a phase indents by the thread it belongs to', () => {
    const groups = groupTraceByPhase([
      event({ seq: 0, phase: 'deep', depth: 2 }),
      event({ seq: 1, phase: 'deep', depth: 1 }),
    ]);

    expect(groups[0]?.depth).toBe(1);
  });

  it('handles nesting more than one level below the main thread', () => {
    const groups = groupTraceByPhase([
      event({ seq: 0, phase: 'main', depth: 0 }),
      event({ seq: 1, phase: 'worker', depth: 1, agent: 'worker' }),
      event({ seq: 2, phase: 'sub-worker', depth: 2, agent: 'sub' }),
    ]);

    expect(groups.map((g) => g.depth)).toEqual([0, 1, 2]);
  });

  it('keeps two agents that reuse a phase name apart', () => {
    const groups = groupTraceByPhase([
      event({ seq: 0, phase: 'worker', depth: 1, agent: 'a' }),
      event({ seq: 1, phase: 'worker', depth: 1, agent: 'b' }),
    ]);
    expect(groups.map((g) => g.agent)).toEqual(['a', 'b']);
  });

  it('pairs tool results with the call that produced them', () => {
    const results = indexToolResults([
      event({ seq: 0, kind: 'tool_call', toolUseId: 'tu_1', toolName: 'get' }),
      event({ seq: 1, kind: 'tool_result', toolUseId: 'tu_1', text: 'body' }),
      event({ seq: 2, kind: 'tool_result', text: 'orphan' }),
    ]);

    expect(Object.keys(results)).toEqual(['tu_1']);
    expect(results['tu_1']?.text).toBe('body');
  });

  it('parses JSONL, skipping blank and unreadable lines', () => {
    const parsed = parseTraceLines(
      ['{"seq":0,"tMs":0,"phase":"main","depth":0,"kind":"note"}', '', 'not json', '   '].join('\n'),
    );

    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.phase).toBe('main');
  });
});

// ---------------------------------------------------------------------------
// Phase table
// ---------------------------------------------------------------------------

describe('buildPhaseRows', () => {
  it('uses the recorded phases when the run has them', () => {
    const record = run({
      phases: [
        {
          phase: 'plan',
          label: 'Plan',
          startedAtMs: 0,
          durationMs: 1_200,
          costUsd: 0.01,
          turns: 2,
          toolCalls: 0,
          model: 'claude-sonnet-5',
          aborted: false,
        },
      ],
    });

    const rows = buildPhaseRows(record, []);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.label).toBe('Plan');
    expect(rows[0]?.derived).toBe(false);
  });

  it('derives a phase table from the trace when the run recorded none', () => {
    const rows = buildPhaseRows(run({ phases: [] }), [
      event({ seq: 0, tMs: 0, phase: 'main', kind: 'phase_start' }),
      event({ seq: 1, tMs: 400, phase: 'main', kind: 'tool_call', toolName: 'get' }),
      event({ seq: 2, tMs: 900, phase: 'main', kind: 'result', costUsd: 0.04 }),
      event({ seq: 3, tMs: 1_000, phase: 'worker-1', depth: 1, kind: 'assistant_text' }),
    ]);

    expect(rows.map((r) => r.phase)).toEqual(['main', 'worker-1']);
    expect(rows[0]?.durationMs).toBe(900);
    expect(rows[0]?.costUsd).toBeCloseTo(0.04, 6);
    expect(rows[0]?.toolCalls).toBe(1);
    expect(rows[0]?.derived).toBe(true);
  });

  it('returns nothing when there is neither a phase record nor a trace', () => {
    expect(buildPhaseRows(run({ phases: [] }), [])).toEqual([]);
  });
});

describe('formatting', () => {
  it('keeps small dollar amounts legible instead of rounding them to zero', () => {
    expect(formatUsd(0.032509)).toBe('$0.033');
    expect(formatUsd(1.5)).toBe('$1.50');
    expect(formatUsd(0)).toBe('$0');
  });

  it('formats durations at a resolution a reader can hold', () => {
    expect(formatDuration(840)).toBe('0.8s');
    expect(formatDuration(21_379)).toBe('21.4s');
    expect(formatDuration(125_000)).toBe('2m 5s');
  });
});
