import { describe, expect, it } from 'vitest';
import { BudgetTracker, TotalBudget, emptyUsage } from '@scaffoldbench/core';

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

  it('splits what is left between concurrent leases instead of handing each all of it', () => {
    const b = new BudgetTracker({ maxCostUsd: 0.75, maxWallClockMs: 60_000, now: () => 0 });
    const share = b.availableUsd / 4;
    const leases = [1, 2, 3, 4].map(() => b.reserve(share));

    expect(leases.map((lease) => lease.amountUsd)).toEqual([0.1875, 0.1875, 0.1875, 0.1875]);
    expect(b.availableUsd).toBe(0);
    // Reserved money is not spent money.
    expect(b.remainingUsd).toBe(0.75);
    expect(b.exceeded).toBe(false);
  });

  it('never reserves more than is available', () => {
    const b = new BudgetTracker({ maxCostUsd: 1, maxWallClockMs: 60_000, now: () => 0 });
    const first = b.reserve();
    const second = b.reserve(0.5);

    expect(first.amountUsd).toBe(1);
    expect(second.amountUsd).toBe(0);
  });

  it('returns the unspent part of a lease when it settles, once', () => {
    const b = new BudgetTracker({ maxCostUsd: 1, maxWallClockMs: 60_000, now: () => 0 });
    const lease = b.reserve(0.6);
    lease.settle({ costUsd: 0.25, turns: 2, usage: usage(10, 5) });
    lease.settle({ costUsd: 0.25, turns: 2, usage: usage(10, 5) });

    expect(b.spentUsd).toBeCloseTo(0.25);
    expect(b.turns).toBe(2);
    expect(b.availableUsd).toBeCloseTo(0.75);
  });

  it('records an overrun past the lease as spend', () => {
    // The SDK checks its budget after each turn, so a call can finish a turn
    // past its lease; the ledger records what was really spent.
    const b = new BudgetTracker({ maxCostUsd: 0.5, maxWallClockMs: 60_000, now: () => 0 });
    b.reserve().settle({ costUsd: 0.6, turns: 1, usage: usage(1, 1) });

    expect(b.spentUsd).toBeCloseTo(0.6);
    expect(b.exceeded).toBe(true);
    expect(b.availableUsd).toBe(0);
  });

  it('tolerates partial usage deltas', () => {
    const b = new BudgetTracker({ maxCostUsd: 1, maxWallClockMs: 60_000, now: () => 0 });
    b.charge({ costUsd: 0, turns: 0, usage: { inputTokens: 5 } });
    expect(b.usage.inputTokens).toBe(5);
    expect(b.usage.outputTokens).toBe(0);
  });
});

describe('TotalBudget', () => {
  it('reserves a run only while its whole cap fits beside spend and other reservations', () => {
    const total = new TotalBudget(2.5);
    const a = total.tryReserve(1);
    const b = total.tryReserve(1);

    expect(a?.amountUsd).toBe(1);
    expect(b?.amountUsd).toBe(1);
    // A third run would fit beside what is spent ($0) but not beside what the
    // two in flight may still spend.
    expect(total.tryReserve(1)).toBeUndefined();
    expect(total.inFlight).toBe(2);
    expect(total.reservedUsd).toBe(2);

    a?.settle(0.25);
    expect(total.spentUsd).toBe(0.25);
    expect(total.reservedUsd).toBe(1);
    expect(total.tryReserve(1)).toBeDefined();
  });

  it('counts a settlement once', () => {
    const total = new TotalBudget(10);
    const lease = total.tryReserve(1);
    lease?.settle(0.5);
    lease?.settle(0.5);

    expect(total.spentUsd).toBe(0.5);
    expect(total.inFlight).toBe(0);
    expect(total.reservedUsd).toBe(0);
  });

  it('lets a waiting run start when one in flight settles under its cap', async () => {
    const total = new TotalBudget(2.5);
    const first = total.tryReserve(1);
    const second = total.tryReserve(1);

    let started = false;
    const waiting = total.acquire(1).then((lease) => {
      started = true;
      return lease;
    });
    await Promise.resolve();
    expect(started).toBe(false);

    // $0.10 spent + $1 still reserved + the new $1 cap fits in $2.50.
    first?.settle(0.1);
    const third = await waiting;
    expect(third?.amountUsd).toBe(1);
    expect(total.inFlight).toBe(2);
    second?.settle(0);
  });

  it('keeps a run waiting while what is spent and reserved leaves no room for its cap', async () => {
    const total = new TotalBudget(2);
    const first = total.tryReserve(1);
    const second = total.tryReserve(1);

    let outcome: string | undefined;
    const waiting = total.acquire(1).then((lease) => {
      outcome = lease ? 'started' : 'gave up';
    });

    // $0.10 spent + $1 reserved + $1 is over $2: still waiting.
    first?.settle(0.1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(outcome).toBeUndefined();

    // Nothing in flight and still no room: the budget is spent.
    second?.settle(1);
    await waiting;
    expect(outcome).toBe('gave up');
  });

  it('gives up when nothing is in flight to free room', async () => {
    const total = new TotalBudget(1.5);
    total.tryReserve(1)?.settle(1);

    expect(await total.acquire(1)).toBeUndefined();
    expect(total.closed).toBe(false);
  });

  it('never starts a run whose cap exceeds the whole budget', async () => {
    expect(await new TotalBudget(0.5).acquire(1)).toBeUndefined();
  });

  it('releases every waiter when closed, and refuses further reservations', async () => {
    const total = new TotalBudget(1);
    const holder = total.tryReserve(1);
    const waiting = total.acquire(1);

    total.close();
    expect(await waiting).toBeUndefined();
    expect(total.closed).toBe(true);

    holder?.settle(0);
    expect(total.tryReserve(0.1)).toBeUndefined();
  });

  it('tolerates floating-point residue at the boundary', () => {
    const total = new TotalBudget(0.3);
    total.tryReserve(0.1)?.settle(0.1);
    total.tryReserve(0.1)?.settle(0.1);
    // 0.1 + 0.1 + 0.1 is 0.30000000000000004.
    expect(total.tryReserve(0.1)).toBeDefined();
  });
});
