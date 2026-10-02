/**
 * Telling a spent usage limit apart from a transient rate limit.
 *
 * Both reach the harness as a 429. A transient one clears in seconds, so the
 * runner retries the cell after a short back-off. A usage limit — the
 * five-hour, weekly or per-model allowance of the account the CLI runs on —
 * is spent until a set time, usually hours away: every retry and every cell
 * started after it fails the same way. Retrying it turned the rest of a
 * matrix into a stream of doomed calls and `api_error` records in minutes,
 * so a usage limit is not retryable, and the runner stops the session on it
 * as it does on rejected credentials. The run set is then resumed once the
 * limit has reset.
 */

import type { ApiError } from './types';

/** What the CLI's `rate_limit_event` said about the account's limits during one call. */
export interface RateLimitState {
  /** True once an event said `rejected`: the limit is spent. */
  rejected: boolean;
  /** When the spent limit lifts (ISO 8601), when the event said. */
  resetsAt?: string;
  /** Which limit, e.g. `five_hour` or `seven_day`, when the event said. */
  limitType?: string;
}

/**
 * The CLI's `rate_limit_event`, as far as this module reads it. Every call on
 * a subscription streams one (`status: 'allowed'` with the window's
 * utilisation); `rejected` means the request was refused for a spent limit.
 */
export interface RateLimitEventLike {
  type: 'rate_limit_event';
  rate_limit_info?: { status?: unknown; resetsAt?: unknown; rateLimitType?: unknown } | null;
}

/** Fold one `rate_limit_event` into what the call has seen so far. */
export function observeRateLimit(state: RateLimitState, event: RateLimitEventLike): RateLimitState {
  const info = event.rate_limit_info;
  if (!info || info.status !== 'rejected') return state;
  return {
    rejected: true,
    // The event gives epoch seconds.
    ...(typeof info.resetsAt === 'number' && Number.isFinite(info.resetsAt)
      ? { resetsAt: new Date(info.resetsAt * 1_000).toISOString() }
      : {}),
    ...(typeof info.rateLimitType === 'string' ? { limitType: info.rateLimitType } : {}),
  };
}

/**
 * How the CLI words a spent limit, e.g. "You've hit your session limit ·
 * resets 6am (Europe/Istanbul)": a limit, and when it resets. A transient
 * rate limit ("Rate limit reached for requests") names no reset.
 */
const USAGE_LIMIT_TEXT = /\blimit\b[^.]*\breset/i;

/**
 * `error` as a usage limit when that is what it is: when the call saw a
 * rejected `rate_limit_event`, or failing that when a rate limit is worded as
 * one. Anything else is returned unchanged.
 */
export function asUsageLimit(error: ApiError, seen: RateLimitState): ApiError {
  const spent = seen.rejected || (error.kind === 'rate_limit' && USAGE_LIMIT_TEXT.test(error.message));
  if (!spent) return error;
  return {
    ...error,
    kind: 'rate_limit',
    retryable: false,
    ...(seen.resetsAt !== undefined ? { resetsAt: seen.resetsAt } : {}),
  };
}

/** True for a spent usage limit: the one rate limit that is not retryable. */
export function isUsageLimit(error: ApiError): boolean {
  return error.kind === 'rate_limit' && !error.retryable;
}
