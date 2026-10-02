/**
 * Shared contracts for the arena.
 *
 * Two rules make the benchmark fair, and both are encoded here:
 *
 *  1. Every strategy reaches the model through `runQuery`, so trace capture,
 *     cost accounting and abort handling are identical no matter which
 *     architecture is under test.
 *  2. Every task owns both its environment and its scorer, so a task can be
 *     added without touching the runner.
 */

import type {
  AgentDefinition,
  EffortLevel,
  McpServerConfig,
} from '@anthropic-ai/claude-agent-sdk';

export type { AgentDefinition, EffortLevel, McpServerConfig };

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

export type TaskCategory = 'tool-use' | 'research';

/** A single tool invocation, recorded by the journaling wrapper in `tools.ts`. */
export interface ToolCall {
  /** Bare tool name as declared on the MCP server, e.g. `cancel_reservation`. */
  name: string;
  args: Record<string, unknown>;
  /** Milliseconds since the environment was created. */
  tMs: number;
  ok: boolean;
  /** Text the tool returned to the model, truncated for storage. */
  result: string;
}

/** Narrows which of a task's MCP tools a `query()` call is shown. */
export interface McpServerFilter {
  /**
   * Fully-qualified tool names (`mcp__<server>__<tool>`, `*` wildcards
   * allowed) to expose. Omitted means every tool. A server left with no
   * tools is left out altogether.
   */
  only?: readonly string[];
}

/**
 * Everything a task needs to hand to the agent, plus the mutable state the
 * scorer inspects once the run is over.
 */
export interface TaskEnvironment {
  /**
   * Build the task's MCP servers for one `query()` call.
   *
   * `runQuery` calls this once per call, so every call gets its own server
   * instances. An in-process MCP server can be connected to only one session
   * at a time: when every phase shared one instance, concurrent phases after
   * the first silently failed to connect and ran with no tools at all. The
   * handlers of every instance close over the same world and journal, so
   * state is still shared — concurrent workers acting on one world is the
   * architecture under test — and only the protocol endpoint is new.
   *
   * The filter is what keeps a phase's view honest: a phase is shown only the
   * tools it may call, so a "tool-less" planner sees none and a read-only
   * proposer never sees a mutating tool it would be denied.
   */
  createMcpServers(filter?: McpServerFilter): Record<string, McpServerConfig>;
  /**
   * Fully-qualified tool names (`mcp__<server>__<tool>`) that the agent is
   * pre-approved to call. Combined with `permissionMode: 'dontAsk'` this is
   * what keeps a strategy inside its sandbox.
   */
  allowedTools: string[];
  /**
   * Subset of `allowedTools` that cannot mutate state. Strategies that explore
   * candidate approaches in parallel hand only these to their proposers.
   * When it equals `allowedTools` the task has nothing to mutate, so a
   * separate execution phase is unnecessary.
   */
  readOnlyTools: string[];
  /** World state, mutated by tool handlers during the run. */
  state: unknown;
  journal: ToolCall[];
  dispose?(): Promise<void> | void;
}

export interface EnvironmentOptions {
  /** Per-run scratch directory. Nothing outside it should be written. */
  cwd: string;
  /**
   * `replay` reads only from recorded fixtures (free, deterministic, CI default).
   * `record` performs real network calls and writes fixtures to disk.
   * `live` performs real calls without persisting them.
   */
  fixtureMode: FixtureMode;
  fixtureDir: string;
}

export type FixtureMode = 'replay' | 'record' | 'live';

/** One line item in a score breakdown, surfaced in the web UI. */
export interface ScoreItem {
  id: string;
  label: string;
  weight: number;
  /** Fraction of `weight` earned, 0..1. */
  earned: number;
  detail?: string;
}

export type PenaltyKind = 'policy_violation' | 'hallucinated_citation' | 'unsafe_action';

export interface Penalty {
  id: string;
  label: string;
  kind: PenaltyKind;
  /** Multiplier applied to the raw score; 0 means the run is a hard fail. */
  multiplier: number;
  detail?: string;
}

