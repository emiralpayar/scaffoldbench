import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@anthropic-ai/claude-agent-sdk')>();
  const fake = await import('../../../packages/core/test/support/fakeClaudeCode');
  return { ...actual, query: fake.fakeQuery };
});

import { listJsonFiles, manifestPath, readJson, runsDir } from '@arena/core';
import type { RunSetManifest } from '@arena/core';

import { assistant, resetFake, setScript, sleep, success } from '../../../packages/core/test/support/fakeClaudeCode';
import { parseArgs } from '../src/args';
import type { RunArgs } from '../src/args';
import { EXIT_INTERRUPTED, runCommand } from '../src/commands/run';
import { fakeContext, plain } from './support';

/**
 * `arena run` end to end: the real command, runner, strategy, task and
 * `runQuery`, with only the SDK's `query` scripted. Nothing is spent.
 */

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'arena-cli-e2e-'));
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

describe('arena run', () => {
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
    expect(log).toMatch(/Resume with: arena run --resume e2e-1/);

    const stopped = await readJson<RunSetManifest>(manifestPath('e2e-1', root));
    expect(stopped).toMatchObject({ status: 'interrupted', stoppedBy: 'drain', completedRuns: 1, totalRuns: 4 });
    expect(await listJsonFiles(runsDir('e2e-1', root))).toHaveLength(1);

    // Resume: the run set's own settings, only the three missing cells.
    const second = fakeContext();
    const resumed = await runCommand(args('--resume', 'e2e-1', '--plain'), second.ctx);

    expect(resumed).toBe(0);
    expect(second.stderrText()).toMatch(/1 already recorded, 3 to run/);
    expect(second.stderrText()).not.toMatch(/\[\d\/4\] .*__airline-easy__r1 /);
    const complete = await readJson<RunSetManifest>(manifestPath('e2e-1', root));
    expect(complete).toMatchObject({ status: 'complete', completedRuns: 4, totalRuns: 4 });
    expect(complete.previousSessions).toHaveLength(1);
    expect(await listJsonFiles(runsDir('e2e-1', root))).toHaveLength(4);

    // The report covers the whole run set, both sessions.
    const report = plain(second.out.join('\n'));
    expect(report).toMatch(/HEALTH {2}4 of 4 runs ranked/);
    expect(report).toMatch(/single\s+4\s+0\.\d{3}/);
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

  it('plans without starting anything on --dry-run', async () => {
    setScript(async function* () {
      throw new Error('a dry run must not start a session');
    });
    const dry = fakeContext();
    expect(await runCommand(args(...MATRIX, '--dry-run'), dry.ctx)).toBe(0);
    const text = dry.stderrText();
    expect(text).toMatch(/Matrix\s+1 model × 1 strategy × 2 tasks × 2 repeats = 4 runs/);
    expect(text).toMatch(/Ceiling\s+\$2\.00 {2}4 runs × \$0\.50 cap/);
    expect(text).toMatch(/Dry run: nothing was started\./);
    expect(await listJsonFiles(runsDir('anything', root))).toHaveLength(0);
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
