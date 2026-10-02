/**
 * What `arena run` is about to do, worked out before it does any of it: the
 * cells of the matrix, which of them a resumed run set still needs, the
 * settings a resume must keep, and the most the session can spend.
 *
 * Pure: the command reads the disk and hands the results in.
 */

import { DEFAULT_RETRY_POLICY, cellKey, makeRunId } from '@arena/core';
import type { CellCoordinates, EffortLevel, FixtureMode, RunSetManifest } from '@arena/core';

import { CONFIRM_ABOVE_USD } from './args';
import type { MeasurementSetting, RunArgs } from './args';
import { formatBudget, formatDuration, plural } from './format';

/** Most a single grading call may spend; passed to `createJudge` so the plan and the cap agree. */
export const JUDGE_CALL_CAP_USD = 0.5;

/**
 * Attempts the runner gives a run: a transient API failure is retried, and
 * every attempt reserves the run's cap afresh, so a run can spend its cap
 * more than once. `arena run` does not override the runner's retry policy.
 */
export const MAX_ATTEMPTS = DEFAULT_RETRY_POLICY.maxAttempts;

export interface MatrixCell extends CellCoordinates {
  runId: string;
  key: string;
}

/** Every cell, in the runner's order: repeat, then task, then model, then strategy. */
export function matrixCells(
  models: readonly string[],
  strategyIds: readonly string[],
  taskIds: readonly string[],
  repeats: number,
): MatrixCell[] {
  const cells: MatrixCell[] = [];
  for (let repeat = 1; repeat <= repeats; repeat++) {
    for (const taskId of taskIds) {
      for (const model of models) {
        for (const strategyId of strategyIds) {
          const coordinates = { model, strategyId, taskId, repeat };
          cells.push({ ...coordinates, runId: makeRunId(coordinates), key: cellKey(coordinates) });
        }
      }
    }
  }
  return cells;
}

/**
 * Two cells that would be recorded under one run id, if any: the second
 * would silently replace the first. Strategies and tasks are de-duplicated
 * when they are selected, and models when they are parsed, so this takes two
 * model ids that read the same once made file-safe, such as `claude/x` and
 * `claude-x`. The runner refuses such a matrix too, but only after the plan
 * has been printed and with a stack trace.
 */
