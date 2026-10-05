import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@anthropic-ai/claude-agent-sdk')>();
  const fake = await import('../../../packages/core/test/support/fakeClaudeCode');
  return { ...actual, query: fake.fakeQuery };
});

import { latestPointerPath, listJsonFiles, manifestPath, readJson, readJsonIfExists, runsDir, writeJson } from '@scaffoldbench/core';
import type { RunSetManifest } from '@scaffoldbench/core';

import { assistant, resetFake, setScript, sleep, success } from '../../../packages/core/test/support/fakeClaudeCode';
import { parseArgs } from '../src/args';
import type { RunArgs } from '../src/args';
import { EXIT_INTERRUPTED, runCommand } from '../src/commands/run';
import { fakeContext, plain } from './support';

/**
 * `scaffoldbench run` end to end: the real command, runner, strategy, task and
 * `runQuery`, with only the SDK's `query` scripted. Nothing is spent.
 */

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'scaffoldbench-cli-e2e-'));
  resetFake();
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function args(...argv: string[]): RunArgs {
  const parsed = parseArgs(['run', ...argv, '--results-dir', root], {});
  if (!parsed.ok || parsed.command !== 'run') throw new Error(parsed.ok ? parsed.command : parsed.error);
  return parsed.args;
}

/** One cell: list flags accumulate, so this is spelled out rather than built from MATRIX. */
const ONE_CELL = [
  '--strategies', 'single',
  '--tasks', 'airline-easy',
  '--models', 'claude-haiku-4-5-20251001',
  '--repeats', '1',
  '--max-cost', '0.5',
];

const MATRIX = [
  '--strategies', 'single',
  '--tasks', 'airline-easy,airline-medium',
  '--models', 'claude-haiku-4-5-20251001',
  '--repeats', '2',
  '--concurrency', '1',
  '--max-cost', '0.5',
  '--total-budget', '5',
];

