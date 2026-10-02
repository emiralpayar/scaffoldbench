import { describe, expect, it } from 'vitest';
import {
  apiErrorOfAssistant,
  classifyFailureText,
  isApiErrorText,
  isSyntheticAssistant,
  kindFromSdkCode,
  kindFromStatus,
  modelStopOfAssistant,
  recognizeFailureText,
} from '@arena/core';

/** An assistant message as the SDK streams it. */
const message = (text: string, extra: Record<string, unknown> = {}, model = 'claude-sonnet-5-5') => ({
  type: 'assistant',
  parent_tool_use_id: null,
  message: { model, content: [{ type: 'text', text }] },
  ...extra,
});

/** The CLI's notices when the model cannot finish (CLI bundled with Agent SDK 0.3.287). */
const OUTPUT_LIMIT =
  "API Error: Claude's response exceeded the 64000 output token maximum. To configure this " +
  'behavior, set the CLAUDE_CODE_MAX_OUTPUT_TOKENS environment variable.';
const CONTEXT_LIMIT = 'API Error: The model has reached its context window limit.';
const REFUSAL =
  "API Error: Sonnet 5.5's safeguards flagged this message (https://www.anthropic.com/legal/aup).";
const limitNotice = (text: string) =>
  message(text, { error: 'max_output_tokens', is_api_error_message: true }, '<synthetic>');
const refusalNotice = (category: string | null) => ({
  type: 'assistant',
  parent_tool_use_id: null,
  error: 'invalid_request',
  is_api_error_message: true,
  message: {
    model: '<synthetic>',
    content: [{ type: 'text', text: REFUSAL }],
    stop_reason: 'refusal',
    stop_details: { type: 'refusal', category, explanation: null },
  },
});

describe('kindFromStatus', () => {
  it.each([
    [401, 'auth'],
    [403, 'auth'],
    [429, 'rate_limit'],
    [529, 'overloaded'],
    [500, 'server'],
    [503, 'server'],
    [400, 'invalid_request'],
    [404, 'invalid_request'],
  ] as const)('%i is %s', (status, kind) => {
    expect(kindFromStatus(status)).toBe(kind);
  });
});

describe('kindFromSdkCode', () => {
  it('maps the SDK error codes onto failure kinds', () => {
    expect(kindFromSdkCode('authentication_failed')).toBe('auth');
    expect(kindFromSdkCode('billing_error')).toBe('auth');
    expect(kindFromSdkCode('rate_limit')).toBe('rate_limit');
    expect(kindFromSdkCode('overloaded')).toBe('overloaded');
    expect(kindFromSdkCode('server_error')).toBe('server');
    expect(kindFromSdkCode('model_not_found')).toBe('invalid_request');
    expect(kindFromSdkCode('something_new')).toBe('unknown');
  });

  it('does not count running out of output tokens as an API failure', () => {
    expect(kindFromSdkCode('max_output_tokens')).toBeUndefined();
  });
});

describe('isApiErrorText', () => {
  it('recognises the CLI’s stand-in text only at the start', () => {
    expect(isApiErrorText('API Error: 400 {"type":"error"}')).toBe(true);
    expect(isApiErrorText('  API Error: Request was aborted.')).toBe(true);
    expect(isApiErrorText('The API Error: 400 case is handled by retrying.')).toBe(false);
    expect(isApiErrorText('Retry on 429 rate limit errors.')).toBe(false);
  });
});

describe('classifyFailureText', () => {
  it('prefers the status in an "API Error:" text', () => {
    expect(classifyFailureText('API Error: 529 {"type":"overloaded_error"}')).toMatchObject({
      kind: 'overloaded',
      status: 529,
      retryable: true,
    });
  });

  it.each([
    ['Invalid API key · Please run /login', 'auth', false],
    ['Not logged in · Run /login', 'auth', false],
    ['Credit balance is too low', 'auth', false],
    ['Claude AI usage limit reached', 'rate_limit', true],
    ['Repeated 529 Overloaded errors', 'overloaded', true],
    ['Request timed out.', 'server', true],
    ['Connection error.', 'server', true],
    ['model does not support this feature', 'invalid_request', false],
    ['Claude Code process exited with code 1', 'unknown', true],
  ] as const)('classifies %j as %s', (text, kind, retryable) => {
    expect(classifyFailureText(text)).toMatchObject({ kind, retryable });
  });
});

