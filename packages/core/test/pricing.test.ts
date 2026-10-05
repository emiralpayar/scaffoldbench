import { describe, expect, it } from 'vitest';
import { estimateCostUsd, priceFor } from '@scaffoldbench/core';

describe('priceFor', () => {
  it('matches dated snapshots and provider-prefixed ids by family', () => {
    expect(priceFor('claude-haiku-4-5-20251001')).toMatchObject({ inputPerMTok: 1, outputPerMTok: 5 });
    expect(priceFor('us.anthropic.claude-sonnet-5-5')).toMatchObject({ inputPerMTok: 2 });
    expect(priceFor('claude-opus-5-5')).toMatchObject({ inputPerMTok: 4, outputPerMTok: 20 });
    expect(priceFor('claude-fable-5-1')).toMatchObject({ inputPerMTok: 10, outputPerMTok: 50 });
  });

  it('does not guess at a model it does not know', () => {
    expect(priceFor('claude-sonnet-5')).toBeUndefined();
    expect(priceFor('claude-opus-5-50')).toBeUndefined();
  });
});

describe('estimateCostUsd', () => {
  it('prices input, output, cache reads and both cache-write tiers', () => {
    // Sonnet 5.5: $2 in, $10 out, $0.20 cache read; writes 1.25x / 2x input.
    const usd = estimateCostUsd('claude-sonnet-5-5', {
      inputTokens: 1_000_000,
      outputTokens: 100_000,
      cacheReadInputTokens: 1_000_000,
      cacheCreationInputTokens: 300_000,
      cacheCreation1hInputTokens: 100_000,
    });
    expect(usd).toBeCloseTo(2 + 1 + 0.2 + 0.2 * 2 * 1.25 + 0.1 * 2 * 2, 10);
  });

  it('uses each model’s own cache-read discount', () => {
    expect(estimateCostUsd('claude-opus-5-5', { cacheReadInputTokens: 1_000_000 })).toBeCloseTo(0.2, 10);
    expect(estimateCostUsd('claude-fable-5-1', { cacheReadInputTokens: 1_000_000 })).toBeCloseTo(0.25, 10);
  });

  it('returns undefined for an unpriced model', () => {
    expect(estimateCostUsd('claude-unreleased-9', { inputTokens: 1 })).toBeUndefined();
  });
});