describe('scaffoldbench run', () => {
  it('drains on the first Ctrl-C, records the run in flight, and resumes only what is missing', async () => {
    const first = fakeContext();
    let calls = 0;
    setScript(async function* () {
      calls += 1;
      // The first call is in flight when Ctrl-C arrives.
      if (calls === 1) first.signals.emit('SIGINT');
      await sleep(5);
      yield assistant('Nothing to do.');
      yield success({ text: 'Nothing to do.', costUsd: 0.01 });
    });

    const code = await runCommand(args(...MATRIX, '--run-set', 'e2e-1', '--plain'), first.ctx);

    expect(code).toBe(EXIT_INTERRUPTED);
    const log = first.stderrText();
    expect(log).toMatch(/Stopping: no new runs will start; 1 in flight will finish/);
    expect(log).toMatch(/\[1\/4\] [●◑✗] claude-haiku-4-5-20251001__single__airline-easy__r1/);
    expect(log).toMatch(/Resume with: scaffoldbench run --resume e2e-1/);
    expect(log).toMatch(/Stopped: 1 run recorded in \S+ this session · run set 1 of 4 · spent \$0\.010 this session/);

    const stopped = await readJson<RunSetManifest>(manifestPath('e2e-1', root));
    expect(stopped).toMatchObject({ status: 'interrupted', stoppedBy: 'drain', completedRuns: 1, totalRuns: 4 });
    expect(await listJsonFiles(runsDir('e2e-1', root))).toHaveLength(1);

    // Resume: the run set's own settings, only the three missing cells.
    const second = fakeContext();
    const resumed = await runCommand(args('--resume', 'e2e-1', '--plain'), second.ctx);

    expect(resumed).toBe(0);
    expect(second.stderrText()).toMatch(/1 already recorded, 3 to run/);
    expect(second.stderrText()).not.toMatch(/\[\d\/4\] .*__airline-easy__r1 /);
    // The second session says what it spent, apart from what the run set had spent before it.
    expect(second.stderrText()).toMatch(/spent \$0\.030 this session, \$0\.040 on the run set/);
    const complete = await readJson<RunSetManifest>(manifestPath('e2e-1', root));
    expect(complete).toMatchObject({ status: 'complete', completedRuns: 4, totalRuns: 4 });
    expect(complete.previousSessions).toHaveLength(1);
    expect(await listJsonFiles(runsDir('e2e-1', root))).toHaveLength(4);

    // The report covers the whole run set, both sessions.
    const report = plain(second.out.join('\n'));
    expect(report).toMatch(/HEALTH {2}4 of 4 runs ranked/);
    expect(report).toMatch(/single\s+4\s+0\.\d{3}/);
  });

  it('aborts on the second Ctrl-C, discards the run it cut off, and runs it again on resume', async () => {
    const first = fakeContext();
    let calls = 0;
    setScript(async function* (session) {
      calls += 1;
      if (calls === 1) {
        // Two presses while the first run is in flight: drain, then abort.
        first.signals.emit('SIGINT');
        first.signals.emit('SIGINT');
        await session.untilAborted();
      }
      yield assistant('Nothing to do.');
      yield success({ text: 'Nothing to do.', costUsd: 0.01 });
    });

    const code = await runCommand(args(...MATRIX, '--run-set', 'e2e-abort', '--plain'), first.ctx);

    expect(code).toBe(EXIT_INTERRUPTED);
    const log = first.stderrText();
    expect(log).toMatch(/Stopping: no new runs will start; 1 in flight will finish/);
    expect(log).toMatch(/Aborting the runs in flight; they are discarded and run again on --resume/);
    expect(log).toMatch(/cut off by the stop and discarded/);
    expect(log).toMatch(/Resume with: scaffoldbench run --resume e2e-abort/);
    // Nothing was recorded for the run that was cut off, and the manifest says why.
    expect(await listJsonFiles(runsDir('e2e-abort', root))).toHaveLength(0);
    expect(await readJson<RunSetManifest>(manifestPath('e2e-abort', root))).toMatchObject({
      status: 'interrupted',
      stoppedBy: 'signal',
      completedRuns: 0,
      totalRuns: 4,
    });
    // No run finished, so there is no report to render.
    expect(first.out.join('\n')).toBe('');

    const second = fakeContext();
    expect(await runCommand(args('--resume', 'e2e-abort', '--plain'), second.ctx)).toBe(0);
    expect(second.stderrText()).toMatch(/= 4 runs\n/);
    expect(await listJsonFiles(runsDir('e2e-abort', root))).toHaveLength(4);
  });

  it('moves the pointer the site follows only when asked, and says so either way', async () => {
    setScript(async function* () {
      yield success({ text: 'done', costUsd: 0.01 });
    });
    const quiet = fakeContext();
    expect(await runCommand(args(...ONE_CELL, '--run-set', 'e2e-ptr-a', '--plain'), quiet.ctx)).toBe(0);
    expect(await readJsonIfExists(latestPointerPath(root))).toBeUndefined();
    expect(quiet.stderrText()).toMatch(/results\/latest\.json, which the site shows, was left alone/);

    const moves = fakeContext();
    expect(await runCommand(args(...ONE_CELL, '--run-set', 'e2e-ptr-b', '--plain', '--update-latest'), moves.ctx)).toBe(0);
    expect(await readJson(latestPointerPath(root))).toEqual({ runSetId: 'e2e-ptr-b' });
    expect(moves.stderrText()).not.toMatch(/left alone/);
  });

  it('lets one process at a time run a run set, so a second resume cannot spend twice', async () => {
    let started!: () => void;
    const running = new Promise<void>((resolve) => (started = resolve));
    let finish!: () => void;
    const held = new Promise<void>((resolve) => (finish = resolve));
    setScript(async function* () {
      started();
      await held;
      yield success({ text: 'done', costUsd: 0.01 });
    });

    const first = fakeContext();
    const firstRun = runCommand(args(...ONE_CELL, '--run-set', 'e2e-lock', '--plain'), first.ctx);
    await running;

    // The same run set, named either way, is refused while the first run is in flight.
    for (const flags of [['--run-set', 'e2e-lock'], ['--resume', 'e2e-lock']]) {
      const second = fakeContext();
      expect(await runCommand(args(...flags, '--plain'), second.ctx)).toBe(1);
      expect(second.err.join('\n')).toMatch(new RegExp(`Run set "e2e-lock" is already being run by process ${process.pid} \\(started `));
      expect(second.err.join('\n')).toMatch(/spend twice/);
    }
    // A dry run only reads, and another run set is another run set.
    const dry = fakeContext();
    expect(await runCommand(args(...ONE_CELL, '--run-set', 'e2e-lock', '--dry-run'), dry.ctx)).toBe(0);

    finish();
    expect(await firstRun).toBe(0);

    // Released: the run set can be resumed now (there is nothing left to run).
    const after = fakeContext();
    expect(await runCommand(args('--resume', 'e2e-lock', '--plain'), after.ctx)).toBe(0);
    expect(after.stderrText()).toMatch(/Nothing to run: every cell of e2e-lock is recorded/);
  });

  it('will not resume a run set whose strategy was renamed, since it would run the new one into the old records', async () => {
    setScript(async function* () {
      yield success({ text: 'done', costUsd: 0.01 });
    });
    const once = fakeContext();
    expect(await runCommand(args(...ONE_CELL, '--run-set', 'e2e-renamed', '--plain'), once.ctx)).toBe(0);
    // The first published run set recorded `debate-select`, which is called `propose-select` now.
    const manifest = await readJson<RunSetManifest>(manifestPath('e2e-renamed', root));
    await writeJson(manifestPath('e2e-renamed', root), { ...manifest, strategyIds: ['debate-select'] });

    const again = fakeContext();
    expect(await runCommand(args('--resume', 'e2e-renamed', '--dry-run'), again.ctx)).toBe(1);
    expect(again.err.join('\n')).toMatch(
      /Run set "e2e-renamed" cannot be resumed: it was measured with strategies debate-select, which are now propose-select/,
    );
    expect(await listJsonFiles(runsDir('e2e-renamed', root))).toHaveLength(1);
  });

  it('refuses to write into a run set that already holds runs unless resuming', async () => {
    setScript(async function* () {
      yield success({ text: 'done', costUsd: 0.01 });
    });
    const once = fakeContext();
    expect(await runCommand(args(...ONE_CELL, '--run-set', 'e2e-2', '--plain'), once.ctx)).toBe(0);

    const again = fakeContext();
    const code = await runCommand(args(...ONE_CELL, '--run-set', 'e2e-2', '--plain'), again.ctx);
    expect(code).toBe(1);
    expect(again.err.join('\n')).toMatch(/already holds 1 run\. Resume it with --resume e2e-2/);
  });

  it('refuses to resume under a different measurement setting', async () => {
    setScript(async function* () {
      yield success({ text: 'done', costUsd: 0.01 });
    });
    const once = fakeContext();
    await runCommand(args(...ONE_CELL, '--run-set', 'e2e-3', '--plain'), once.ctx);

    const again = fakeContext();
    const code = await runCommand(args('--resume', 'e2e-3', '--repeats', '3', '--plain'), again.ctx);
    expect(code).toBe(1);
    expect(again.err.join('\n')).toMatch(/--repeats is 3, but the run set was measured with 1/);
  });

  it('defers a model to a later session of the same run set, and resume runs only its cells', async () => {
    setScript(async function* () {
      yield assistant('Nothing to do.');
      yield success({ text: 'Nothing to do.', costUsd: 0.01 });
    });
    const twoModels = [
      '--strategies', 'single',
      '--tasks', 'airline-easy',
      '--models', 'claude-haiku-4-5-20251001,claude-sonnet-5-5',
      '--repeats', '1',
      '--max-cost', '0.5',
      '--total-budget', '5',
      '--plain',
    ];

    const first = fakeContext();
    const code = await runCommand(
      args(...twoModels, '--run-set', 'e2e-defer', '--defer-models', 'claude-sonnet-5-5'),
      first.ctx,
    );
    expect(code).toBe(0);
    expect(first.stderrText()).toMatch(/0 already recorded, 1 deferred, 1 to run/);
    const firstRuns = await listJsonFiles(runsDir('e2e-defer', root));
    expect(firstRuns).toHaveLength(1);
    expect(firstRuns[0]).toMatch(/claude-haiku-4-5-20251001__single__airline-easy__r1/);
    const planned = await readJson<RunSetManifest>(manifestPath('e2e-defer', root));
    // The deferred model is part of the plan a resume is checked against.
    expect(planned.models).toEqual(['claude-haiku-4-5-20251001', 'claude-sonnet-5-5']);

    const second = fakeContext();
    expect(await runCommand(args('--resume', 'e2e-defer', '--plain'), second.ctx)).toBe(0);
    const allRuns = await listJsonFiles(runsDir('e2e-defer', root));
    expect(allRuns).toHaveLength(2);
    expect(second.stderrText()).not.toMatch(/claude-haiku-4-5-20251001__single__airline-easy__r1 /);
  });

  it('refuses to defer a model the run set does not measure, or every model it does', async () => {
    setScript(async function* () {
      throw new Error('nothing may start');
    });
    const unknown = fakeContext();
    expect(await runCommand(args(...ONE_CELL, '--defer-models', 'claude-opus-5-5', '--dry-run'), unknown.ctx)).toBe(1);
    expect(unknown.err.join('\n')).toMatch(/--defer-models names claude-opus-5-5, which this run set does not measure/);

    const everything = fakeContext();
    expect(await runCommand(args(...ONE_CELL, '--defer-models', 'claude-haiku-4-5-20251001', '--dry-run'), everything.ctx)).toBe(1);
    expect(everything.err.join('\n')).toMatch(/defers every model/);
  });

  it('refuses two models that would share a run id before it plans, instead of dying with a stack trace', async () => {
    setScript(async function* () {
      throw new Error('nothing may start');
    });
    const clash = fakeContext();
    const code = await runCommand(args(...ONE_CELL, '--models', 'claude/haiku,claude-haiku', '--dry-run'), clash.ctx);

    expect(code).toBe(1);
    expect(clash.err.join('\n')).toMatch(/"claude\/haiku" and "claude-haiku" would both be recorded as claude-haiku__single__airline-easy__r1/);
    expect(clash.stderrText()).not.toMatch(/Matrix/);
  });

  describe('on a terminal, with a run that can cost more than $5 on the default budget', () => {
    // 4 runs x $0.50 x 3 attempts is $6.00 of ceiling, and no --total-budget was typed.
    const UNCHOSEN = [
      '--strategies', 'single',
      '--tasks', 'airline-easy,airline-medium',
      '--models', 'claude-haiku-4-5-20251001',
      '--repeats', '2',
      '--concurrency', '1',
      '--max-cost', '0.5',
    ];
    const answering = (answer: string | undefined) => {
      const asked: string[] = [];
      const context = fakeContext({
        ask: async (question) => {
          asked.push(question);
          return answer;
        },
      });
      return { ...context, asked };
    };
    const script = () =>
      setScript(async function* () {
        yield success({ text: 'done', costUsd: 0.01 });
      });

    it('asks, says what it could cost, and starts nothing on anything but yes', async () => {
      script();
      for (const answer of ['', 'n', 'no', 'yes please', undefined]) {
        const declined = answering(answer);
        const code = await runCommand(args(...UNCHOSEN, '--run-set', 'e2e-ask-no', '--plain'), declined.ctx);

        expect(code, String(answer)).toBe(1);
        expect(declined.asked).toEqual(['This can spend up to $6.00 on the default budget. Start? [y/N] ']);
        expect(declined.stderrText()).toMatch(/Not started\. Choose a limit with --total-budget \(or pass --yes\)/);
      }
      expect(await listJsonFiles(runsDir('e2e-ask-no', root))).toHaveLength(0);
    });

    it('starts on y or yes', async () => {
      script();
      for (const [answer, runSet] of [['y', 'e2e-ask-y'], [' YES ', 'e2e-ask-yes']] as const) {
        const accepted = answering(answer);
        expect(await runCommand(args(...UNCHOSEN, '--run-set', runSet, '--plain'), accepted.ctx)).toBe(0);
        expect(accepted.asked).toHaveLength(1);
        expect(await listJsonFiles(runsDir(runSet, root))).toHaveLength(4);
      }
    });

    it('does not ask when the budget was typed, when --yes was, or when the run is small', async () => {
      script();
      const typed = answering('n');
      expect(await runCommand(args(...UNCHOSEN, '--total-budget', '25', '--run-set', 'e2e-ask-a', '--plain'), typed.ctx)).toBe(0);
      const waived = answering('n');
      expect(await runCommand(args(...UNCHOSEN, '--yes', '--run-set', 'e2e-ask-b', '--plain'), waived.ctx)).toBe(0);
      const small = answering('n');
      expect(await runCommand(args(...ONE_CELL, '--run-set', 'e2e-ask-c', '--plain'), small.ctx)).toBe(0);
      expect(typed.asked.length + waived.asked.length + small.asked.length).toBe(0);
    });

    it('does not ask a dry run, and cannot ask anyone who is not at a terminal', async () => {
      script();
      const dry = answering('n');
      expect(await runCommand(args(...UNCHOSEN, '--dry-run'), dry.ctx)).toBe(0);
      expect(dry.asked).toEqual([]);

      // fakeContext has no `ask`, as main.ts leaves it out unless stdin and stderr are terminals.
      const piped = fakeContext();
      expect(await runCommand(args(...UNCHOSEN, '--run-set', 'e2e-ask-d', '--plain'), piped.ctx)).toBe(0);
    });
  });

  it('plans without starting anything on --dry-run', async () => {
    setScript(async function* () {
      throw new Error('a dry run must not start a session');
    });
    const dry = fakeContext();
    expect(await runCommand(args(...MATRIX, '--dry-run'), dry.ctx)).toBe(0);
    const text = dry.stderrText();
    expect(text).toMatch(/Matrix\s+1 model × 1 strategy × 2 tasks × 2 repeats = 4 runs/);
    // 4 runs x $0.50 x 3 attempts is $6.00, above the $5.00 session budget, which binds.
    expect(text).toMatch(/Ceiling\s+\$5\.00 {2}total budget \$5\.00/);
    expect(text).toMatch(/tried up to 3 times, each attempt with a cap of its own/);
    expect(text).toMatch(/Dry run: nothing was started\./);
    expect(await listJsonFiles(runsDir('anything', root))).toHaveLength(0);
  });

  it('exits 1 and says so when every run hit an API error, since nothing was measured', async () => {
    // What a mistyped model id looks like: the API refuses every call, for free.
    setScript(async function* () {
      yield success({ isError: true, apiErrorStatus: 404, text: 'There is an issue with the selected model', costUsd: 0 });
    });
    const run = fakeContext();
    const code = await runCommand(args(...MATRIX, '--run-set', 'e2e-api', '--plain'), run.ctx);

    expect(code).toBe(1);
    const log = run.stderrText();
    expect(log).toMatch(/Finished: 4 runs recorded \(all hit an API error\)/);
    expect(log).toMatch(/Nothing was measured: every run hit an API error/);
    expect(log).toMatch(/Run them again with: scaffoldbench run --resume e2e-api/);
    // They are recorded, but a resume runs them again instead of keeping them.
    const resumed = fakeContext();
    expect(await runCommand(args('--resume', 'e2e-api', '--dry-run'), resumed.ctx)).toBe(0);
    expect(resumed.stderrText()).toMatch(/= 4 runs\n/);
    expect(resumed.stderrText()).not.toMatch(/already recorded/);
  });

  it('exits 0 but names the runs that hit an API error when only some did', async () => {
    let calls = 0;
    setScript(async function* () {
      calls += 1;
      if (calls === 1) {
        yield success({ isError: true, apiErrorStatus: 404, text: 'There is an issue with the selected model', costUsd: 0 });
      } else {
        yield success({ text: 'done', costUsd: 0.01 });
      }
    });
    const run = fakeContext();
    const code = await runCommand(args(...MATRIX, '--run-set', 'e2e-some', '--plain'), run.ctx);

    expect(code).toBe(0);
    expect(run.stderrText()).toMatch(/Finished: 4 runs recorded \(1 hit an API error\)/);
    expect(run.stderrText()).toMatch(/1 run hit an API error and was not scored\. Run it again with: scaffoldbench run --resume e2e-some/);
  });

  it('writes one line per run, not a frame it cannot fit, on a terminal too small for the live view', async () => {
    setScript(async function* () {
      yield success({ text: 'done', costUsd: 0.01 });
    });
    for (const size of [{ columns: 30, rows: 40 }, { columns: 110, rows: 5 }]) {
      const small = fakeContext({}, { tty: true, ...size });
      expect(await runCommand(args(...ONE_CELL, '--run-set', `e2e-small-${size.columns}`), small.ctx)).toBe(0);
      const raw = small.stderrText();
      expect(raw, JSON.stringify(size)).not.toContain('\u001b[?25l');
      expect(plain(raw)).toMatch(/\[1\/1\] [●◑✗] claude-haiku-4-5-20251001__single__airline-easy__r1/);
    }
  });

  it('draws the live grid on a terminal and gives the cursor back', async () => {
    setScript(async function* () {
      await sleep(5);
      yield success({ text: 'done', costUsd: 0.01 });
    });
    const live = fakeContext({}, { tty: true });
    expect(await runCommand(args(...MATRIX, '--run-set', 'e2e-live'), live.ctx)).toBe(0);

    const raw = live.stderrText();
    expect(raw).toContain('\u001b[?25l');
    expect(raw.lastIndexOf('\u001b[?25h')).toBeGreaterThan(raw.lastIndexOf('\u001b[?25l'));
    const frame = plain(raw);
    expect(frame).toMatch(/ScaffoldBench {2}e2e-live/);
    expect(frame).toMatch(/4\/4 {2}100%/);
  });
});
