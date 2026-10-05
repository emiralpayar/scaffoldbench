import { describe, expect, it } from 'vitest';

import type { RunRecord } from '@scaffoldbench/core';

import { applyRunnerEvent, applyTraceEvent, createLiveState, outcomeOf, renderLiveFrame, spentSoFar, windowRows } from '../src/live';
import type { LiveState } from '../src/live';
import { matrixCells } from '../src/plan';
import { createStyle, visibleWidth } from '../src/style';
import { makeRecord, plain } from './support';

const T0 = 1_000_000;
const MODEL = 'claude-haiku-4-5-20251001';

function setup(
  models = [MODEL],
  options: { recorded?: Map<string, RunRecord>; strategies?: string[] } = {},
): LiveState {
  const cells = matrixCells(models, options.strategies ?? ['single', 'plan-execute'], ['airline-easy', 'airline-hard'], 2);
  return createLiveState({
    runSetId: 'set-1',
    cells,
    recorded: options.recorded ?? new Map(),
    total: cells.length,
    effort: 'high',
    budgetUsd: 5,
    now: T0,
  });
}

const id = (strategy: string, task: string, repeat: number, model = MODEL) => `${model}__${strategy}__${task}__r${repeat}`;

function finish(state: LiveState, runId: string, overrides: Partial<RunRecord>, now: number): void {
  const [model = MODEL, strategyId = '', taskId = '', r = 'r1'] = runId.split('__');
  applyRunnerEvent(
    state,
    {
      type: 'run-end',
      record: makeRecord({ model, strategyId, taskId, repeat: Number(r.slice(1)), ...overrides }),
      index: 0,
      total: state.total,
    },
    now,
  );
}

describe('outcomeOf', () => {
  it('puts what was not measured before how well it went', () => {
    expect(outcomeOf({ failureMode: 'api_error', passed: false, score: 0 })).toBe('api_error');
    expect(outcomeOf({ failureMode: 'none', passed: true, score: 1, integrity: { ok: false, checks: [] } })).toBe('integrity');
    expect(outcomeOf({ failureMode: 'none', passed: true, score: 1 })).toBe('pass');
    expect(outcomeOf({ failureMode: 'wrong_answer', passed: false, score: 0.4 })).toBe('partial');
    expect(outcomeOf({ failureMode: 'wrong_answer', passed: false, score: 0 })).toBe('fail');
  });
});

