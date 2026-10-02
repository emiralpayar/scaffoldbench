import type { SDKMessage, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import {
  SYNTHETIC_MODEL,
  apiErrorOfAssistant,
  classifyFailureText,
  isApiErrorText,
  kindFromStatus,
  makeApiError,
  modelStopOfAssistant,
  modelStopOfResult,
  recognizeFailureText,
  type ModelStop,
} from './apiErrors';
import { emptyUsage } from './budget';
import { asUsageLimit, observeRateLimit, type RateLimitState } from './usageLimit';
import { estimateCostUsd, type PricedUsage } from './pricing';
import { usageFrom } from './trace';
import type { ApiError, McpServerStatus, ModelSpend, UsageTotals } from './types';

/** Everything one `query()` call said about itself, read from its own message stream. */
export interface CallReport {
  /** True once the call's terminal `result` message arrived. */
  resultSeen: boolean;
  /** The result's subtype, or `undefined` when no result arrived. */
  subtype: string | undefined;
  /**
   * The final text of a call that succeeded. Empty for every failure — and in
   * particular for a "successful" result that is really an API error, whose
   * text must never be mistaken for an answer.
   */
  text: string;
  structured: unknown;
  /** Error strings of an error result. */
  errors: string[];
  /**
   * Model round-trips. From the result when it arrived, otherwise the number
   * of distinct main-thread responses streamed before the call was cut off.
   */
  turns: number;
  costUsd: number;
  /** True when no result reported a cost, so `costUsd` was priced from streamed usage. */
  costEstimated: boolean;
  /** Models whose streamed usage could not be priced; `costUsd` is then a lower bound. */
  unpricedModels: string[];
  usage: UsageTotals;
  /** Per-model breakdown, including the SDK's own helper-model calls when it reports them. */
  byModel: Record<string, ModelSpend>;
  apiError?: ApiError;
  /**
   * Set when the turn ended because the model could not finish it — out of
   * room, or a refusal. The run's own limit, so it never comes with an
   * `apiError`, though the result looks like one.
   */
  modelStop?: ModelStop;
  /** MCP servers as the session's init message listed them. */
  mcpServers: McpServerStatus[];
}

interface StreamedResponse {
  model: string;
  mainThread: boolean;
  usage: Required<PricedUsage>;
}

/**
 * Accumulates the accounting for one `query()` call from that call's own
 * messages.
 *
 * Reading usage and text back out of the run's shared trace was how two
 * concurrent phases ended up charged each other's tokens, and how a truncated
 * proposer salvaged its sibling's proposal as its own. A meter belongs to one
 * call and sees nothing else, so neither can happen.
 */
export class CallMeter {
  readonly #defaultModel: string;
  #result: SDKResultMessage | undefined;
  readonly #streamed = new Map<string, StreamedResponse>();
  #anonymous = 0;
  #assistantError: ApiError | undefined;
  #thrown: ApiError | undefined;
  /** The CLI's model-stop notice, while it is the last thing the main thread said. */
  #modelStop: ModelStop | undefined;
  #mcpServers: McpServerStatus[] = [];
  #rateLimit: RateLimitState = { rejected: false };

  constructor(defaultModel: string) {
    this.#defaultModel = defaultModel;
  }

  observe(message: SDKMessage): void {
    switch (message.type) {
      case 'system':
        if (message.subtype === 'init') {
          this.#mcpServers = (message.mcp_servers ?? []).map(({ name, status }) => ({
            name,
            status,
          }));
        }
        break;
      case 'assistant':
        this.#observeAssistant(message);
        break;
      case 'result':
        this.#result = message;
        break;
      case 'rate_limit_event':
        this.#rateLimit = observeRateLimit(this.#rateLimit, message);
        break;
      default:
        break;
    }
  }

  /** Record an exception that ended the stream for a reason other than our own abort. */
  noteThrown(error: unknown): void {
    const text = error instanceof Error ? error.message : String(error);
    this.#thrown = classifyFailureText(text);
  }

  report(): CallReport {
    const result = this.#result;
    const success =
      result?.subtype === 'success' && result.is_error !== true && !isApiErrorText(result.result);
    const cost = this.#cost(result);

    // A turn the CLI ended on a model stop reports itself the way an API
    // failure does — `is_error`, the notice as its text — but is not one.
    // Its last notice says which and why; the terminal reason, when the
    // notice was not recognised, says which.
    const modelStop = success
      ? undefined
      : (this.#modelStop ?? (result ? modelStopOfResult(result) : undefined));

    let apiError: ApiError | undefined;
    if (modelStop !== undefined) {
      // Only a crash after the notice is the infrastructure's.
      apiError = this.#thrown;
    } else if (!success) {
      const fromResult = resultApiError(result);
      apiError = this.#assistantError ?? fromResult ?? this.#thrown;
      // The assistant message names the failure; the result may add its status.
      if (apiError && apiError.status === undefined && fromResult?.status !== undefined) {
        apiError = { ...apiError, status: fromResult.status };
      }
      // A spent usage limit will not lift within a retry's wait.
      if (apiError) apiError = asUsageLimit(apiError, this.#rateLimit);
    }

    return {
      resultSeen: result !== undefined,
      subtype: result?.subtype,
      text: success && result?.subtype === 'success' ? result.result ?? '' : '',
      structured: success && result?.subtype === 'success' ? result.structured_output : undefined,
      errors: result !== undefined && result.subtype !== 'success' ? [...(result.errors ?? [])] : [],
      turns: result?.num_turns ?? this.#streamedTurns(),
      ...cost,
      ...(apiError ? { apiError } : {}),
      ...(modelStop !== undefined && apiError === undefined ? { modelStop } : {}),
      mcpServers: this.#mcpServers,
    };
  }

  #observeAssistant(message: Extract<SDKMessage, { type: 'assistant' }>): void {
    const apiError = apiErrorOfAssistant(message);
    if (apiError) this.#assistantError = apiError;
    if (message.parent_tool_use_id == null) this.#modelStop = modelStopOfAssistant(message);

    const body = message.message as { id?: unknown; model?: unknown; usage?: unknown } | undefined;
    const model = typeof body?.model === 'string' ? body.model : this.#defaultModel;
    // The CLI's own stand-in messages were never billed.
    if (model === SYNTHETIC_MODEL || body?.usage === undefined || body.usage === null) return;

    const id = typeof body.id === 'string' ? body.id : `anonymous-${this.#anonymous++}`;
    const usage = pricedUsageFrom(body.usage);
    const previous = this.#streamed.get(id);
    // Several streamed messages share one response id and carry its usage as
    // it grows, so the largest figure seen per field is the response's own.
    this.#streamed.set(id, {
      model,
      mainThread: message.parent_tool_use_id == null,
      usage: previous ? maxUsage(previous.usage, usage) : usage,
    });
  }

  #streamedTurns(): number {
    let turns = 0;
    for (const response of this.#streamed.values()) if (response.mainThread) turns += 1;
    return turns;
  }

  #cost(
    result: SDKResultMessage | undefined,
  ): Pick<CallReport, 'costUsd' | 'costEstimated' | 'unpricedModels' | 'usage' | 'byModel'> {
    const streamed = this.#streamedEstimate();
    if (result === undefined) return { ...streamed, costEstimated: true };

    const reported = result.total_cost_usd ?? 0;
    // "Crash/startup-error results may carry zeroed values" (SDK docs): a
    // result that reports nothing for a call that visibly streamed tokens is
    // no better than no result at all.
    if (reported === 0 && streamed.costUsd > 0) return { ...streamed, costEstimated: true };

    const byModel: Record<string, ModelSpend> = {};
    for (const [model, u] of Object.entries(result.modelUsage ?? {})) {
      byModel[model] = {
        inputTokens: u.inputTokens,
        outputTokens: u.outputTokens,
        cacheReadInputTokens: u.cacheReadInputTokens,
        cacheCreationInputTokens: u.cacheCreationInputTokens,
        costUsd: u.costUSD,
      };
    }
    // `modelUsage` covers every model call the session made — subagents,
    // compaction and helper models included — where `usage` covers only the
    // main loop, so it is the better total whenever it is present.
    const models = Object.values(byModel);
    const usage = models.length > 0 ? sumUsage(models) : { ...emptyUsage(), ...usageFrom(result.usage) };

    return { costUsd: reported, costEstimated: false, unpricedModels: [], usage, byModel };
  }

  #streamedEstimate(): Pick<CallReport, 'costUsd' | 'unpricedModels' | 'usage' | 'byModel'> {
    const byModel: Record<string, ModelSpend> = {};
    const unpriced = new Set<string>();
    let costUsd = 0;

    for (const { model, usage } of this.#streamed.values()) {
      const estimate = estimateCostUsd(model, usage);
      if (estimate === undefined) unpriced.add(model);
      else costUsd += estimate;

      const entry = (byModel[model] ??= { ...emptyUsage(), costUsd: 0 });
      entry.inputTokens += usage.inputTokens;
      entry.outputTokens += usage.outputTokens;
      entry.cacheReadInputTokens += usage.cacheReadInputTokens;
      entry.cacheCreationInputTokens += usage.cacheCreationInputTokens;
      entry.costUsd += estimate ?? 0;
    }

    return {
      costUsd,
      unpricedModels: [...unpriced],
      usage: sumUsage(Object.values(byModel)),
      byModel,
    };
  }
}

