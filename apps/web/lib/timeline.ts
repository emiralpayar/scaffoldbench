/**
 * A run's trace as calls on one clock: when each model call started and
 * ended, which tools it called, what the sandbox guard refused, and what the
 * run had spent at every moment.
 *
 * One model, many pictures: the run explorer's swimlane, the replay player,
 * the landing page's race and the strategy pages all draw from it. Parallel
 * calls overlap on the shared clock, which is the one thing a list of events
 * can never show and the thing the first published run set needed shown.
 *
 * Pure: no filesystem, safe in client components.
 */

import type { PhaseRecord, TraceEvent } from './records';

/**
 * How a call ended, in the terms the swimlane colours:
 * - `ok`: it finished.
 * - `limit`: the run's own limits stopped it (turns, budget). A valid, losing
 *   data point for the architecture.
 * - `failed`: it crashed, or the harness broke it (a denied harness tool).
 * - `skipped`: it never ran, because the run was already out of budget or
 *   aborted.
 */
export type CallStatus = 'ok' | 'limit' | 'failed' | 'skipped';

export interface TimelineTick {
  seq: number;
  tMs: number;
  /** `denied` is the sandbox guard refusing the call; `error` an error event. */
  kind: 'tool' | 'tool-error' | 'denied' | 'error';
  /** Tool name without its `mcp__<server>__` prefix, or the error, in a few words. */
  label: string;
}

export interface TimelineCall {
  key: string;
  phase: string;
  label: string;
  agent?: string;
  /** 0 for the main thread, 1 for a subagent context. */
  depth: number;
  startMs: number;
  endMs: number;
  status: CallStatus;
  /** The SDK's own word for how the call ended, e.g. `error_max_turns`. */
  subtype?: string;
  costUsd: number;
  turns?: number;
  toolCalls: number;
  ticks: TimelineTick[];
  /** Task tools the session was shown at start-up; absent without an init message. */
  toolsOffered?: number;
  /** MCP servers the harness gave this call that did not connect. */
  serversDown: string[];
  /** MCP servers the session loaded that the harness never gave it. */
  foreignServers: string[];
  /** What the strategy fell back on instead of this call's output. */
  degraded?: string;
  /** The first event of the call, for linking the swimlane to the event list. */
  firstSeq: number;
}

export interface CostPoint {
  tMs: number;
  usd: number;
}

export interface Timeline {
  /**
   * `phases` when no trace was committed and the phase records stand in;
   * `schematic` for a design drawn on an invented clock (`lib/schematic.ts`).
   */
  source: 'trace' | 'phases' | 'schematic';
  durationMs: number;
  calls: TimelineCall[];
  /**
   * Cumulative spend. A call reports its cost when it ends, so the series
   * steps at call ends rather than rising smoothly.
   */
  cost: CostPoint[];
  totalCostUsd: number;
}

const LIMIT_SUBTYPES = new Set(['error_max_turns', 'error_max_budget_usd', 'error_max_structured_output_retries']);
const SKIPPED_SUBTYPES = new Set(['skipped', 'aborted']);

// ---------------------------------------------------------------------------
// Which call an event belongs to
// ---------------------------------------------------------------------------

/**
 * The call each event belongs to, keyed by event `seq`.
 *
 * A current trace stamps every event with the `callId` of the call that wrote
 * it. A trace from before that (such as the first published run set's) is read
 * the way core's integrity check reads it: a `phase_start` opens a new call for
 * its phase name, and later events of that phase belong to it. Concurrent calls
 * always had distinct phase names, so this never merges two of them.
 */
export function callKeys(events: readonly TraceEvent[]): Map<number, string> {
  const keys = new Map<number, string>();
  const open = new Map<string, string>();
  const opened = new Map<string, number>();

  for (const event of ordered(events)) {
    if (event.callId !== undefined) {
      keys.set(event.seq, event.callId);
      continue;
    }
    if (event.kind === 'phase_start') {
      const n = (opened.get(event.phase) ?? 0) + 1;
      opened.set(event.phase, n);
      open.set(event.phase, `${event.phase}#${n}`);
    }
    keys.set(event.seq, open.get(event.phase) ?? `${event.phase}#0`);
  }
  return keys;
}

