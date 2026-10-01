import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { promisify } from 'node:util';

import { redactSecrets } from './credentials';
import { REPO_ROOT } from './paths';
import type { Provenance } from './types';

const execFileAsync = promisify(execFile);

const SDK_PACKAGE = '@anthropic-ai/claude-agent-sdk';

/**
 * Record what a session ran on: the commit and whether the working tree
 * matched it, the Agent SDK and the Claude Code CLI it bundles, Node, the
 * platform and the command line.
 *
 * Every field degrades to `null` rather than failing: a run set that cannot
 * say which commit produced it is weaker evidence, but it is not a reason to
 * refuse to run. (The hosted demo has no git checkout at all.)
 */
export async function collectProvenance(argv: readonly string[]): Promise<Provenance> {
  const [git, sdk] = await Promise.all([gitState(REPO_ROOT), sdkVersions()]);
  return {
    gitSha: git.sha,
    gitDirty: git.dirty,
    agentSdkVersion: sdk.agentSdkVersion,
    claudeCodeVersion: sdk.claudeCodeVersion,
    nodeVersion: process.version,
    platform: `${process.platform}-${process.arch}`,
    // Nothing on the arena's command line is a secret, but the manifest is
    // committed: anything key-shaped is masked all the same.
    argv: argv.map(redactSecrets),
  };
}

/**
 * HEAD, and whether tracked files differ from it.
 *
 * `results/` is left out of the dirty check — writing results is what a run
 * does, and a session that updated `results/latest.json` would otherwise mark
 * the next one dirty. Untracked files are left out too: they are scratch far
 * more often than code.
 */
export async function gitState(cwd: string): Promise<{ sha: string | null; dirty: boolean | null }> {
  const git = async (...args: string[]) =>
    (await execFileAsync('git', args, { cwd, timeout: 5_000 })).stdout;

  let sha: string | null = null;
  try {
    sha = (await git('rev-parse', 'HEAD')).trim() || null;
  } catch {
    return { sha: null, dirty: null };
  }

  try {
    const status = await git(
      'status',
      '--porcelain',
      '--untracked-files=no',
      '--',
      '.',
      ':(exclude)results',
    );
    return { sha, dirty: status.trim() !== '' };
  } catch {
    return { sha, dirty: null };
  }
}

/** The Agent SDK's version and the Claude Code CLI version it bundles. */
export async function sdkVersions(): Promise<{
  agentSdkVersion: string | null;
  claudeCodeVersion: string | null;
}> {
  for (const file of sdkPackageJsonCandidates()) {
    try {
      const pkg = JSON.parse(await readFile(file, 'utf8')) as {
        version?: unknown;
        claudeCodeVersion?: unknown;
      };
      return {
        agentSdkVersion: typeof pkg.version === 'string' ? pkg.version : null,
        claudeCodeVersion: typeof pkg.claudeCodeVersion === 'string' ? pkg.claudeCodeVersion : null,
      };
    } catch {
      // Try the next location.
    }
  }
  return { agentSdkVersion: null, claudeCodeVersion: null };
}

/**
 * Where the SDK's package.json may be. Its `exports` map does not expose the
 * file, so it is found next to the resolved entry point, falling back to the
 * workspace's hoisted `node_modules` when resolution is unavailable (bundled
 * into the web app, for one).
 */
function sdkPackageJsonCandidates(): string[] {
  const candidates: string[] = [];
  try {
    const entry = createRequire(import.meta.url).resolve(SDK_PACKAGE);
    candidates.push(path.join(path.dirname(entry), 'package.json'));
  } catch {
    // Fall through to the workspace location.
  }
  candidates.push(path.join(REPO_ROOT, 'node_modules', ...SDK_PACKAGE.split('/'), 'package.json'));
  return candidates;
}
