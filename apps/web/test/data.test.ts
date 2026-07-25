import { describe, expect, it } from 'vitest';

import { summarizeRuns } from '@arena/core';
import type { RunRecord, StrategyInfo, TaskInfo, TraceEvent } from '@arena/core';

import {
  assertionPassRates,
  buildCatalog,
  buildLeaderboardRows,
  buildMatrix,
  buildParetoModel,
  buildPhaseRows,
  describeFindings,
  emptyCatalog,
  formatDuration,
  formatUsd,
  groupTraceByPhase,
  indexToolResults,
  matrixKey,
  parseTraceLines,
  selectRunsForTask,
  sortTasks,
} from '../lib/data';

const BASE_RUN: RunRecord = {
  runId: 'single__alpha__r1',
  runSetId: 'set-1',
  taskId: 'alpha',
  taskTitle: 'Alpha task',
  taskCategory: 'tool-use',
  taskWorld: 'airline',
  taskDifficulty: 'easy',
  strategyId: 'single',
  model: 'claude-sonnet-5',
  effort: 'high',
  repeat: 1,
  startedAt: '2026-01-01T00:00:00.000Z',
  finishedAt: '2026-01-01T00:00:10.000Z',
  latencyMs: 10_000,
  score: 1,
  passed: true,
  breakdown: [],
  penalties: [],
  failureMode: 'none',
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
  toolCalls: 2,
  deniedToolCalls: 0,
  subagentCount: 0,
  phases: [],
  finalText: 'done',
};

function run(overrides: Partial<RunRecord>): RunRecord {
  return { ...BASE_RUN, ...overrides };
}

const BASE_EVENT: TraceEvent = { seq: 0, tMs: 0, phase: 'main', depth: 0, kind: 'note' };

function event(overrides: Partial<TraceEvent>): TraceEvent {
  return { ...BASE_EVENT, ...overrides };
}

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
// Empty results
// ---------------------------------------------------------------------------

