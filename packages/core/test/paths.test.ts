import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  assertValidRunSetId,
  cellKey,
  isValidRunSetId,
  makeRunId,
  makeRunSetId,
  writeJson,
} from '@arena/core';

describe('run set ids', () => {
  it('accepts the ids the runner generates and ordinary names', () => {
    expect(isValidRunSetId(makeRunSetId(new Date('2026-10-02T09:15:00Z'), 'ab12'))).toBe(true);
    expect(isValidRunSetId('scaffold-or-scale_v1.2')).toBe(true);
    expect(isValidRunSetId('demo-synthetic')).toBe(true);
  });

  it.each([
    ['a parent directory', '../evil'],
    ['a nested parent directory', 'ok/../../evil'],
    ['an absolute path', '/etc'],
    ['a separator', 'a/b'],
    ['a Windows separator', 'a\\b'],
    ['a leading dot', '.hidden'],
    ['the current directory', '.'],
    ['an empty id', ''],
    ['whitespace', 'run set'],
    ['a NUL byte', 'a\0b'],
    ['an id longer than 100 characters', 'a'.repeat(101)],
  ])('refuses %s', (_label, id) => {
    expect(isValidRunSetId(id)).toBe(false);
    expect(() => assertValidRunSetId(id)).toThrow(/Invalid run set id/);
  });
});

describe('cell identity', () => {
  const cell = { model: 'claude-sonnet-5-5', strategyId: 'single', taskId: 'airline-easy', repeat: 2 };

  it('names a run after every coordinate of its cell, model first', () => {
    expect(makeRunId(cell)).toBe('claude-sonnet-5-5__single__airline-easy__r2');
  });

  it('keeps run ids file- and URL-safe whatever the model id looks like', () => {
    expect(makeRunId({ ...cell, model: 'claude-opus-4-6[1m]' })).toBe(
      'claude-opus-4-6-1m-__single__airline-easy__r2',
    );
    expect(makeRunId({ ...cell, model: 'us.anthropic/claude:x' })).toBe(
      'us.anthropic-claude-x__single__airline-easy__r2',
    );
  });

  it('keys a cell by its coordinates as given, for resuming', () => {
    expect(cellKey(cell)).toBe('claude-sonnet-5-5|single|airline-easy|2');
    expect(cellKey({ ...cell, model: 'claude-opus-4-6[1m]' })).toBe(
      'claude-opus-4-6[1m]|single|airline-easy|2',
    );
  });
});

describe('writeJson', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'arena-paths-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('replaces the file whole and leaves no temporary file behind', async () => {
    const file = path.join(dir, 'nested', 'manifest.json');
    await writeJson(file, { status: 'running' });
    await writeJson(file, { status: 'complete' });

    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ status: 'complete' });
    expect(await readdir(path.dirname(file))).toEqual(['manifest.json']);
  });

  it('keeps concurrent writers from leaving a torn file', async () => {
    const file = path.join(dir, 'manifest.json');
    const big = (n: number) => ({ n, padding: 'x'.repeat(200_000) });
    await Promise.all(Array.from({ length: 8 }, (_, n) => writeJson(file, big(n))));

    const parsed = JSON.parse(await readFile(file, 'utf8')) as { n: number; padding: string };
    expect(parsed.padding).toHaveLength(200_000);
    expect(await readdir(dir)).toEqual(['manifest.json']);
  });
});
