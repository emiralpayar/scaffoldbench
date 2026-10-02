/**
 * Run one tool-use task, once, on a visitor's own API key, and stream the
 * trace back. Server mode only: the file is named `route.live.ts` and only a
 * `NEXT_PUBLIC_ARENA_LIVE=1` build lists `live.ts` as a page extension, so the
 * public static export has no API at all.
 *
 * Hosting: this spawns the Agent SDK's native subprocess (hundreds of MB of
 * RSS per run) and writes a scratch directory, so it needs a long-lived Node
 * server or container, not a serverless function.
 *
 * What keeps it safe to expose (the rules live in `lib/server/live.ts`, with
 * tests):
 *
 *  1. The model subprocess runs with `liveEnv(apiKey)`, which removes every
 *     credential source the SDK would otherwise fall back to, the operator's
 *     Claude Code subscription token included. A visitor's run can only
 *     authenticate as the visitor.
 *  2. No judge runs at all. The demo accepts only tool-use tasks, which are
 *     scored deterministically, and hands the runner a judge that refuses to
 *     run, so no grading call can fall back to the operator's credentials.
 *  3. The key is read from the request body, checked against the API's model
 *     list (a free call) so a bad key fails in a second instead of after a
 *     full run, handed to the subprocess, and never written anywhere.
 *     Everything streamed back, trace events included, passes through
 *     `redactSecrets`.
 *  4. Every run is bounded: one architecture, one task, one repeat, a USD
 *     ceiling, a wall-clock ceiling, a cap on runs in flight, and a rate
 *     limit. Each request gets its own run-set id, and the runner gives every
 *     run a private temporary directory that it removes afterwards.
 *
 * The request signal is the runner's hard stop, so a visitor who closes the
 * tab aborts the run and pays only for what had already run.
 */

import { randomUUID } from 'node:crypto';

import type { NextRequest } from 'next/server';

import {
  FIXTURES_DIR,
  InvalidApiKeyError,
  assertApiKeyShape,
  redactSecrets,
  runMatrix,
} from '@arena/core';
import type { RunnerConfig, TraceEvent } from '@arena/core';
import { getStrategies } from '@arena/strategies';
import { getTasks } from '@arena/tasks';

import {
  LIVE_DEFAULT_MODEL,
  LIVE_HEARTBEAT_MS,
  LIVE_MAX_COST_USD,
  LIVE_MAX_WALL_CLOCK_MS,
  LIVE_MODELS,
  LiveAdmissions,
  checkApiKey,
  clientBucket,
  isLiveModel,
  liveEnv,
  refusingJudge,
  summarizeLiveRun,
} from '../../../lib/server/live';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const admissions = new LiveAdmissions();

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
    const message = error instanceof InvalidApiKeyError ? error.message : 'The API key is not usable.';
    return errorResponse(400, message);
  }
  const apiKey = body.apiKey.trim();

  if (typeof body.taskId !== 'string' || typeof body.strategyId !== 'string') {
    return errorResponse(400, 'Pick a task and an architecture.');
  }

  const model = typeof body.model === 'string' ? body.model : LIVE_DEFAULT_MODEL;
  if (!isLiveModel(model)) {
    return errorResponse(400, `Model must be one of: ${LIVE_MODELS.map((m) => m.id).join(', ')}.`);
  }

  let tasks;
  let strategies;
  try {
    tasks = getTasks([body.taskId]);
    strategies = getStrategies([body.strategyId]);
  } catch (error) {
    return errorResponse(400, redactSecrets(error instanceof Error ? error.message : 'Unknown selection.'));
  }
  const task = tasks[0];
  const strategy = strategies[0];
  if (tasks.length !== 1 || strategies.length !== 1 || !task || !strategy) {
    return errorResponse(400, 'Pick exactly one task and one architecture.');
  }
  if (task.category !== 'tool-use') {
    return errorResponse(
      400,
      'The live demo runs tool-use tasks only: they are scored deterministically and need no judge.',
    );
  }

  // The slot is taken before the first await, so concurrent requests cannot
  // both see it free; every path below either hands it to the stream or
  // releases it.
  const admission = admissions.admit(clientBucket(request.headers), Date.now());
  if (!admission.ok) return errorResponse(admission.status, admission.message);

  // Never throws: a failed check is 'unknown' and the run proceeds.
  if ((await checkApiKey(apiKey, request.signal)) === 'rejected') {
    admission.release();
    return errorResponse(401, 'Anthropic rejected this API key. Nothing was run.');
  }

  const runSetId = `live-${randomUUID()}`;
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const write = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          closed = true;
        }
      };
      const send = (event: string, data: unknown) =>
        write(`event: ${event}\ndata: ${redactSecrets(JSON.stringify(data))}\n\n`);

      // Idle proxies cut silent connections; a comment frame keeps this one open.
      const heartbeat = setInterval(() => write(': ping\n\n'), LIVE_HEARTBEAT_MS);

      send('status', { phase: 'starting', task: task.id, strategy: strategy.id, model });

      try {
        // The request's own signal is the runner's hard stop: a visitor who
        // closes the tab aborts the run and its model subprocess.
        const config: RunnerConfig = {
          runSetId,
          strategies,
          tasks,
          models: [model],
          effort: 'high',
          repeats: 1,
          concurrency: 1,
          maxCostUsdPerRun: LIVE_MAX_COST_USD,
          maxWallClockMsPerRun: LIVE_MAX_WALL_CLOCK_MS,
          totalBudgetUsd: LIVE_MAX_COST_USD,
          fixtureMode: 'replay',
          fixtureDir: FIXTURES_DIR,
          judge: refusingJudge,
          judgeSamples: 1,
          // Nothing a visitor runs may reach published results.
          persist: false,
          subprocessEnv: liveEnv(apiKey),
          onTraceEvent: (_runId, event: TraceEvent) => send('trace', event),
          signal: request.signal,
        };
        const { records } = await runMatrix(config);

        const record = records[0];
        if (record) send('result', summarizeLiveRun(record));
        else send('error', { message: 'The run produced no result.' });
      } catch (error) {
        send('error', { message: error instanceof Error ? error.message : String(error) });
      } finally {
        clearInterval(heartbeat);
        admission.release();
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

function errorResponse(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
