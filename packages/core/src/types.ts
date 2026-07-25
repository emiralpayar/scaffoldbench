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

/**
 * Everything a task needs to hand to the agent, plus the mutable state the
 * scorer inspects once the run is over.
 */
export interface TaskEnvironment {
  mcpServers: Record<string, McpServerConfig>;
  /**
   * Fully-qualified tool names (`mcp__<server>__<tool>`) that the agent is
   * pre-approved to call. Combined with `permissionMode: 'dontAsk'` this is
   * what keeps a strategy inside its sandbox.
   */
  allowedTools: string[];
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

export type FailureMode =
  | 'none'
  | 'timeout'
  | 'budget_exceeded'
  | 'max_turns'
  | 'tool_error_loop'
  | 'policy_violation'
  | 'gave_up'
  | 'wrong_answer'
  | 'harness_error';

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
}

export interface JudgeResponse<T = unknown> {
  value: T;
  costUsd: number;
}

export type Judge = <T = unknown>(req: JudgeRequest) => Promise<JudgeResponse<T>>;

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
  startedAtMs: number;
  durationMs: number;
  costUsd: number;
  turns: number;
  toolCalls: number;
  model: string;
  aborted: boolean;
  error?: string;
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
  /** USD still available for the next `query()` call, never negative. */
  readonly remainingUsd: number;
  charge(delta: ChargeDelta): void;
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
  startedAt: string;
  finishedAt: string;
  latencyMs: number;
  score: number;
  passed: boolean;
  breakdown: ScoreItem[];
  penalties: Penalty[];
  failureMode: FailureMode;
  scoreMetadata: Record<string, unknown>;
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
}

export interface RunSetManifest {
  runSetId: string;
  createdAt: string;
  finishedAt?: string;
  gitSha: string | null;
  model: string;
  effort: EffortLevel;
  repeats: number;
  fixtureMode: FixtureMode;
  strategyIds: string[];
  taskIds: string[];
  totalRuns: number;
  completedRuns: number;
  totalCostUsd: number;
  totalJudgeCostUsd: number;
  durationMs: number;
  maxCostUsdPerRun: number;
  notes?: string;
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
