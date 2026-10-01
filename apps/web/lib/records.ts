/**
 * The run-record shape the site reads, written against the v1 contract.
 *
 * `@arena/core` owns `RunRecord`. The contract it is moving to (integrity
 * checks, `api_error`, setup/grading time, retries, multi-model manifests) is
 * declared here as optional additions on top of today's type, so the site can
 * render run sets from either side of that change: a legacy set simply has no
 * `integrity` and reads as unverified. Once core exports these fields the
 * local declarations become redundant and can be deleted; the `Omit` keeps
 * them from conflicting in the meantime.
 *
 * Nothing here touches the filesystem; it is safe in client components.
 */

import type {
  FailureMode as CoreFailureMode,
  PhaseRecord as CorePhaseRecord,
  RunRecord as CoreRunRecord,
  RunSetManifest as CoreRunSetManifest,
  StrategyInfo,
  TaskInfo as CoreTaskInfo,
} from '@arena/core';

import { canonicalArchitectureId } from './architectures';

/** Infrastructure, auth, rate-limit or overload failure: not the architecture's fault. */
export type FailureMode = CoreFailureMode | 'api_error';

export interface IntegrityCheck {
  id: string;
  ok: boolean;
  detail?: string;
}

/** Harness health plus architecture fidelity: did the design actually run? */
export interface Integrity {
  ok: boolean;
  checks: IntegrityCheck[];
}

export interface PhaseRecord extends CorePhaseRecord {
  /** SDK result subtype, e.g. `success` or `error_max_turns`. */
  subtype?: string;
  /** Set when the strategy silently fell back (empty plan, default winner…). */
  degraded?: string;
}

type ContractKeys =
  | 'failureMode'
  | 'phases'
  | 'integrity'
  | 'setupMs'
  | 'gradingMs'
  | 'attempts'
  | 'taskDifficulty';

export type Difficulty = 'easy' | 'medium' | 'hard' | 'expert';

export interface RunRecord extends Omit<CoreRunRecord, ContractKeys> {
  failureMode: FailureMode;
  phases: PhaseRecord[];
  taskDifficulty: Difficulty;
  /** Absent on run sets recorded before the fidelity gate existed. */
  integrity?: Integrity;
  /** Wall-clock spent building the task environment, outside `latencyMs`. */
  setupMs?: number;
  /** Wall-clock spent scoring, outside `latencyMs`. */
  gradingMs?: number;
  /** How many times the run was attempted; retries happen only on `api_error`. */
  attempts?: number;
}

export interface TaskTrap {
  id: string;
  description: string;
  /** Which architecture's mechanism is expected to catch it. */
  caughtBy?: string;
}

export interface TaskInfo extends Omit<CoreTaskInfo, 'difficulty'> {
  difficulty: Difficulty;
  /** Pre-registered prediction of which architecture should do best, and why. */
  hypothesis?: string;
  traps?: TaskTrap[];
}

export interface RunSetManifest extends Omit<CoreRunSetManifest, 'model'> {
  /** The single model of a legacy run set; a v1 set lists `models` instead. */
  model?: string;
  models?: string[];
  status?: 'running' | 'interrupted' | 'complete';
}

export interface Catalog {
  strategies: StrategyInfo[];
  tasks: TaskInfo[];
}

export function emptyCatalog(): Catalog {
  return { strategies: [], tasks: [] };
}

/**
 * Bring a record onto the current vocabulary. Only the architecture id
 * changes; the run id and trace file keep the name the run was recorded under,
 * because they address files on disk.
 */
export function normalizeRecord(record: RunRecord): RunRecord {
  const strategyId = canonicalArchitectureId(record.strategyId);
  return strategyId === record.strategyId ? record : { ...record, strategyId };
}

/** Whether a record carries the fidelity verdict at all. */
export function hasIntegrity(record: RunRecord): boolean {
  return record.integrity !== undefined;
}

/**
 * Contract 3: runs whose integrity failed, and runs lost to infrastructure,
 * are excluded from every ranking and counted in the health summary instead.
 * A legacy record with no integrity verdict is not excluded on that ground —
 * the run set as a whole is flagged unverified instead.
 */
export function isRankable(record: RunRecord): boolean {
  if (record.failureMode === 'api_error') return false;
  if (record.integrity && !record.integrity.ok) return false;
  return true;
}

/** The models a run set covers, from the manifest when it says, else the records. */
export function runSetModels(
  manifest: RunSetManifest | null,
  records: readonly RunRecord[],
): string[] {
  const fromRecords = new Set(records.map((record) => record.model));
  const declared = manifest?.models ?? (manifest?.model ? [manifest.model] : []);
  const all = new Set([...declared, ...fromRecords]);
  return [...all];
}
