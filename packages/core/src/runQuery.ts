import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { SANDBOX_DENYLIST, createSandboxGuard } from './guard';
import { normalizeSdkMessage } from './trace';
import type { AgentDefinition, McpServerConfig, RunContext } from './types';

/** Smallest budget worth attempting a call with. */
const MIN_CALL_BUDGET_USD = 0.02;

export interface QuerySpec {
  /** Stable identifier for this step, e.g. `plan`, `execute`, `worker-2`. */
  phase: string;
  label?: string;
  prompt: string;
  /** Full system prompt. Defaults to the run's shared prompt. */
  systemPrompt?: string;
  /** Defaults to the task environment's allowlist. */
  allowedTools?: string[];
  /** Extra MCP servers beyond the task's, merged in. */
  mcpServers?: Record<string, McpServerConfig>;
  maxTurns?: number;
  agents?: Record<string, AgentDefinition>;
  /** JSON Schema. When set, the reply is parsed into `structured`. */
  outputSchema?: Record<string, unknown>;
  model?: string;
  depth?: number;
  agentLabel?: string;
}

export interface QueryOutcome {
  text: string;
  structured: unknown;
  costUsd: number;
  turns: number;
  toolCalls: number;
  deniedToolCalls: number;
  aborted: boolean;
  subtype: string;
  error?: string;
  durationMs: number;
}

/**
 * The single door every strategy goes through to reach the model.
 *
 * Centralising the call is what makes the comparison fair: trace capture, cost
 * accounting, the sandbox guard, hermetic settings and abort propagation are
 * identical for all five architectures, so a difference in the leaderboard is a
 * difference in the architecture rather than in how it was instrumented.
 */
