import type {
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
 * The SDK enforces `maxBudgetUsd` per `query()` call, but a strategy such as
 * `best-of-n` makes several calls, so the run-level ceiling has to live here.
 * `remainingUsd` is fed back into each subsequent call so the two layers agree.
 */
export class BudgetTracker implements BudgetLedger {
  readonly #maxCostUsd: number;
  readonly #maxWallClockMs: number;
  readonly #now: () => number;
  readonly #startedAt: number;

  #spentUsd = 0;
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
