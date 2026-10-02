/**
 * What a matrix is likely to cost, from what the same cells cost before.
 *
 * The per-run cap and the total budget bound the spend; they say nothing
 * about what a run usually costs. Earlier run sets do: the expected spend of
 * a cell is the mean of its earlier runs (agent and grading), and failing
 * that the mean of the same model and strategy on other tasks. Cells with
 * neither are counted, not guessed.
 *
 * Only runs that measured something are used: synthetic run sets, API
 * errors and runs whose integrity failed are left out, because a broken
 * architecture that never ran its planner is cheaper than a working one.
 */

import type { RunRecord } from '@arena/core';

import { listRunSets, loadRunSet } from './runSet';

interface Mean {
  totalUsd: number;
  runs: number;
}

export interface CostHistory {
  byCell: Map<string, Mean>;
  byArm: Map<string, Mean>;
  runs: number;
  runSets: number;
}

export interface CellRef {
  model: string;
  strategyId: string;
  taskId: string;
}

const cellKeyOf = (cell: CellRef) => JSON.stringify([cell.model, cell.strategyId, cell.taskId]);
const armKeyOf = (cell: CellRef) => JSON.stringify([cell.model, cell.strategyId]);

export function emptyHistory(): CostHistory {
  return { byCell: new Map(), byArm: new Map(), runs: 0, runSets: 0 };
}

/** Whether a record's cost says anything about what the cell costs when it works. */
export function usableForCost(record: RunRecord): boolean {
  return record.failureMode !== 'api_error' && record.integrity?.ok !== false;
}

export function addToHistory(history: CostHistory, records: readonly RunRecord[]): void {
  let added = 0;
  for (const record of records) {
    if (!usableForCost(record)) continue;
    const spend = record.costUsd + record.judgeCostUsd;
    for (const [map, key] of [
      [history.byCell, cellKeyOf(record)],
      [history.byArm, armKeyOf(record)],
    ] as const) {
      const mean = map.get(key) ?? { totalUsd: 0, runs: 0 };
      mean.totalUsd += spend;
      mean.runs += 1;
      map.set(key, mean);
    }
    added += 1;
  }
  if (added > 0) {
    history.runs += added;
    history.runSets += 1;
  }
}

/** Every non-synthetic run set under `root`. */
export async function loadCostHistory(root: string): Promise<CostHistory> {
  const history = emptyHistory();
  for (const entry of await listRunSets(root)) {
    if (entry.manifest?.synthetic) continue;
    try {
      const runSet = await loadRunSet(entry.runSetId, { root });
      addToHistory(history, runSet.records);
    } catch {
      // A run set that cannot be read contributes nothing to an estimate.
    }
  }
  return history;
}

export interface Expectation {
  /** Expected spend of the cells that have history. */
  usd: number;
  /** Cells priced from their own earlier runs. */
  exact: number;
  /** Cells priced from the same model and strategy on other tasks. */
  fromArm: number;
  /** Cells with no usable history at all. */
  unknown: number;
}

export function expectedCost(cells: readonly CellRef[], history: CostHistory): Expectation {
  const expectation: Expectation = { usd: 0, exact: 0, fromArm: 0, unknown: 0 };
  for (const cell of cells) {
    const own = history.byCell.get(cellKeyOf(cell));
    if (own && own.runs > 0) {
      expectation.usd += own.totalUsd / own.runs;
      expectation.exact += 1;
      continue;
    }
    const arm = history.byArm.get(armKeyOf(cell));
    if (arm && arm.runs > 0) {
      expectation.usd += arm.totalUsd / arm.runs;
      expectation.fromArm += 1;
      continue;
    }
    expectation.unknown += 1;
  }
  return expectation;
}
