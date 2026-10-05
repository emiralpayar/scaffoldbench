import { describe, expect, it } from 'vitest';

import { CREDENTIAL_ENV_VARS } from '@scaffoldbench/core';

import {
  LIVE_MAX_CONCURRENT_RUNS,
  LIVE_RATE_LIMIT_PER_HOUR,
  LIVE_SHARED_RATE_LIMIT_PER_HOUR,
  LiveAdmissions,
  checkApiKey,
  clientBucket,
  isLiveModel,
  liveEnv,
  refusingJudge,
  summarizeLiveRun,
} from '../lib/server/live';
import { run } from './fixtures';

const KEY = `sk-ant-api03-${'a'.repeat(60)}`;

describe('liveEnv', () => {
  it('leaves the visitor key as the only credential, subscription token included', () => {
    const operator: Record<string, string> = { PATH: '/usr/bin', CLAUDE_CODE_OAUTH_TOKEN: 'operator-oauth' };
    for (const name of CREDENTIAL_ENV_VARS) operator[name] = 'operator-secret';

    const env = liveEnv(KEY, operator as NodeJS.ProcessEnv);

    expect(env.ANTHROPIC_API_KEY).toBe(KEY);
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    const leaked = Object.entries(env).filter(([, value]) => value === 'operator-secret' || value === 'operator-oauth');
    expect(leaked).toEqual([]);
    expect(env.PATH).toBe('/usr/bin');
  });
});

describe('refusingJudge', () => {
  it('fails loudly instead of grading', async () => {
    await expect(refusingJudge({ system: 's', prompt: 'p', schema: {} })).rejects.toThrow(/no judge/);
  });
});

describe('isLiveModel', () => {
  it('offers the current models below the top tier, and nothing legacy', () => {
    expect(isLiveModel('claude-sonnet-5-5')).toBe(true);
    expect(isLiveModel('claude-haiku-4-5-20251001')).toBe(true);
    expect(isLiveModel('claude-opus-5-5')).toBe(true);
    expect(isLiveModel('claude-fable-5-1')).toBe(false);
    expect(isLiveModel('claude-sonnet-5')).toBe(false);
  });
});

describe('clientBucket', () => {
  const headers = new Headers({ 'x-forwarded-for': '203.0.113.7, 10.0.0.1' });

  it('ignores X-Forwarded-For unless a trusted proxy is declared', () => {
    expect(clientBucket(headers, {})).toEqual({ key: 'shared', limit: LIVE_SHARED_RATE_LIMIT_PER_HOUR });
  });

  it('uses the first forwarded address behind a trusted proxy', () => {
    expect(clientBucket(headers, { SCAFFOLDBENCH_TRUST_PROXY: '1' })).toEqual({
      key: '203.0.113.7',
      limit: LIVE_RATE_LIMIT_PER_HOUR,
    });
  });
});

describe('LiveAdmissions', () => {
  const bucket = { key: 'a', limit: 3 };

  it('caps the runs in flight and frees a slot on release, once', () => {
    const admissions = new LiveAdmissions(2);
    const first = admissions.admit({ key: 'x', limit: 10 }, 0);
    const second = admissions.admit({ key: 'y', limit: 10 }, 0);
    expect(first.ok && second.ok).toBe(true);
    const third = admissions.admit({ key: 'z', limit: 10 }, 0);
    expect(third).toMatchObject({ ok: false, status: 503 });

    if (!first.ok) throw new Error('unreachable');
    first.release();
    first.release();
    expect(admissions.activeRuns).toBe(1);
    expect(admissions.admit({ key: 'z', limit: 10 }, 0).ok).toBe(true);
  });

  it('rate-limits a client per rolling hour', () => {
    const admissions = new LiveAdmissions(100);
    for (let i = 0; i < 3; i += 1) expect(admissions.admit(bucket, i).ok).toBe(true);
    expect(admissions.admit(bucket, 10)).toMatchObject({ ok: false, status: 429 });
    expect(admissions.admit({ key: 'b', limit: 3 }, 10).ok).toBe(true);
    expect(admissions.admit(bucket, 3_600_001).ok).toBe(true);
  });

  it('defaults to the documented concurrency cap', () => {
    const admissions = new LiveAdmissions();
    for (let i = 0; i < LIVE_MAX_CONCURRENT_RUNS; i += 1) {
      expect(admissions.admit({ key: `k${i}`, limit: 10 }, 0).ok).toBe(true);
    }
    expect(admissions.admit({ key: 'next', limit: 10 }, 0).ok).toBe(false);
  });
});

describe('checkApiKey', () => {
  const signal = new AbortController().signal;
  const answering = (status: number) => (async () => new Response('{}', { status })) as typeof fetch;

  it('rejects only on an authentication answer', async () => {
    expect(await checkApiKey(KEY, signal, answering(401))).toBe('rejected');
    expect(await checkApiKey(KEY, signal, answering(403))).toBe('rejected');
    expect(await checkApiKey(KEY, signal, answering(200))).toBe('ok');
    expect(await checkApiKey(KEY, signal, answering(529))).toBe('unknown');
  });

  it('treats a network failure as no verdict', async () => {
    const failing = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    expect(await checkApiKey(KEY, signal, failing)).toBe('unknown');
  });

  it('sends the key to the API and nowhere else', async () => {
    let seen: { url: string; key: string | null } | undefined;
    const recording = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen = { url: String(input), key: new Headers(init?.headers).get('x-api-key') };
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    await checkApiKey(KEY, signal, recording);
    expect(seen).toEqual({ url: 'https://api.anthropic.com/v1/models?limit=1', key: KEY });
  });
});

describe('summarizeLiveRun', () => {
  it('sends the fields the demo renders and not the rest of the record', () => {
    const summary = summarizeLiveRun(run({ judgeCostUsd: 0.2 }));
    expect(summary).not.toHaveProperty('judgeCostUsd');
    expect(summary).not.toHaveProperty('usage');
    expect(summary.runId).toBe('single__alpha__r1');
  });
});
