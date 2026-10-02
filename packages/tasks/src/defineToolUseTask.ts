import {
  buildScore,
  createJournaledToolServer,
  type Difficulty,
  type JournaledToolSpec,
  type PenaltyKind,
  type Penalty,
  type ScoreItem,
  type Task,
  type TaskEnvironment,
  type TaskTrap,
  type ToolCall,
} from '@arena/core';

/** Structural deep clone, so every repeat of a task starts from an identical world. */
export function cloneWorld<T>(value: T): T {
  return structuredClone(value);
}

export interface AssertionSpec<W> {
  id: string;
  label: string;
  weight: number;
  /**
   * Return `true`/`false`, or a number in 0..1 for partial credit.
   * Receives the world as it stands after the run plus the tool journal.
   */
  check(world: W, journal: readonly ToolCall[]): boolean | number;
  /** Optional explanation rendered in the run detail view. */
  detail?(world: W, journal: readonly ToolCall[]): string | undefined;
}

export interface ForbiddenSpec<W> {
  id: string;
  label: string;
  kind?: PenaltyKind;
  /** Score multiplier when violated. Defaults to 0 — a hard fail. */
  multiplier?: number;
  violated(world: W, journal: readonly ToolCall[]): boolean;
  /** Fixed text, or computed from the run (e.g. naming what was changed out of scope). */
  detail?: string | ((world: W, journal: readonly ToolCall[]) => string | undefined);
}

export interface ToolUseTaskSpec<W> {
  id: string;
  world: string;
  title: string;
  /** The user request, handed to the agent verbatim. */
  prompt: string;
  /** Binding domain rules, injected into the system prompt for every strategy. */
  policy?: string;
  difficulty: Difficulty;
  tags: string[];
  maxTurns: number;
  /** Pre-registered prediction of which architecture should win, and why. */
  hypothesis?: string;
  /** Documented failure paths; every `caughtBy` id must name an assertion or forbidden rule. */
  traps?: TaskTrap[];
  /** Fresh world state for each run. Must not share references between calls. */
  createWorld(): W;
  /** Tools the agent may call, closing over the world instance. */
  createTools(world: W): JournaledToolSpec[];
  /** Server-level instructions shown to the model alongside the tool list. */
  instructions?: string;
  assertions: AssertionSpec<W>[];
  forbidden?: ForbiddenSpec<W>[];
}

/**
 * Build a deterministically-scored task from a world definition.
 *
 * Every tool-use world goes through this factory so scoring is identical
 * across domains: a weighted breakdown of final-state assertions, multiplied by
 * any rule violations found in the tool journal. No model is involved in
 * grading, so these scores are reproducible and not open to argument.
 */
export function defineToolUseTask<W>(spec: ToolUseTaskSpec<W>): Task {
  assertTrapsResolve(spec);
  return {
    id: spec.id,
    category: 'tool-use',
    world: spec.world,
    title: spec.title,
    prompt: spec.prompt,
    ...(spec.policy ? { policy: spec.policy } : {}),
    difficulty: spec.difficulty,
    tags: spec.tags,
    maxTurns: spec.maxTurns,
    ...(spec.hypothesis ? { hypothesis: spec.hypothesis } : {}),
    ...(spec.traps ? { traps: spec.traps } : {}),

    createEnvironment(): TaskEnvironment {
      const world = spec.createWorld();
      const journal: ToolCall[] = [];
      const { createMcpServers, allowedTools, readOnlyTools } = createJournaledToolServer({
        name: spec.world,
        ...(spec.instructions ? { instructions: spec.instructions } : {}),
        journal,
        tools: spec.createTools(world),
      });

      return {
        createMcpServers,
        allowedTools,
        readOnlyTools,
        state: world,
        journal,
      };
    },

    async score({ env }) {
      const world = env.state as W;
      const journal = env.journal;

      const breakdown: ScoreItem[] = spec.assertions.map((assertion) => {
        const raw = safeCheck(() => assertion.check(world, journal));
        const earned = typeof raw === 'boolean' ? (raw ? 1 : 0) : raw;
        const detail = assertion.detail
          ? safeDetail(() => assertion.detail?.(world, journal))
          : undefined;
        return {
          id: assertion.id,
          label: assertion.label,
          weight: assertion.weight,
          earned,
          ...(detail ? { detail } : {}),
        };
      });

      const penalties: Penalty[] = [];
      for (const rule of spec.forbidden ?? []) {
        if (!safeCheck(() => rule.violated(world, journal))) continue;
        const ruleDetail = rule.detail;
        const detail =
          typeof ruleDetail === 'function'
            ? safeDetail(() => ruleDetail(world, journal))
            : ruleDetail;
        penalties.push({
          id: rule.id,
          label: rule.label,
          kind: rule.kind ?? 'policy_violation',
          multiplier: rule.multiplier ?? 0,
          ...(detail ? { detail } : {}),
        });
      }

      return buildScore({
        breakdown,
        penalties,
        metadata: {
          toolCalls: journal.length,
          failedToolCalls: journal.filter((entry) => !entry.ok).length,
          distinctTools: new Set(journal.map((entry) => entry.name)).size,
        },
      });
    },
  };
}

/**
 * A trap that names a scorer item which does not exist would silently never
 * fire, and the report would show a perfect trap record for every
 * architecture. Fail at definition time instead.
 */
function assertTrapsResolve<W>(spec: ToolUseTaskSpec<W>): void {
  const known = new Set([
    ...spec.assertions.map((assertion) => assertion.id),
    ...(spec.forbidden ?? []).map((rule) => rule.id),
  ]);
  for (const trap of spec.traps ?? []) {
    if (trap.caughtBy.length === 0) {
      throw new Error(`task ${spec.id}: trap ${trap.id} names no scorer item in caughtBy`);
    }
    for (const id of trap.caughtBy) {
      if (!known.has(id)) {
        throw new Error(`task ${spec.id}: trap ${trap.id} is caught by unknown scorer item ${id}`);
      }
    }
  }
}

/**
 * A throwing assertion must not crash the whole run — it scores zero and the
 * remaining assertions still report, which keeps one bad predicate from
 * discarding an otherwise valid data point.
 */
function safeCheck(fn: () => boolean | number): number {
  try {
    const value = fn();
    if (typeof value === 'boolean') return value ? 1 : 0;
    if (typeof value !== 'number' || Number.isNaN(value)) return 0;
    return Math.min(1, Math.max(0, value));
  } catch {
    return 0;
  }
}

function safeDetail(fn: () => string | undefined): string | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}
