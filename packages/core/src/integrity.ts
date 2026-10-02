/**
 * Did a run measure the architecture it claims to?
 *
 * The first published run set answered "yes" for 90 runs in which four of five
 * architectures never ran as designed: the guard denied every planner's
 * structured reply, and parallel proposers ran without their tool server. All
 * of it was in the traces; nothing read it. This module reads it. The runner
 * calls `harnessChecks` after every run and stores the result, with the
 * strategy's own fidelity checks, as `RunRecord.integrity`.
 *
 * The checks look for the harness failing the architecture, not for the
 * architecture failing the task. A phase that runs out of turns, budget or
 * time has failed on its own terms; the run is a valid, losing data point,
 * and excluding it would flatter exactly the architectures that fail that
 * way. A phase that crashed, lost its tool server, had a harness tool denied
 * or never got its structured reply has not been measured at all.
 */

import { matchesToolList } from './guard';
import { STRUCTURED_OUTPUT_TOOL } from './hermetic';
import type {
  ApiError,
  Integrity,
  IntegrityCheck,
  McpServerStatus,
  PhaseRecord,
  TraceEvent,
} from './types';

/** Ids of the runner's own checks. */
export const HARNESS_CHECK = {
  /** The environment was built, the strategy returned and grading finished, none of them throwing. */
  runCompleted: 'harness.run-completed',
  /** No model call failed at the API. */
  api: 'harness.api',
  /** Every call ended with a result, or was stopped by the run's own limits. */
  callsEnded: 'harness.calls-ended',
  /** The guard never denied a harness tool, nor a tool the session itself offered. */
  harnessTools: 'harness.harness-tools',
  /** Every MCP server the harness gave a call was connected when the session started. */
  mcpConnected: 'harness.mcp-connected',
  /** No call loaded an MCP server the harness did not give it. */
  mcpHermetic: 'harness.mcp-hermetic',
  /**
   * No call was offered one of Claude Code's own tools: a session's whole
   * surface was its task tools and, for a schema call, the structured-output
   * tool.
   */
  builtinTools: 'harness.builtin-tools',
  /**
   * Every call that asked for structured output and ran to the end got it, or
   * its strategy asked again and the retry got it (`PhaseRecord.retriedBy`).
   */
  structuredOutput: 'harness.structured-output',
  /** No phase fell back on a default instead of its output (`PhaseRecord.degraded`). */
  notDegraded: 'harness.not-degraded',
  /** At least one grading call returned a usable verdict. Only present for graded runs. */
  judge: 'harness.judge',
} as const;

/**
 * Checks whose failure means the harness broke the run rather than only
 * casting doubt on it: an agent without its tools, its structured reply
 * denied, a call that never finished. A run that fails one of these and does
 * not pass is a `harness_error`, whatever its score says.
 */
export const BREAKING_HARNESS_CHECKS: ReadonlySet<string> = new Set([
  HARNESS_CHECK.callsEnded,
  HARNESS_CHECK.harnessTools,
  HARNESS_CHECK.mcpConnected,
]);

/**
 * How a call may end without the harness having failed it: it finished, or
 * the run's own limits stopped it. A schema call that exhausted its retries
 * is the structured-output check's business.
 */
const CLEAN_ENDINGS: ReadonlySet<string> = new Set([
  'success',
  'error_max_turns',
  'error_max_budget_usd',
  'error_max_structured_output_retries',
  'skipped',
  'aborted',
]);

/** Endings that mean the call was cut short by the run's limits before it could finish. */
const CUT_SHORT: ReadonlySet<string> = new Set(['skipped', 'aborted', 'error_max_budget_usd']);

/** One `query()` call, reassembled from the events it left in the trace. */
export interface TracedCall {
  callId: string;
  phase: string;
  /** What the session offered at start-up. Absent when no init message arrived. */
  init?: { tools: string[]; mcpServers: McpServerStatus[] };
  /** How the call ended. Absent when it never recorded its `phase_end`. */
  end?: {
    subtype: string | undefined;
    apiError?: ApiError;
    structuredMissing: boolean;
    /** The MCP servers the harness gave the call. Absent in traces older than per-call servers. */
    mcpServersExpected?: string[];
    /** The effort level the call reported running at; see `QueryOutcome.effectiveEffort`. */
    effectiveEffort?: string | null;
  };
  /** Tools the sandbox guard refused, in order. */
  deniedTools: string[];
}

export interface TracedCallOptions {
  /**
   * Read a trace written before events carried a `callId`, such as the first
   * published run set's. A phase's events then belong to the call its latest
   * `phase_start` opened, which tells concurrent calls apart because they
   * always had distinct phase names. Off by default: in a current trace, an
   * event without a `callId` was not written by a call.
   */
  legacy?: boolean;
}

