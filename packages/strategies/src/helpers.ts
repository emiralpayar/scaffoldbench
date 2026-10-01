import { runQuery } from '@arena/core';
import type {
  PhaseRecord,
  QueryOutcome,
  QuerySpec,
  RunContext,
  StrategyOutcome,
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

/**
 * Turn budget for a phase that has no tools and answers in prose.
 *
 * A tool-less phase cannot productively loop: it thinks once and answers, so
 * anything above one turn is spend without a decision behind it. Applied
 * identically in every strategy so no architecture is quietly given more room.
 *
 * A tool-less phase that answers through a JSON schema is different: the
 * structured reply is itself a tool call, and a reply that fails validation
 * needs a turn to retry. Those phases use `SCHEMA_MIN_TURNS` from core, which
 * `runQuery` also enforces as a floor.
 */
export const REASONING_TURNS = 1;

/** A `QuerySpec` that always carries the human-readable label for its phase. */
export interface LabeledSpec extends QuerySpec {
  label: string;
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

export interface FinishOptions {
  /** The agent's answer. Falls back to the last phase that produced text. */
  finalText?: string;
  subagentCount?: number;
}

export interface PhaseRunner {
  readonly phases: PhaseRecord[];
  /** False once the run is out of budget or has been aborted. */
  canContinue(): boolean;
  run(spec: LabeledSpec): Promise<QueryOutcome>;
  /**
   * Run several phases at once, recording them in spec order. Each gets an
   * equal share of the budget available when the batch starts.
   */
  runAll(specs: LabeledSpec[]): Promise<QueryOutcome[]>;
  finish(options?: FinishOptions): StrategyOutcome;
}

/**
 * Bookkeeping shared by all five architectures: one `PhaseRecord` per model
 * call, a running fallback answer, and the budget check every strategy makes
 * before it starts another phase.
 */
export function createPhaseRunner(ctx: RunContext, deps: Partial<StrategyDeps>): PhaseRunner {
  const call = deps.runQuery ?? runQuery;
  const phases: PhaseRecord[] = [];
  let lastText = '';

  const record = (spec: LabeledSpec, outcome: QueryOutcome): QueryOutcome => {
    phases.push(recordPhase(outcome, spec.phase, spec.label, spec.model ?? ctx.model));
    const text = outcome.text.trim();
    if (text !== '') lastText = text;
    return outcome;
  };

  return {
    phases,

    canContinue: () => !ctx.budget.exceeded && !ctx.signal.aborted,

    async run(spec: LabeledSpec): Promise<QueryOutcome> {
      return record(spec, await call(ctx, spec));
    },

    async runAll(specs: LabeledSpec[]): Promise<QueryOutcome[]> {
      // Split what is left before any sibling reserves, so the first to start
      // cannot take everything and the rest cannot each be handed all of it.
      const share = specs.length > 0 ? ctx.budget.availableUsd / specs.length : 0;
      const settled = await Promise.all(
        specs.map(async (spec) => ({
          spec,
          outcome: await call(ctx, { ...spec, maxBudgetUsd: spec.maxBudgetUsd ?? share }),
        })),
      );
      // Recorded in spec order rather than completion order, so a fan-out
      // produces the same phase list on every run.
      return settled.map(({ spec, outcome }) => record(spec, outcome));
    },

    finish(options: FinishOptions = {}): StrategyOutcome {
      const preferred = (options.finalText ?? '').trim();
      return {
        finalText: preferred !== '' ? preferred : lastText,
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
 * to travel with it. Quoting rather than paraphrasing keeps all five
 * architectures working from exactly the same words.
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

/** A read-only task has nothing to apply, so no execution phase is warranted. */
export function hasMutatingTools(ctx: RunContext): boolean {
  return ctx.env.readOnlyTools.length !== ctx.env.allowedTools.length;
}