export function firstRunIdClash(cells: readonly MatrixCell[]): [MatrixCell, MatrixCell] | undefined {
  const seen = new Map<string, MatrixCell>();
  for (const cell of cells) {
    const earlier = seen.get(cell.runId);
    if (earlier) return [earlier, cell];
    seen.set(cell.runId, cell);
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Resuming
// ---------------------------------------------------------------------------

export interface SelectionResolver {
  strategies(selectors: string[]): string[];
  tasks(selectors: string[]): string[];
}

export type ResumeResult = { ok: true; args: RunArgs; notes: string[] } | { ok: false; error: string };

/**
 * The settings a resumed session runs under: the run set's own, so that
 * `arena run --resume <id>` needs nothing else. A flag that says otherwise
 * is refused rather than quietly overridden, because a run set measured
 * under two settings measures neither. Operational flags (concurrency, the
 * session's budget) are free to change. Settings an older manifest did not
 * record come from the flags or their defaults.
 */
export function resolveResume(args: RunArgs, manifest: RunSetManifest | undefined, resolve: SelectionResolver): ResumeResult {
  if (!manifest) {
    return {
      ok: true,
      args,
      notes: ['The run set has no manifest, so it is resumed with the settings given here.'],
    };
  }

  const conflicts: string[] = [];
  const next: RunArgs = { ...args };
  const notes: string[] = [];

  const keep = <T>(setting: MeasurementSetting, flag: string, recorded: T | undefined, given: T, apply: (value: T) => void) => {
    if (recorded === undefined) {
      notes.push(`The manifest does not record ${flag}; using ${JSON.stringify(given)}.`);
      return;
    }
    if (args.explicit.has(setting) && JSON.stringify(recorded) !== JSON.stringify(given)) {
      conflicts.push(`--${flag} is ${JSON.stringify(given)}, but the run set was measured with ${JSON.stringify(recorded)}`);
      return;
    }
    apply(recorded);
  };

  const models = manifest.models ?? manifest.model.split(',').map((m) => m.trim()).filter(Boolean);
  keep('models', 'models', models, args.models, (value) => (next.models = value));
  keep(
    'strategies',
    'strategies',
    manifest.strategyIds,
    args.explicit.has('strategies') ? safely(() => resolve.strategies(args.strategies), args.strategies) : manifest.strategyIds,
    (value) => (next.strategies = value),
  );
  keep(
    'tasks',
    'tasks',
    manifest.taskIds,
    args.explicit.has('tasks') ? safely(() => resolve.tasks(args.tasks), args.tasks) : manifest.taskIds,
    (value) => (next.tasks = value),
  );
  keep('repeats', 'repeats', manifest.repeats, args.repeats, (value) => (next.repeats = value));
  keep<EffortLevel>('effort', 'effort', manifest.effort, args.effort, (value) => (next.effort = value));
  keep<FixtureMode>('fixtureMode', 'replay/--record/--live', manifest.fixtureMode, args.fixtureMode, (value) => (next.fixtureMode = value));
  keep('maxCostUsd', 'max-cost', manifest.maxCostUsdPerRun, args.maxCostUsd, (value) => (next.maxCostUsd = value));
  keep(
    'maxSeconds',
    'max-seconds',
    manifest.maxWallClockMsPerRun === undefined ? undefined : manifest.maxWallClockMsPerRun / 1_000,
    args.maxSeconds,
    (value) => (next.maxSeconds = value),
  );
  keep('judgeModel', 'judge-model', manifest.judge?.model ?? undefined, args.judgeModel, (value) => (next.judgeModel = value));
  keep<EffortLevel>(
    'judgeEffort',
    'judge-effort',
    manifest.judge?.effort ?? undefined,
    args.judgeEffort,
    (value) => (next.judgeEffort = value),
  );
  keep('judgeSamples', 'judge-samples', manifest.judge?.samples, args.judgeSamples, (value) => (next.judgeSamples = value));

  if (conflicts.length > 0) {
    return {
      ok: false,
      error:
        `Run set "${manifest.runSetId}" cannot be resumed with different measurement settings:\n` +
        conflicts.map((conflict) => `  ${conflict}`).join('\n') +
        '\nDrop those flags to resume it as it was measured, or start a new run set.',
    };
  }
  if (next.maxCostUsd > next.totalBudgetUsd) {
    return {
      ok: false,
      error:
        `The run set's per-run cap is ${formatBudget(next.maxCostUsd)}, above --total-budget ` +
        `${formatBudget(next.totalBudgetUsd)}: no run could start. Raise --total-budget.`,
    };
  }
  return { ok: true, args: { ...next, runSetId: manifest.runSetId }, notes };
}

function safely<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Spend
// ---------------------------------------------------------------------------

export interface SpendInput {
  /** Cells this session will run. */
  runs: number;
  /** Of those, cells whose task may call the judge. */
  gradedRuns: number;
  maxCostUsd: number;
  totalBudgetUsd: number;
  concurrency: number;
  judgeSamples: number;
  /** Attempts a run may take; see `MAX_ATTEMPTS`. */
  attempts: number;
}

export interface SpendPlan {
  /** Runs that can be in flight at once: each reserves its full cap from the total. */
  maxInFlight: number;
  /** The most graded runs can spend on grading, per run. */
  judgeCapPerRun: number;
  /** Agent spend, at most: every attempt of every run at its cap, or the total budget. */
  agentCeiling: number;
  /**
   * Grading is billed when a run settles but not reserved before it starts,
   * so the runs still in flight once the budget is reached can add their
   * grading on top of it.
   */
  judgeOverBudget: number;
  /** What every attempt of every run could spend at its cap, with all the grading, if no budget cut it short. */
  uncapped: number;
  /** The most this session can spend, give or take one model turn per call in flight. */
  ceiling: number;
}

export function spendPlan(input: SpendInput): SpendPlan {
  const maxInFlight = Math.max(
    0,
    Math.min(input.concurrency, input.runs, Math.floor(input.totalBudgetUsd / input.maxCostUsd + 1e-9)),
  );
  const judgeCapPerRun = input.gradedRuns > 0 ? input.judgeSamples * JUDGE_CALL_CAP_USD : 0;
  // A run retried after an API failure is graded again if the judge was the
  // failure, so grading repeats with the attempts like the agent does.
  const uncapped = input.attempts * (input.runs * input.maxCostUsd + input.gradedRuns * judgeCapPerRun);
  const agentCeiling = Math.min(input.attempts * input.runs * input.maxCostUsd, input.totalBudgetUsd);
  const judgeOverBudget = Math.min(maxInFlight, input.gradedRuns) * judgeCapPerRun;
  const ceiling = Math.min(uncapped, input.totalBudgetUsd + judgeOverBudget);
  return { maxInFlight, judgeCapPerRun, agentCeiling, judgeOverBudget, uncapped, ceiling };
}

/**
 * Whether to ask before starting. Only a person at a terminal can be asked,
 * and only when the run could cost real money on a limit they did not pick:
 * typing `--total-budget` is a decision, and so is `--yes`. A script, a pipe
 * or a CI job has neither a terminal nor anyone to ask, and is never held up.
 */
export function needsConfirmation(input: {
  interactive: boolean;
  yes: boolean;
  budgetGiven: boolean;
  ceilingUsd: number;
}): boolean {
  return input.interactive && !input.yes && !input.budgetGiven && input.ceilingUsd > CONFIRM_ABOVE_USD;
}

/**
 * The plan's "Ceiling" line: the number, and the terms that add up to it.
 * Either nothing binds, and the terms are every attempt of every run plus all
 * the grading, or the session's budget does, and the terms are the budget
 * plus the grading of the runs still in flight when it is reached.
 */
export function ceilingText(input: SpendInput, plan: SpendPlan): string {
  const parts: string[] = [];
  const attempts = input.attempts > 1 ? ` × ${input.attempts} attempts` : '';
  const grading = `${input.judgeSamples} × ${formatBudget(JUDGE_CALL_CAP_USD)} each`;
  if (plan.uncapped <= input.totalBudgetUsd + plan.judgeOverBudget + 1e-9) {
    parts.push(`${plural(input.runs, 'run')} × ${formatBudget(input.maxCostUsd)} cap${attempts}`);
    if (plan.judgeCapPerRun > 0) parts.push(`grading of ${plural(input.gradedRuns, 'run')} (${grading}${attempts})`);
  } else {
    parts.push(`total budget ${formatBudget(input.totalBudgetUsd)}`);
    if (plan.judgeOverBudget > 0) {
      parts.push(
        `grading of up to ${plural(Math.min(plan.maxInFlight, input.gradedRuns), 'run')} in flight (${grading})`,
      );
    }
  }
  return `${formatBudget(plan.ceiling)}  ${parts.join(' + ')}`;
}

/** "4m00s per run" style summary of the per-run caps. */
export function capsText(args: Pick<RunArgs, 'maxCostUsd' | 'maxSeconds' | 'concurrency'>, maxInFlight: number): string {
  const inFlight =
    maxInFlight < args.concurrency
      ? `${maxInFlight} in flight (each run reserves its cap from the budget; --concurrency ${args.concurrency})`
      : `${args.concurrency} in flight`;
  return `${formatBudget(args.maxCostUsd)} and ${formatDuration(args.maxSeconds * 1_000)} per run · ${inFlight}`;
}