/**
 * Why a run did not pass.
 *
 * Every member is produced by the pipeline; none exists only to decorate demo
 * data. `buildScore` produces the first four, the runner the rest. The last
 * two are failures of the harness or of the infrastructure, never of the
 * architecture under test, and a record carrying either always has
 * `integrity.ok === false`.
 */
export type FailureMode =
  /** The run passed. */
  | 'none'
  /** The final state or answer fell short, and nothing more specific explains why. */
  | 'wrong_answer'
  /** A domain rule was broken: a hard penalty, or a rule penalty that alone cost the pass. */
  | 'policy_violation'
  /** Every rubric item held, but the answer cited pages the agent never opened. */
  | 'hallucinated_citation'
  /**
   * A phase that was working the task with its tools ran out of turns (the
   * SDK's `error_max_turns`) and the run did not pass.
   */
  | 'max_turns'
  /** The run hit its per-run cost ceiling before it could finish. */
  | 'budget_exceeded'
  /** The run hit its per-run wall-clock ceiling before it could finish. */
  | 'timeout'
  /**
   * The harness failed: the environment, the strategy or the grader threw, a
   * task tool server never connected, the guard blocked a tool the harness
   * itself offered, or the grader never returned a usable verdict.
   */
  | 'harness_error'
  /**
   * The infrastructure failed — authentication, a rate limit, an overloaded
   * or erroring API, an unusable model id, or a grader that never answered.
   * Never the architecture's fault, so never counted as a wrong answer.
   */
  | 'api_error';

export interface TaskScore {
  /** Final score in 0..1, after penalties. */
  score: number;
  passed: boolean;
  breakdown: ScoreItem[];
  penalties: Penalty[];
  failureMode: FailureMode;
  /** Task-specific extras, e.g. `{ citationIntegrity: 0.8 }`. */
  metadata?: Record<string, unknown>;
}

export interface ScoreInput {
  env: TaskEnvironment;
  outcome: StrategyOutcome;
  /** Normalized, read-only view of everything that happened during the run. */
  trace: readonly TraceEvent[];
  deps: ScoringDeps;
}

/** Structured-output judge call. Implementations live in `packages/core/src/judge.ts`. */
export interface JudgeRequest {
  system: string;
  prompt: string;
  /** JSON Schema describing the expected reply. */
  schema: Record<string, unknown>;
  /**
   * Effort to grade this request at, overriding the judge's default. Like
   * the rubric and the schema it belongs to the task: a task whose grading
   * was calibrated at one effort asks for that effort wherever it runs.
   */
  effort?: EffortLevel;
}

export interface JudgeResponse<T = unknown> {
  value: T;
  costUsd: number;
}

/** Per-call settings the runner passes to a judge. */
export interface JudgeCallOptions {
  /**
   * Subprocess environment for this call, overriding the judge's own. The
   * runner passes the run's `subprocessEnv`, so a live-demo run is graded on
   * the visitor's credentials, never the operator's.
   */
  env?: Record<string, string | undefined>;
  /** Abort the call early, e.g. when the whole matrix is being stopped. */
  signal?: AbortSignal;
}

export type Judge = <T = unknown>(
  req: JudgeRequest,
  options?: JudgeCallOptions,
) => Promise<JudgeResponse<T>>;

export interface ScoringDeps {
  judge: Judge;
  /** Number of independent judge calls to take the median of. */
  judgeSamples: number;
}

export interface Task {
  id: string;
  category: TaskCategory;
  /** World this task belongs to, e.g. `airline`. Research tasks use `web`. */
  world: string;
  title: string;
  /** The user request handed to the agent verbatim. */
  prompt: string;
  /** Domain rules appended to the system prompt for every strategy. */
  policy?: string;
  /** Upper bound on agentic turns for a single `query()` call. */
  maxTurns: number;
  difficulty: 'easy' | 'medium' | 'hard';
  tags: string[];
  createEnvironment(opts: EnvironmentOptions): Promise<TaskEnvironment> | TaskEnvironment;
  score(input: ScoreInput): Promise<TaskScore>;
}

