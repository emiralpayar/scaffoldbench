import { describe, expect, it } from 'vitest';

import { asUsageLimit, isUsageLimit, makeApiError, observeRateLimit } from '@arena/core';

/**
 * A spent usage limit against a transient rate limit: the first stops the
 * session, the second is retried.
 */

const SPENT = 'You\'ve hit your session limit · resets 6am (Europe/Istanbul)';

describe('observeRateLimit', () => {
  it('ignores the allowance report every subscription call streams', () => {
    const seen = observeRateLimit(
      { rejected: false },
      { type: 'rate_limit_event', rate_limit_info: { status: 'allowed', resetsAt: 1790931600, rateLimitType: 'five_hour' } },
    );
    expect(seen).toEqual({ rejected: false });
  });

  it('reads a refusal, its limit and when it resets', () => {
    const seen = observeRateLimit(
      { rejected: false },
      { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1790931600, rateLimitType: 'seven_day' } },
    );
    expect(seen).toEqual({ rejected: true, resetsAt: '2026-10-02T09:00:00.000Z', limitType: 'seven_day' });
  });
});

describe('asUsageLimit', () => {
  const transient = makeApiError('rate_limit', 'API Error: Rate limit reached', 429);

  it('leaves a transient rate limit retryable', () => {
    expect(asUsageLimit(transient, { rejected: false })).toEqual(transient);
    expect(isUsageLimit(transient)).toBe(false);
  });

  it('makes a refused call a usage limit, with when it resets', () => {
    const limit = asUsageLimit(makeApiError('rate_limit', SPENT, 429), {
      rejected: true,
      resetsAt: '2026-10-02T03:00:00.000Z',
    });
    expect(limit).toMatchObject({ kind: 'rate_limit', retryable: false, resetsAt: '2026-10-02T03:00:00.000Z' });
    expect(isUsageLimit(limit)).toBe(true);
  });

  it('knows the CLI’s wording for a spent limit even without the event', () => {
    expect(isUsageLimit(asUsageLimit(makeApiError('rate_limit', SPENT, 429), { rejected: false }))).toBe(true);
  });

  it('never makes a usage limit of anything but a rate limit by wording alone', () => {
    const server = makeApiError('server', 'The usage limit service will reset shortly', 500);
    expect(asUsageLimit(server, { rejected: false })).toEqual(server);
  });
});
