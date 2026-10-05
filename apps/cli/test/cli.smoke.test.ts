import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { REPO_ROOT } from '@scaffoldbench/core';

/**
 * The real entry point in a real process: what `npm run bench` and a future
 * npm `bin` symlink run. Every command here is free.
 */

const run = promisify(execFile);
const MAIN = path.join(REPO_ROOT, 'apps', 'cli', 'src', 'main.ts');

interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

async function scaffoldbench(args: string[], env: NodeJS.ProcessEnv = {}, entry = MAIN): Promise<Result> {
  const base = { ...process.env };
  // Nothing from the developer's shell may change what these tests see.
  for (const name of ['FORCE_COLOR', 'NO_COLOR', 'SCAFFOLDBENCH_MODEL', 'SCAFFOLDBENCH_RESULTS_DIR', 'SCAFFOLDBENCH_REPO_ROOT', 'INIT_CWD']) {
    delete base[name];
  }
  try {
    const { stdout, stderr } = await run(process.execPath, ['--import', 'tsx', entry, ...args], {
      cwd: REPO_ROOT,
      env: { ...base, ...env },
      timeout: 60_000,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failed.code ?? -1, stdout: failed.stdout ?? '', stderr: failed.stderr ?? '' };
  }
}

let scratch: string;
beforeAll(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), 'scaffoldbench-cli-smoke-'));
});
afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe.concurrent('the scaffoldbench command', () => {
  it('prints its version, commit and SDK', async () => {
    const result = await scaffoldbench(['--version']);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/^scaffoldbench \d+\.\d+\.\d+ · commit /);
    expect(result.stdout).toMatch(/Agent SDK \d+\.\d+\.\d+ · Claude Code \d+\.\d+\.\d+ · Node v\d+/);
  });

  it('runs through a symlink, as an npm bin entry would', async () => {
    const link = path.join(scratch, 'scaffoldbench-link.ts');
    await symlink(MAIN, link);
    const result = await scaffoldbench(['strategies'], {}, link);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/^STRATEGIES \(\d+\)/);
  });

  it('renders the committed run set, data on stdout and nothing else', async () => {
    const result = await scaffoldbench(['report', '2026-07-25T20-18-35Z-3fs5']);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/HEALTH/);
    expect(result.stdout).toMatch(/LEADERBOARD/);
    expect(result.stderr).toBe('');
    // Piped output carries no escape codes.
    expect(result.stdout).not.toContain('\u001b[');
  });

  it('colours when FORCE_COLOR asks, even into a pipe', async () => {
    const result = await scaffoldbench(['tasks'], { FORCE_COLOR: '1' });
    expect(result.stdout).toContain('\u001b[1m');
  });

  it('fails a usage error briefly, on stderr, with exit 1', async () => {
    const result = await scaffoldbench(['run', '--strategy', 'single']);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/^error: Unknown flag: --strategy\. Did you mean --strategies\?/);
    expect(result.stderr).toMatch(/Run "scaffoldbench help run" for usage\./);
  });

  it('loads .env from the repository root, letting the shell win', async () => {
    const root = path.join(scratch, 'repo');
    await mkdir(root, { recursive: true });
    await writeFile(path.join(root, '.env'), 'SCAFFOLDBENCH_MODEL=claude-from-dotenv\nSCAFFOLDBENCH_JUDGE_MODEL=judge-from-dotenv\n');
    const result = await scaffoldbench(
      ['run', '--strategies', 'single', '--tasks', 'airline-easy', '--repeats', '1', '--dry-run'],
      { SCAFFOLDBENCH_REPO_ROOT: root, SCAFFOLDBENCH_JUDGE_MODEL: 'judge-from-shell' },
    );
    expect(result.code).toBe(0);
    expect(result.stderr).toMatch(/Model\s+claude-from-dotenv/);
    expect(result.stderr).toMatch(/judge-from-shell/);
    expect(result.stderr).toMatch(/Dry run: nothing was started/);
  });
});
