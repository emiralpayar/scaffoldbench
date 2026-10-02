/**
 * Recognising failures that belong to the infrastructure, not the architecture.
 *
 * A revoked key, a rate limit, an overloaded API or a model id the account
 * cannot use all end a call without the architecture having done anything
 * wrong. The SDK does not surface them as errors. A model id the account
 * cannot use comes back as a *successful* result whose text is the error
 * message — `API Error: 400 … does not support this model` on the SDK the
 * first run set used, `There's an issue with the selected model …` with
 * `is_error` set on 0.3.287 — and that text used to be graded as the agent's
 * answer and scored `wrong_answer`. Everything here exists so such a call is
 * labelled for what it is and never becomes an answer — and so a turn the
 * model could not finish for a reason of its own, which the CLI dresses the
 * same way, is not excused as one (`ModelStop`).
 */

import type { ApiError, ApiErrorKind } from './types';

/**
 * Whether a kind of failure is worth retrying.
 *
 * Credentials and malformed requests fail the same way every time. Everything
 * else, including an unclassified failure, is retried: a retry of a call that
 * failed at the API costs little, while a lost cell unbalances the design.
 */
export function isRetryable(kind: ApiErrorKind): boolean {
  return kind !== 'auth' && kind !== 'invalid_request';
}

export function makeApiError(kind: ApiErrorKind, message: string, status?: number): ApiError {
  return {
    kind,
    retryable: isRetryable(kind),
    message: message.trim() === '' ? `API error (${kind})` : message.trim(),
    ...(status !== undefined ? { status } : {}),
  };
}

/** Classify by HTTP status, as the API reports it. */
export function kindFromStatus(status: number): ApiErrorKind {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate_limit';
  if (status === 529) return 'overloaded';
  if (status >= 500) return 'server';
  if (status >= 400) return 'invalid_request';
  return 'unknown';
}

/**
 * Classify by the SDK's typed error code on an assistant message
 * (`SDKAssistantMessageError`).
 *
 * Returns `undefined` for codes that are not infrastructure failures:
 * `max_output_tokens` is the model running out of room, which is a property of
 * the run, not of the API.
 */
export function kindFromSdkCode(code: string): ApiErrorKind | undefined {
  switch (code) {
    case 'authentication_failed':
    case 'oauth_org_not_allowed':
    case 'account_on_hold':
    case 'verification_required':
    case 'billing_error':
    case 'cloud_credential_error':
      return 'auth';
    case 'rate_limit':
      return 'rate_limit';
    case 'overloaded':
      return 'overloaded';
    case 'server_error':
      return 'server';
    case 'invalid_request':
    case 'model_not_found':
      return 'invalid_request';
    case 'max_output_tokens':
      return undefined;
    default:
      return 'unknown';
  }
}

/**
 * The synthetic text the CLI writes in place of an answer when a request
 * fails, e.g. `API Error: 400 {"type":"error",…}`. Anchored at the start so a
 * genuine answer that merely discusses API errors is never mistaken for one.
 */
const API_ERROR_PREFIX = /^\s*API Error\b:?\s*(\d{3})?/;

/** True when `text` is the CLI's stand-in for a failed request rather than model output. */
export function isApiErrorText(text: string): boolean {
  return API_ERROR_PREFIX.test(text);
}

const TEXT_RULES: readonly { kind: ApiErrorKind; pattern: RegExp }[] = [
  {
    kind: 'auth',
    pattern:
      /invalid api key|not logged in|run \/login|oauth|authenticat|unauthori[sz]ed|forbidden|credit balance|billing|permission_error/i,
  },
  { kind: 'rate_limit', pattern: /rate.?limit|usage limit|too many requests|\b429\b/i },
  { kind: 'overloaded', pattern: /overloaded|\b529\b/i },
  {
    kind: 'invalid_request',
    pattern: /does not support|model_not_found|not_found_error|invalid_request|\b40[04]\b/i,
  },
  {
    kind: 'server',
    pattern:
      /internal server error|api_error|request timed out|connection error|econnreset|etimedout|enotfound|socket hang up|\b5\d\d\b/i,
  },
];

/**
 * Classify a message that is already known to describe a failure — a thrown
 * error, an error result, or one of the CLI's synthetic error texts.
 *
 * Never call this on ordinary model output: an answer about HTTP 429 handling
 * is not a rate limit.
 */
export function classifyFailureText(text: string): ApiError {
  const status = API_ERROR_PREFIX.exec(text)?.[1];
  if (status !== undefined) {
    const code = Number(status);
    return makeApiError(kindFromStatus(code), text, code);
  }
  for (const rule of TEXT_RULES) {
    if (rule.pattern.test(text)) return makeApiError(rule.kind, text);
  }
  return makeApiError('unknown', text);
}

/**
 * Like `classifyFailureText`, but returns `undefined` unless the text matches
 * a known API or connection failure. Used for error results, which also cover
 * failures that are the run's own (turn limits, budget, prompt too long).
 */
