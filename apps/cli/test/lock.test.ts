import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { acquireRunSetLock, lockFile } from '../src/lock';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'arena-lock-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const ROOT = '/results';

describe('run set lock', () => {
  it('is taken once, says who holds it, and is free again after release', async () => {
    const first = await acquireRunSetLock(ROOT, 'set-1', { dir, now: () => new Date('2026-10-02T09:00:00.000Z') });
    expect(first.acquired).toBe(true);

    const second = await acquireRunSetLock(ROOT, 'set-1', { dir });
    expect(second).toMatchObject({
      acquired: false,
      holder: { pid: process.pid, startedAt: '2026-10-02T09:00:00.000Z' },
      file: lockFile(ROOT, 'set-1', dir),
    });

    if (first.acquired) await first.release();
    if (first.acquired) await first.release(); // idempotent
    const third = await acquireRunSetLock(ROOT, 'set-1', { dir });
    expect(third.acquired).toBe(true);
    if (third.acquired) await third.release();
  });

  it('is per run set and per results root', async () => {
    const a = await acquireRunSetLock(ROOT, 'set-1', { dir });
    const otherSet = await acquireRunSetLock(ROOT, 'set-2', { dir });
    const otherRoot = await acquireRunSetLock('/elsewhere', 'set-1', { dir });
    expect([a.acquired, otherSet.acquired, otherRoot.acquired]).toEqual([true, true, true]);
    for (const lock of [a, otherSet, otherRoot]) if (lock.acquired) await lock.release();
  });

  it('is taken over when its process is gone, however it died', async () => {
    // A pid no process has: far above any the kernel hands out.
    const gone = 2 ** 22 + 12345;
    await acquireRunSetLock(ROOT, 'set-1', { dir, pid: gone });
    const taken = await acquireRunSetLock(ROOT, 'set-1', { dir });
    expect(taken.acquired).toBe(true);
    expect(JSON.parse(await readFile(lockFile(ROOT, 'set-1', dir), 'utf8')).pid).toBe(process.pid);
    if (taken.acquired) await taken.release();
  });

  it('is taken over when the file is garbage, and left alone when it is somebody else\'s at release', async () => {
    await writeFile(lockFile(ROOT, 'set-1', dir), 'not json at all', 'utf8');
    const taken = await acquireRunSetLock(ROOT, 'set-1', { dir });
    expect(taken.acquired).toBe(true);

    // If another process has since taken the file over, releasing must not delete its lock.
    await writeFile(lockFile(ROOT, 'set-1', dir), `${JSON.stringify({ pid: 1, startedAt: 'later' })}\n`, 'utf8');
    if (taken.acquired) await taken.release();
    expect(JSON.parse(await readFile(lockFile(ROOT, 'set-1', dir), 'utf8')).pid).toBe(1);
  });
});