describe('live state', () => {
  it('follows a run from start to end, with its phases and spend', () => {
    const state = setup();
    const runId = id('single', 'airline-easy', 1);
    applyRunnerEvent(state, { type: 'run-start', runId, index: 0, total: 8 }, T0);
    applyTraceEvent(state, runId, { seq: 1, tMs: 0, phase: 'agent', depth: 0, kind: 'phase_start' });
    applyTraceEvent(state, runId, { seq: 2, tMs: 1, phase: 'agent', depth: 0, kind: 'tool_denied', toolName: 'Bash' });

    expect(state.cells.get(runId)).toEqual({ kind: 'running' });
    expect(state.inFlight.get(runId)?.phases).toEqual(['agent']);
    expect(state.denied).toBe(1);

    applyTraceEvent(state, runId, { seq: 3, tMs: 2, phase: 'agent', depth: 0, kind: 'phase_end', costUsd: 0.03 });
    expect(spentSoFar(state)).toBeCloseTo(0.03);

    finish(state, runId, { score: 1, passed: true, failureMode: 'none', costUsd: 0.03, judgeCostUsd: 0.01 }, T0 + 5_000);
    expect(state.cells.get(runId)).toEqual({ kind: 'done', outcome: 'pass' });
    expect(state.inFlight.size).toBe(0);
    expect(state.finished).toBe(1);
    expect(state.counts.pass).toBe(1);
    expect(spentSoFar(state)).toBeCloseTo(0.04);
  });

  it('counts retries, API errors, integrity failures and discarded runs, and says what happened', () => {
    const state = setup();
    const a = id('single', 'airline-easy', 1);
    const b = id('plan-execute', 'airline-easy', 1);
    const c = id('single', 'airline-hard', 1);
    for (const runId of [a, b, c]) applyRunnerEvent(state, { type: 'run-start', runId, index: 0, total: 8 }, T0);

    applyRunnerEvent(state, { type: 'run-retry', runId: a, attempt: 1, error: 'overloaded 529: busy\nstack', delayMs: 6_000 }, T0);
    expect(state.cells.get(a)).toEqual({ kind: 'retrying', until: T0 + 6_000 });
    finish(state, a, { failureMode: 'api_error', error: 'API error (overloaded 529: busy)' }, T0);
    finish(state, b, { integrity: { ok: false, checks: [{ id: 'harness.mcp-connected', ok: false }] } }, T0);
    applyRunnerEvent(state, { type: 'run-interrupted', runId: c }, T0);

    expect(state).toMatchObject({ retries: 1, discarded: 1, finished: 2 });
    expect(state.counts).toMatchObject({ api_error: 1, integrity: 1 });
    expect(state.notices.join('\n')).toMatch(/attempt 1 failed at the API \(overloaded 529: busy\); retrying in 6\.0s/);
    expect(state.notices.join('\n')).toMatch(/integrity failed \(harness\.mcp-connected\)/);
    expect(state.notices).toHaveLength(3);
  });

  it('keeps what a discarded run had already spent, and does not call it progress', () => {
    const state = setup();
    const runId = id('single', 'airline-easy', 1);
    applyRunnerEvent(state, { type: 'run-start', runId, index: 0, total: 8 }, T0);
    applyTraceEvent(state, runId, { seq: 1, tMs: 0, phase: 'agent', depth: 0, kind: 'phase_start' });
    applyTraceEvent(state, runId, { seq: 2, tMs: 1, phase: 'agent', depth: 0, kind: 'phase_end', costUsd: 0.026 });
    applyRunnerEvent(state, { type: 'run-interrupted', runId }, T0 + 5_000);

    expect(state).toMatchObject({ finished: 0, discarded: 1 });
    expect(spentSoFar(state)).toBeCloseTo(0.026);
    expect(state.inFlight.size).toBe(0);
  });

  it('counts runs that had a call end on a model stop, and shows the count only once there is one', () => {
    const state = setup();
    const a = id('single', 'airline-easy', 1);
    applyRunnerEvent(state, { type: 'run-start', runId: a, index: 0, total: 8 }, T0);
    const frame = () => renderLiveFrame(state, { width: 110, height: 30, now: T0 + 1_000 }).map(plain).join('\n');
    expect(frame()).not.toMatch(/model stop/);

    finish(
      state,
      a,
      { failureMode: 'model_stop', modelStops: [{ phase: 'agent', callId: 'c1', reason: 'refusal' }] },
      T0 + 2_000,
    );
    expect(state.modelStops).toBe(1);
    expect(frame()).toMatch(/0 denied {3}1 model stop\b/);
  });

  it('draws cells an earlier session finished as they ended', () => {
    const recorded = new Map([
      [`${MODEL}|single|airline-easy|1`, makeRecord({ strategyId: 'single', taskId: 'airline-easy', score: 1, passed: true, failureMode: 'none' })],
    ]);
    const state = setup([MODEL], { recorded });
    expect(state.cells.get(id('single', 'airline-easy', 1))).toEqual({ kind: 'done', outcome: 'pass' });
    expect(state.finished).toBe(0);
  });
});

