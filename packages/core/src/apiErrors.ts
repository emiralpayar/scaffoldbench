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

import type { ApiError, ApiErrorKind, ModelStop } from './types';

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

/*
 * How the CLI reports each kind of `ModelStop` (see `types.ts`):
 *
 * - `output_limit`: a response ran past the output-token maximum (`API Error:
 *   Claude's response exceeded the 64000 output token maximum…`, typed code
 *   `max_output_tokens`). The CLI first lets the model try to carry on; the
 *   notice ends the turn only when that fails.
 * - `context_limit`: the conversation no longer fits the context window, and
 *   compacting it did not help (`API Error: The model has reached its context
 *   window limit.`, `Prompt is too long`; terminal reasons `prompt_too_long`,
 *   `blocking_limit`, `rapid_refill_breaker`).
 * - `malformed_tool_use`: the model could not produce a tool call the CLI
 *   could parse, even when asked again (`malformed_tool_use_exhausted`).
 * - `refusal`: the model's safeguards declined the request (`API Error:
 *   …'s safeguards flagged this message…`, `stop_reason: 'refusal'`).
 */

/** How a model stop is named in errors and integrity details: `refused: …`. */
export const MODEL_STOP_LABELS: Readonly<Record<ModelStop['reason'], string>> = {
  output_limit: 'output limit',
  context_limit: 'context limit',
  malformed_tool_use: 'malformed tool call',
  refusal: 'refused',
};

/** The CLI's own wording for a context that no longer fits, and for a tool call it gave up parsing. */
const CONTEXT_LIMIT_NOTICE = /^(?:Prompt is too long|The model has reached its context window limit)/;
const MALFORMED_TOOL_USE_NOTICE = /^The model's tool call could not be parsed/;

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

  if (m.message?.stop_reason === 'refusal') {
    const category = m.message.stop_details?.category;
    return {
      reason: 'refusal',
      message: noticeText(m) || 'refusal',
      ...(typeof category === 'string' ? { category } : {}),
    };
  }
  // Everything else is recognised only on a message the CLI wrote itself, so
  // a model that merely talks about prompts or limits is never taken for one.
  if (!isSyntheticAssistant(message)) return undefined;
  const text = noticeText(m);
  if (CONTEXT_LIMIT_NOTICE.test(text)) return { reason: 'context_limit', message: text };
  if (m.error === 'max_output_tokens') {
    return { reason: 'output_limit', message: text || 'max_output_tokens' };
  }
  if (MALFORMED_TOOL_USE_NOTICE.test(text)) return { reason: 'malformed_tool_use', message: text };
  return undefined;
}

/** How the CLI's terminal reasons for a turn map onto model stops. */
const MODEL_STOP_TERMINAL_REASONS: Readonly<Record<string, ModelStop['reason']>> = {
  prompt_too_long: 'context_limit',
  blocking_limit: 'context_limit',
  rapid_refill_breaker: 'context_limit',
  malformed_tool_use_exhausted: 'malformed_tool_use',
};

/**
 * The model stop a result message reports through its `terminal_reason`, if
 * any: the CLI's own structured account of why the turn ended, which holds
 * even when its wording changes.
 */
export function modelStopOfResult(result: {
  subtype: string;
  terminal_reason?: string;
  result?: string;
  errors?: string[];
}): ModelStop | undefined {
  const terminal = result.terminal_reason;
  const reason = terminal !== undefined ? MODEL_STOP_TERMINAL_REASONS[terminal] : undefined;
  if (terminal === undefined || reason === undefined) return undefined;
  const text = result.subtype === 'success' ? (result.result ?? '') : (result.errors ?? []).join('; ');
  return { reason, message: text.replace(API_ERROR_PREFIX, '').trim() || terminal };
}

function noticeText(message: { message?: { content?: unknown } }): string {
  return assistantText(message).replace(API_ERROR_PREFIX, '').trim();
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
