/**
 * The rules of the live demo (`app/api/live/route.live.ts`), kept out of the
 * route file because a Next route may export only its handlers and config,
 * and because every rule here is a safety property worth a test.
 *
 * Server mode only: nothing in the static export imports this module.
 */

import type { Judge } from '@scaffoldbench/core';
import { visitorEnv } from '@scaffoldbench/core';

import { MODELS } from '../models';
import type { RunRecord } from '../records';

/** Well below what a full benchmark run allows: this is a demonstration. */
export const LIVE_MAX_COST_USD = 0.5;
export const LIVE_MAX_WALL_CLOCK_MS = 240_000;
export const LIVE_MAX_CONCURRENT_RUNS = 2;
export const LIVE_HEARTBEAT_MS = 15_000;

/** Per client, when a trusted proxy says who the client is. */
export const LIVE_RATE_LIMIT_PER_HOUR = 6;
/** Without a trusted proxy every visitor shares one bucket, so it is larger. */
export const LIVE_SHARED_RATE_LIMIT_PER_HOUR = 30;

export const LIVE_DEFAULT_MODEL = 'claude-sonnet-5-5';

/** The current generation below the most expensive tier. */
export const LIVE_MODELS = MODELS.filter((model) => model.tier <= 3);
const LIVE_MODEL_IDS = new Set(LIVE_MODELS.map((model) => model.id));

export function isLiveModel(id: string): boolean {
  return LIVE_MODEL_IDS.has(id);
}

/**
 * Passed to the runner in place of a real judge. The demo offers only
 * tool-use tasks, which are scored deterministically and never call a judge,
 * so this is a tripwire: if a judged task ever reaches the demo, grading
 * fails loudly instead of spending anything on anybody's credentials.
 */
export const refusingJudge: Judge = async () => {
  throw new Error('The live demo runs only deterministic tool-use tasks; no judge is available.');
};

/**
 * The subprocess environment for a visitor's run: `visitorEnv` removes every
 * credential source the SDK would fall back to, and this also removes a
 * Claude Code subscription token from the operator's shell, which is a
 * credential too.
 */
export function liveEnv(
  apiKey: string,
  baseEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string | undefined> {
  const env = visitorEnv(apiKey, baseEnv);
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  return env;
}

// ---------------------------------------------------------------------------
// Admission: rate limit and concurrency
// ---------------------------------------------------------------------------

export interface ClientBucket {
  key: string;
  limit: number;
}

/**
 * Who is asking. `X-Forwarded-For` is trivially forged, so it is trusted only
 * when the operator says a proxy sets it (`SCAFFOLDBENCH_TRUST_PROXY=1`); otherwise
 * every request shares one bucket.
 */
export function clientBucket(
  headers: Headers,
  env: Readonly<Record<string, string | undefined>> = process.env,
): ClientBucket {
  if (env.SCAFFOLDBENCH_TRUST_PROXY !== '1') {
    return { key: 'shared', limit: LIVE_SHARED_RATE_LIMIT_PER_HOUR };
  }
  const forwarded = headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  const ip = forwarded || headers.get('x-real-ip') || 'unknown';
  return { key: ip, limit: LIVE_RATE_LIMIT_PER_HOUR };
}

export type Admission =
  | { ok: true; release: () => void }
  | { ok: false; status: 429 | 503; message: string };

/**
 * Per-client attempt times and the number of runs in flight. In memory, so
 * it resets on restart and does not span instances: it exists to stop one
 * visitor monopolising the process. The real ceiling is that every run is
 * paid for by the key that asked for it.
 */
export class LiveAdmissions {
  private readonly attempts = new Map<string, number[]>();
  private active = 0;

  constructor(private readonly maxConcurrent = LIVE_MAX_CONCURRENT_RUNS) {}

  /**
   * Take a run slot, or say why not. The slot is taken synchronously, before
   * the caller awaits anything, so two requests cannot both see a free slot.
   * `release` is idempotent.
   */
  admit(bucket: ClientBucket, now: number): Admission {
    if (this.rateLimited(bucket, now)) {
      return {
        ok: false,
        status: 429,
        message: 'Too many live runs this hour. Try again later, or run the benchmark locally.',
      };
    }
    if (this.active >= this.maxConcurrent) {
      return {
        ok: false,
        status: 503,
        message: 'The live demo is busy with other runs. Try again in a few minutes.',
      };
    }
    this.active += 1;
    let released = false;
    return {
      ok: true,
      release: () => {
        if (released) return;
        released = true;
        this.active -= 1;
      },
    };
  }

  get activeRuns(): number {
    return this.active;
  }

  private rateLimited({ key, limit }: ClientBucket, now: number): boolean {
    const hourAgo = now - 3_600_000;
    // Forged addresses would otherwise grow the map without bound.
    if (this.attempts.size > 10_000) {
      for (const [client, times] of this.attempts) {
        if (!times.some((t) => t > hourAgo)) this.attempts.delete(client);
      }
    }
    const recent = (this.attempts.get(key) ?? []).filter((t) => t > hourAgo);
    if (recent.length >= limit) {
      this.attempts.set(key, recent);
      return true;
    }
    recent.push(now);
    this.attempts.set(key, recent);
    return false;
  }
}

/**
 * Ask the API whether it knows this key, so a typo fails in a second rather
 * than after a full run. Listing models costs nothing. A network problem is
 * not a verdict on the key, so it lets the run proceed and fail on its own.
 */
export async function checkApiKey(
  apiKey: string,
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<'ok' | 'rejected' | 'unknown'> {
  try {
    const response = await fetchImpl('https://api.anthropic.com/v1/models?limit=1', {
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]),
    });
    if (response.status === 401 || response.status === 403) return 'rejected';
    return response.ok ? 'ok' : 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Only the fields the demo renders, deliberately not the whole record. */
export function summarizeLiveRun(record: RunRecord) {
  return {
    runId: record.runId,
    score: record.score,
    passed: record.passed,
    failureMode: record.failureMode,
    costUsd: record.costUsd,
    latencyMs: record.latencyMs,
    turns: record.turns,
    toolCalls: record.toolCalls,
    deniedToolCalls: record.deniedToolCalls,
    subagentCount: record.subagentCount,
    breakdown: record.breakdown,
    penalties: record.penalties,
    finalText: record.finalText,
    phases: record.phases,
  };
}

export type LiveRunSummary = ReturnType<typeof summarizeLiveRun>;