describe('empty results', () => {
  it('produces no leaderboard rows and a paragraph that says so', () => {
    const summary = summarizeRuns([]);
    const rows = buildLeaderboardRows(summary, emptyCatalog(), 'all');

    expect(rows).toEqual([]);
    expect(describeFindings(rows, { runs: 0, taskCount: 0, scope: 'all' })).toMatch(
      /no runs/i,
    );
  });

  it('returns empty collections from every derivation', () => {
    const summary = summarizeRuns([]);

    expect(selectRunsForTask([], 'alpha')).toEqual([]);
    expect(assertionPassRates([], 'alpha')).toEqual([]);
    expect(groupTraceByPhase([])).toEqual([]);
    expect(indexToolResults([])).toEqual({});
    expect(parseTraceLines('')).toEqual([]);
    expect(buildMatrix(summary, emptyCatalog()).tasks).toEqual([]);
    expect(buildParetoModel([]).points).toEqual([]);
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
});

// ---------------------------------------------------------------------------
// A single run
// ---------------------------------------------------------------------------

describe('a single run', () => {
  const records = [run({})];
  const summary = summarizeRuns(records);
  const catalog = buildCatalog(
    { strategies: [strategyInfo('single', 'Single agent')], tasks: [taskInfo({ id: 'alpha' })] },
    records,
  );

  it('reports n=1 with a degenerate confidence interval and marks it on the frontier', () => {
    const rows = buildLeaderboardRows(summary, catalog, 'all');
    const row = rows[0];

    expect(rows).toHaveLength(1);
    expect(row?.rank).toBe(1);
    expect(row?.label).toBe('Single agent');
    expect(row?.runs).toBe(1);
    expect(row?.score.mean).toBe(1);
    expect(row?.score.ciLow).toBe(1);
    expect(row?.score.ciHigh).toBe(1);
    expect(row?.passRate).toBe(1);
    expect(row?.scorePerDollar).toBeCloseTo(10, 6);
    // The only point on the plane cannot be dominated.
    expect(row?.onFrontier).toBe(true);
  });

  it('warns in prose that one repeat carries no interval worth reading', () => {
    const rows = buildLeaderboardRows(summary, catalog, 'all');
    const prose = describeFindings(rows, { runs: 1, taskCount: 1, scope: 'all' });

    expect(prose).toContain('Single agent');
    expect(prose).toMatch(/1 run/);
    expect(prose).toMatch(/single run|one run|no comparison/i);
  });

  it('filters a category with no runs down to nothing', () => {
    expect(buildLeaderboardRows(summary, catalog, 'research')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Pareto marking
// ---------------------------------------------------------------------------

describe('pareto marking', () => {
  it('excludes a strategy that is beaten on both score and cost', () => {
    const records = [
      run({ runId: 'a__alpha__r1', strategyId: 'cheap-good', score: 1, costUsd: 0.1 }),
      run({ runId: 'b__alpha__r1', strategyId: 'dear-bad', score: 0.5, costUsd: 0.9, passed: false }),
      run({ runId: 'c__alpha__r1', strategyId: 'dear-good', score: 1, costUsd: 0.9 }),
    ];
    const summary = summarizeRuns(records);
    const rows = buildLeaderboardRows(summary, buildCatalog(null, records), 'all');
    const frontier = rows.filter((r) => r.onFrontier).map((r) => r.strategyId);

    expect(frontier).toEqual(['cheap-good']);
  });

  it('orders pareto points by cost and reports the medians used for the quadrants', () => {
    const records = [
      run({ runId: 'a__alpha__r1', strategyId: 'a', score: 0.4, costUsd: 0.3 }),
      run({ runId: 'b__alpha__r1', strategyId: 'b', score: 0.8, costUsd: 0.1 }),
      run({ runId: 'c__alpha__r1', strategyId: 'c', score: 0.9, costUsd: 0.5 }),
    ];
    const rows = buildLeaderboardRows(summarizeRuns(records), buildCatalog(null, records), 'all');
    const model = buildParetoModel(rows);

    expect(model.points).toHaveLength(3);
    expect(model.frontier.map((p) => p.strategyId)).toEqual(['b', 'c']);
    expect(model.frontier.map((p) => p.cost)).toEqual([0.1, 0.5]);
    expect(model.medianCost).toBeCloseTo(0.3, 6);
    expect(model.medianScore).toBeCloseTo(0.8, 6);
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

  it('selects and orders the runs for a task by strategy then repeat', () => {
    const selected = selectRunsForTask(records, 'alpha');

    expect(selected.map((r) => r.runId)).toEqual([
      'plan__alpha__r1',
      'single__alpha__r1',
      'single__alpha__r2',
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

// ---------------------------------------------------------------------------
// Matrix
// ---------------------------------------------------------------------------

describe('buildMatrix', () => {
  const records = [
    run({ runId: 'a__alpha__r1', strategyId: 'a', taskId: 'alpha', score: 1 }),
    run({ runId: 'a__alpha__r2', strategyId: 'a', taskId: 'alpha', repeat: 2, score: 0.5 }),
    run({
      runId: 'b__beta__r1',
      strategyId: 'b',
      taskId: 'beta',
      taskCategory: 'research',
      taskWorld: 'web',
      score: 0.25,
    }),
  ];

  it('keys cells by strategy and task and leaves untested pairs absent', () => {
    const matrix = buildMatrix(summarizeRuns(records), buildCatalog(null, records));

    expect(matrix.cells[matrixKey('a', 'alpha')]?.meanScore).toBeCloseTo(0.75, 6);
    expect(matrix.cells[matrixKey('a', 'alpha')]?.runs).toBe(2);
    expect(matrix.cells[matrixKey('a', 'beta')]).toBeUndefined();
  });

  it('orders strategies by mean score and tasks by category then difficulty', () => {
    const matrix = buildMatrix(summarizeRuns(records), buildCatalog(null, records));

    expect(matrix.strategies.map((s) => s.id)).toEqual(['a', 'b']);
    expect(matrix.tasks.map((t) => t.id)).toEqual(['alpha', 'beta']);
  });

  it('sorts tool-use tasks ahead of research and easy ahead of hard', () => {
    const sorted = sortTasks([
      taskInfo({ id: 'r-easy', category: 'research', world: 'web' }),
      taskInfo({ id: 'hard', difficulty: 'hard' }),
      taskInfo({ id: 'easy', difficulty: 'easy' }),
      taskInfo({ id: 'medium', difficulty: 'medium' }),
    ]);

    expect(sorted.map((t) => t.id)).toEqual(['easy', 'medium', 'hard', 'r-easy']);
  });
});

// ---------------------------------------------------------------------------
// Prose and formatting
// ---------------------------------------------------------------------------

describe('describeFindings', () => {
  it('calls an overlap inconclusive and counts how many comparisons are', () => {
    const records = [
      run({ runId: 'a1', strategyId: 'a', repeat: 1, score: 0.9 }),
      run({ runId: 'a2', strategyId: 'a', repeat: 2, score: 0.5 }),
      run({ runId: 'b1', strategyId: 'b', repeat: 1, score: 0.8, costUsd: 0.4 }),
      run({ runId: 'b2', strategyId: 'b', repeat: 2, score: 0.4, costUsd: 0.4 }),
    ];
    const rows = buildLeaderboardRows(summarizeRuns(records), buildCatalog(null, records), 'all');
    const prose = describeFindings(rows, { runs: 4, taskCount: 1, scope: 'all' });

    expect(prose).toMatch(/inconclusive/i);
    expect(prose).toMatch(/1 of 1/);
  });

  it('states a separation when the intervals do not overlap', () => {
    const records = [
      run({ runId: 'a1', strategyId: 'a', repeat: 1, score: 1 }),
      run({ runId: 'a2', strategyId: 'a', repeat: 2, score: 1 }),
      run({ runId: 'a3', strategyId: 'a', repeat: 3, score: 1 }),
      run({ runId: 'b1', strategyId: 'b', repeat: 1, score: 0 }),
      run({ runId: 'b2', strategyId: 'b', repeat: 2, score: 0 }),
      run({ runId: 'b3', strategyId: 'b', repeat: 3, score: 0 }),
    ];
    const rows = buildLeaderboardRows(summarizeRuns(records), buildCatalog(null, records), 'all');
    const prose = describeFindings(rows, { runs: 6, taskCount: 1, scope: 'all' });

    expect(prose).toMatch(/do not overlap|separates/i);
    expect(prose).not.toMatch(/1 of 1 pairwise comparisons is inconclusive/);
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
