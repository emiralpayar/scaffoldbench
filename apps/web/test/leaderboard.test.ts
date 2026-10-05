import { describe, expect, it } from 'vitest';

import { analyzeForSite } from '../lib/analysis';
import { leaderboardRows, rankLabel, scoreDomain } from '../lib/leaderboard';
import type { RunRecord } from '../lib/records';
import { run } from './fixtures';

function records(): RunRecord[] {
  const out: RunRecord[] = [];
  const add = (strategyId: string, score: (t: number) => number, extra: Partial<RunRecord> = {}) => {
    for (let t = 0; t < 12; t++) {
      for (const repeat of [1, 2]) {
        out.push(
          run({
            runId: `${strategyId}__t${t}__r${repeat}`,
            strategyId,
            taskId: `t${t}`,
            repeat,
            score: score(t),
            passed: score(t) >= 0.999,
            integrity: { ok: true, checks: [] },
            ...extra,
          }),
        );
      }
    }
  };
  add('single', (t) => 0.5 + t * 0.01);
  add('plan-execute', (t) => 0.9 + t * 0.01);
  // Within noise of single: it scores above on some tasks and below on others.
  add('gated-execute', (t) => [0.63, 0.48, 0.65, 0.5, 0.63, 0.52, 0.61, 0.47, 0.66, 0.51, 0.62, 0.53][t] as number);
  out.push(run({ runId: 'lost', strategyId: 'gated-execute', failureMode: 'api_error', taskId: 't0', repeat: 3 }));
  return out;
}

describe('leaderboardRows', () => {
  const [model] = analyzeForSite(records()).models;

  it('orders rows by rank and says when a rank is shared', () => {
    const rows = leaderboardRows(model!, 'single', { ranked: true });
    expect(rows.map((row) => [row.strategyId, rankLabel(row)])).toEqual([
      ['plan-execute', '1'],
      ['gated-execute', '=2'],
      ['single', '=2'],
    ]);
  });

  it('keeps the excluded runs visible beside the ranked ones', () => {
    const gated = leaderboardRows(model!, 'single', { ranked: true }).find((row) => row.strategyId === 'gated-execute');
    expect(gated).toMatchObject({ ranked: 24, total: 25, apiErrors: 1, verdict: expect.any(String) });
    expect(leaderboardRows(model!, 'single', { ranked: true }).find((r) => r.strategyId === 'single')?.verdict).toBe(
      'control',
    );
  });

  it('draws no rank for a run set that cannot support one', () => {
    const rows = leaderboardRows(model!, 'single', { ranked: false });
    expect(rows.every((row) => row.rank === null && rankLabel(row) === '—')).toBe(true);
    expect(rows[0]?.strategyId).toBe('plan-execute');
  });
});

describe('scoreDomain', () => {
  it('zooms to the data and stays inside 0–1, even when every run scored 1', () => {
    const e = (mean: number, low: number, high: number) => ({ score: { mean, ci: { low, high } } });
    expect(scoreDomain([e(1, 1, 1)])).toEqual([0.9, 1]);
    // No interval: the axis still holds the point.
    expect(scoreDomain([{ score: { mean: 0.62, ci: null } }, e(0.9, 0.84, 0.95)])[0]).toBeLessThanOrEqual(0.62);
    const [lo, hi] = scoreDomain([e(0.62, 0.55, 0.7), e(0.9, 0.84, 0.95)]);
    expect(lo).toBeLessThanOrEqual(0.55);
    expect(hi).toBeGreaterThanOrEqual(0.95);
    expect(hi).toBeLessThanOrEqual(1);
  });
});
