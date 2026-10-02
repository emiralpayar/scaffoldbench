import { describe, expect, it } from 'vitest';

import { createLiveState } from '../src/live';
import { matrixCells } from '../src/plan';
import { PLAIN } from '../src/style';
import { LiveReporter, PlainReporter } from '../src/terminal';
import { makeRecord, plain } from './support';

const MODEL = 'claude-haiku-4-5-20251001';

function reporterState() {
  const cells = matrixCells([MODEL], ['single', 'plan-execute'], ['airline-easy'], 2);
  return createLiveState({
    runSetId: 'set-1',
    cells,
    recorded: new Map(),
    total: cells.length,
    effort: 'high',
    budgetUsd: 5,
    now: 0,
  });
}

function sink() {
  const chunks: string[] = [];
  return {
    chunks,
    stream: { write: (chunk: string) => (chunks.push(chunk), true), isTTY: false, columns: 100, rows: 30 },
    text: () => chunks.join(''),
  };
}

describe('PlainReporter', () => {
  it('writes one self-contained line per finished run, and says why a run is not a score', () => {
    const out = sink();
    const reporter = new PlainReporter(reporterState(), out.stream, PLAIN);
    const end = (index: number, overrides: Parameters<typeof makeRecord>[0]) =>
      reporter.onEvent({ type: 'run-end', record: makeRecord(overrides), index, total: 4 });

    end(0, { strategyId: 'single', taskId: 'airline-easy', repeat: 1, score: 1, passed: true, failureMode: 'none', costUsd: 0.051 });
    end(1, { strategyId: 'single', taskId: 'airline-easy', repeat: 2, score: 0, failureMode: 'model_stop', modelStops: [{ phase: 'agent', callId: 'c1', reason: 'refusal' }] });
    end(2, {
      strategyId: 'plan-execute',
      taskId: 'airline-easy',
      repeat: 1,
      failureMode: 'harness_error',
      integrity: { ok: false, checks: [{ id: 'harness.mcp-connected', ok: false }, { id: 'harness.api', ok: true }] },
    });
    end(3, { strategyId: 'plan-execute', taskId: 'airline-easy', repeat: 2, failureMode: 'api_error', error: 'API error (overloaded)\nstack' });

    const lines = out.text().trimEnd().split('\n');
    expect(lines[0]).toMatch(/^\[1\/4\] ● claude-haiku-4-5-20251001__single__airline-easy__r1 {2}1\.000 +\$0\.051 +30\.0s$/);
    expect(lines[1]).toMatch(/^\[2\/4\] ✗ .*__single__airline-easy__r2 .* model_stop: refused$/);
    expect(lines[2]).toMatch(/^\[3\/4\] ⊘ .*__plan-execute__airline-easy__r1 .* harness_error; integrity failed: harness\.mcp-connected$/);
    expect(lines[3]).toMatch(/^\[4\/4\] ! .*__plan-execute__airline-easy__r2 .* api_error: API error \(overloaded\)$/);
  });

  it('reports retries, stops and runs the stop cut off, each on a line of its own', () => {
    const out = sink();
    const state = reporterState();
    const reporter = new PlainReporter(state, out.stream, PLAIN);
    reporter.onEvent({ type: 'run-retry', runId: 'r', attempt: 1, error: 'overloaded\nmore', delayMs: 6_000 });
    reporter.onEvent({ type: 'budget-stop', spentUsd: 4.8 });
    reporter.onEvent({ type: 'run-interrupted', runId: 'r2' });
    reporter.onStop('draining');
    reporter.onStop('aborting');

    expect(out.text().trimEnd().split('\n')).toEqual([
      '↻ r: attempt 1 failed at the API (overloaded); retrying in 6.0s',
      'Total budget reached ($4.80 settled): no new runs will start.',
      '○ r2: cut off by the stop and discarded',
      'Stopping: no new runs will start; 0 in flight will finish. Interrupt again to abort them.',
      'Aborting the runs in flight; they are discarded and run again on --resume.',
    ]);
  });
});

describe('LiveReporter', () => {
  it('hides the cursor, redraws in place, and gives the cursor back', () => {
    const out = sink();
    const reporter = new LiveReporter(reporterState(), out.stream, PLAIN, () => 5_000);
    const hide = '\u001b[?25l';
    const show = '\u001b[?25h';
    expect(out.chunks[0]).toBe(hide);

    reporter.onStop('draining');
    const first = out.chunks.at(-1) ?? '';
    // The second frame starts by moving up over the lines of the first.
    expect(first).toMatch(/^\u001b\[\?2026h\u001b\[\d+F/);
    expect(plain(first)).toMatch(/Stopping: waiting for 0 runs in flight/);

    reporter.finish();
    reporter.finish();
    expect(out.chunks.filter((chunk) => chunk === show)).toHaveLength(1);
    const finalFrame = plain(out.chunks.at(-2) ?? '');
    expect(finalFrame).not.toMatch(/Ctrl-C/);
  });
});
