/** `scaffoldbench --version`: what is running, precisely enough to put in a bug report. */

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { REPO_ROOT, gitState, sdkVersions } from '@scaffoldbench/core';

import type { CliContext } from './context';

export async function packageVersion(): Promise<string | undefined> {
  try {
    const pkg = JSON.parse(await readFile(path.join(REPO_ROOT, 'package.json'), 'utf8')) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : undefined;
  } catch {
    return undefined;
  }
}

export async function versionCommand(ctx: CliContext): Promise<number> {
  const [version, git, sdk] = await Promise.all([packageVersion(), gitState(REPO_ROOT), sdkVersions()]);
  const style = ctx.outStyle;
  const commit = git.sha
    ? `commit ${git.sha.slice(0, 12)}${git.dirty ? style.warn(' (uncommitted changes)') : ''}`
    : style.dim('commit unknown (not a git checkout)');
  ctx.out(`${style.bold('scaffoldbench')} ${version ?? 'unknown'} · ${commit}`);
  ctx.out(
    style.dim(
      `Agent SDK ${sdk.agentSdkVersion ?? 'unknown'} · Claude Code ${sdk.claudeCodeVersion ?? 'unknown'} · ` +
        `Node ${process.version} · ${process.platform}-${process.arch}`,
    ),
  );
  return 0;
}
