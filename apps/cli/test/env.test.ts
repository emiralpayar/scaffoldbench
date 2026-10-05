import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { REPO_ROOT } from '@scaffoldbench/core';

import { credentialText, describeCredential, loadDotEnv, maskEmail, maskSecret } from '../src/env';

const KEY = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCD-wxyz';

describe('.env.example', () => {
  // Copying the template must not change what a run bills or spends: a
  // placeholder key left active is exactly how a run ends up refused, and a
  // model left active is how a sweep ends up on the expensive tier.
  it('sets nothing until someone edits it', async () => {
    const text = await readFile(path.join(REPO_ROOT, '.env.example'), 'utf8');
    const active = text.split('\n').filter((line) => line.trim() !== '' && !line.trim().startsWith('#'));
    expect(active).toEqual([]);
  });

  it('documents each variable the CLI reads', async () => {
    const text = await readFile(path.join(REPO_ROOT, '.env.example'), 'utf8');
    for (const name of ['ANTHROPIC_API_KEY', 'SCAFFOLDBENCH_MODEL', 'SCAFFOLDBENCH_JUDGE_MODEL', 'SCAFFOLDBENCH_MAX_COST_USD', 'SCAFFOLDBENCH_RESULTS_DIR']) {
      expect(text).toContain(`# ${name}=`);
    }
  });
});

describe('loadDotEnv', () => {
  const names = ['SCAFFOLDBENCH_CLI_TEST_FROM_FILE', 'SCAFFOLDBENCH_CLI_TEST_SHELL_WINS', 'SCAFFOLDBENCH_CLI_TEST_EMPTY'];
  let dir: string | undefined;
  afterEach(async () => {
    for (const name of names) delete process.env[name];
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('loads the file, lets the shell win, and reports what the file set', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'scaffoldbench-cli-env-'));
    const file = path.join(dir, '.env');
    await writeFile(
      file,
      'SCAFFOLDBENCH_CLI_TEST_FROM_FILE=from-file\nSCAFFOLDBENCH_CLI_TEST_SHELL_WINS=from-file\n# comment\nSCAFFOLDBENCH_CLI_TEST_EMPTY=\n',
    );
    process.env.SCAFFOLDBENCH_CLI_TEST_SHELL_WINS = 'from-shell';

    const loaded = loadDotEnv(file);

    expect(loaded && 'keys' in loaded ? loaded.keys.sort() : loaded).toEqual([
      'SCAFFOLDBENCH_CLI_TEST_EMPTY',
      'SCAFFOLDBENCH_CLI_TEST_FROM_FILE',
    ]);
    expect(process.env.SCAFFOLDBENCH_CLI_TEST_FROM_FILE).toBe('from-file');
    expect(process.env.SCAFFOLDBENCH_CLI_TEST_SHELL_WINS).toBe('from-shell');
  });

  it('does nothing without a file, and reports a file it cannot read', async () => {
    expect(loadDotEnv(path.join(tmpdir(), 'no-such-dir-scaffoldbench', '.env'))).toBeUndefined();
    dir = await mkdtemp(path.join(tmpdir(), 'scaffoldbench-cli-env-'));
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

  it('says where requests go when a base URL sends them elsewhere, host only', () => {
    const viaGateway = describeCredential({
      ANTHROPIC_API_KEY: KEY,
      ANTHROPIC_BASE_URL: 'https://user:hunter2@gateway.example.com:8443/v1/secret-path?token=abc',
    });
    expect(viaGateway.endpoint).toBe('gateway.example.com:8443');
    const text = credentialText(viaGateway);
    expect(text).toBe(
      'ANTHROPIC_API_KEY sk-ant-…wxyz (from the environment), sent to gateway.example.com:8443 (ANTHROPIC_BASE_URL)',
    );
    expect(text).not.toMatch(/hunter2|secret-path|token=abc/);

    // A login goes through it too; an unset or blank variable says nothing; nonsense is reported as such.
    expect(credentialText(describeCredential({ ANTHROPIC_BASE_URL: 'http://localhost:9' }))).toBe(
      "this machine's Claude Code login (no key in the environment), sent to localhost:9 (ANTHROPIC_BASE_URL)",
    );
    expect(describeCredential({ ANTHROPIC_API_KEY: KEY, ANTHROPIC_BASE_URL: '  ' }).endpoint).toBeUndefined();
    expect(describeCredential({ ANTHROPIC_BASE_URL: 'not a url' }).endpoint).toBe('(unreadable URL)');
    // A cloud provider switch routes elsewhere altogether; the base URL is not what is billed.
    expect(describeCredential({ CLAUDE_CODE_USE_BEDROCK: '1', ANTHROPIC_BASE_URL: 'http://localhost:9' }).endpoint).toBeUndefined();
  });

  it('never prints more of a secret than the mask', () => {
    const text = credentialText(describeCredential({ ANTHROPIC_API_KEY: KEY }));
    expect(text).not.toContain(KEY.slice(7, -4));
  });
});
