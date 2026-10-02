/**
 * What a run set says about one architecture, read off its records: where a
 * run's money goes, stage by stage, and how a representative run is chosen.
 *
 * Pure: no filesystem, safe anywhere.
 */

import { designFor, stageOfPhase } from './designs';
import type { CheckRate } from './integrity';
import { checkRates, isHarnessCheck } from './integrity';
import { compareModels } from './models';
import type { Difficulty, RunRecord } from './records';

export interface StageCost {
  stageId: string;
  title: string;
  /** Mean over the model's runs, so stages add up to the run's cost. */
  costUsd: number;
  /** Model calls the stage made per run (a parallel stage makes several). */
  calls: number;
  toolCalls: number;
}

export interface ModelStageCosts {
  model: string;
  runs: number;
  /** Mean cost of a run. */
  costUsd: number;
  stages: StageCost[];
}

const OTHER = 'other';

/**
 * A run's cost by the stage of the design that spent it, per model. A phase
 * the design does not know (a name from some other version of the strategy)
 * is counted as `other` rather than dropped, so the stages always add up.
 */
export function stageCosts(records: readonly RunRecord[], strategyId: string): ModelStageCosts[] {
  const design = designFor(strategyId);
  if (!design) return [];
  const mine = records.filter((record) => record.strategyId === design.id);
  const models = [...new Set(mine.map((record) => record.model))].sort(compareModels);

  return models.map((model) => {
    const runs = mine.filter((record) => record.model === model);
    const totals = new Map<string, StageCost>(
      design.stages.map((stage) => [
        stage.id,
        { stageId: stage.id, title: stage.title, costUsd: 0, calls: 0, toolCalls: 0 },
      ]),
    );
    for (const run of runs) {
      for (const phase of run.phases) {
        const stage = stageOfPhase(design.id, phase.phase);
        const key = stage?.id ?? OTHER;
        let total = totals.get(key);
        if (!total) {
          total = { stageId: OTHER, title: 'Other calls', costUsd: 0, calls: 0, toolCalls: 0 };
          totals.set(key, total);
        }
        total.costUsd += phase.costUsd;
        total.calls += 1;
        total.toolCalls += phase.toolCalls;
      }
    }
    const n = Math.max(1, runs.length);
    const stages = [...totals.values()]
      .filter((total) => total.calls > 0 || total.stageId !== OTHER)
      .map((total) => ({
        ...total,
        costUsd: total.costUsd / n,
        calls: total.calls / n,
        toolCalls: total.toolCalls / n,
      }));
    return {
      model,
      runs: runs.length,
      costUsd: stages.reduce((sum, stage) => sum + stage.costUsd, 0),
      stages,
    };
  });
}

const DIFFICULTY: Record<Difficulty, number> = { easy: 0, medium: 1, hard: 2, expert: 3 };

/**
 * Which of an architecture's runs to show as "a run of this design": one
 * whose design ran and that passed, on the middle model, on a task hard enough
 * to give the design something to do. Deterministic, so a build is stable.
 */
export function pickRepresentative(
  records: readonly RunRecord[],
  strategyId: string,
  preferredModel: string | undefined,
  has: (record: RunRecord) => boolean = () => true,
): RunRecord | undefined {
  const candidates = records.filter((record) => record.strategyId === strategyId && has(record));
  return [...candidates].sort(
    (a, b) =>
      Number(healthy(b)) - Number(healthy(a)) ||
      Number(b.passed) - Number(a.passed) ||
      Number(b.model === preferredModel) - Number(a.model === preferredModel) ||
      DIFFICULTY[b.taskDifficulty] - DIFFICULTY[a.taskDifficulty] ||
      a.repeat - b.repeat ||
      a.runId.localeCompare(b.runId),
  )[0];
}

function healthy(record: RunRecord): boolean {
  return record.failureMode !== 'api_error' && (record.integrity ? record.integrity.ok : true);
}

/**
 * The architecture's own fidelity checks, in the order its design declares
 * them. A check the design does not describe (an id from some other version
 * of the strategy) follows, alphabetically.
 */
export function ownCheckRates(records: readonly RunRecord[], strategyId: string): CheckRate[] {
  const design = designFor(strategyId);
  if (!design) return [];
  const declared = design.checks.map((check) => check.id);
  const rank = (id: string) => {
    const at = declared.indexOf(id);
    return at === -1 ? declared.length : at;
  };
  return checkRates(records.filter((record) => record.strategyId === design.id))
    .filter((rate) => rate.id.startsWith(`${design.id}.`))
    .sort((a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id));
}

/** The runner's own checks over some records: harness health, shared by every design. */
export function harnessCheckRates(records: readonly RunRecord[]): CheckRate[] {
  return checkRates(records).filter((rate) => isHarnessCheck(rate.id));
}

export interface TaskDelta {
  taskId: string;
  title: string;
  difficulty: Difficulty;
  /** Mean score of the architecture minus the control's, over the repeats both have. */
  delta: number;
  /** Repeats both ran. */
  pairs: number;
}

/**
 * Task by task, how the architecture scored against the control on one
 * model: the mean over the repeats both completed, so a missing run on one
 * side never reads as a loss. Pass the runs that count. A task where either
 * has no such repeat is left out, not drawn as a tie.
 */
export function taskDeltas(
  records: readonly RunRecord[],
  strategyId: string,
  model: string,
  baselineId = 'single',
): TaskDelta[] {
  const mine = records.filter((record) => record.model === model && record.strategyId === strategyId);
  const control = new Map(
    records
      .filter((record) => record.model === model && record.strategyId === baselineId)
      .map((record) => [`${record.taskId}\u0000${record.repeat}`, record] as const),
  );
  const tasks = new Map<string, { title: string; difficulty: Difficulty; diffs: number[] }>();

  for (const record of mine) {
    const other = control.get(`${record.taskId}\u0000${record.repeat}`);
    if (!other) continue;
    const task = tasks.get(record.taskId) ?? { title: record.taskTitle, difficulty: record.taskDifficulty, diffs: [] };
    task.diffs.push(record.score - other.score);
    tasks.set(record.taskId, task);
  }

  return [...tasks.entries()].map(([taskId, task]) => ({
    taskId,
    title: task.title,
    difficulty: task.difficulty,
    delta: task.diffs.reduce((sum, diff) => sum + diff, 0) / task.diffs.length,
    pairs: task.diffs.length,
  }));
}
