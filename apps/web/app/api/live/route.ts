/**
 * Run one task, once, on a visitor's own API key, and stream the trace back.
 *
 * Three things make this safe to expose:
 *
 *  1. The run executes with an environment built by `visitorEnv`, which deletes
 *     every credential source the SDK would otherwise fall back to. A visitor's
 *     run cannot authenticate as the site operator, so it cannot bill them.
 *  2. The key is read from the request body, handed to the subprocess, and
 *     never written anywhere — not to `results/`, not to a log line. Anything
 *     echoed back passes through `redactSecrets` first.
 *  3. The run is bounded on every axis that costs money: one strategy, one
 *     task, one repeat, a hard USD ceiling, a wall-clock timeout, and a per-IP
 *     rate limit.
 */

import { NextRequest } from 'next/server';

import {
  InvalidApiKeyError,
  assertApiKeyShape,
  createJudge,
  redactSecrets,
  runMatrix,
  visitorEnv,
} from '@arena/core';
import type { RunRecord, TraceEvent } from '@arena/core';
import { getStrategies } from '@arena/strategies';
import { getTasks } from '@arena/tasks';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/** Well below what a full benchmark run allows — this is a demonstration. */
const MAX_COST_USD = 0.5;
const MAX_WALL_CLOCK_MS = 240_000;
const RATE_LIMIT_PER_HOUR = 6;

const ALLOWED_MODELS = new Set(['claude-sonnet-5', 'claude-opus-5', 'claude-haiku-4-5']);

/**
 * Per-IP counter.
 *
 * In-memory, so it resets on redeploy and does not span instances. That is an
 * accepted limit: the real ceiling is that every run is paid for by the key
 * that requested it. This exists to stop one visitor monopolising the process,
 * not to enforce a quota.
 */
const attempts = new Map<string, number[]>();

function rateLimited(ip: string, now: number): boolean {
  const hourAgo = now - 3_600_000;
  const recent = (attempts.get(ip) ?? []).filter((t) => t > hourAgo);
  if (recent.length >= RATE_LIMIT_PER_HOUR) {
    attempts.set(ip, recent);
    return true;
  }
  recent.push(now);
  attempts.set(ip, recent);
  return false;
}

function clientIp(request: NextRequest): string {
  const forwarded = request.headers.get('x-forwarded-for');
  return forwarded?.split(',')[0]?.trim() || request.headers.get('x-real-ip') || 'unknown';
}

interface LiveRequestBody {
  apiKey?: unknown;
  taskId?: unknown;
  strategyId?: unknown;
  model?: unknown;
}

export async function POST(request: NextRequest): Promise<Response> {
  let body: LiveRequestBody;
  try {
    body = (await request.json()) as LiveRequestBody;
  } catch {
    return errorResponse(400, 'The request body must be JSON.');
  }

  try {
    assertApiKeyShape(body.apiKey);
  } catch (error) {
    const message =
      error instanceof InvalidApiKeyError ? error.message : 'The API key is not usable.';
    return errorResponse(400, message);
  }
  const apiKey = body.apiKey;

  if (typeof body.taskId !== 'string' || typeof body.strategyId !== 'string') {
    return errorResponse(400, 'Pick a task and a strategy.');
  }

  const model = typeof body.model === 'string' ? body.model : 'claude-sonnet-5';
  if (!ALLOWED_MODELS.has(model)) {
    return errorResponse(400, `Model must be one of: ${[...ALLOWED_MODELS].join(', ')}.`);
  }

  let tasks;
  let strategies;
  try {
    tasks = getTasks([body.taskId]);
    strategies = getStrategies([body.strategyId]);
  } catch (error) {
    return errorResponse(400, error instanceof Error ? error.message : 'Unknown selection.');
  }
  if (tasks.length !== 1 || strategies.length !== 1) {
    return errorResponse(400, 'Pick exactly one task and one strategy.');
  }

  if (rateLimited(clientIp(request), Date.now())) {
    return errorResponse(
      429,
      `That is ${RATE_LIMIT_PER_HOUR} runs this hour from your address. Try again later, or run the benchmark locally.`,
    );
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
          );
        } catch {
          closed = true;
        }
      };

      send('status', { phase: 'starting', task: tasks[0]?.id, strategy: strategies[0]?.id });

      try {
        const { records } = await runMatrix({
          runSetId: 'live-demo',
          strategies,
          tasks,
          models: [model],
          effort: 'high',
          repeats: 1,
          concurrency: 1,
          maxCostUsdPerRun: MAX_COST_USD,
          maxWallClockMsPerRun: MAX_WALL_CLOCK_MS,
          totalBudgetUsd: MAX_COST_USD,
          fixtureMode: 'replay',
          fixtureDir: fixtureDirectory(),
          judge: createJudge({ model }),
          judgeSamples: 1,
          // Nothing a visitor runs may reach published results.
          persist: false,
          // The whole point: this run can only authenticate as its caller.
          subprocessEnv: visitorEnv(apiKey),
          onTraceEvent: (_runId, event: TraceEvent) => send('trace', event),
        });

        const record = records[0];
        if (record) send('result', summarize(record));
        else send('error', { message: 'The run produced no result.' });
      } catch (error) {
        send('error', {
          message: redactSecrets(error instanceof Error ? error.message : String(error)),
        });
      } finally {
        send('done', {});
        closed = true;
        try {
          controller.close();
        } catch {
          // Already closed by the client disconnecting.
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  });
}

/** Only the fields the demo renders — deliberately not the whole record. */
function summarize(record: RunRecord) {
  return {
    runId: record.runId,
    score: record.score,
    passed: record.passed,
    failureMode: record.failureMode,
    costUsd: record.costUsd,
    judgeCostUsd: record.judgeCostUsd,
    latencyMs: record.latencyMs,
    turns: record.turns,
    toolCalls: record.toolCalls,
    deniedToolCalls: record.deniedToolCalls,
    subagentCount: record.subagentCount,
    breakdown: record.breakdown,
    penalties: record.penalties,
    finalText: redactSecrets(record.finalText),
    phases: record.phases,
  };
}

function fixtureDirectory(): string {
  return `${process.cwd()}/../../fixtures`;
}

function errorResponse(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
