import { query } from '@anthropic-ai/claude-agent-sdk';
import type { EffortLevel, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { SANDBOX_DENYLIST } from './guard';
import { STRUCTURED_OUTPUT_TOOL, hermeticOptions } from './hermetic';
import { CallMeter } from './meter';
import { SCHEMA_MIN_TURNS, parseLooseJson } from './runQuery';
import type {
  ApiError,
  Judge,
  JudgeCallOptions,
  JudgeInfo,
  JudgeRequest,
  JudgeResponse,
} from './types';

/**
 * Grading effort when neither the judge's options nor the request name one.
 * Pinned rather than left to the SDK, whose default differs by model, so the
 * judge behaves and costs the same whatever model it runs on. Medium rather
 * than low: rubric grading is reading an answer against a short list of
 * claims, but a lower setting should be shown to grade as well before it is
 * used. A task that has shown it can ask for it (`JudgeRequest.effort`).
 */
export const DEFAULT_JUDGE_EFFORT: EffortLevel = 'medium';

/** How long one grading call may take before it is abandoned. */
export const DEFAULT_JUDGE_TIMEOUT_MS = 180_000;

export interface JudgeOptions {
  model: string;
  /**
   * Called with the USD cost of every judge call — failed and abandoned ones
   * included — so grading spend is accounted for and stays out of strategy cost.
   */
  onCost?: (usd: number) => void;
  maxBudgetUsd?: number;
  /** Default grading effort; a request's own `effort` takes precedence. */
  effort?: EffortLevel;
  /**
   * Environment for the judge's subprocess. A per-call `env` (which the
   * runner passes from the run's `subprocessEnv`) takes precedence.
   */
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
}

/**
 * A judge call that produced no verdict. Carries what the call cost, because
 * a failed grading call is still billed, and the API failure behind it, if
 * any, so the runner can tell a grader outage from a malformed reply.
 */
export class JudgeError extends Error {
  readonly costUsd: number;
  readonly apiError: ApiError | undefined;

  constructor(message: string, details: { costUsd: number; apiError?: ApiError }) {
    super(message);
    this.name = 'JudgeError';
    this.costUsd = details.costUsd;
    this.apiError = details.apiError;
  }
}

/**
 * A judge that says which model grades and at what effort, which the runner
 * records in the manifest. Taken from the judge itself rather than passed
 * alongside it, so the record cannot drift from what actually graded.
 */
export type DescribedJudge = Judge & { readonly info: JudgeInfo };

/** The judge's own description, when it has one. */
export function judgeInfoOf(judge: Judge): JudgeInfo | undefined {
  const info = (judge as Partial<DescribedJudge>).info;
  return info && typeof info.model === 'string' ? info : undefined;
}

/**
 * A tool-less, structured-output model call used for rubric grading.
 *
 * Judge spend is reported separately from strategy spend everywhere in the
 * pipeline. Folding grading cost into a strategy's cost would make an
 * architecture look expensive for reasons that have nothing to do with it.
 */
export function createJudge(options: JudgeOptions): DescribedJudge {
  const timeoutMs = options.timeoutMs ?? DEFAULT_JUDGE_TIMEOUT_MS;
  const effort = options.effort ?? DEFAULT_JUDGE_EFFORT;

  const judge = async function judge<T>(
    req: JudgeRequest,
    call: JudgeCallOptions = {},
  ): Promise<JudgeResponse<T>> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const onAbort = () => controller.abort();
    if (call.signal?.aborted) controller.abort();
    call.signal?.addEventListener('abort', onAbort, { once: true });

    const meter = new CallMeter(options.model);

    try {
      for await (const message of query({
        prompt: req.prompt,
        options: {
          ...hermeticOptions(call.env ?? options.env),
          model: options.model,
          effort: req.effort ?? effort,
          systemPrompt: req.system,
          // No built-in tools and no MCP servers: the judge reads and answers.
          // The structured-output tool is how it answers.
          tools: [STRUCTURED_OUTPUT_TOOL],
          allowedTools: [STRUCTURED_OUTPUT_TOOL],
          disallowedTools: [...SANDBOX_DENYLIST],
          mcpServers: {},
          maxTurns: SCHEMA_MIN_TURNS,
          maxBudgetUsd: options.maxBudgetUsd ?? 0.5,
          outputFormat: { type: 'json_schema', schema: req.schema },
          abortController: controller,
        },
      }) as AsyncIterable<SDKMessage>) {
        meter.observe(message);
      }
    } catch (caught) {
      if (!controller.signal.aborted) meter.noteThrown(caught);
    } finally {
      clearTimeout(timer);
      call.signal?.removeEventListener('abort', onAbort);
    }

    const report = meter.report();
    const costUsd = report.costUsd;
    options.onCost?.(costUsd);

    if (controller.signal.aborted && !report.resultSeen) {
      if (timedOut) {
        const message = `judge did not answer within ${Math.round(timeoutMs / 1000)}s`;
        throw new JudgeError(message, {
          costUsd,
          apiError: { kind: 'server', retryable: true, message },
        });
      }
      throw new JudgeError('judge call aborted', { costUsd });
    }
    if (report.apiError) {
      throw new JudgeError(`judge call failed: ${report.apiError.message}`, {
        costUsd,
        apiError: report.apiError,
      });
    }

    const value = report.structured ?? parseLooseJson(report.text);
    if (value === undefined || value === null) {
      // A grader that ran out of room or refused gave no verdict either, but
      // say which: it is not a malformed reply, and not an API failure.
      const why = report.modelStop
        ? `judge could not finish (${report.modelStop.reason}): ${report.modelStop.message}`
        : 'judge returned no parsable structured output';
      throw new JudgeError(why, { costUsd });
    }
    return { value: value as T, costUsd };
  };

  return Object.assign(judge, { info: { model: options.model, effort } });
}

/**
 * Run the judge `samples` times independently.
 *
 * Rubric grading is the one part of scoring that is not deterministic, so it is
 * sampled and reduced by median. A single grading call would let one unlucky
 * draw move a strategy's headline number.
 */
export async function sampleJudge<T>(
  judge: Judge,
  req: JudgeRequest,
  samples: number,
): Promise<{ values: T[]; failures: number }> {
  const attempts = await Promise.allSettled(
    Array.from({ length: Math.max(1, samples) }, () => judge<T>(req)),
  );

  const values: T[] = [];
  let failures = 0;
  for (const attempt of attempts) {
    if (attempt.status === 'fulfilled') values.push(attempt.value.value);
    else failures += 1;
  }
  return { values, failures };
}

/** Median of numeric samples; returns `fallback` when there are none. */
export function medianOf(values: readonly number[], fallback = 0): number {
  if (values.length === 0) return fallback;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}
