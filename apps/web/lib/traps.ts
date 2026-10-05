/**
 * Which of a task's declared traps each run fell into.
 *
 * A trap names the scorer items that register it (`caughtBy`): it fired when
 * one of those rules' penalties was applied or one of those assertions earned
 * less than full credit. This mirrors `firedTraps` in `@scaffoldbench/tasks`, which
 * the tasks stream owns; once that is exported on this branch the site should
 * import it instead of keeping a copy.
 *
 * A run that did nothing at all fails assertion-backed traps too, so a trap
 * rate is read beside the score, never instead of it.
 *
 * Pure: no filesystem, safe anywhere.
 */

import { compareArchitectures } from './architectures';
import type { RunRecord, TaskInfo, TaskTrap } from './records';

export function firedTraps(
  task: Pick<TaskInfo, 'traps'>,
  run: Pick<RunRecord, 'breakdown' | 'penalties'>,
): string[] {
  const penalties = new Set(run.penalties.map((penalty) => penalty.id));
  const missed = new Set(run.breakdown.filter((item) => item.earned < 1).map((item) => item.id));
  return (task.traps ?? [])
    .filter((trap) => trap.caughtBy.some((id) => penalties.has(id) || missed.has(id)))
    .map((trap) => trap.id);
}

export interface TrapCell {
  fired: number;
  runs: number;
}

export interface TrapRow {
  trap: TaskTrap;
  /** Keyed by architecture id. */
  cells: Record<string, TrapCell>;
  /** Over every architecture. */
  total: TrapCell;
}

export interface TrapTable {
  taskId: string;
  architectures: string[];
  rows: TrapRow[];
}

/**
 * Trap by architecture for one task, over the runs given (the caller decides
 * the model and drops unrankable runs: a run that never measured the
 * architecture says nothing about the traps it would have hit).
 */
export function trapTable(task: TaskInfo, records: readonly RunRecord[]): TrapTable | null {
  const traps = task.traps ?? [];
  if (traps.length === 0) return null;
  const runs = records.filter((record) => record.taskId === task.id);
  const architectures = [...new Set(runs.map((record) => record.strategyId))].sort(compareArchitectures);

  const fired = new Map(runs.map((record) => [record.runId, new Set(firedTraps(task, record))]));
  const rows = traps.map((trap) => {
    const cells: Record<string, TrapCell> = {};
    let firedTotal = 0;
    for (const architecture of architectures) {
      const mine = runs.filter((record) => record.strategyId === architecture);
      const count = mine.filter((record) => fired.get(record.runId)?.has(trap.id)).length;
      cells[architecture] = { fired: count, runs: mine.length };
      firedTotal += count;
    }
    return { trap, cells, total: { fired: firedTotal, runs: runs.length } };
  });

  return { taskId: task.id, architectures, rows };
}