// ---------------------------------------------------------------------------
// Strategies
// ---------------------------------------------------------------------------

/** One `query()` call inside a strategy, recorded for the trace viewer. */
export interface PhaseRecord {
  phase: string;
  label: string;
  /** Epoch milliseconds at which the call started, so parallel phases share a timeline. */
  startedAtMs: number;
  durationMs: number;
  costUsd: number;
  turns: number;
  toolCalls: number;
  model: string;
  aborted: boolean;
  error?: string;
  /** How the call ended; see `QueryOutcome.subtype`. */
  subtype?: string;
  /** Present when the call failed at the API rather than in the architecture. */
  apiError?: ApiError;
  /** True when `costUsd` was estimated from streamed usage; see `QueryOutcome.costEstimated`. */
  costEstimated?: boolean;
  /** True when the phase asked for structured output and none came back. */
  structuredMissing?: boolean;
  /**
   * Set by a strategy when it carried on with a fallback instead of what the
   * phase was meant to produce — an empty plan, a default winner, a verdict it
   * could not read — saying what it fell back to. A degraded phase means the
   * architecture did not run as designed, so the run fails its integrity check.
   */
  degraded?: string;
  /** The call behind this phase (`QueryOutcome.callId`): what ties it to its events in the trace. */
  callId?: string;
  /**
   * What the strategy read from the phase's reply, in the strategy's own
   * terms: how many steps a plan had, a verifier's verdict, which proposal a
   * selector chose, the action a reviewer allowed or denied. Fidelity checks
   * read it, and so can an analysis of how often a verifier approved work that
   * went on to fail.
   */
  meta?: Record<string, unknown>;
  /**
   * Set when the phase asked for structured output, got none, and the
   * strategy asked again: the name of the phase that did. The miss is then
   * judged by the retry, which `harness.structured-output` checks like any
   * other schema call — so a harness that drops every structured reply still
   * fails, and one slip the strategy recovered from does not.
   */
  retriedBy?: string;
}

export interface StrategyOutcome {
  /** The agent's final answer, used by research scorers and shown in the UI. */
  finalText: string;
  /** How many subagent contexts the strategy opened, beyond the main thread. */
  subagentCount: number;
  phases: PhaseRecord[];
}

export interface Strategy {
  id: string;
  label: string;
  /** One paragraph, rendered on the site next to the leaderboard row. */
  description: string;
  run(ctx: RunContext): Promise<StrategyOutcome>;
  /**
   * The architecture's own invariants, checked after every run: the plan was
   * not empty, the fan-out happened, the selector's choice was readable, and
   * so on. The runner adds these to its harness checks in
   * `RunRecord.integrity`, and a failing one keeps the run out of the
   * rankings: a run in which the architecture silently degraded into another
   * one measured the wrong thing.
   *
   * Ids should be stable and specific to the strategy (`plan-execute.plan`).
   * Not called when `run` threw.
   */
  fidelityChecks?(input: FidelityInput): IntegrityCheck[];
}

/** What a strategy's `fidelityChecks` gets to inspect. */
export interface FidelityInput {
  task: Task;
  env: TaskEnvironment;
  outcome: StrategyOutcome;
  /** Everything the run's calls recorded, `phase_end` metadata included. */
  trace: readonly TraceEvent[];
  /**
   * Set when the run was cut short by its cost or wall-clock ceiling. Phases
   * after the cut never ran, which is the run's failure, not a lapse of
   * fidelity: a check about a phase that never got to run should pass.
   */
  stoppedBy?: BudgetStopReason;
}

/** One verified property of a run. */
export interface IntegrityCheck {
  /** Stable id: `harness.*` for the runner's own checks, strategy-specific otherwise. */
  id: string;
  ok: boolean;
  /** What failed, or what was verified, in a sentence. */
  detail?: string;
}

