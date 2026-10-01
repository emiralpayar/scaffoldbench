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