function ordered(events: readonly TraceEvent[]): TraceEvent[] {
  return [...events].sort((a, b) => a.seq - b.seq);
}

// ---------------------------------------------------------------------------
// From a trace
// ---------------------------------------------------------------------------

interface Draft {
  call: TimelineCall;
  ended: boolean;
  /** Tool calls waiting to learn whether the guard denied them. */
  pendingByTool: Map<string, TimelineTick[]>;
  byUseId: Map<string, TimelineTick>;
  expected?: string[];
}

export function timelineFromTrace(
  events: readonly TraceEvent[],
  phases: readonly PhaseRecord[] = [],
): Timeline {
  const sorted = ordered(events);
  const keys = callKeys(sorted);
  const drafts = new Map<string, Draft>();
  const labels = new Map(phases.map((phase) => [phase.phase, phase.label]));
  const degraded = new Map(
    phases.filter((phase) => phase.degraded).map((phase) => [phase.phase, phase.degraded as string]),
  );

  for (const event of sorted) {
    const key = keys.get(event.seq) as string;
    let draft = drafts.get(key);
    if (!draft) {
      draft = {
        call: {
          key,
          phase: event.phase,
          label: labels.get(event.phase) ?? event.phase,
          ...(event.agent ? { agent: event.agent } : {}),
          depth: event.depth,
          startMs: event.tMs,
          endMs: event.tMs,
          status: 'ok',
          costUsd: 0,
          toolCalls: 0,
          ticks: [],
          serversDown: [],
          foreignServers: [],
          firstSeq: event.seq,
          ...(degraded.has(event.phase) ? { degraded: degraded.get(event.phase) as string } : {}),
        },
        ended: false,
        pendingByTool: new Map(),
        byUseId: new Map(),
      };
      drafts.set(key, draft);
    }
    const { call } = draft;
    call.startMs = Math.min(call.startMs, event.tMs);
    call.endMs = Math.max(call.endMs, event.tMs);
    call.depth = Math.min(call.depth, event.depth);
    const meta = event.meta ?? {};

    switch (event.kind) {
      case 'phase_start':
        if (event.text) call.label = labels.get(event.phase) ?? event.text;
        break;

      case 'system_init': {
        const tools = Array.isArray(meta.tools) ? meta.tools.filter((t): t is string => typeof t === 'string') : [];
        call.toolsOffered = tools.filter((tool) => tool.startsWith('mcp__')).length;
        const servers = serverList(meta.mcpServers);
        call.serversDown = servers.filter((s) => s.status !== 'connected' && !isForeign(s.name)).map((s) => s.name);
        call.foreignServers = servers.filter((s) => isForeign(s.name)).map((s) => s.name);
        break;
      }

      case 'tool_call': {
        const tick: TimelineTick = { seq: event.seq, tMs: event.tMs, kind: 'tool', label: shortToolName(event.toolName) };
        call.ticks.push(tick);
        call.toolCalls += 1;
        const name = event.toolName ?? '';
        const pending = draft.pendingByTool.get(name) ?? [];
        pending.push(tick);
        draft.pendingByTool.set(name, pending);
        if (event.toolUseId) draft.byUseId.set(event.toolUseId, tick);
        break;
      }

      case 'tool_denied': {
        // The guard's denial carries no tool-use id; it follows the call it refused.
        const pending = draft.pendingByTool.get(event.toolName ?? '');
        const tick = pending?.pop();
        if (tick) tick.kind = 'denied';
        else call.ticks.push({ seq: event.seq, tMs: event.tMs, kind: 'denied', label: shortToolName(event.toolName) });
        break;
      }

      case 'tool_result': {
        const tick = event.toolUseId ? draft.byUseId.get(event.toolUseId) : undefined;
        if (!tick) break;
        if (tick.kind === 'tool' && event.isError) tick.kind = 'tool-error';
        // Answered, so no later denial can be about this call.
        for (const list of draft.pendingByTool.values()) {
          const index = list.indexOf(tick);
          if (index >= 0) list.splice(index, 1);
        }
        break;
      }

      case 'error':
        call.ticks.push({ seq: event.seq, tMs: event.tMs, kind: 'error', label: normalizeError(event.text ?? '') });
        break;

      case 'result':
        if (!draft.ended) {
          if (typeof event.costUsd === 'number') call.costUsd = event.costUsd;
          if (typeof meta.subtype === 'string') call.subtype = meta.subtype;
          if (typeof meta.numTurns === 'number') call.turns = meta.numTurns;
        }
        break;

      case 'phase_end':
        draft.ended = true;
        if (typeof event.costUsd === 'number') call.costUsd = event.costUsd;
        if (typeof meta.subtype === 'string') call.subtype = meta.subtype;
        if (typeof meta.turns === 'number') call.turns = meta.turns;
        if (typeof meta.degraded === 'string') call.degraded = meta.degraded;
        if (Array.isArray(meta.mcpServersExpected)) {
          const expected = meta.mcpServersExpected.filter((s): s is string => typeof s === 'string');
          draft.expected = expected;
        }
        break;

      default:
        break;
    }
  }

  const calls = [...drafts.values()].map((draft) => {
    const { call } = draft;
    if (draft.expected) {
      // A current trace says which servers the harness handed the call, so
      // "foreign" is exact rather than a guess from the name.
      const expected = new Set(draft.expected);
      call.foreignServers = [...call.foreignServers, ...call.serversDown].filter((name) => !expected.has(name));
      call.serversDown = call.serversDown.filter((name) => expected.has(name));
    }
    call.status = statusOf(call);
    return call;
  });

  calls.sort((a, b) => a.startMs - b.startMs || a.firstSeq - b.firstSeq);
  return finish('trace', calls);
}