/**
 * Whether a run measured the architecture it claims to measure.
 *
 * The first published run set scored five architectures although four of them
 * never ran as designed; nothing in its records could say so. Integrity is the
 * record saying so: harness health (every tool server connected, no harness
 * tool denied, no call lost to the API) plus the strategy's own fidelity
 * checks. A run with `ok === false` must not be ranked.
 */
export interface Integrity {
  ok: boolean;
  checks: IntegrityCheck[];
}

export interface RunContext {
  runId: string;
  task: Task;
  strategyId: string;
  model: string;
  effort: EffortLevel;
  env: TaskEnvironment;
  cwd: string;
  signal: AbortSignal;
  budget: BudgetLedger;
  trace: TraceSink;
  /** Base system prompt every phase should build on. */
  systemPrompt: string;
  /**
   * Environment for the model subprocess. Normally undefined, so the process
   * environment applies. The live demo sets it to run on a visitor's own key
   * without the site operator's credentials leaking into the run.
   */
  subprocessEnv?: Record<string, string | undefined>;
}

// ---------------------------------------------------------------------------
// Model calls
// ---------------------------------------------------------------------------

export type ApiErrorKind =
  | 'auth'
  | 'rate_limit'
  | 'overloaded'
  | 'server'
  | 'invalid_request'
  | 'unknown';

/** A call that failed at the API or in the infrastructure around it. See `apiErrors.ts`. */
export interface ApiError {
  kind: ApiErrorKind;
  /** True when the same call could succeed if made again later. */
  retryable: boolean;
  message: string;
  /** HTTP status, when the SDK reported one. */
  status?: number;
}

/** One model's share of a call, as the SDK's `modelUsage` reports it. */
export interface ModelSpend extends UsageTotals {
  costUsd: number;
}

/** An MCP server as the session's init message reported it. */
export interface McpServerStatus {
  name: string;
  /** `connected`, `failed`, `needs-auth`, `pending`, … as reported by the SDK. */
  status: string;
}

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

export type BudgetStopReason = 'cost' | 'wallclock';

export interface BudgetLedger {
  readonly spentUsd: number;
  readonly usage: UsageTotals;
  readonly turns: number;
  readonly exceeded: boolean;
  readonly stopReason: BudgetStopReason | undefined;
  /** USD not yet spent, never negative. Includes money reserved by calls in flight. */
  readonly remainingUsd: number;
  /** USD neither spent nor reserved by a call in flight, never negative. */
  readonly availableUsd: number;
  /**
   * Reserve up to `capUsd` (default: everything available) for one call.
   *
   * The lease is what the call may spend, and the amount handed to the SDK as
   * its `maxBudgetUsd`. Because each reservation is taken out of what is
   * available, the leases of concurrent calls can never add up to more than
   * the run has left.
   */
  reserve(capUsd?: number): BudgetLease;
  charge(delta: ChargeDelta): void;
}

export interface BudgetLease {
  /** USD reserved for the call. Zero when nothing was available. */
  readonly amountUsd: number;
  /**
   * Charge what the call actually cost and return the rest of the reservation
   * to the ledger. Only the first settlement counts.
   */
  settle(delta: ChargeDelta): void;
}

export interface ChargeDelta {
  costUsd: number;
  usage: Partial<UsageTotals>;
  turns: number;
}

// ---------------------------------------------------------------------------
// Trace
// ---------------------------------------------------------------------------

export type TraceKind =
  | 'phase_start'
  | 'phase_end'
  | 'user'
  | 'assistant_text'
  | 'thinking'
  | 'tool_call'
  | 'tool_result'
  | 'tool_denied'
  | 'system_init'
  | 'result'
  | 'note'
  | 'error';

/**
 * Normalized trace event. Deliberately decoupled from the SDK's `SDKMessage`
 * union so a SDK upgrade cannot break stored results or the viewer.
 */
