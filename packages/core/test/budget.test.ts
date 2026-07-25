import { describe, expect, it } from 'vitest';
import { BudgetTracker, emptyUsage } from '@arena/core';

const usage = (input: number, output: number) => ({
  inputTokens: input,
  outputTokens: output,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
});

describe('BudgetTracker', () => {
  it('starts empty and not exceeded', () => {
    const b = new BudgetTracker({ maxCostUsd: 1, maxWallClockMs: 60_000, now: () => 0 });
    expect(b.spentUsd).toBe(0);
    expect(b.turns).toBe(0);
    expect(b.exceeded).toBe(false);
    expect(b.stopReason).toBeUndefined();
    expect(b.usage).toEqual(emptyUsage());
    expect(b.remainingUsd).toBe(1);
  });

  it('accumulates cost, turns and usage across charges', () => {
    const b = new BudgetTracker({ maxCostUsd: 10, maxWallClockMs: 60_000, now: () => 0 });
    b.charge({ costUsd: 0.25, turns: 3, usage: usage(100, 50) });
    b.charge({ costUsd: 0.5, turns: 2, usage: usage(200, 25) });

    expect(b.spentUsd).toBeCloseTo(0.75);
    expect(b.turns).toBe(5);
    expect(b.usage.inputTokens).toBe(300);
    expect(b.usage.outputTokens).toBe(75);
    expect(b.remainingUsd).toBeCloseTo(9.25);
  });

  it('trips on cost and reports the reason', () => {
    const b = new BudgetTracker({ maxCostUsd: 0.5, maxWallClockMs: 60_000, now: () => 0 });
    b.charge({ costUsd: 0.49, turns: 1, usage: usage(1, 1) });
    expect(b.exceeded).toBe(false);

    b.charge({ costUsd: 0.02, turns: 1, usage: usage(1, 1) });
    expect(b.exceeded).toBe(true);
    expect(b.stopReason).toBe('cost');
    expect(b.remainingUsd).toBe(0);
  });

  it('never reports a negative remaining budget', () => {
    const b = new BudgetTracker({ maxCostUsd: 0.1, maxWallClockMs: 60_000, now: () => 0 });
    b.charge({ costUsd: 5, turns: 1, usage: usage(1, 1) });
    expect(b.remainingUsd).toBe(0);
  });

  it('trips on wall clock without any charge', () => {
    let t = 0;
    const b = new BudgetTracker({ maxCostUsd: 100, maxWallClockMs: 1_000, now: () => t });
    expect(b.exceeded).toBe(false);

    t = 1_001;
    expect(b.exceeded).toBe(true);
    expect(b.stopReason).toBe('wallclock');
  });

  it('keeps the first stop reason once tripped', () => {
    let t = 0;
    const b = new BudgetTracker({ maxCostUsd: 0.1, maxWallClockMs: 1_000, now: () => t });
    b.charge({ costUsd: 0.2, turns: 1, usage: usage(1, 1) });
    expect(b.stopReason).toBe('cost');

    t = 5_000;
    expect(b.stopReason).toBe('cost');
  });

  it('returns a defensive copy of usage', () => {
    const b = new BudgetTracker({ maxCostUsd: 1, maxWallClockMs: 60_000, now: () => 0 });
    b.charge({ costUsd: 0, turns: 0, usage: usage(10, 10) });
    const snapshot = b.usage;
    snapshot.inputTokens = 9999;
    expect(b.usage.inputTokens).toBe(10);
  });

  it('tolerates partial usage deltas', () => {
    const b = new BudgetTracker({ maxCostUsd: 1, maxWallClockMs: 60_000, now: () => 0 });
    b.charge({ costUsd: 0, turns: 0, usage: { inputTokens: 5 } });
    expect(b.usage.inputTokens).toBe(5);
    expect(b.usage.outputTokens).toBe(0);
  });
});
