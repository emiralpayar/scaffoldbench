import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { credentialText, describeCredential, loadDotEnv, maskEmail, maskSecret } from '../src/env';

const KEY = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCD-wxyz';

describe('loadDotEnv', () => {
  const names = ['ARENA_CLI_TEST_FROM_FILE', 'ARENA_CLI_TEST_SHELL_WINS', 'ARENA_CLI_TEST_EMPTY'];
  let dir: string | undefined;
  afterEach(async () => {
    for (const name of names) delete process.env[name];
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('loads the file, lets the shell win, and reports what the file set', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'arena-cli-env-'));
    const file = path.join(dir, '.env');
    await writeFile(
      file,
      'ARENA_CLI_TEST_FROM_FILE=from-file\nARENA_CLI_TEST_SHELL_WINS=from-file\n# comment\nARENA_CLI_TEST_EMPTY=\n',
    );
    process.env.ARENA_CLI_TEST_SHELL_WINS = 'from-shell';

    const loaded = loadDotEnv(file);

    expect(loaded && 'keys' in loaded ? loaded.keys.sort() : loaded).toEqual([
      'ARENA_CLI_TEST_EMPTY',
      'ARENA_CLI_TEST_FROM_FILE',
    ]);
    expect(process.env.ARENA_CLI_TEST_FROM_FILE).toBe('from-file');
    expect(process.env.ARENA_CLI_TEST_SHELL_WINS).toBe('from-shell');
  });

  it('does nothing without a file, and reports a file it cannot read', async () => {
    expect(loadDotEnv(path.join(tmpdir(), 'no-such-dir-arena', '.env'))).toBeUndefined();
    dir = await mkdtemp(path.join(tmpdir(), 'arena-cli-env-'));
    // A directory where the file should be cannot be read as one.
    const result = loadDotEnv(dir);
    expect(result && 'error' in result).toBe(true);
  });
});

describe('credentials', () => {
  it('masks a key down to its prefix and last four characters', () => {
    expect(maskSecret(KEY)).toBe('sk-ant-…wxyz');
    expect(maskSecret('short')).toBe('…');
    expect(maskEmail('someone@example.com')).toBe('so…@example.com');
  });

  it('says which credential will be billed and where it came from', () => {
    expect(describeCredential({ ANTHROPIC_API_KEY: KEY }, new Set(['ANTHROPIC_API_KEY']))).toEqual({
      kind: 'api-key',
      variable: 'ANTHROPIC_API_KEY',
      masked: 'sk-ant-…wxyz',
      source: '.env',
    });
    expect(credentialText(describeCredential({ ANTHROPIC_API_KEY: KEY }))).toBe(
      'ANTHROPIC_API_KEY sk-ant-…wxyz (from the environment)',
    );
    expect(describeCredential({}).kind).toBe('login');
    expect(describeCredential({ ANTHROPIC_API_KEY: '  ' }).kind).toBe('login');
    expect(describeCredential({ ANTHROPIC_AUTH_TOKEN: 'tok-0123456789abcdef' }).kind).toBe('auth-token');
  });

  it('flags the placeholder from .env.example instead of billing nobody', () => {
    const credential = describeCredential({ ANTHROPIC_API_KEY: 'sk-ant-...' });
    expect(credential.kind).toBe('api-key');
    expect(credential.problem).toMatch(/complete API key/);
  });

  it('does not guess between a token and a key', () => {
    const credential = describeCredential({ ANTHROPIC_API_KEY: KEY, ANTHROPIC_AUTH_TOKEN: 'tok-0123456789abcdef' });
    expect(credential.kind).toBe('both');
    expect(credentialText(credential)).toMatch(/unset one to be sure/);
  });

  it('puts a cloud provider switch first', () => {
    const credential = describeCredential({ CLAUDE_CODE_USE_BEDROCK: '1', ANTHROPIC_API_KEY: KEY });
    expect(credential).toMatchObject({ kind: 'platform', provider: 'Amazon Bedrock' });
    expect(describeCredential({ CLAUDE_CODE_USE_BEDROCK: '0', ANTHROPIC_API_KEY: KEY }).kind).toBe('api-key');
  });

  it('never prints more of a secret than the mask', () => {
    const text = credentialText(describeCredential({ ANTHROPIC_API_KEY: KEY }));
    expect(text).not.toContain(KEY.slice(7, -4));
  });
});