export interface TraceEvent {
  seq: number;
  /** Milliseconds since the run started. */
  tMs: number;
  phase: string;
  /**
   * The `query()` call that produced this event (`QueryOutcome.callId`).
   * Concurrent calls interleave in one trace, so this — not the event's
   * position — is what ties an event to the call it belongs to.
   */
  callId?: string;
  /** 0 for the main thread, 1 for a subagent, and so on. */
  depth: number;
  agent?: string;
  kind: TraceKind;
  text?: string;
  toolName?: string;
  toolInput?: unknown;
  toolUseId?: string;
  isError?: boolean;
  costUsd?: number;
  usage?: Partial<UsageTotals>;
  meta?: Record<string, unknown>;
}

export interface TraceSink {
  append(event: Omit<TraceEvent, 'seq' | 'tMs'>): void;
  readonly events: readonly TraceEvent[];
}

// ---------------------------------------------------------------------------
// Persisted results
// ---------------------------------------------------------------------------

export interface RunRecord {
  runId: string;
  runSetId: string;
  taskId: string;
  taskTitle: string;
  taskCategory: TaskCategory;
  taskWorld: string;
  taskDifficulty: Task['difficulty'];
  strategyId: string;
  model: string;
  effort: EffortLevel;
  repeat: number;
  /** When the recorded attempt started building its environment. */
  startedAt: string;
  finishedAt: string;
  /**
   * Wall-clock time of the strategy alone, from `strategy.run` to its return.
   * Building the environment and grading are timed separately (`setupMs`,
   * `gradingMs`), so a slow judge never makes an architecture look slow.
   * (Run sets from before those fields existed timed the whole cell.)
   */
  latencyMs: number;
  score: number;
  passed: boolean;
  breakdown: ScoreItem[];
  penalties: Penalty[];
  failureMode: FailureMode;
  scoreMetadata: Record<string, unknown>;
  /** What the recorded attempt's model calls cost, aborted and crashed calls included. */
  costUsd: number;
  /** Cost of the judge calls, tracked separately so it never skews strategy cost. */
  judgeCostUsd: number;
  usage: UsageTotals;
  turns: number;
  toolCalls: number;
  deniedToolCalls: number;
  subagentCount: number;
  phases: PhaseRecord[];
  finalText: string;
  error?: string;
  traceFile?: string;

  // The fields below are always written by the current runner. They are
  // optional because records from earlier run sets do not have them.

  /** Building the task environment, in milliseconds. */
  setupMs?: number;
  /** Scoring, judge calls included, in milliseconds. */
  gradingMs?: number;
  /**
   * How many times this cell was executed. Above 1 when transient API
   * failures forced a retry; only the last attempt is recorded.
   */
  attempts?: number;
  /**
   * What the discarded attempts spent, agent and judge together. Kept out of
   * `costUsd` so infrastructure trouble never makes an architecture look
   * expensive, and counted in the run set's totals and total budget.
   */
  discardedCostUsd?: number;
  /** The infrastructure failure behind an `api_error` record. */
  apiError?: ApiError;
  /**
   * Whether this run measured the architecture it claims to. A record with
   * `integrity.ok === false` must not be ranked; see `Integrity`.
   */
  integrity?: Integrity;
}

/** How a run set's session ended, or that it is still going. */
export type RunSetStatus = 'running' | 'interrupted' | 'complete';

/** Why a session stopped before reaching every cell. */
export type RunSetStopReason =
  /** The caller's abort signal: in-flight runs were cut off and discarded. */
  | 'signal'
  /** The caller's drain signal: in-flight runs finished, nothing new started. */
  | 'drain'
  /** The next run's cap no longer fit in the total budget. */
  | 'total_budget'
  /** The API rejected the credentials, so every further run would have failed. */
  | 'auth';

/** Transient API failures are retried by re-running the whole cell. */
export interface RetryPolicy {
  /** Most times one cell is executed; 1 disables retries. */
  maxAttempts: number;
  /** Delay before the first retry. It doubles with each retry, with jitter. */
  baseDelayMs: number;
  /** Ceiling on a single delay. */
  maxDelayMs: number;
}

/** What a judge says about itself, so a manifest can record how grading was done. */
export interface JudgeInfo {
  model: string;
  /** Effort for a request that names none (see `JudgeRequest.effort`). */
  effort: EffortLevel;
}

