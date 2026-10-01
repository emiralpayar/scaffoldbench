/**
 * The trace as a reader wants to read it: one group per model call, and in
 * each group only what happened, once.
 *
 * A raw trace repeats itself. The final `result` restates the last message,
 * a tool call and its answer are two events, a denied call is three (the call,
 * the guard's refusal, the SDK's error back to the model), and every session
 * opens with an init listing a dozen tools. Shown as-is, one run was 8,500px
 * tall. Here a tool call carries its answer and any denial, the init becomes a
 * one-line session summary, and a reply that repeats the last message is
 * dropped. Nothing is invented: every item points back at the events (`seq`)
 * it was built from.
 *
 * Pure: no filesystem, safe in client components.
 */

import type { TraceEvent } from './records';
import type { TimelineCall } from './timeline';
import { callKeys, normalizeError, shortToolName, toolServer } from './timeline';

export interface SessionInfo {
  /** Task tools the session was shown (`mcp__*`), short names. */
  tools: string[];
  /** Harness tools the session was shown, e.g. `StructuredOutput`. */
  harnessTools: string[];
  servers: { name: string; status: string }[];
  model?: string;
}

export type ViewItem =
  | { kind: 'prompt'; seq: number; tMs: number; text: string }
  | { kind: 'say'; seq: number; tMs: number; text: string }
  | { kind: 'think'; seq: number; tMs: number; text: string }
  | {
      kind: 'tool';
      seq: number;
      tMs: number;
      name: string;
      server?: string;
      input?: unknown;
      result?: { text: string; isError: boolean; tMs: number };
      /** The sandbox guard refused it; `reason` is the guard's own message. */
      denied?: { reason: string; tMs: number };
    }
  | { kind: 'reply'; seq: number; tMs: number; text: string }
  | { kind: 'error'; seq: number; tMs: number; message: string; raw: string }
  | { kind: 'note'; seq: number; tMs: number; text: string };

export interface ViewGroup {
  key: string;
  phase: string;
  depth: number;
  agent?: string;
  session?: SessionInfo;
  items: ViewItem[];
}

export function buildViewGroups(events: readonly TraceEvent[]): ViewGroup[] {
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  const keys = callKeys(sorted);
  const groups = new Map<string, ViewGroup>();
  const order: string[] = [];
  /** Per group: tool items waiting for an answer, by tool-use id and by name. */
  const byUseId = new Map<string, Extract<ViewItem, { kind: 'tool' }>>();
  const lastByName = new Map<string, Extract<ViewItem, { kind: 'tool' }>>();
  const lastSay = new Map<string, string>();

  for (const event of sorted) {
    const key = keys.get(event.seq) as string;
    let group = groups.get(key);
    if (!group) {
      group = { key, phase: event.phase, depth: event.depth, items: [] };
      if (event.agent) group.agent = event.agent;
      groups.set(key, group);
      order.push(key);
    }
    group.depth = Math.min(group.depth, event.depth);
    const base = { seq: event.seq, tMs: event.tMs };
    const text = event.text?.trim() ?? '';

    switch (event.kind) {
      case 'phase_start':
      case 'phase_end':
        break;

      case 'system_init': {
        const meta = event.meta ?? {};
        const tools = Array.isArray(meta.tools) ? meta.tools.filter((t): t is string => typeof t === 'string') : [];
        group.session = {
          tools: tools.filter((tool) => tool.startsWith('mcp__')).map((tool) => shortToolName(tool)),
          harnessTools: tools.filter((tool) => !tool.startsWith('mcp__')),
          servers: Array.isArray(meta.mcpServers)
            ? meta.mcpServers
                .filter((s): s is Record<string, unknown> => typeof s === 'object' && s !== null)
                .map((s) => ({ name: String(s.name ?? ''), status: String(s.status ?? '') }))
                .filter((s) => s.name !== '')
            : [],
          ...(typeof meta.model === 'string' ? { model: meta.model } : {}),
        };
        break;
      }

      case 'user':
        if (text) group.items.push({ kind: 'prompt', ...base, text });
        break;

      case 'assistant_text':
        if (text) {
          group.items.push({ kind: 'say', ...base, text });
          lastSay.set(key, text);
        }
        break;

      case 'thinking':
        if (text) group.items.push({ kind: 'think', ...base, text });
        break;

      case 'tool_call': {
        const item: Extract<ViewItem, { kind: 'tool' }> = {
          kind: 'tool',
          ...base,
          name: shortToolName(event.toolName),
          ...(toolServer(event.toolName) ? { server: toolServer(event.toolName) as string } : {}),
          ...(event.toolInput !== undefined ? { input: event.toolInput } : {}),
        };
        group.items.push(item);
        if (event.toolUseId) byUseId.set(event.toolUseId, item);
        lastByName.set(`${key}\u0000${event.toolName ?? ''}`, item);
        break;
      }

      case 'tool_denied': {
        const target = lastByName.get(`${key}\u0000${event.toolName ?? ''}`);
        const reason = text || 'Blocked by the sandbox guard.';
        if (target && !target.denied && !target.result) {
          target.denied = { reason, tMs: event.tMs };
        } else {
          group.items.push({
            kind: 'tool',
            ...base,
            name: shortToolName(event.toolName),
            ...(event.toolInput !== undefined ? { input: event.toolInput } : {}),
            denied: { reason, tMs: event.tMs },
          });
        }
        break;
      }

      case 'tool_result': {
        const target = event.toolUseId ? byUseId.get(event.toolUseId) : undefined;
        const result = { text: event.text ?? '', isError: !!event.isError, tMs: event.tMs };
        if (target) target.result = result;
        else if (text) group.items.push({ kind: 'note', ...base, text });
        break;
      }

      case 'result':
        // The SDK's closing message restates the last reply; keep it only
        // when it says something the reader has not already seen.
        if (text && text !== lastSay.get(key)) group.items.push({ kind: 'reply', ...base, text });
        break;

      case 'error':
        group.items.push({ kind: 'error', ...base, message: normalizeError(text), raw: text });
        break;

      case 'note':
        if (text) group.items.push({ kind: 'note', ...base, text });
        break;
    }
  }

  return order.map((key) => groups.get(key) as ViewGroup);
}

/** Pair each group with its call on the timeline, in the timeline's order. */
export function joinGroups(
  calls: readonly TimelineCall[],
  groups: readonly ViewGroup[],
): { call: TimelineCall; group: ViewGroup }[] {
  const byKey = new Map(groups.map((group) => [group.key, group]));
  return calls
    .map((call) => ({ call, group: byKey.get(call.key) }))
    .filter((pair): pair is { call: TimelineCall; group: ViewGroup } => pair.group !== undefined);
}

/** A short, single-line rendering of tool arguments: `R1042, 2 bags`. */
export function summarizeInput(input: unknown, max = 80): string {
  if (input === undefined || input === null) return '';
  let text: string;
  if (typeof input === 'object' && !Array.isArray(input)) {
    const values = Object.values(input as Record<string, unknown>).map((value) =>
      typeof value === 'string' ? value : JSON.stringify(value),
    );
    text = values.join(', ');
  } else {
    text = typeof input === 'string' ? input : JSON.stringify(input);
  }
  text = text.replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Pretty JSON for the detail panel. */
export function prettyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}
