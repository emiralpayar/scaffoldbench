import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { RunRecord } from '../lib/records';
import { findRace } from '../lib/server/replays';
import type { RunSetData } from '../lib/server/runSet';
import { event, run } from './fixtures';

/**
 * The race on the landing page is "the designs at work". It must not include a
 * run the rest of the site throws out of every ranking.
 */
describe('findRace', () => {
  let dir: string;
  let data: RunSetData;

  const records: RunRecord[] = ['single', 'plan-execute', 'propose-select'].map((strategyId) =>
    run({ runId: `${strategyId}__alpha__r1`, strategyId, taskId: 'alpha' }),
  );
  // The most elaborate design failed its fidelity check.
  records[2] = {
    ...(records[2] as RunRecord),
    integrity: { ok: false, checks: [{ id: 'propose-select.proposals', ok: false, detail: 'starved' }] },
  };

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'scaffoldbench-race-'));
    await mkdir(path.join(dir, 'traces'));
    for (const record of records) {
      const line = JSON.stringify(event({ seq: 0, tMs: 0, kind: 'note', phase: 'main' }));
      await writeFile(path.join(dir, 'traces', `${record.runId}.jsonl`), `${line}\n`);
    }
    data = {
      runSetId: 'set-1',
      dir,
      manifest: null,
      catalog: { strategies: [], tasks: [] },
      records,
      models: ['claude-sonnet-5-5'],
      verification: 'verified',
    };
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('races every traced run by default, excluded or not', async () => {
    const race = await findRace(data);
    expect(race?.runs.map((r) => r.record.strategyId).sort()).toEqual(['plan-execute', 'propose-select', 'single']);
  });

  it('leaves out a run that is excluded from rankings when asked to', async () => {
    const race = await findRace(data, { rankableOnly: true });
    expect(race?.runs.map((r) => r.record.strategyId).sort()).toEqual(['plan-execute', 'single']);
  });

  it('has no race when fewer than two runs count', async () => {
    const lone: RunSetData = { ...data, records: [records[0] as RunRecord, records[2] as RunRecord] };
    expect(await findRace(lone, { rankableOnly: true })).toBeNull();
  });
});