describe('renderLiveFrame', () => {
  it('draws the grid, one glyph per repeat, over a footer that adds up', () => {
    const state = setup();
    const run1 = id('single', 'airline-easy', 1);
    applyRunnerEvent(state, { type: 'run-start', runId: run1, index: 0, total: 8 }, T0);
    finish(state, run1, { score: 1, passed: true, failureMode: 'none', costUsd: 0.05 }, T0 + 20_000);
    const run2 = id('plan-execute', 'airline-easy', 1);
    applyRunnerEvent(state, { type: 'run-start', runId: run2, index: 1, total: 8 }, T0 + 20_000);
    applyTraceEvent(state, run2, { seq: 1, tMs: 0, phase: 'plan', depth: 0, kind: 'phase_start' });

    const lines = renderLiveFrame(state, { width: 100, height: 30, now: T0 + 30_000 }).map(plain);
    const text = lines.join('\n');

    expect(lines[0]).toBe(' ScaffoldBench  set-1  claude-haiku-4-5-20251001 · effort high · 2 repeats');
    expect(text).toMatch(/TASK\s+S\s+PE\n/);
    expect(text).toMatch(/airline-easy\s+● ·\s+[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] ·/);
    expect(text).toMatch(/airline-hard\s+· ·\s+· ·/);
    expect(text).toMatch(/1\/8 {2}12% {3}\$0\.050 of \$5\.00 {3}1 in flight {3}30\.0s {3}ETA 3m30s/);
    expect(text).toMatch(/● 1 pass {3}◑ 0 partial {3}✗ 0 fail {3}! 0 API errors {3}⊘ 0 integrity {3}↻ 0 retries {3}0 denied/);
    expect(text).toMatch(/plan-execute · airline-easy · r1 {3}plan {3}10\.0s/);
    expect(text).toMatch(/S single · PE plan-execute/);
    expect(text).toMatch(/Ctrl-C: start nothing new and let the runs in flight finish · twice: abort them/);
  });

  it('keeps the whole footer, ETA included, in 80 columns by leaving out tallies that are zero', () => {
    const state = setup();
    const run1 = id('single', 'airline-easy', 1);
    applyRunnerEvent(state, { type: 'run-start', runId: run1, index: 0, total: 8 }, T0);
    finish(state, run1, { score: 1, passed: true, failureMode: 'none', costUsd: 0.05 }, T0 + 20_000);
    applyRunnerEvent(state, { type: 'run-start', runId: id('plan-execute', 'airline-easy', 1), index: 1, total: 8 }, T0 + 20_000);

    const narrow = renderLiveFrame(state, { width: 80, height: 30, now: T0 + 30_000 }).map(plain);
    for (const line of narrow) expect(visibleWidth(line), line).toBeLessThanOrEqual(80);
    const text = narrow.join('\n');
    expect(text).toMatch(/1\/8 {2}12% {2}\$0\.050 of \$5\.00 {2}1 in flight {2}30\.0s {2}ETA 3m30s/);
    expect(text).toMatch(/● 1 pass {2}◑ 0 partial {2}✗ 0 fail$/m);
    expect(text).not.toMatch(/retries|denied|integrity/);

    // ...and says the zeros once there is room for them.
    const wide = renderLiveFrame(state, { width: 120, height: 30, now: T0 + 30_000 }).map(plain).join('\n');
    expect(wide).toMatch(/0 retries {3}0 denied/);
  });

  it('changes its hint as the stop progresses, and drops it from the final frame', () => {
    const state = setup();
    applyRunnerEvent(state, { type: 'run-start', runId: id('single', 'airline-easy', 1), index: 0, total: 8 }, T0);
    state.stage = 'draining';
    expect(renderLiveFrame(state, { width: 100, height: 30, now: T0 }).join('\n')).toMatch(
      /Stopping: waiting for 1 run in flight · Ctrl-C again to abort it/,
    );
    state.stage = 'aborting';
    expect(renderLiveFrame(state, { width: 100, height: 30, now: T0 }).join('\n')).toMatch(/Aborting the runs in flight/);
    const final = renderLiveFrame(state, { width: 100, height: 30, now: T0, live: false });
    expect(final.join('\n')).not.toMatch(/Ctrl-C/);
  });

  it('puts models side by side when they fit, and under one another when they do not', () => {
    const models = [MODEL, 'claude-sonnet-5-5', 'claude-opus-5-5'];
    const strategies = ['single', 'plan-execute', 'orchestrator-workers', 'plan-execute-verify', 'propose-select'];
    const state = setup(models, { strategies });
    const wide = renderLiveFrame(state, { width: 120, height: 40, now: T0 }).map(plain).join('\n');
    expect(wide).toMatch(/haiku-4-5\s+│ sonnet-5-5\s+│ opus-5-5/);

    const narrow = renderLiveFrame(state, { width: 50, height: 40, now: T0 }).map(plain);
    expect(narrow.filter((line) => /^ (haiku-4-5|sonnet-5-5|opus-5-5)$/.test(line))).toHaveLength(3);
  });

  it('never draws a line wider than the terminal, nor more lines than it has', () => {
    const models = [MODEL, 'claude-sonnet-5-5', 'claude-opus-5-5'];
    const state = setup(models);
    for (const [runId] of [...state.cells].slice(0, 6)) applyRunnerEvent(state, { type: 'run-start', runId, index: 0, total: 24 }, T0);
    for (const [width, height] of [
      [40, 12],
      [80, 24],
      [100, 30],
      [200, 60],
    ] as const) {
      const lines = renderLiveFrame(state, { width, height, now: T0, style: createStyle(true) });
      expect(lines.length, `${width}x${height}`).toBeLessThanOrEqual(height - 1);
      for (const line of lines) expect(visibleWidth(line), `${width}: ${plain(line)}`).toBeLessThanOrEqual(width);
    }
  });
});

describe('windowRows', () => {
  const rows = Array.from({ length: 20 }, (_, index) => ({ text: `row ${index}`, active: index === 12 }));

  it('keeps the first active row in view', () => {
    const { shown, above, below } = windowRows(rows, 8);
    expect(shown.map((row) => row.text)).toContain('row 12');
    expect(above + shown.length + below).toBe(20);
  });

  it('pins a stacked model header above a window that starts inside it', () => {
    const stacked = [
      { text: 'haiku', active: false, group: 'haiku', isGroupHeader: true },
      ...Array.from({ length: 10 }, (_, index) => ({ text: `task ${index}`, active: index === 8, group: 'haiku' })),
    ];
    const { shown } = windowRows(stacked, 5);
    expect(shown[0]?.text).toBe('haiku');
    expect(shown.map((row) => row.text)).toContain('task 8');
  });
});