export function recognizeFailureText(text: string): ApiError | undefined {
  if (isApiErrorText(text)) return classifyFailureText(text);
  for (const rule of TEXT_RULES) {
    if (rule.pattern.test(text)) return makeApiError(rule.kind, text);
  }
  return undefined;
}

/** The model name the CLI stamps on assistant messages it fabricates itself. */
export const SYNTHETIC_MODEL = '<synthetic>';

/** The text blocks of an assistant message, joined. */
export function assistantText(message: { message?: { content?: unknown } }): string {
  const content = message.message?.content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      if (typeof block !== 'object' || block === null) return '';
      const b = block as Record<string, unknown>;
      return b.type === 'text' && typeof b.text === 'string' ? b.text : '';
    })
    .filter((text) => text.trim() !== '')
    .join('\n');
}

/**
 * The API failure an assistant message stands for, if it is one.
 *
 * When a request fails the CLI does not throw: it writes a synthetic assistant
 * message carrying the error text, marked by the SDK's typed `error` field
 * and, on current CLIs, by `is_api_error_message`, an `api_error_status` and
 * the `<synthetic>` model name. Any one of those marks is enough, as is the
 * literal `API Error:` prefix older CLIs used without the marks.
 */
export function apiErrorOfAssistant(message: unknown): ApiError | undefined {
  if (typeof message !== 'object' || message === null) return undefined;
  const m = message as {
    error?: unknown;
    is_api_error_message?: unknown;
    api_error_status?: unknown;
    message?: { content?: unknown; model?: unknown };
  };
  if (modelStopOfAssistant(message)) return undefined;
  const text = assistantText(m);
  const status = typeof m.api_error_status === 'number' ? m.api_error_status : undefined;

  if (typeof m.error === 'string') {
    const kind = kindFromSdkCode(m.error);
    if (kind === undefined) return undefined;
    // The typed code is more specific than the status (a billing failure
    // arrives as a 400, yet is a credential problem, not a malformed request).
    return makeApiError(kind, text || m.error, status);
  }
  if (m.is_api_error_message === true) {
    if (status !== undefined) return makeApiError(kindFromStatus(status), text, status);
    return classifyFailureText(text);
  }
  if (isApiErrorText(text)) return classifyFailureText(text);
  if (m.message?.model === SYNTHETIC_MODEL && text !== '') return recognizeFailureText(text);
  return undefined;
}

/**
 * A turn the model could not finish for a reason of its own, which the CLI
 * reports in the shape of an API failure.
 *
 * - `output_limit`: a response ran past the output-token maximum, or the
 *   conversation filled the context window (`API Error: Claude's response
 *   exceeded the 64000 output token maximum…`, `API Error: The model has
 *   reached its context window limit.`, typed code `max_output_tokens`). The
 *   CLI first lets the model try to carry on; the notice ends the turn only
 *   when that fails.
 * - `refusal`: the model's safeguards declined the request (`API Error:
 *   …'s safeguards flagged this message…`, typed code `invalid_request`,
 *   `stop_reason: 'refusal'`).
 *
 * Nothing failed at the API. The run met a limit of its own, as when it runs
 * out of turns, so it is a losing data point. Excusing it as an
 * infrastructure failure would retry it and then drop it from the rankings,
 * flattering whichever architecture provokes it most.
 */
export interface ModelStop {
  reason: 'output_limit' | 'refusal';
  /** The CLI's notice, without the "API Error:" it is written with. */
  message: string;
  /** For a refusal, the safeguard category the API named, if it named one. */
  category?: string;
}

/** The model stop an assistant message reports, if it is one of the CLI's notices of one. */
export function modelStopOfAssistant(message: unknown): ModelStop | undefined {
  if (typeof message !== 'object' || message === null) return undefined;
  const m = message as {
    error?: unknown;
    message?: {
      content?: unknown;
      stop_reason?: unknown;
      stop_details?: { category?: unknown } | null;
    };
  };
  const notice = (fallback: string) =>
    assistantText(m).replace(API_ERROR_PREFIX, '').trim() || fallback;

  if (m.message?.stop_reason === 'refusal') {
    const category = m.message.stop_details?.category;
    return {
      reason: 'refusal',
      message: notice('refusal'),
      ...(typeof category === 'string' ? { category } : {}),
    };
  }
  if (m.error === 'max_output_tokens') {
    return { reason: 'output_limit', message: notice('max_output_tokens') };
  }
  return undefined;
}

/**
 * True when the CLI wrote `message` in the model's place — an API failure, a
 * model-stop notice or any other stand-in — so its text is never the agent's
 * words and can never be salvaged as its answer.
 */
export function isSyntheticAssistant(message: unknown): boolean {
  if (typeof message !== 'object' || message === null) return false;
  const m = message as {
    error?: unknown;
    is_api_error_message?: unknown;
    message?: { content?: unknown; model?: unknown };
  };
  return (
    typeof m.error === 'string' ||
    m.is_api_error_message === true ||
    m.message?.model === SYNTHETIC_MODEL ||
    isApiErrorText(assistantText(m))
  );
}
