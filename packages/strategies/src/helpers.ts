import { runQuery } from '@arena/core';
import type {
  PhaseRecord,
  QueryOutcome,
  QuerySpec,
  RunContext,
  StrategyOutcome,
  TaskEnvironment,
} from '@arena/core';

/**
 * The single seam every strategy is built around.
 *
 * Strategies never import the SDK. They reach the model through `runQuery`, and
 * because that dependency is injectable the orchestration logic — how many
 * calls, in what order, with which tools — can be tested without a network.
 */
export interface StrategyDeps {
  runQuery: typeof runQuery;
}

// ---------------------------------------------------------------------------
// Turn budgets
// ---------------------------------------------------------------------------

/**
 * Turn budget for a phase that has no tools and answers in prose.
 *
 * A tool-less phase cannot productively loop: it thinks once and answers, so
 * anything above one turn is spend without a decision behind it. Applied
 * identically in every strategy so no architecture is quietly given more room.
 *
 * The rest of the turn policy, also identical everywhere: a tool-less phase
 * that answers through a JSON schema gets `SCHEMA_MIN_TURNS` from core (the
 * structured reply is itself a tool call, and one that fails validation needs
 * a turn to retry), and every phase that holds tools — acting or read-only —
 * gets the task's own `maxTurns`, the allowance its author sized for one agent
 * doing the whole task. See "Turn budgets" in docs/ARCHITECTURE.md.
 */
export const REASONING_TURNS = 1;

// ---------------------------------------------------------------------------
// Acting prompts
// ---------------------------------------------------------------------------

/**
 * What every acting phase is told about doing the work, word for word.
 *
 * An acting phase is one that holds the tools that change state: `single`'s
 * main call, an executor, a worker, a reviser. Nudges like "check the state
 * before you change it" measurably change behaviour on tasks with traps, so
 * one architecture getting a nudge another does not would be a difference in
 * wording, not in architecture. Everything else in an acting prompt is the
 * architecture's own context: the plan it was handed, the issues it must fix.
 */
export const ACTING_INSTRUCTIONS =
  'Use the tools available to you, checking the state you are about to change before you ' +
  'change it. If anything you were given or anything you find conflicts with the task or the ' +
  'domain rules, follow the task and the rules, and say so.';

/**
 * How every acting phase whose reply is the answer to the task is told to end.
 * A worker's reply goes to the orchestrator instead, so it is asked for a
 * report; that is the one intended difference.
 */
export const FINAL_ANSWER_INSTRUCTION = 'When you are finished, reply with your final answer.';

// ---------------------------------------------------------------------------
// Phases
// ---------------------------------------------------------------------------

/** A `QuerySpec` that always carries the human-readable label for its phase. */
export interface LabeledSpec extends QuerySpec {
  label: string;
  /**
   * True when the phase's reply is an answer to the task — an executor's, a
   * worker's report, a synthesis — rather than a plan, a verdict or a choice.
   * Only these can stand in as the final answer when the phase meant to give
   * it came back empty, so a critic's notes never become the agent's answer.
   */
  answers?: boolean;
}

export function recordPhase(
  outcome: QueryOutcome,
  phase: string,
  label: string,
  model: string,
): PhaseRecord {
  return {
    phase,
    label,
    callId: outcome.callId,
    // Epoch-based and taken from the call itself, so concurrent phases land
    // on one timeline where they actually ran — not where they were recorded,
    // which for a fan-out is after the slowest sibling finished.
    startedAtMs: outcome.startedAtMs,
    durationMs: outcome.durationMs,
    costUsd: outcome.costUsd,
    turns: outcome.turns,
    toolCalls: outcome.toolCalls,
    model,
    aborted: outcome.aborted,
    subtype: outcome.subtype,
    ...(outcome.error ? { error: outcome.error } : {}),
    ...(outcome.apiError ? { apiError: outcome.apiError } : {}),
    ...(outcome.costEstimated ? { costEstimated: true } : {}),
    ...(outcome.structuredMissing ? { structuredMissing: true } : {}),
  };
}

/** Endings that mean the run's own limits stopped the call before it could finish. */
const CUT_SHORT_SUBTYPES: ReadonlySet<string> = new Set(['skipped', 'aborted', 'error_max_budget_usd']);

/**
 * True when a call was stopped from outside — by the run's cost or time
 * limit, or by an API failure — before it could finish.
 *
 * Its missing output is then not the architecture's doing: the run is a
 * losing data point (or, for an API failure, no data point), and a strategy
 * must not record it as `degraded`. Running out of turns is different: the
 * call ran to the end of what it was given, so what it failed to produce is
 * on the architecture.
 */
export function interrupted(outcome: Pick<QueryOutcome, 'aborted' | 'subtype' | 'apiError'>): boolean {
  return outcome.aborted || outcome.apiError !== undefined || CUT_SHORT_SUBTYPES.has(outcome.subtype);
}

/** What a strategy adds to a phase's record once it has read the reply. */
export interface PhaseNote {
  meta?: Record<string, unknown>;
  /** See `PhaseRecord.degraded`. Never set for an `interrupted` call. */
  degraded?: string;
  /** See `PhaseRecord.retriedBy`. */
  retriedBy?: string;
}

export interface FinishOptions {
  /**
   * The agent's answer. When empty, the last answer-bearing phase's text is
   * used instead (see `LabeledSpec.answers`).
   */
  finalText?: string;
  subagentCount?: number;
}

