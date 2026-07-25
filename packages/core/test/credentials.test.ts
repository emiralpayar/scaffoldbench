import { describe, expect, it } from 'vitest';
import {
  CREDENTIAL_ENV_VARS,
  InvalidApiKeyError,
  assertApiKeyShape,
  redactSecrets,
  visitorEnv,
} from '@arena/core';

const VALID_KEY = `sk-ant-api03-${'a'.repeat(60)}`;

describe('assertApiKeyShape', () => {
  it('accepts a well-formed key', () => {
    expect(() => assertApiKeyShape(VALID_KEY)).not.toThrow();
  });

  it('tolerates surrounding whitespace from a paste', () => {
    expect(() => assertApiKeyShape(`  ${VALID_KEY}\n`)).not.toThrow();
  });

  it('rejects a missing or non-string key', () => {
    expect(() => assertApiKeyShape(undefined)).toThrow(InvalidApiKeyError);
    expect(() => assertApiKeyShape(12345)).toThrow(InvalidApiKeyError);
  });

  it('rejects a key with the wrong prefix', () => {
    expect(() => assertApiKeyShape(`sk-proj-${'a'.repeat(60)}`)).toThrow(/sk-ant-/);
  });

  it('rejects a truncated key', () => {
    expect(() => assertApiKeyShape('sk-ant-short')).toThrow(/complete/);
  });

  it('rejects a key containing whitespace in the middle', () => {
    expect(() => assertApiKeyShape(`sk-ant-api03-${'a'.repeat(30)} ${'b'.repeat(30)}`)).toThrow(
      /whitespace/,
    );
  });
});

describe('visitorEnv', () => {
  it('sets the supplied key', () => {
    const env = visitorEnv(VALID_KEY, {});
    expect(env.ANTHROPIC_API_KEY).toBe(VALID_KEY);
  });

  it('trims a pasted key', () => {
    expect(visitorEnv(`  ${VALID_KEY}  `, {}).ANTHROPIC_API_KEY).toBe(VALID_KEY);
  });

  it('removes every credential source the SDK would fall back to', () => {
    const hostile: NodeJS.ProcessEnv = {};
    for (const name of CREDENTIAL_ENV_VARS) hostile[name] = 'host-secret';

    const env = visitorEnv(VALID_KEY, hostile);

    for (const name of CREDENTIAL_ENV_VARS) {
      if (name === 'ANTHROPIC_API_KEY') continue;
      expect(env[name], `${name} must not survive`).toBeUndefined();
    }
    expect(env.ANTHROPIC_API_KEY).toBe(VALID_KEY);
  });

  it('keeps the operator token out even when no key is otherwise set', () => {
    const env = visitorEnv(VALID_KEY, { ANTHROPIC_AUTH_TOKEN: 'operator-oauth-token' });
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  });

  it('preserves the non-credential environment the subprocess needs', () => {
    const env = visitorEnv(VALID_KEY, {
      PATH: '/usr/bin',
      HOME: '/home/app',
      TMPDIR: '/tmp',
      ANTHROPIC_API_KEY: 'operator-key',
    });
    expect(env.PATH).toBe('/usr/bin');
    expect(env.HOME).toBe('/home/app');
    expect(env.TMPDIR).toBe('/tmp');
    expect(env.ANTHROPIC_API_KEY).toBe(VALID_KEY);
  });

  it('does not mutate the environment it was given', () => {
    const base: NodeJS.ProcessEnv = { ANTHROPIC_API_KEY: 'operator-key' };
    visitorEnv(VALID_KEY, base);
    expect(base.ANTHROPIC_API_KEY).toBe('operator-key');
  });

  it('covers the cloud-provider switches, not just the direct key', () => {
    for (const name of [
      'CLAUDE_CODE_USE_BEDROCK',
      'CLAUDE_CODE_USE_VERTEX',
      'CLAUDE_CODE_USE_FOUNDRY',
      'AWS_ACCESS_KEY_ID',
      'GOOGLE_APPLICATION_CREDENTIALS',
    ]) {
      expect(CREDENTIAL_ENV_VARS).toContain(name);
    }
  });
});

describe('redactSecrets', () => {
  it('redacts a key embedded in an error message', () => {
    const text = `Request failed with key ${VALID_KEY} at line 3`;
    const out = redactSecrets(text);
    expect(out).not.toContain(VALID_KEY);
    expect(out).toContain('sk-ant-***redacted***');
  });

  it('redacts every occurrence', () => {
    const out = redactSecrets(`${VALID_KEY} and ${VALID_KEY}`);
    expect(out.match(/redacted/g)).toHaveLength(2);
  });

  it('leaves ordinary text alone', () => {
    expect(redactSecrets('nothing secret here')).toBe('nothing secret here');
  });
});
