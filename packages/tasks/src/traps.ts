import type { Penalty, ScoreItem, Task } from '@arena/core';

/** Anything carrying a scored breakdown: a `TaskScore` or a stored `RunRecord`. */
export interface ScoredRun {
  breakdown: readonly ScoreItem[];
  penalties: readonly Penalty[];
}

/**
 * Ids of the task's declared traps that this run fell into.
 *
 * A trap fired when any scorer item in its `caughtBy` registered a failure: a
 * listed penalty was applied, or a listed assertion earned less than full
 * credit. A run that did nothing at all fails assertion-backed traps too, so a
 * trap rate is read alongside the score, never instead of it.
 */
export function firedTraps(task: Pick<Task, 'traps'>, run: ScoredRun): string[] {
  const penalties = new Set(run.penalties.map((penalty) => penalty.id));
  const missed = new Set(run.breakdown.filter((item) => item.earned < 1).map((item) => item.id));
  return (task.traps ?? [])
    .filter((trap) => trap.caughtBy.some((id) => penalties.has(id) || missed.has(id)))
    .map((trap) => trap.id);
}