/** Group a run's trace into its calls, in start order. Events with no `callId` are ignored. */
export function tracedCalls(
  trace: readonly TraceEvent[],
  options: TracedCallOptions = {},
): TracedCall[] {
  const calls = new Map<string, TracedCall>();
  const openByPhase = new Map<string, string>();
  const idOf = (event: TraceEvent): string | undefined => {
    if (event.callId !== undefined || !options.legacy) return event.callId;
    if (event.kind === 'phase_start') {
      const id = `${event.phase}#${calls.size + 1}`;
      openByPhase.set(event.phase, id);
      return id;
    }
    return openByPhase.get(event.phase);
  };
  const callFor = (event: TraceEvent): TracedCall | undefined => {
    const callId = idOf(event);
    if (callId === undefined) return undefined;
    let call = calls.get(callId);
    if (!call) {
      call = { callId, phase: event.phase, deniedTools: [] };
      calls.set(callId, call);
    }
    return call;
  };

  for (const event of trace) {
    const call = callFor(event);
    if (!call) continue;
    const meta = event.meta ?? {};

    switch (event.kind) {
      case 'system_init':
        call.init = {
          tools: stringArray(meta.tools),
          mcpServers: serverStatuses(meta.mcpServers),
        };
        break;
      case 'tool_denied':
        call.deniedTools.push(event.toolName ?? 'unknown');
        break;
      case 'phase_end': {
        const apiError = asApiError(meta.apiError);
        call.end = {
          subtype: typeof meta.subtype === 'string' ? meta.subtype : undefined,
          ...(apiError ? { apiError } : {}),
          structuredMissing: meta.structuredMissing === true,
          ...(Array.isArray(meta.mcpServersExpected)
            ? { mcpServersExpected: stringArray(meta.mcpServersExpected) }
            : {}),
          ...(typeof meta.effectiveEffort === 'string' || meta.effectiveEffort === null
            ? { effectiveEffort: meta.effectiveEffort }
            : {}),
        };
        break;
      }
      default:
        break;
    }
  }
  return [...calls.values()];
}

export interface HarnessCheckInput extends TracedCallOptions {
  trace: readonly TraceEvent[];
  phases: readonly PhaseRecord[];
  /** Why the run did not complete: the environment, the strategy or grading threw. */
  runError?: string;
  /** Grading by a judge, when the task used one. */
  judge?: { calls: number; failures: number };
}

/** The runner's own checks on one run. See `HARNESS_CHECK` for what each verifies. */
export function harnessChecks(input: HarnessCheckInput): IntegrityCheck[] {
  const calls = tracedCalls(input.trace, { legacy: input.legacy === true });
  const checks: IntegrityCheck[] = [];
  const add = (id: string, failures: readonly string[]) => {
    checks.push(failures.length === 0 ? { id, ok: true } : { id, ok: false, detail: summarize(failures) });
  };

  add(HARNESS_CHECK.runCompleted, input.runError === undefined ? [] : [input.runError]);

  const tracedApiFailures = calls.flatMap((call) =>
    call.end?.apiError ? [`${where(call)}: ${describeApiError(call.end.apiError)}`] : [],
  );
  // The trace is the better witness; the phase records are the fallback for
  // a strategy that reported a failure without going through `runQuery`.
  add(
    HARNESS_CHECK.api,
    tracedApiFailures.length > 0
      ? tracedApiFailures
      : input.phases.flatMap((phase) =>
          phase.apiError ? [`${phase.phase}: ${describeApiError(phase.apiError)}`] : [],
        ),
  );

  add(
    HARNESS_CHECK.callsEnded,
    calls.flatMap((call) => {
      if (!call.end) return [`${where(call)} never finished`];
      if (call.end.apiError) return [];
      const subtype = call.end.subtype ?? 'unknown';
      return CLEAN_ENDINGS.has(subtype) ? [] : [`${where(call)} ended ${subtype}`];
    }),
  );

  add(
    HARNESS_CHECK.harnessTools,
    calls.flatMap((call) =>
      call.deniedTools
        .filter((tool) => tool === STRUCTURED_OUTPUT_TOOL || call.init?.tools.includes(tool))
        .map((tool) => `${where(call)}: ${tool} was offered, then denied`),
    ),
  );

  const connection = calls.flatMap((call) => {
    if (!call.init) return [];
    const expected = call.end?.mcpServersExpected;
    if (expected === undefined) {
      // A trace from before calls recorded the servers they were given: which
      // servers belonged is unknown, but none should ever have failed.
      const failed = call.init.mcpServers.filter((server) => server.status === 'failed');
      return [{ call, notConnected: failed.map((server) => `${server.name} failed`), unexpected: [] }];
    }
    const reported = new Map(call.init.mcpServers.map((s) => [s.name, s.status]));
    return [
      {
        call,
        notConnected: expected
          .filter((name) => reported.get(name) !== 'connected')
          .map((name) => `${name} ${reported.get(name) ?? 'missing'}`),
        unexpected: call.init.mcpServers
          .filter((server) => !expected.includes(server.name))
          .map((server) => server.name),
      },
    ];
  });
  add(
    HARNESS_CHECK.mcpConnected,
    connection.flatMap(({ call, notConnected }) =>
      notConnected.length > 0 ? [`${where(call)}: ${notConnected.join(', ')}`] : [],
    ),
  );
  add(
    HARNESS_CHECK.mcpHermetic,
    connection.flatMap(({ call, unexpected }) =>
      unexpected.length > 0 ? [`${where(call)} also loaded ${unexpected.join(', ')}`] : [],
    ),
  );

  // `runQuery` pins the built-in toolset to the harness's own tool, so an
  // agent's tools are its task's. Were the CLI to start offering its own
  // anyway — an Agent tool, a shell — every architecture's prompt would
  // change and its agents could work outside the harness, unseen unless one
  // happened to call such a tool and be denied. So the offer itself is checked.
  add(
    HARNESS_CHECK.builtinTools,
    calls.flatMap((call) => {
      const builtin = (call.init?.tools ?? []).filter(
        (tool) => !tool.startsWith('mcp__') && tool !== STRUCTURED_OUTPUT_TOOL,
      );
      return builtin.length > 0 ? [`${where(call)} was offered ${builtin.join(', ')}`] : [];
    }),
  );

  // A miss the strategy asked again about is judged by the retry, which is a
  // schema call of its own and checked here like any other.
  const retried = new Set(
    input.phases.flatMap((phase) =>
      phase.retriedBy !== undefined && phase.callId !== undefined ? [phase.callId] : [],
    ),
  );
  add(
    HARNESS_CHECK.structuredOutput,
    calls.flatMap((call) => {
      const end = call.end;
      if (!end?.structuredMissing || end.apiError) return [];
      if (end.subtype !== undefined && CUT_SHORT.has(end.subtype)) return [];
      if (retried.has(call.callId)) return [];
      return [`${where(call)} returned no structured output (${end.subtype ?? 'no result'})`];
    }),
  );

  add(
    HARNESS_CHECK.notDegraded,
    input.phases.flatMap((phase) =>
      phase.degraded !== undefined ? [`${phase.phase}: ${phase.degraded}`] : [],
    ),
  );

  if (input.judge && input.judge.calls > 0) {
    add(
      HARNESS_CHECK.judge,
      input.judge.failures >= input.judge.calls
        ? [`all ${input.judge.calls} grading calls failed`]
        : [],
    );
  }

  return checks;
}

