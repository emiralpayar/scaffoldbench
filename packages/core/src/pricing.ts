import type { UsageTotals } from './types';

/**
 * List prices used to estimate the cost of a call that never reported one.
 *
 * The SDK prices every call itself and reports the total on the terminal
 * `result` message, and that figure is always preferred. A call that is
 * aborted (wall clock, budget, a parent abort) or whose subprocess crashes
 * ends without a result, yet the tokens it streamed were still billed.
 * Charging such a call $0 made timed-out runs look cheap and inflated
 * score-per-dollar for exactly the runs that went worst, so instead the
 * streamed usage is priced here.
 *
 * USD per million tokens: Anthropic first-party list prices as published in
 * late September 2026. Cache reads are priced per model because the discount
 * differs (0.1× input on most models, 0.05× on Opus 5.5, 0.025× on Fable
 * 5.1). Cache writes bill at 1.25× input for the five-minute TTL and 2× for
 * the one-hour TTL. A model missing from this table cannot be estimated: its
 * streamed usage is reported as unpriced rather than guessed at.
 */
export interface ModelPrice {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok: number;
}

export const CACHE_WRITE_5M_MULTIPLIER = 1.25;
export const CACHE_WRITE_1H_MULTIPLIER = 2;

const PRICE_TABLE: readonly { family: string; price: ModelPrice }[] = [
  { family: 'claude-haiku-4-5', price: { inputPerMTok: 1, outputPerMTok: 5, cacheReadPerMTok: 0.1 } },
  { family: 'claude-sonnet-5-5', price: { inputPerMTok: 2, outputPerMTok: 10, cacheReadPerMTok: 0.2 } },
  { family: 'claude-opus-5-5', price: { inputPerMTok: 4, outputPerMTok: 20, cacheReadPerMTok: 0.2 } },
  { family: 'claude-fable-5-1', price: { inputPerMTok: 10, outputPerMTok: 50, cacheReadPerMTok: 0.25 } },
];

/** Token counts to price. `cacheCreation1hInputTokens` is the one-hour-TTL share of the cache writes. */
export interface PricedUsage extends Partial<UsageTotals> {
  cacheCreation1hInputTokens?: number;
}

/**
 * The list price for a model id, matched by family so dated snapshots
 * (`claude-haiku-4-5-20251001`) and provider-prefixed ids resolve too.
 */
export function priceFor(model: string): ModelPrice | undefined {
  const id = model.toLowerCase();
  return PRICE_TABLE.find(({ family }) => {
    const at = id.indexOf(family);
    if (at === -1) return false;
    // `claude-opus-5-5` must not match a hypothetical `claude-opus-5-50`.
    return !/[0-9]/.test(id.charAt(at + family.length));
  })?.price;
}

/** Estimated USD for `usage` on `model`, or `undefined` when the model has no known price. */
export function estimateCostUsd(model: string, usage: PricedUsage): number | undefined {
  const price = priceFor(model);
  if (!price) return undefined;
  const cacheWrites = usage.cacheCreationInputTokens ?? 0;
  const longWrites = Math.min(cacheWrites, usage.cacheCreation1hInputTokens ?? 0);
  const perMTok =
    (usage.inputTokens ?? 0) * price.inputPerMTok +
    (usage.outputTokens ?? 0) * price.outputPerMTok +
    (usage.cacheReadInputTokens ?? 0) * price.cacheReadPerMTok +
    (cacheWrites - longWrites) * price.inputPerMTok * CACHE_WRITE_5M_MULTIPLIER +
    longWrites * price.inputPerMTok * CACHE_WRITE_1H_MULTIPLIER;
  return perMTok / 1_000_000;
}
