import { query } from '@anthropic-ai/claude-agent-sdk';
import type { HookCallbackMatcher, HookInput, Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { assistantText, isSyntheticAssistant, type ModelStop } from './apiErrors';
import { emptyUsage } from './budget';
import { SANDBOX_DENYLIST, createSandboxGuard } from './guard';
import type { ToolCallReviewer } from './guard';
import { STRUCTURED_OUTPUT_TOOL, hermeticOptions } from './hermetic';
import { CallMeter } from './meter';
import { modelStopMeta, normalizeSdkMessage } from './trace';
import type {
  ApiError,
  BudgetStopReason,
  McpServerConfig,
  McpServerStatus,
  ModelSpend,
  RunContext,
  TraceSink,
  UsageTotals,
} from './types';

/** How `QueryOutcome.error` names a model stop. */
const MODEL_STOP_LABEL: Record<ModelStop['reason'], string> = {
  output_limit: 'output limit',
  context_limit: 'context limit',
  malformed_tool_use: 'malformed tool call',
  refusal: 'refused',
};

/** Smallest budget worth attempting a call with. */
const MIN_CALL_BUDGET_USD = 0.02;

/**
 * Turn floor for a call that asks for structured output.
 *
 * The SDK delivers a schema reply as a call to its `StructuredOutput` tool, so
 * the answer itself takes a turn, and a reply that fails schema validation
 * needs another turn to retry. With one turn, every such slip became a lost
 * phase: `error_max_turns`, and the plan or selection inside the rejected
 * call discarded. Three leaves room for two retries. A call stops at its first
 * valid reply, so the floor costs nothing when it is not needed.
 */
export const SCHEMA_MIN_TURNS = 3;

export interface QuerySpec {
  /** Stable identifier for this step, e.g. `plan`, `execute`, `worker-2`. */
  phase: string;
  label?: string;
  prompt: string;
  /** Full system prompt. Defaults to the run's shared prompt. */
  systemPrompt?: string;
  /**
   * The task tools this call may see and call. Defaults to the environment's
   * full toolset. Tools outside the list are not shown to the model at all,
   * so `[]` is a call with no task tools.
   */
  allowedTools?: string[];
  /** Extra MCP servers beyond the task's, merged in. */
  mcpServers?: Record<string, McpServerConfig>;
  maxTurns?: number;
  /**
   * Most this call may spend; it never gets more than the run's unreserved
   * budget. Calls made at the same time each need a share (`runAll` sets an
   * equal one): without it the first call reserves everything available and
   * its siblings are skipped rather than handed money the run does not have.
   */
  maxBudgetUsd?: number;
  /**
   * JSON Schema. When set, the reply is parsed into `structured`, the
   * `StructuredOutput` tool is allowed, and the call gets at least
   * `SCHEMA_MIN_TURNS` turns.
   */
  outputSchema?: Record<string, unknown>;
  model?: string;
  depth?: number;
  agentLabel?: string;
  /**
   * Review each permitted tool call before it runs (see `ToolCallReviewer`).
   * A denial reaches the model as the tool's result, so it can adapt. The
   * reviewer may make model calls of its own through `runQuery`; they are
   * separate calls, traced and charged to the run like any other.
   */
  reviewToolCall?: ToolCallReviewer;
}

export interface QueryOutcome {
  /** Identifies this call. Every trace event it produced carries it as `callId`. */
  callId: string;
  /** The call's answer. Never the text of an API error. */
  text: string;
  structured: unknown;
  /**
   * True when the spec asked for an `outputSchema` and no structured output
   * came back. `readStructured` may still find JSON in the text; this flag
   * records that the schema path itself failed.
   */
  structuredMissing: boolean;
  costUsd: number;
  /**
   * True when no result message reported the cost (the call was aborted or
   * crashed), so `costUsd` was priced from the usage it streamed.
   */
  costEstimated: boolean;
  /** Models whose streamed usage had no known price; `costUsd` is then a lower bound. */
  unpricedModels: string[];
  usage: UsageTotals;
  /** Per-model breakdown of this call, including the SDK's helper-model calls. */
  byModel: Record<string, ModelSpend>;
  /** The lease this call ran under: the `maxBudgetUsd` handed to the SDK. */
  budgetUsd: number;
  turns: number;
  /** Task tool calls attempted, denied ones included; the structured reply is not one. */
  toolCalls: number;
  deniedToolCalls: number;
  /** True when the call was cut off before it finished (run aborted, or out of budget). */
  aborted: boolean;
  /**
   * How the call ended: the SDK's result subtype (`success`,
   * `error_max_turns`, …), or — when no result arrived — `skipped` (never
   * started), `aborted` (cut off by the run) or `crashed` (the stream threw).
   */
  subtype: string;
  error?: string;
  /**
   * Set when the call failed at the API or in the infrastructure (auth, rate
   * limit, overload, server error, unusable model, a crashed subprocess):
   * a failure that is not the architecture's.
   */
  apiError?: ApiError;
  /**
   * Set when the turn ended because the model could not finish it: it ran
   * out of output tokens or context, or its safeguards refused. Never with
   * `apiError`: this is the run's own outcome, and it counts against it.
   */
  modelStop?: ModelStop;
  /**
   * The effort level the CLI reported applying to this call's turns, after
   * any silent downgrade for the model: `null` when it sent no effort
   * parameter (a model without effort support), absent when the call ended
   * before a tool call or a finished reply could report it. See `watchEffort`.
   */
  effectiveEffort?: string | null;
  /** Names of the MCP servers this call was given. */
  mcpServersExpected: string[];
  /** MCP servers as the session reported them at start-up; empty if it never got that far. */
  mcpServers: McpServerStatus[];
  /** Epoch milliseconds at which the call started. */
  startedAtMs: number;
  durationMs: number;
}

const callCounters = new WeakMap<TraceSink, number>();

/** `call-1`, `call-2`, … in start order, unique within one run's trace. */
function nextCallId(trace: TraceSink): string {
  const next = (callCounters.get(trace) ?? 0) + 1;
  callCounters.set(trace, next);
  return `call-${next}`;
}

/**
 * The single door every strategy goes through to reach the model.
 *
 * Centralising the call is what makes the comparison fair: trace capture, cost
 * accounting, the sandbox guard, hermetic settings and abort propagation are
 * identical for every architecture, so a difference in the leaderboard is a
 * difference in the architecture rather than in how it was instrumented.
 */
export async function runQuery(ctx: RunContext, spec: QuerySpec): Promise<QueryOutcome> {
  const depth = spec.depth ?? 0;
  const startedAtMs = Date.now();
  const callId = nextCallId(ctx.trace);
  const where = { phase: spec.phase, depth, agent: spec.agentLabel, callId };
  const allowedTools = spec.allowedTools ?? ctx.env.allowedTools;
  const schema = spec.outputSchema;

  ctx.trace.append({ ...where, kind: 'phase_start', text: spec.label ?? spec.phase });

  const skip = (reason: string): QueryOutcome => {
    const outcome: QueryOutcome = {
      callId,
      text: '',
      structured: undefined,
      structuredMissing: schema !== undefined,
      costUsd: 0,
      costEstimated: false,
      unpricedModels: [],
      usage: emptyUsage(),
      byModel: {},
      budgetUsd: 0,
      turns: 0,
      toolCalls: 0,
      deniedToolCalls: 0,
      aborted: true,
      subtype: 'skipped',
      error: reason,
      mcpServersExpected: [],
      mcpServers: [],
      startedAtMs,
      durationMs: Date.now() - startedAtMs,
    };
    ctx.trace.append({
      ...where,
      kind: 'phase_end',
      costUsd: 0,
      meta: { subtype: outcome.subtype, skipped: reason, durationMs: outcome.durationMs },
    });
    return outcome;
  };

  if (ctx.signal.aborted) return skip('run already aborted');
  if (ctx.budget.exceeded) return skip(`budget exhausted (${ctx.budget.stopReason})`);
  const lease = ctx.budget.reserve(spec.maxBudgetUsd);
  if (lease.amountUsd < MIN_CALL_BUDGET_USD) {
    lease.settle({ costUsd: 0, turns: 0, usage: {} });
    return skip(
      `budget available to this call ($${lease.amountUsd.toFixed(4)}) is below the ` +
        `$${MIN_CALL_BUDGET_USD} minimum`,
    );
  }

  ctx.trace.append({ ...where, kind: 'user', text: spec.prompt });

  const controller = new AbortController();
  const onParentAbort = () => controller.abort();
  ctx.signal.addEventListener('abort', onParentAbort, { once: true });

  // A phase sees only the task tools it may call: a "tool-less" planner gets
  // no task server at all, a read-only proposer a server holding only the
  // read-only tools. And every call gets its own server instances, because an
  // in-process MCP server can serve only one session at a time.
  const mcpServers = {
    ...ctx.env.createMcpServers({ only: allowedTools }),
    ...(spec.mcpServers ?? {}),
  };
  const harnessTools = schema ? [STRUCTURED_OUTPUT_TOOL] : [];
  const permitted = [...allowedTools, ...harnessTools];
  const requestedTurns = spec.maxTurns ?? ctx.task.maxTurns;

  let deniedToolCalls = 0;
  const appliedEffort = watchEffort();
  const options: Options = {
    ...hermeticOptions(),
    model: spec.model ?? ctx.model,
    effort: ctx.effort,
    systemPrompt: spec.systemPrompt ?? ctx.systemPrompt,
    // `tools` is the set of *built-in* tools the session offers. None of
    // Claude Code's own tools belong in a benchmark — the task's MCP servers
    // are the whole toolset — so it holds only the harness's structured-output
    // tool when a schema needs it. Left unset, the session would load its
    // agent tools (Task, Skill, ToolSearch, …), which vary by host and would
    // make two runs of the same task incomparable. Without the Agent tool the
    // SDK's own subagents are out too: an architecture's sub-agents are its
    // own `runQuery` calls (`depth` > 0), each traced and charged like any other.
    tools: [...harnessTools],
    allowedTools: [...permitted],
    disallowedTools: [...SANDBOX_DENYLIST],
    mcpServers,
    cwd: ctx.cwd,
    maxTurns: schema ? Math.max(requestedTurns, SCHEMA_MIN_TURNS) : requestedTurns,
    maxBudgetUsd: lease.amountUsd,
    abortController: controller,
    includePartialMessages: false,
    hooks: {
      PreToolUse: [
        ...createSandboxGuard({
          allowedTools: permitted,
          trace: ctx.trace,
          phase: spec.phase,
          depth,
          ...(spec.agentLabel !== undefined ? { agent: spec.agentLabel } : {}),
          callId,
          onDenied: () => {
            deniedToolCalls += 1;
          },
          ...(spec.reviewToolCall ? { review: spec.reviewToolCall } : {}),
        }),
        appliedEffort.matcher,
      ],
      Stop: [appliedEffort.matcher],
    },
    ...(ctx.subprocessEnv ? { env: ctx.subprocessEnv } : {}),
    ...(schema ? { outputFormat: { type: 'json_schema' as const, schema } } : {}),
  };

  const meter = new CallMeter(options.model ?? ctx.model);
  let toolCalls = 0;
  // This call's own last words, for when the turn is cut short. Tracked here
  // rather than read back from the trace, which concurrent siblings share,
  // and only ever the model's: never text the CLI wrote in its place.
  let lastText = '';
  // Which of the run's limits made us abort the call mid-stream, if one did.
  let stoppedBy: BudgetStopReason | undefined;
  let crashed = false;

  try {
    for await (const message of query({ prompt: spec.prompt, options }) as AsyncIterable<SDKMessage>) {
      meter.observe(message);
      if (
        message.type === 'assistant' &&
        message.parent_tool_use_id == null &&
        !isSyntheticAssistant(message)
      ) {
        const said = assistantText(message);
        if (said.trim() !== '') lastText = said;
      }
      for (const event of normalizeSdkMessage(message, where)) {
        if (event.kind === 'tool_call' && event.toolName !== STRUCTURED_OUTPUT_TOOL) toolCalls += 1;
        ctx.trace.append(event);
      }

      // Stop as soon as the run-level ceiling is hit, even mid-stream.
      if (message.type !== 'result' && ctx.budget.exceeded && !controller.signal.aborted) {
        stoppedBy = ctx.budget.stopReason;
        controller.abort();
      }
    }
  } catch (caught) {
    // An exception after our own abort is just the stream closing.
    if (!controller.signal.aborted) {
      crashed = true;
      meter.noteThrown(caught);
      ctx.trace.append({
        ...where,
        kind: 'error',
        isError: true,
        text: caught instanceof Error ? caught.message : String(caught),
      });
    }
  } finally {
    ctx.signal.removeEventListener('abort', onParentAbort);
  }

  const report = meter.report();
  const aborted = controller.signal.aborted && !report.resultSeen;
  // A call the run cut short is a timeout or a budget stop — the run's own
  // outcome — even if the CLI wrote "Request was aborted" on its way out.
  const apiError = aborted ? undefined : report.apiError;
  let text = apiError ? '' : report.text;
  const structured = apiError ? undefined : report.structured;

  // A turn that runs out of turns or budget returns an error result with no
  // text, which would throw away everything the agent actually produced — on a
  // research task that can mean a dozen real page fetches scoring zero for want
  // of a final message. The work is still in this call's stream, so recover
  // it. A truncated run is a valid data point; a silently empty one is not.
  // An API failure recovers nothing: the run is not a data point at all.
  if (!apiError && text.trim() === '' && lastText !== '') {
    text = lastText;
    ctx.trace.append({
      ...where,
      kind: 'note',
      text: 'Turn ended without a final message; recovered the last assistant text.',
    });
  }

  const subtype = report.subtype ?? (aborted ? 'aborted' : crashed ? 'crashed' : 'no_result');
  const error = apiError
    ? `API error (${apiError.kind}${apiError.status !== undefined ? ` ${apiError.status}` : ''}): ${apiError.message}`
    : aborted
      ? `aborted: ${stoppedBy ? `run ${stoppedBy} limit reached` : 'run aborted'}`
      : report.modelStop !== undefined
        ? `${MODEL_STOP_LABEL[report.modelStop.reason]}: ${report.modelStop.message}`
        : report.subtype !== undefined && report.subtype !== 'success'
          ? report.errors.join('; ') || report.subtype
          : undefined;

  lease.settle({ costUsd: report.costUsd, turns: report.turns, usage: report.usage });

  const structuredMissing = schema !== undefined && (structured === undefined || structured === null);
  const effectiveEffort = appliedEffort.level();
  const mcpServersExpected = Object.keys(mcpServers);
  const durationMs = Date.now() - startedAtMs;

  ctx.trace.append({
    ...where,
    kind: 'phase_end',
    costUsd: report.costUsd,
    usage: report.usage,
    meta: {
      subtype,
      turns: report.turns,
      toolCalls,
      deniedToolCalls,
      durationMs,
      aborted,
      budgetUsd: lease.amountUsd,
      mcpServersExpected,
      mcpServers: report.mcpServers,
      ...(report.costEstimated ? { costEstimated: true } : {}),
      ...(report.unpricedModels.length > 0 ? { unpricedModels: report.unpricedModels } : {}),
      ...(structuredMissing ? { structuredMissing: true } : {}),
      ...(apiError ? { apiError } : {}),
      ...(report.modelStop ? { modelStop: modelStopMeta(report.modelStop) } : {}),
      ...(effectiveEffort !== undefined ? { effectiveEffort } : {}),
      costByModel: Object.fromEntries(
        Object.entries(report.byModel).map(([model, spend]) => [model, spend.costUsd]),
      ),
    },
  });

  return {
    callId,
    text,
    structured,
    structuredMissing,
    costUsd: report.costUsd,
    costEstimated: report.costEstimated,
    unpricedModels: report.unpricedModels,
    usage: report.usage,
    byModel: report.byModel,
    budgetUsd: lease.amountUsd,
    turns: report.turns,
    toolCalls,
    deniedToolCalls,
    aborted,
    subtype,
    ...(error !== undefined ? { error } : {}),
    ...(apiError ? { apiError } : {}),
    ...(report.modelStop ? { modelStop: report.modelStop } : {}),
    ...(effectiveEffort !== undefined ? { effectiveEffort } : {}),
    mcpServersExpected,
    mcpServers: report.mcpServers,
    startedAtMs,
    durationMs,
  };
}

/**
 * Watches the effort level the CLI actually applies to a call.
 *
 * `effort` is a request. The CLI silently drops it for a model without effort
 * support — Haiku 4.5 is sent none, whatever was asked — and caps it where the
 * model or the account says so. Neither the init message nor the result says
 * which level it settled on; only hooks that fire inside a turn are told:
 * `PreToolUse` before each tool call, `Stop` when the reply ends. So these two
 * hooks are how a record can say what effort its model really ran at.
 */
function watchEffort(): { matcher: HookCallbackMatcher; level(): string | null | undefined } {
  let level: string | null | undefined;
  return {
    matcher: {
      hooks: [
        async (input: HookInput) => {
          const applied = input.effort?.level;
          // A hook told no level means none was sent; a level once told is the call's.
          level = typeof applied === 'string' ? applied : (level ?? null);
          return {};
        },
      ],
    },
    level: () => level,
  };
}

/** Parse a structured reply, falling back to JSON embedded in prose. */
export function readStructured<T>(outcome: Pick<QueryOutcome, 'structured' | 'text'>): T | undefined {
  if (outcome.structured !== undefined && outcome.structured !== null) {
    return outcome.structured as T;
  }
  return parseLooseJson(outcome.text) as T | undefined;
}

/** The first JSON object in `text`, fenced or bare; `undefined` when there is none. */
export function parseLooseJson(text: string): unknown {
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