/**
 * Account connectors (`claude.ai Gmail` and the like) are the one kind of
 * server known to leak into sessions run on a subscription login. A current
 * trace records the expected servers, which replaces this guess.
 */
function isForeign(name: string): boolean {
  return name.startsWith('claude.ai');
}

function serverList(raw: unknown): { name: string; status: string }[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((s): s is Record<string, unknown> => typeof s === 'object' && s !== null)
    .map((s) => ({ name: String(s.name ?? ''), status: String(s.status ?? '') }))
    .filter((s) => s.name !== '');
}

function statusOf(call: TimelineCall): CallStatus {
  const subtype = call.subtype;
  const denied = call.ticks.some((tick) => tick.kind === 'denied');
  if (subtype && SKIPPED_SUBTYPES.has(subtype)) return 'skipped';
  if (subtype && LIMIT_SUBTYPES.has(subtype)) return denied ? 'failed' : 'limit';
  if (subtype && subtype !== 'success') return 'failed';
  if (!subtype && call.ticks.some((tick) => tick.kind === 'error')) return 'failed';
  return 'ok';
}

// ---------------------------------------------------------------------------
// From phase records
// ---------------------------------------------------------------------------

/**
 * The phase records alone, for a run whose trace was not committed. Only
 * trustworthy when the records were written by a runner that timed parallel
 * phases correctly; the caller decides (see `phaseTimingTrusted`).
 */
export function timelineFromPhases(phases: readonly PhaseRecord[]): Timeline {
  if (phases.length === 0) return finish('phases', []);
  const t0 = Math.min(...phases.map((phase) => phase.startedAtMs));
  const calls: TimelineCall[] = phases.map((phase, index) => {
    const call: TimelineCall = {
      key: `${phase.phase}#${index + 1}`,
      phase: phase.phase,
      label: phase.label,
      depth: 0,
      startMs: phase.startedAtMs - t0,
      endMs: phase.startedAtMs - t0 + phase.durationMs,
      status: 'ok',
      ...(phase.subtype ? { subtype: phase.subtype } : {}),
      costUsd: phase.costUsd,
      turns: phase.turns,
      toolCalls: phase.toolCalls,
      ticks: [],
      serversDown: [],
      foreignServers: [],
      ...(phase.degraded ? { degraded: phase.degraded } : {}),
      firstSeq: index,
    };
    call.status = phase.error && !phase.subtype ? 'failed' : statusOf(call);
    if (phase.aborted && call.status === 'ok') call.status = 'skipped';
    return call;
  });
  calls.sort((a, b) => a.startMs - b.startMs || a.firstSeq - b.firstSeq);
  return finish('phases', calls);
}

