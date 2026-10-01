import { describe, expect, it } from 'vitest';
import {
  apiErrorOfAssistant,
  classifyFailureText,
  isApiErrorText,
  kindFromSdkCode,
  kindFromStatus,
  recognizeFailureText,
} from '@arena/core';

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
  const message = (text: string, extra: Record<string, unknown> = {}, model = 'claude-sonnet-5-5') => ({
    type: 'assistant',
    parent_tool_use_id: null,
    message: { model, content: [{ type: 'text', text }] },
    ...extra,
  });

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
});