describe('recognizeFailureText', () => {
  it('returns nothing for failures that are the run’s own', () => {
    expect(recognizeFailureText('Reached maximum number of turns (6)')).toBeUndefined();
    expect(recognizeFailureText('Prompt is too long')).toBeUndefined();
  });
});

describe('apiErrorOfAssistant', () => {
  it('reads the typed error code', () => {
    expect(apiErrorOfAssistant(message('Rate limited', { error: 'rate_limit' }))).toMatchObject({
      kind: 'rate_limit',
      message: 'Rate limited',
    });
  });

  it('reads the internal API-error marks', () => {
    expect(
      apiErrorOfAssistant(message('boom', { is_api_error_message: true, api_error_status: 500 })),
    ).toMatchObject({ kind: 'server', status: 500 });
  });

  it('recognises a synthetic message by its text', () => {
    expect(apiErrorOfAssistant(message('Connection error.', {}, '<synthetic>'))?.kind).toBe('server');
    expect(apiErrorOfAssistant(message('No response requested.', {}, '<synthetic>'))).toBeUndefined();
  });

  it('leaves ordinary model output alone', () => {
    expect(apiErrorOfAssistant(message('Back off and retry on HTTP 429.'))).toBeUndefined();
    expect(apiErrorOfAssistant(message('Truncated', { error: 'max_output_tokens' }))).toBeUndefined();
  });

  it('does not take the CLI’s notice that the model could not finish for an API failure', () => {
    expect(apiErrorOfAssistant(limitNotice(OUTPUT_LIMIT))).toBeUndefined();
    expect(apiErrorOfAssistant(limitNotice(CONTEXT_LIMIT))).toBeUndefined();
    expect(apiErrorOfAssistant(refusalNotice('cyber'))).toBeUndefined();
  });
});

describe('modelStopOfAssistant', () => {
  it('reads a model that ran out of room, without the notice’s "API Error" dress', () => {
    expect(modelStopOfAssistant(limitNotice(OUTPUT_LIMIT))).toEqual({
      reason: 'output_limit',
      message: expect.stringMatching(/^Claude's response exceeded the 64000 output token maximum\./),
    });
    expect(modelStopOfAssistant(limitNotice(CONTEXT_LIMIT))).toEqual({
      reason: 'output_limit',
      message: 'The model has reached its context window limit.',
    });
  });

  it('reads a refusal and the category the API gave for it', () => {
    expect(modelStopOfAssistant(refusalNotice('reasoning_extraction'))).toEqual({
      reason: 'refusal',
      message: expect.stringMatching(/^Sonnet 5\.5's safeguards flagged this message/),
      category: 'reasoning_extraction',
    });
    expect(modelStopOfAssistant(refusalNotice(null))).not.toHaveProperty('category');
  });

  it('is not an API failure, nor the model talking about limits', () => {
    const overloaded = message('API Error: 529 Overloaded', { error: 'overloaded' }, '<synthetic>');
    expect(modelStopOfAssistant(overloaded)).toBeUndefined();
    expect(modelStopOfAssistant(message('The reply exceeded the output token maximum.'))).toBeUndefined();
  });
});

describe('isSyntheticAssistant', () => {
  it('recognises everything the CLI writes in the model’s place', () => {
    expect(isSyntheticAssistant(limitNotice(OUTPUT_LIMIT))).toBe(true);
    expect(isSyntheticAssistant(refusalNotice('cyber'))).toBe(true);
    expect(isSyntheticAssistant(message('Rate limited', { error: 'rate_limit' }))).toBe(true);
    expect(isSyntheticAssistant(message('boom', { is_api_error_message: true }))).toBe(true);
    expect(isSyntheticAssistant(message('No response requested.', {}, '<synthetic>'))).toBe(true);
    expect(isSyntheticAssistant(message('API Error: 500 Internal server error'))).toBe(true);
  });

  it('leaves the model’s own words alone', () => {
    expect(isSyntheticAssistant(message('Back off and retry on HTTP 429.'))).toBe(false);
  });
});
