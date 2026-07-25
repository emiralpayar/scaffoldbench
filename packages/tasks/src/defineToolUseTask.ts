import {
  buildScore,
  createJournaledToolServer,
  type JournaledToolSpec,
  type PenaltyKind,
  type Penalty,
  type ScoreItem,
  type Task,
  type TaskEnvironment,
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
  detail?: string;
}

export interface ToolUseTaskSpec<W> {
  id: string;
  world: string;
  title: string;
  /** The user request, handed to the agent verbatim. */
  prompt: string;
  /** Binding domain rules, injected into the system prompt for every strategy. */
  policy?: string;
  difficulty: 'easy' | 'medium' | 'hard';
  tags: string[];
  maxTurns: number;
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

    createEnvironment(): TaskEnvironment {
      const world = spec.createWorld();
      const journal: ToolCall[] = [];
      const { server, serverName, allowedTools, readOnlyTools } = createJournaledToolServer({
        name: spec.world,
        ...(spec.instructions ? { instructions: spec.instructions } : {}),
        journal,
        tools: spec.createTools(world),
      });

      return {
        mcpServers: { [serverName]: server },
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
        penalties.push({
          id: rule.id,
          label: rule.label,
          kind: rule.kind ?? 'policy_violation',
          multiplier: rule.multiplier ?? 0,
          ...(rule.detail ? { detail: rule.detail } : {}),
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