/** Where and with what a session ran: enough to reproduce it or to doubt it. */
export interface Provenance {
  gitSha: string | null;
  /**
   * True when tracked files outside `results/` had uncommitted changes, so
   * the code that ran is not exactly `gitSha`. `null` when git was unavailable.
   */
  gitDirty: boolean | null;
  agentSdkVersion: string | null;
  /** The Claude Code CLI bundled with the Agent SDK, which is what actually runs each call. */
  claudeCodeVersion: string | null;
  nodeVersion: string;
  /** `process.platform-process.arch`, e.g. `darwin-arm64`. */
  platform: string;
  /** The command line that started the session. */
  argv: string[];
}

/** One earlier session of a run set that was resumed. */
export interface ManifestSession {
  startedAt: string;
  finishedAt?: string;
  status?: RunSetStatus;
  stoppedBy?: RunSetStopReason;
  durationMs: number;
  concurrency?: number;
  provenance?: Provenance;
}

export interface RunSetManifest {
  runSetId: string;
  /** When the run set's first session started. */
  createdAt: string;
  finishedAt?: string;
  /** Legacy alias of `provenance.gitSha`. */
  gitSha: string | null;
  /**
   * The model under test; for a run set over several models, their ids joined
   * with ", ". Kept for readers that predate `models`.
   */
  model: string;
  effort: EffortLevel;
  repeats: number;
  fixtureMode: FixtureMode;
  strategyIds: string[];
  taskIds: string[];
  totalRuns: number;
  /** Cells of the matrix that have a record. */
  completedRuns: number;
  totalCostUsd: number;
  totalJudgeCostUsd: number;
  /** Total time spent in sessions of this run set. */
  durationMs: number;
  maxCostUsdPerRun: number;
  notes?: string;

  // The fields below are always written by the current runner. They are
  // optional because earlier run sets do not have them.

  /**
   * `running` while a session is in progress (also what a crashed session
   * leaves behind), `interrupted` when it stopped before reaching every cell
   * (`stoppedBy` says why), `complete` when it reached them all.
   */
  status?: RunSetStatus;
  stoppedBy?: RunSetStopReason;
  /** When the current (latest) session started. */
  startedAt?: string;
  /** Model ids, in matrix order. */
  models?: string[];
  maxWallClockMsPerRun?: number;
  totalBudgetUsd?: number;
  concurrency?: number;
  /**
   * Grading settings. `model` and `effort` are null for a judge that does not
   * describe itself. `effort` is the judge's default: a task whose requests
   * name their own (`JudgeRequest.effort`) is graded at that, as its code at
   * `provenance.gitSha` says.
   */
  judge?: { model: string | null; effort: EffortLevel | null; samples: number };
  retry?: RetryPolicy;
  /**
   * Spend that no record's `costUsd` or `judgeCostUsd` shows: attempts retried
   * after a transient API error (see `RunRecord.discardedCostUsd`), and runs a
   * hard stop cut off and discarded.
   */
  totalDiscardedCostUsd?: number;
  /** The current session's provenance. */
  provenance?: Provenance;
  /** Earlier sessions, oldest first, when the run set was resumed. */
  previousSessions?: ManifestSession[];
  /**
   * True for fabricated run sets used to develop the site.
   *
   * Nothing in the pipeline sets this — only `scripts/generate-demo-data.ts`
   * does. The site renders an unmissable banner when it sees it, so synthetic
   * data can never be mistaken for a measurement.
   */
  synthetic?: boolean;
}

/** Static metadata about a strategy, written alongside results for the site. */
export interface StrategyInfo {
  id: string;
  label: string;
  description: string;
}

/** Static metadata about a task, written alongside results for the site. */
export interface TaskInfo {
  id: string;
  category: TaskCategory;
  world: string;
  title: string;
  prompt: string;
  policy?: string;
  difficulty: Task['difficulty'];
  tags: string[];
  maxTurns: number;
}
