import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { REPO_ROOT, collectProvenance, gitState, sdkVersions } from '@arena/core';

describe('gitState', () => {
  let repo: string;
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], {
      cwd: repo,
      stdio: 'pipe',
    }).toString();

  beforeEach(async () => {
    repo = await mkdtemp(path.join(tmpdir(), 'arena-provenance-'));
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  async function commitBaseline(): Promise<void> {
    git('init', '-q');
    await writeFile(path.join(repo, 'code.ts'), 'export const a = 1;\n');
    await mkdir(path.join(repo, 'results'));
    await writeFile(path.join(repo, 'results', 'latest.json'), '{ "runSetId": "a" }\n');
    git('add', '.');
    git('commit', '-q', '-m', 'baseline');
  }

  it('reports the commit and a clean tree', async () => {
    await commitBaseline();
    const state = await gitState(repo);
    expect(state.sha).toBe(git('rev-parse', 'HEAD').trim());
    expect(state.dirty).toBe(false);
  });

  it('flags uncommitted changes to tracked code', async () => {
    await commitBaseline();
    await writeFile(path.join(repo, 'code.ts'), 'export const a = 2;\n');
    expect((await gitState(repo)).dirty).toBe(true);
  });

  it('ignores results, which a run writes, and untracked files', async () => {
    await commitBaseline();
    await writeFile(path.join(repo, 'results', 'latest.json'), '{ "runSetId": "b" }\n');
    await writeFile(path.join(repo, 'scratch.txt'), 'notes\n');
    expect((await gitState(repo)).dirty).toBe(false);
  });

  it('says nothing rather than failing outside a repository', async () => {
    expect(await gitState(repo)).toEqual({ sha: null, dirty: null });
  });
});

describe('sdkVersions', () => {
  it('reads the Agent SDK and the Claude Code CLI it bundles', async () => {
    const pkg = JSON.parse(
      await readFile(
        path.join(REPO_ROOT, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'package.json'),
        'utf8',
      ),
    ) as { version: string; claudeCodeVersion: string };

    expect(await sdkVersions()).toEqual({
      agentSdkVersion: pkg.version,
      claudeCodeVersion: pkg.claudeCodeVersion,
    });
  });
});

describe('collectProvenance', () => {
  it('records the runtime and the command line, with anything key-shaped masked', async () => {
    const argv = ['run', '--strategies', 'single', '--note', 'key sk-ant-api03-abcdefghijklmnop'];
    const provenance = await collectProvenance(argv);

    expect(provenance.nodeVersion).toBe(process.version);
    expect(provenance.platform).toBe(`${process.platform}-${process.arch}`);
    expect(provenance.argv).toEqual([
      'run',
      '--strategies',
      'single',
      '--note',
      'key sk-ant-***redacted***',
    ]);
    expect(provenance.agentSdkVersion).toMatch(/^\d+\.\d+\.\d+/);
    expect(provenance.claudeCodeVersion).toMatch(/^\d+\.\d+\.\d+/);
    const git = await gitState(REPO_ROOT);
    expect({ sha: provenance.gitSha, dirty: provenance.gitDirty }).toEqual(git);
  });
});