function finish(source: 'trace' | 'phases', calls: TimelineCall[]): Timeline {
  const ends = calls.map((call) => ({ tMs: call.endMs, usd: call.costUsd })).sort((a, b) => a.tMs - b.tMs);
  const cost: CostPoint[] = [{ tMs: 0, usd: 0 }];
  let running = 0;
  for (const end of ends) {
    running += end.usd;
    cost.push({ tMs: end.tMs, usd: running });
  }
  return {
    source,
    durationMs: calls.reduce((max, call) => Math.max(max, call.endMs), 0),
    calls,
    cost,
    totalCostUsd: running,
  };
}

// ---------------------------------------------------------------------------
// Reading a timeline at a moment
// ---------------------------------------------------------------------------

/** What the run had spent by `tMs`. */
export function costAt(timeline: Pick<Timeline, 'cost'>, tMs: number): number {
  let usd = 0;
  for (const point of timeline.cost) {
    if (point.tMs > tMs) break;
    usd = point.usd;
  }
  return usd;
}

/**
 * Assign each call a row for a compact drawing: main-thread calls take the
 * first free row from the top, subagents the first free row below it, so a
 * fan-out reads as rows that open under the main line and close again.
 */
export function packLanes(calls: readonly TimelineCall[]): { lanes: number; laneOf: Map<string, number> } {
  const ends: number[] = [];
  const laneOf = new Map<string, number>();
  const sorted = [...calls].sort((a, b) => a.startMs - b.startMs || a.depth - b.depth || a.firstSeq - b.firstSeq);
  for (const call of sorted) {
    let lane = call.depth > 0 && ends.length > 0 && (ends[0] as number) > call.startMs ? 1 : 0;
    while (lane < ends.length && (ends[lane] as number) > call.startMs) lane++;
    ends[lane] = call.endMs;
    laneOf.set(call.key, lane);
  }
  return { lanes: Math.max(1, ends.length), laneOf };
}

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

/** `mcp__airline__get_reservation` reads as `get_reservation`. */
export function shortToolName(name: string | undefined): string {
  if (!name) return 'unknown tool';
  const parts = name.split('__');
  return parts.length >= 3 && parts[0] === 'mcp' ? parts.slice(2).join('__') : name;
}

/** The MCP server a fully-qualified tool name belongs to, if it has one. */
export function toolServer(name: string | undefined): string | undefined {
  if (!name) return undefined;
  const parts = name.split('__');
  return parts.length >= 3 && parts[0] === 'mcp' ? parts[1] : undefined;
}

/**
 * The harness's errors in the site's own words. The SDK's phrasing ("Claude
 * Code returned an error result: …") names a vendor component a reader never
 * chose and buries the fact; the raw text stays available beside it.
 */
export function normalizeError(text: string): string {
  const stripped = text.replace(/^Claude Code returned an error result:\s*/i, '').trim();
  const turns = /Reached maximum number of turns \((\d+)\)/i.exec(stripped);
  if (turns) {
    const n = Number(turns[1]);
    return `Stopped at its limit of ${n} turn${n === 1 ? '' : 's'}`;
  }
  if (/max(imum)?[ _-]?budget/i.test(stripped)) return 'Stopped at its budget limit';
  return stripped || 'Error';
}

const SUBTYPE_WORDS: Record<string, string> = {
  success: 'finished',
  error_max_turns: 'turn limit',
  error_max_budget_usd: 'budget limit',
  error_max_structured_output_retries: 'structured output retries ran out',
  error_during_execution: 'crashed',
  skipped: 'skipped',
  aborted: 'aborted',
};

export function describeSubtype(subtype: string | undefined): string {
  if (!subtype) return 'no result';
  return SUBTYPE_WORDS[subtype] ?? subtype.replace(/^error_/, '').replace(/_/g, ' ');
}
