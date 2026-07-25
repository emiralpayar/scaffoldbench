import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { Judge, JudgeRequest, JudgeResponse } from './types';

export interface JudgeOptions {
  model: string;
  /** Called with the USD cost of every judge call, so it stays out of strategy cost. */
  onCost?: (usd: number) => void;
  maxBudgetUsd?: number;
}

/**
 * A tool-less, structured-output model call used for rubric grading.
 *
 * Judge spend is reported separately from strategy spend everywhere in the
 * pipeline. Folding grading cost into a strategy's cost would make an
 * architecture look expensive for reasons that have nothing to do with it.
 */
export function createJudge(options: JudgeOptions): Judge {
  return async function judge<T>(req: JudgeRequest): Promise<JudgeResponse<T>> {
    let value: unknown;
    let costUsd = 0;
    let text = '';

    for await (const message of query({
      prompt: req.prompt,
      options: {
        model: options.model,
        systemPrompt: req.system,
        allowedTools: [],
        disallowedTools: ['Bash', 'Read', 'Write', 'Edit', 'WebFetch', 'WebSearch', 'Glob', 'Grep'],
        permissionMode: 'dontAsk',
        settingSources: [],
        persistSession: false,
        maxTurns: 1,
        maxBudgetUsd: options.maxBudgetUsd ?? 0.5,
        outputFormat: { type: 'json_schema', schema: req.schema },
      },
    }) as AsyncIterable<SDKMessage>) {
      if (message.type !== 'result') continue;
      costUsd = message.total_cost_usd ?? 0;
      if (message.subtype === 'success') {
        value = message.structured_output;
        text = message.result ?? '';
      }
    }

    options.onCost?.(costUsd);

    if (value === undefined || value === null) {
      value = parseLooseJson(text);
    }
    if (value === undefined) {
      throw new Error('judge returned no parsable structured output');
    }

    return { value: value as T, costUsd };
  };
}

function parseLooseJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced?.[1] ?? text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end <= start) return undefined;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return undefined;
  }
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