export interface PhaseRunner {
  /** One record per call, in the order the calls started. */
  readonly phases: PhaseRecord[];
  /**
   * False once the run is out of budget, has been aborted, or has lost a
   * call to the API (see `createPhaseRunner`).
   */
  canContinue(): boolean;
  /**
   * Run one phase. `signal` additionally aborts it — for a call made on
   * behalf of another, such as a review the other call is waiting on.
   */
  run(spec: LabeledSpec, options?: { signal?: AbortSignal }): Promise<QueryOutcome>;
  /**
   * Run several phases at once. Each gets an equal share of the budget
   * available when the batch starts, so none can be starved by a sibling.
   */
  runAll(specs: LabeledSpec[]): Promise<QueryOutcome[]>;
  /** Add what the strategy made of a phase's reply to its record. */
  annotate(outcome: QueryOutcome, note: PhaseNote): void;
  finish(options?: FinishOptions): StrategyOutcome;
}

/**
 * Bookkeeping shared by every architecture: one `PhaseRecord` per model
 * call, a fallback answer, and the check every strategy makes before it
 * starts another phase.
 *
 * A call that fails at the API ends the run's value as a measurement: the
 * runner records the run as `api_error`, ranks it nowhere and runs the cell
 * again. So the phase runner halts the run there — no further phases, and
 * the calls still in flight are aborted — instead of paying for a plan, a
 * selection or an execution nobody will use, and making more calls to an API
 * that is rejecting them.
 */
export function createPhaseRunner(ctx: RunContext, deps: Partial<StrategyDeps>): PhaseRunner {
  const call = deps.runQuery ?? runQuery;
  const halt = new AbortController();
  const signal = AbortSignal.any([ctx.signal, halt.signal]);
  const phases: PhaseRecord[] = [];
  // Start order of each record in `phases`, kept alongside it. A phase is
  // recorded when it finishes, but listed where it started: a fan-out lists
  // its siblings in spec order whichever finished first, and a review made
  // while an executor waits is listed after the executor, not before it.
  const starts: number[] = [];
  const byCall = new Map<string, PhaseRecord>();
  let started = 0;
  // The latest-started answer-bearing phase that said something: the same
  // fallback however a fan-out's siblings happened to finish.
  let lastAnswer = { order: -1, text: '' };

  const launch = async (spec: LabeledSpec, callSignal: AbortSignal): Promise<QueryOutcome> => {
    const order = started++;
    const outcome = await call({ ...ctx, signal: callSignal }, spec);
    if (outcome.apiError) halt.abort();
    const record = recordPhase(outcome, spec.phase, spec.label, spec.model ?? ctx.model);
    let at = starts.length;
    while (at > 0 && (starts[at - 1] ?? 0) > order) at--;
    phases.splice(at, 0, record);
    starts.splice(at, 0, order);
    byCall.set(outcome.callId, record);

    const text = outcome.text.trim();
    if (spec.answers === true && text !== '' && order > lastAnswer.order) lastAnswer = { order, text };
    return outcome;
  };

  return {
    phases,

    canContinue: () => !ctx.budget.exceeded && !signal.aborted,

    run(spec: LabeledSpec, options: { signal?: AbortSignal } = {}): Promise<QueryOutcome> {
      return launch(spec, options.signal ? AbortSignal.any([signal, options.signal]) : signal);
    },

    runAll(specs: LabeledSpec[]): Promise<QueryOutcome[]> {
      // Split what is left before any sibling reserves, so the first to start
      // cannot take everything and the rest cannot each be handed all of it.
      const share = specs.length > 0 ? ctx.budget.availableUsd / specs.length : 0;
      return Promise.all(
        specs.map((spec) => launch({ ...spec, maxBudgetUsd: spec.maxBudgetUsd ?? share }, signal)),
      );
    },

    annotate(outcome: QueryOutcome, note: PhaseNote): void {
      const record = byCall.get(outcome.callId);
      if (!record) return;
      if (note.meta) record.meta = { ...record.meta, ...note.meta };
      if (note.degraded !== undefined) record.degraded = note.degraded;
      if (note.retriedBy !== undefined) record.retriedBy = note.retriedBy;
    },

    finish(options: FinishOptions = {}): StrategyOutcome {
      const preferred = (options.finalText ?? '').trim();
      return {
        finalText: preferred !== '' ? preferred : lastAnswer.text,
        subagentCount: options.subagentCount ?? 0,
        phases,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Prompt building
// ---------------------------------------------------------------------------

/**
 * The user's request, quoted verbatim in every phase prompt.
 *
 * Each phase is a fresh context with no memory of the others, so the task has
 * to travel with it. Quoting rather than paraphrasing keeps every
 * architecture working from exactly the same words.
 */
export function taskBlock(ctx: RunContext): string {
  return tagged('task', ctx.task.prompt.trim());
}

export function tagged(tag: string, body: string): string {
  return `<${tag}>\n${body}\n</${tag}>`;
}

export function joinSections(...sections: string[]): string {
  return sections.filter((section) => section.trim() !== '').join('\n\n');
}

export function numbered(items: readonly string[]): string {
  return items.map((item, index) => `${index + 1}. ${item}`).join('\n');
}

/** Non-empty trimmed strings from an unknown value, capped at `limit`. */
export function stringList(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (trimmed === '') continue;
    out.push(trimmed);
    if (out.length >= limit) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

/** The task's tools that can change state. */
export function mutatingTools(env: Pick<TaskEnvironment, 'allowedTools' | 'readOnlyTools'>): string[] {
  const readOnly = new Set(env.readOnlyTools);
  return env.allowedTools.filter((tool) => !readOnly.has(tool));
}

/** A read-only task has nothing to apply, so no execution phase is warranted. */
export function hasMutatingTools(ctx: RunContext): boolean {
  return mutatingTools(ctx.env).length > 0;
}
