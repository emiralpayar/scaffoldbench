import type {
  BudgetLease,
  BudgetLedger,
  BudgetStopReason,
  ChargeDelta,
  UsageTotals,
} from './types';

export interface BudgetOptions {
  /** Hard ceiling for the whole run, across every `query()` call a strategy makes. */
  maxCostUsd: number;
  maxWallClockMs: number;
  /** Injected in tests so wall-clock logic is deterministic. */
  now?: () => number;
}

export function emptyUsage(): UsageTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
  };
}

/**
 * Tracks spend across every model call in a single run.
 *
 * The SDK enforces `maxBudgetUsd` per `query()` call, but a strategy makes
 * several calls, some of them at once, so the run-level ceiling has to live
 * here. Each call reserves a lease before it starts and hands the lease to
 * the SDK as its `maxBudgetUsd`; the reservation is taken out of what is
 * available, so concurrent calls split the remainder instead of each being
 * handed all of it. (They used to be: four parallel workers under a $0.75 cap
 * could spend $2.80.)
 *
 * The cap is soft by at most one turn per call in flight, because the SDK
 * checks its budget after each turn rather than mid-turn.
 */
export class BudgetTracker implements BudgetLedger {
  readonly #maxCostUsd: number;
  readonly #maxWallClockMs: number;
  readonly #now: () => number;
  readonly #startedAt: number;

  #spentUsd = 0;
  #reservedUsd = 0;
  #usage: UsageTotals = emptyUsage();
  #turns = 0;
  #stopReason: BudgetStopReason | undefined;

  constructor(options: BudgetOptions) {
    this.#maxCostUsd = options.maxCostUsd;
    this.#maxWallClockMs = options.maxWallClockMs;
    this.#now = options.now ?? Date.now;
    this.#startedAt = this.#now();
  }

  get spentUsd(): number {
    return this.#spentUsd;
  }

  get usage(): UsageTotals {
    return { ...this.#usage };
  }

  get turns(): number {
    return this.#turns;
  }

  get elapsedMs(): number {
    return this.#now() - this.#startedAt;
  }

  get remainingUsd(): number {
    return Math.max(0, this.#maxCostUsd - this.#spentUsd);
  }

  get availableUsd(): number {
    return Math.max(0, this.#maxCostUsd - this.#spentUsd - this.#reservedUsd);
  }

  reserve(capUsd?: number): BudgetLease {
    const wanted = capUsd === undefined ? this.availableUsd : Math.max(0, capUsd);
    const amountUsd = Math.min(wanted, this.availableUsd);
    this.#reservedUsd += amountUsd;

    let settled = false;
    return {
      amountUsd,
      settle: (delta: ChargeDelta) => {
        if (settled) return;
        settled = true;
        // Floating-point residue must not leave a phantom reservation behind.
        this.#reservedUsd = Math.max(0, this.#reservedUsd - amountUsd);
        this.charge(delta);
      },
    };
  }

  get stopReason(): BudgetStopReason | undefined {
    // Re-evaluate wall clock lazily so a stalled run trips without a charge.
    if (this.#stopReason === undefined && this.elapsedMs >= this.#maxWallClockMs) {
      this.#stopReason = 'wallclock';
    }
    return this.#stopReason;
  }

  get exceeded(): boolean {
    return this.stopReason !== undefined;
  }

  charge(delta: ChargeDelta): void {
    this.#spentUsd += delta.costUsd;
    this.#turns += delta.turns;
    for (const key of Object.keys(this.#usage) as (keyof UsageTotals)[]) {
      this.#usage[key] += delta.usage[key] ?? 0;
    }
    if (this.#stopReason === undefined && this.#spentUsd >= this.#maxCostUsd) {
      this.#stopReason = 'cost';
    }
  }
}

/** A share of the total budget held by one run in flight. */
export interface BudgetReservation {
  readonly amountUsd: number;
  /** Record what the run spent and give the reservation back. Only the first call counts. */
  settle(spentUsd: number): void;
}

/** Slack for floating-point sums of dollar amounts. */
const EPSILON_USD = 1e-9;

/**
 * The ceiling for a whole session of the matrix.
 *
 * A run starts only when its full per-run cap fits beside everything already
 * spent and everything reserved by the runs in flight. Gating on completed
 * spend alone, as the first version did, let every worker start a run just
 * under the line and overshoot by up to `concurrency` runs' worth.
 *
 * Every run gets the same cap: a last run squeezed into whatever was left
 * would be measured under a tighter ceiling than its siblings. So a run that
 * does not fit waits for one in flight to finish, and when none is in flight
 * it never will — the budget is spent.
 *
 * What a run spent is charged when it settles, judge calls included. No
 * per-run cap bounds grading, so grading spend counts against the total but
 * is not reserved in advance, and the per-run cap itself is soft by up to one
 * turn per call (see `BudgetTracker`).
 */
export class TotalBudget {
  readonly totalUsd: number;
  #spentUsd = 0;
  #reservedUsd = 0;
  #inFlight = 0;
  #closed = false;
  #waiters: (() => void)[] = [];

  constructor(totalUsd: number) {
    this.totalUsd = totalUsd;
  }

  get spentUsd(): number {
    return this.#spentUsd;
  }

  get reservedUsd(): number {
    return this.#reservedUsd;
  }

  get inFlight(): number {
    return this.#inFlight;
  }

  /** True once `close()` was called: nothing more will be reserved. */
  get closed(): boolean {
    return this.#closed;
  }

  /** Reserve `amountUsd` if it fits now; `undefined` if it does not or the budget is closed. */
  tryReserve(amountUsd: number): BudgetReservation | undefined {
    if (this.#closed) return undefined;
    if (this.#spentUsd + this.#reservedUsd + amountUsd > this.totalUsd + EPSILON_USD) {
      return undefined;
    }

    this.#reservedUsd += amountUsd;
    this.#inFlight += 1;
    let settled = false;
    return {
      amountUsd,
      settle: (spentUsd: number) => {
        if (settled) return;
        settled = true;
        this.#reservedUsd = Math.max(0, this.#reservedUsd - amountUsd);
        this.#inFlight -= 1;
        this.#spentUsd += spentUsd;
        this.#wake();
      },
    };
  }

  /**
   * Reserve `amountUsd`, waiting for runs in flight to settle if it does not
   * fit yet. Resolves `undefined` when the budget is closed, or when nothing
   * is in flight and it still does not fit — check `closed` to tell which.
   */
  async acquire(amountUsd: number): Promise<BudgetReservation | undefined> {
    for (;;) {
      const reservation = this.tryReserve(amountUsd);
      if (reservation || this.#closed || this.#inFlight === 0) return reservation;
      await new Promise<void>((resolve) => this.#waiters.push(resolve));
    }
  }

  /** Refuse every further reservation and release everyone waiting for one. */
  close(): void {
    this.#closed = true;
    this.#wake();
  }

  #wake(): void {
    const waiters = this.#waiters;
    this.#waiters = [];
    for (const wake of waiters) wake();
  }
}