export async function runQuery(ctx: RunContext, spec: QuerySpec): Promise<QueryOutcome> {
  const depth = spec.depth ?? 0;
  const startedAt = Date.now();
  const allowedTools = spec.allowedTools ?? ctx.env.allowedTools;

  const emptyOutcome = (reason: string): QueryOutcome => ({
    text: '',
    structured: undefined,
    costUsd: 0,
    turns: 0,
    toolCalls: 0,
    deniedToolCalls: 0,
    aborted: true,
    subtype: 'skipped',
    error: reason,
    durationMs: Date.now() - startedAt,
  });

  ctx.trace.append({
    phase: spec.phase,
    depth,
    agent: spec.agentLabel,
    kind: 'phase_start',
    text: spec.label ?? spec.phase,
  });

  if (ctx.signal.aborted) return emptyOutcome('run already aborted');
  if (ctx.budget.exceeded) return emptyOutcome(`budget exhausted (${ctx.budget.stopReason})`);
  if (ctx.budget.remainingUsd < MIN_CALL_BUDGET_USD) {
    return emptyOutcome('remaining budget below the minimum for another call');
  }

  ctx.trace.append({
    phase: spec.phase,
    depth,
    agent: spec.agentLabel,
    kind: 'user',
    text: spec.prompt,
  });

  const controller = new AbortController();
  const onParentAbort = () => controller.abort();
  ctx.signal.addEventListener('abort', onParentAbort, { once: true });

  let deniedToolCalls = 0;
  let toolCalls = 0;
  let text = '';
  let structured: unknown;
  let costUsd = 0;
  let turns = 0;
  let subtype = 'unknown';
  let error: string | undefined;
  let aborted = false;

  const options: Options = {
    model: spec.model ?? ctx.model,
    effort: ctx.effort,
    systemPrompt: spec.systemPrompt ?? ctx.systemPrompt,
    // `tools` decides what the model is even shown; `allowedTools` decides what
    // may run. Both are pinned to the task's toolset because the harness owns
    // the built-in surface too: without this the session loads its own agent
    // tools (Task, Skill, Workflow, ToolSearch, the scheduling tools), which
    // are unusable here but still occupy the prompt — and vary by host, which
    // would make two runs of the same task incomparable.
    tools: [...allowedTools],
    allowedTools: [...allowedTools],
    disallowedTools: [...SANDBOX_DENYLIST],
    mcpServers: { ...ctx.env.mcpServers, ...(spec.mcpServers ?? {}) },
    // Only pre-approved tools may run, and nothing prompts an operator.
    permissionMode: 'dontAsk',
    // Hermetic: never inherit ~/.claude or the repo's own settings, otherwise
    // results depend on whoever ran the benchmark.
    settingSources: [],
    cwd: ctx.cwd,
    maxTurns: spec.maxTurns ?? ctx.task.maxTurns,
    maxBudgetUsd: Math.max(MIN_CALL_BUDGET_USD, ctx.budget.remainingUsd),
    abortController: controller,
    persistSession: false,
    includePartialMessages: false,
    hooks: {
      PreToolUse: createSandboxGuard({
        allowedTools,
        trace: ctx.trace,
        phase: spec.phase,
        depth,
        onDenied: () => {
          deniedToolCalls += 1;
        },
      }),
    },
    ...(ctx.subprocessEnv ? { env: ctx.subprocessEnv } : {}),
    ...(spec.agents ? { agents: spec.agents } : {}),
    ...(spec.outputSchema
      ? { outputFormat: { type: 'json_schema' as const, schema: spec.outputSchema } }
      : {}),
  };

  try {
    for await (const message of query({ prompt: spec.prompt, options }) as AsyncIterable<SDKMessage>) {
      for (const event of normalizeSdkMessage(message, {
        phase: spec.phase,
        depth,
        agent: spec.agentLabel,
      })) {
        if (event.kind === 'tool_call') toolCalls += 1;
        ctx.trace.append(event);
      }

      if (message.type === 'result') {
        subtype = message.subtype;
        costUsd = message.total_cost_usd ?? 0;
        turns = message.num_turns ?? 0;
        if (message.subtype === 'success') {
          text = message.result ?? '';
          structured = message.structured_output;
        } else {
          error = (message.errors ?? []).join('; ') || message.subtype;
        }
      }

      // Stop as soon as the run-level ceiling is hit, even mid-stream.
      if (ctx.budget.exceeded && !controller.signal.aborted) {
        aborted = true;
        controller.abort();
      }
    }
  } catch (caught) {
    const messageText = caught instanceof Error ? caught.message : String(caught);
    if (controller.signal.aborted) {
      aborted = true;
      error = error ?? `aborted: ${messageText}`;
    } else {
      error = messageText;
      ctx.trace.append({
        phase: spec.phase,
        depth,
        agent: spec.agentLabel,
        kind: 'error',
        isError: true,
        text: messageText,
      });
    }
  } finally {
    ctx.signal.removeEventListener('abort', onParentAbort);
  }

  ctx.budget.charge({
    costUsd,
    turns,
    usage: lastUsage(ctx),
  });

  const durationMs = Date.now() - startedAt;
  ctx.trace.append({
    phase: spec.phase,
    depth,
    agent: spec.agentLabel,
    kind: 'phase_end',
    costUsd,
    meta: { subtype, turns, toolCalls, deniedToolCalls, durationMs, aborted },
  });

  return {
    text,
    structured,
    costUsd,
    turns,
    toolCalls,
    deniedToolCalls,
    aborted: aborted || ctx.signal.aborted,
    subtype,
    error,
    durationMs,
  };
}

/**
 * Usage for the call that just finished, read back from the trace.
 *
 * The SDK reports token counts only on the terminal `result` message, which the
 * normalizer has already stored, so this avoids threading a second accumulator
 * through the streaming loop.
 */
function lastUsage(ctx: RunContext) {
  for (let i = ctx.trace.events.length - 1; i >= 0; i--) {
    const event = ctx.trace.events[i];
    if (event?.kind === 'result' && event.usage) return event.usage;
  }
  return {};
}

/** Parse a structured reply, falling back to JSON embedded in prose. */
export function readStructured<T>(outcome: QueryOutcome): T | undefined {
  if (outcome.structured !== undefined && outcome.structured !== null) {
    return outcome.structured as T;
  }
  const fenced = outcome.text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced?.[1] ?? outcome.text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end <= start) return undefined;
  try {
    return JSON.parse(candidate.slice(start, end + 1)) as T;
  } catch {
    return undefined;
  }
}