export function integrityOf(checks: readonly IntegrityCheck[]): Integrity {
  return { ok: checks.every((check) => check.ok), checks: [...checks] };
}

/**
 * The first call that ran out of turns while holding tools that act on the
 * task — the failure `max_turns` names. A planner that runs out of turns has
 * lost its plan, which is a fidelity problem; an executor that runs out of
 * turns has run out of road.
 */
export function actingCallOutOfTurns(
  calls: readonly TracedCall[],
  actingTools: readonly string[],
): TracedCall | undefined {
  return calls.find(
    (call) =>
      call.end?.subtype === 'error_max_turns' &&
      (call.init?.tools ?? []).some((tool) => matchesToolList(tool, actingTools)),
  );
}

/**
 * Every API failure the run's calls ended on, most severe first: rejected
 * credentials, then other failures a retry cannot fix, then transient ones.
 */
export function apiErrorsOf(
  calls: readonly TracedCall[],
  phases: readonly PhaseRecord[],
): ApiError[] {
  const errors = [
    ...calls.flatMap((call) => (call.end?.apiError ? [call.end.apiError] : [])),
    ...phases.flatMap((phase) => (phase.apiError ? [phase.apiError] : [])),
  ];
  const severity = (error: ApiError) => (error.kind === 'auth' ? 0 : error.retryable ? 2 : 1);
  return errors.sort((a, b) => severity(a) - severity(b));
}

export function describeApiError(error: ApiError): string {
  const status = error.status !== undefined ? ` ${error.status}` : '';
  return `${error.kind}${status}: ${error.message}`;
}

function where(call: TracedCall): string {
  return `${call.phase} (${call.callId})`;
}

/** At most three offenders, so one broken fan-out cannot bury the record. */
function summarize(failures: readonly string[]): string {
  const shown = failures.slice(0, 3).map((failure) => truncateLine(failure, 240));
  const more = failures.length - shown.length;
  return more > 0 ? `${shown.join('; ')}; and ${more} more` : shown.join('; ');
}

function truncateLine(text: string, max: number): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function serverStatuses(value: unknown): McpServerStatus[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item !== 'object' || item === null) return [];
    const { name, status } = item as { name?: unknown; status?: unknown };
    return typeof name === 'string' ? [{ name, status: typeof status === 'string' ? status : 'unknown' }] : [];
  });
}

function asApiError(value: unknown): ApiError | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const e = value as Partial<ApiError>;
  if (typeof e.kind !== 'string' || typeof e.message !== 'string') return undefined;
  return {
    kind: e.kind,
    retryable: e.retryable === true,
    message: e.message,
    ...(typeof e.status === 'number' ? { status: e.status } : {}),
    ...(typeof e.resetsAt === 'string' ? { resetsAt: e.resetsAt } : {}),
  };
}
