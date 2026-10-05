/**
 * One `scaffoldbench run` at a time per run set.
 *
 * Two processes resuming the same run set would each work out the cells it
 * lacks from the disk, run the same ones, spend twice what either planned
 * against its own total budget, and overwrite each other's manifest. A lock
 * file holding the owner's pid stops the second before it spends anything.
 *
 * The lock is advisory and per machine: it lives in the system's temporary
 * directory, not in the run set (a copy of `results/` must not carry it), and
 * it is the pid that makes it safe to leave behind. A lock whose process is
 * gone — killed, crashed, power cut — is taken over.
 */

import { createHash } from 'node:crypto';
import { rmSync } from 'node:fs';
import { mkdir, open, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

export interface LockHolder {
  pid: number;
  startedAt: string;
}

export type RunSetLock =
  | { acquired: true; release(): Promise<void> }
  | { acquired: false; holder: LockHolder; file: string };

/** Where the lock for a run set lives. `dir` is a test seam; the default is the system's temporary directory. */
export function lockFile(resultsRoot: string, runSetId: string, dir: string = path.join(tmpdir(), 'scaffoldbench-locks')): string {
  const key = createHash('sha256').update(`${path.resolve(resultsRoot)}\0${runSetId}`).digest('hex').slice(0, 24);
  return path.join(dir, `${key}.lock`);
}

/** Whether a process exists. A process of another user (EPERM) exists; one that is gone (ESRCH) does not. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function readHolder(file: string): Promise<LockHolder | undefined> {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as Partial<LockHolder>;
    return typeof parsed.pid === 'number' && Number.isInteger(parsed.pid)
      ? { pid: parsed.pid, startedAt: String(parsed.startedAt ?? '') }
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Take the lock for `runSetId`, or say who holds it. A lock file that cannot
 * be read or names a process that is gone is stale and is replaced.
 */
export async function acquireRunSetLock(
  resultsRoot: string,
  runSetId: string,
  options: { dir?: string; pid?: number; now?: () => Date } = {},
): Promise<RunSetLock> {
  const file = lockFile(resultsRoot, runSetId, options.dir);
  const pid = options.pid ?? process.pid;
  await mkdir(path.dirname(file), { recursive: true });

  // One retry: the first failure may be a stale lock that is removed below.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(file, 'wx');
      try {
        await handle.writeFile(`${JSON.stringify({ pid, startedAt: (options.now?.() ?? new Date()).toISOString() })}\n`);
      } finally {
        await handle.close();
      }
      let released = false;
      const release = async () => {
        if (released) return;
        released = true;
        process.off('exit', releaseSync);
        // Only our own lock: after a takeover the file is somebody else's.
        if ((await readHolder(file))?.pid === pid) await rm(file, { force: true });
      };
      // `process.exit` skips `finally`; an exit handler can only do synchronous work.
      const releaseSync = () => rmSync(file, { force: true });
      process.once('exit', releaseSync);
      return { acquired: true, release };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }

    // A file that cannot be read yet may be one its owner has created and not yet
    // written: look again before calling it stale.
    let holder = await readHolder(file);
    if (!holder) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      holder = await readHolder(file);
    }
    if (holder && alive(holder.pid)) return { acquired: false, holder, file };
    await rm(file, { force: true });
  }

  const holder = (await readHolder(file)) ?? { pid: 0, startedAt: '' };
  return { acquired: false, holder, file };
}
