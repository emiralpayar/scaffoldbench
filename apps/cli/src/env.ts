/**
 * The `.env` file and which credential a run will bill.
 *
 * `.env` at the repository root is loaded with `process.loadEnvFile` before
 * anything reads the environment. Variables already set in the shell win,
 * which is Node's own rule, so `ANTHROPIC_API_KEY=… npm run bench` still
 * overrides the file.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';

import { REPO_ROOT, assertApiKeyShape } from '@scaffoldbench/core';

export const DOT_ENV = path.join(REPO_ROOT, '.env');

export interface DotEnv {
  file: string;
  /** Variables the file set; the ones it named but the shell had already set are not here. */
  keys: string[];
}

/**
 * Load `file` into `process.env` if it exists. Returns what it set, or a
 * message when the file exists but could not be read: a broken `.env` is
 * reported, never silently skipped, because it may hold the key to bill.
 */
export function loadDotEnv(file: string = DOT_ENV): DotEnv | { file: string; error: string } | undefined {
  if (!existsSync(file)) return undefined;
  const before = new Set(Object.keys(process.env));
  try {
    process.loadEnvFile(file);
  } catch (error) {
    return { file, error: error instanceof Error ? error.message : String(error) };
  }
  return { file, keys: Object.keys(process.env).filter((key) => !before.has(key)) };
}

/** `sk-ant-…a1b2`: the vendor prefix and the last four characters, nothing in between. */
export function maskSecret(secret: string): string {
  const trimmed = secret.trim();
  if (trimmed.length <= 12) return '…';
  const prefix = trimmed.startsWith('sk-ant-') ? 'sk-ant-' : trimmed.slice(0, 3);
  return `${prefix}…${trimmed.slice(-4)}`;
}

/** `em…@example.com`: enough to recognise an account, not to harvest it. */
export function maskEmail(email: string): string {
  const at = email.indexOf('@');
  if (at <= 0) return '…';
  return `${email.slice(0, Math.min(2, at))}…${email.slice(at)}`;
}

const PLATFORMS: [string, string][] = [
  ['CLAUDE_CODE_USE_BEDROCK', 'Amazon Bedrock'],
  ['CLAUDE_CODE_USE_VERTEX', 'Google Vertex AI'],
  ['CLAUDE_CODE_USE_FOUNDRY', 'Microsoft Foundry'],
];

export interface Credential {
  kind: 'platform' | 'auth-token' | 'api-key' | 'both' | 'login';
  /** The variable that supplies it. */
  variable?: string;
  masked?: string;
  /** Where the variable came from. */
  source?: '.env' | 'environment';
  /** For `platform`: the provider the SDK will route to. */
  provider?: string;
  /** Set when the value cannot be a working credential, e.g. the placeholder from .env.example. */
  problem?: string;
  /**
   * The host requests go to when `ANTHROPIC_BASE_URL` points somewhere other
   * than the API: a gateway or proxy, which bills and logs by its own rules.
   * Only the host, never a userinfo or a path that could carry a secret.
   */
  endpoint?: string;
}

const isSet = (value: string | undefined): value is string => value !== undefined && value.trim() !== '';

/**
 * The credential the SDK will use, as far as the environment can tell. A
 * cloud provider switch (`CLAUDE_CODE_USE_BEDROCK` and friends) routes every
 * request to that provider. Otherwise an `ANTHROPIC_AUTH_TOKEN` or an
 * `ANTHROPIC_API_KEY` is used, and with neither, this machine's Claude Code
 * login. With both a token and a key set the SDK reports both, so which one
 * is billed is not something to guess at: that is reported as `both`.
 */
export function describeCredential(
  env: NodeJS.ProcessEnv,
  fromDotEnv: ReadonlySet<string> = new Set(),
): Credential {
  const endpoint = endpointOf(env.ANTHROPIC_BASE_URL);
  const credential = credentialFrom(env, fromDotEnv);
  return endpoint !== undefined && credential.kind !== 'platform' ? { ...credential, endpoint } : credential;
}

/** The host of a base URL, `(unreadable URL)` when it is not one, or undefined when none is set. */
function endpointOf(baseUrl: string | undefined): string | undefined {
  if (!isSet(baseUrl)) return undefined;
  try {
    return new URL(baseUrl.trim()).host || '(unreadable URL)';
  } catch {
    return '(unreadable URL)';
  }
}

function credentialFrom(env: NodeJS.ProcessEnv, fromDotEnv: ReadonlySet<string>): Credential {
  const source = (name: string) => (fromDotEnv.has(name) ? '.env' : 'environment');
  for (const [variable, provider] of PLATFORMS) {
    const value = env[variable]?.trim().toLowerCase();
    if (value && value !== '0' && value !== 'false') {
      return { kind: 'platform', variable, provider, source: source(variable) };
    }
  }
  const token = env.ANTHROPIC_AUTH_TOKEN;
  const key = env.ANTHROPIC_API_KEY;
  if (isSet(token) && isSet(key)) {
    return {
      kind: 'both',
      variable: 'ANTHROPIC_AUTH_TOKEN and ANTHROPIC_API_KEY',
      masked: `${maskSecret(token)} / ${maskSecret(key)}`,
    };
  }
  if (isSet(token)) {
    return {
      kind: 'auth-token',
      variable: 'ANTHROPIC_AUTH_TOKEN',
      masked: maskSecret(token),
      source: source('ANTHROPIC_AUTH_TOKEN'),
    };
  }
  if (isSet(key)) {
    let problem: string | undefined;
    try {
      assertApiKeyShape(key);
    } catch (error) {
      problem = error instanceof Error ? error.message : String(error);
    }
    return {
      kind: 'api-key',
      variable: 'ANTHROPIC_API_KEY',
      masked: maskSecret(key),
      source: source('ANTHROPIC_API_KEY'),
      ...(problem ? { problem } : {}),
    };
  }
  return { kind: 'login' };
}

/** One line for the run plan, e.g. `ANTHROPIC_API_KEY sk-ant-…a1b2 (from .env)`. */
export function credentialText(credential: Credential): string {
  const text = credentialKindText(credential);
  return credential.endpoint !== undefined ? `${text}, sent to ${credential.endpoint} (ANTHROPIC_BASE_URL)` : text;
}

function credentialKindText(credential: Credential): string {
  switch (credential.kind) {
    case 'platform':
      return `${credential.provider} (${credential.variable} is set${credential.source === '.env' ? ' in .env' : ''})`;
    case 'auth-token':
    case 'api-key':
      return `${credential.variable} ${credential.masked} (from ${credential.source === '.env' ? '.env' : 'the environment'})`;
    case 'both':
      return `both ANTHROPIC_AUTH_TOKEN and ANTHROPIC_API_KEY are set (${credential.masked}); unset one to be sure which is billed`;
    case 'login':
      return "this machine's Claude Code login (no key in the environment)";
  }
}