/** The API failure a result message reports, if any. */
function resultApiError(result: SDKResultMessage | undefined): ApiError | undefined {
  if (result === undefined) return undefined;

  if (result.subtype === 'success') {
    // A turn that ended on an API error is reported as a *success* whose
    // text is the error: `is_error` and `api_error_status` are the tells.
    if (result.is_error !== true && !isApiErrorText(result.result)) return undefined;
    const status = result.api_error_status ?? undefined;
    if (status !== undefined) return makeApiError(kindFromStatus(status), result.result, status);
    return classifyFailureText(result.result);
  }

  const text = (result.errors ?? []).join('; ');
  if (result.terminal_reason === 'api_error') return classifyFailureText(text);
  if (result.startup_failure_reason !== undefined) {
    const reason = result.startup_failure_reason;
    const credential = /signin|access_denied|org_|provider|api_key|pin_/.test(reason);
    return makeApiError(credential ? 'auth' : 'unknown', text || `startup failed: ${reason}`);
  }
  // Turn limits, budget limits and schema retries are the run's own doing;
  // only an execution error can be the infrastructure's.
  if (result.subtype === 'error_during_execution') return recognizeFailureText(text);
  return undefined;
}

function pricedUsageFrom(raw: unknown): Required<PricedUsage> {
  const base = { ...emptyUsage(), ...usageFrom(raw) };
  const breakdown = (raw as { cache_creation?: { ephemeral_1h_input_tokens?: unknown } | null })
    .cache_creation;
  const longWrites = breakdown?.ephemeral_1h_input_tokens;
  return { ...base, cacheCreation1hInputTokens: typeof longWrites === 'number' ? longWrites : 0 };
}

function maxUsage(a: Required<PricedUsage>, b: Required<PricedUsage>): Required<PricedUsage> {
  return {
    inputTokens: Math.max(a.inputTokens, b.inputTokens),
    outputTokens: Math.max(a.outputTokens, b.outputTokens),
    cacheReadInputTokens: Math.max(a.cacheReadInputTokens, b.cacheReadInputTokens),
    cacheCreationInputTokens: Math.max(a.cacheCreationInputTokens, b.cacheCreationInputTokens),
    cacheCreation1hInputTokens: Math.max(a.cacheCreation1hInputTokens, b.cacheCreation1hInputTokens),
  };
}

function sumUsage(parts: readonly UsageTotals[]): UsageTotals {
  const total = emptyUsage();
  for (const part of parts) {
    total.inputTokens += part.inputTokens;
    total.outputTokens += part.outputTokens;
    total.cacheReadInputTokens += part.cacheReadInputTokens;
    total.cacheCreationInputTokens += part.cacheCreationInputTokens;
  }
  return total;
}
