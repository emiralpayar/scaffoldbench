import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { TraceEvent, TraceKind, TraceSink, UsageTotals } from './types';

const MAX_TEXT = 8_000;

export function truncate(value: string, max = MAX_TEXT): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n…[truncated ${value.length - max} chars]`;
}

export interface TraceCollectorOptions {
  now?: () => number;
  /**
   * Called as each event is recorded. The live demo streams these to the
   * browser; a subscriber that throws must not take the run down with it.
   */
  onAppend?: (event: TraceEvent) => void;
}

/** In-memory trace sink. The runner persists `events` to JSONL after the run. */
export class TraceCollector implements TraceSink {
  readonly #events: TraceEvent[] = [];
  readonly #startedAt: number;
  readonly #now: () => number;
  readonly #onAppend: ((event: TraceEvent) => void) | undefined;
  #seq = 0;

  constructor(options: TraceCollectorOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#onAppend = options.onAppend;
    this.#startedAt = this.#now();
  }

  append(event: Omit<TraceEvent, 'seq' | 'tMs'>): void {
    const full: TraceEvent = {
      ...event,
      seq: this.#seq++,
      tMs: this.#now() - this.#startedAt,
    };
    this.#events.push(full);
    if (this.#onAppend) {
      try {
        this.#onAppend(full);
      } catch {
        // A failing subscriber is a delivery problem, not a run problem.
      }
    }
  }

  get events(): readonly TraceEvent[] {
    return this.#events;
  }

  /** Every tool name the agent successfully invoked, in call order. */
  toolCallNames(): string[] {
    return this.#events.filter((e) => e.kind === 'tool_call').map((e) => e.toolName ?? '');
  }

  countOf(kind: TraceKind): number {
    return this.#events.filter((e) => e.kind === kind).length;
  }
}

interface NormalizeContext {
  phase: string;
  /** Depth for main-thread messages; subagent messages get `depth + 1`. */
  depth: number;
  agent?: string;
}

type PartialEvent = Omit<TraceEvent, 'seq' | 'tMs'>;

function usageFrom(raw: unknown): Partial<UsageTotals> | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const u = raw as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === 'number' ? v : 0);
  return {
    inputTokens: num(u.input_tokens),
    outputTokens: num(u.output_tokens),
    cacheReadInputTokens: num(u.cache_read_input_tokens),
    cacheCreationInputTokens: num(u.cache_creation_input_tokens),
  };
}

/**
 * Convert one SDK message into zero or more normalized trace events.
 *
 * Kept deliberately defensive: the SDK's message union has 30+ members and
 * grows between releases, so anything unrecognized is skipped rather than
 * throwing. Stored traces therefore stay readable across SDK upgrades.
 */
export function normalizeSdkMessage(message: SDKMessage, ctx: NormalizeContext): PartialEvent[] {
  const out: PartialEvent[] = [];
  const base = { phase: ctx.phase, depth: ctx.depth, agent: ctx.agent };

  switch (message.type) {
    case 'system': {
      if (message.subtype !== 'init') break;
      out.push({
        ...base,
        kind: 'system_init',
        meta: {
          model: message.model,
          tools: message.tools,
          mcpServers: message.mcp_servers,
          permissionMode: message.permissionMode,
        },
      });
      break;
    }

    case 'assistant': {
      const isSubagent = message.parent_tool_use_id != null;
      const depth = isSubagent ? ctx.depth + 1 : ctx.depth;
      const content = message.message?.content;
      if (!Array.isArray(content)) break;

      for (const block of content) {
        if (typeof block !== 'object' || block === null) continue;
        const b = block as unknown as Record<string, unknown>;
        if (b.type === 'text' && typeof b.text === 'string' && b.text.trim() !== '') {
          out.push({ ...base, depth, kind: 'assistant_text', text: truncate(b.text) });
        } else if (b.type === 'thinking' && typeof b.thinking === 'string' && b.thinking !== '') {
          out.push({ ...base, depth, kind: 'thinking', text: truncate(b.thinking, 2_000) });
        } else if (b.type === 'tool_use') {
          out.push({
            ...base,
            depth,
            kind: 'tool_call',
            toolName: typeof b.name === 'string' ? b.name : 'unknown',
            toolUseId: typeof b.id === 'string' ? b.id : undefined,
            toolInput: b.input,
          });
        }
      }
      break;
    }

    case 'user': {
      const content = (message as { message?: { content?: unknown } }).message?.content;
      if (!Array.isArray(content)) break;
      for (const block of content) {
        if (typeof block !== 'object' || block === null) continue;
        const b = block as Record<string, unknown>;
        if (b.type !== 'tool_result') continue;
        out.push({
          ...base,
          kind: 'tool_result',
          toolUseId: typeof b.tool_use_id === 'string' ? b.tool_use_id : undefined,
          isError: b.is_error === true,
          text: truncate(stringifyToolResult(b.content)),
        });
      }
      break;
    }

    case 'result': {
      out.push({
        ...base,
        kind: 'result',
        isError: message.is_error,
        text: message.subtype === 'success' ? truncate(message.result, 4_000) : undefined,
        costUsd: message.total_cost_usd,
        usage: usageFrom(message.usage),
        meta: {
          subtype: message.subtype,
          numTurns: message.num_turns,
          stopReason: message.stop_reason,
          permissionDenials: message.permission_denials?.length ?? 0,
          ...(message.subtype !== 'success' ? { errors: message.errors } : {}),
        },
      });
      break;
    }

    default:
      break;
  }

  return out;
}

function stringifyToolResult(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (typeof part === 'object' && part !== null) {
          const p = part as Record<string, unknown>;
          if (typeof p.text === 'string') return p.text;
        }
        return JSON.stringify(part);
      })
      .join('\n');
  }
  return JSON.stringify(content ?? '');
}
