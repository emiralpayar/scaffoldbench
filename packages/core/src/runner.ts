import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { BudgetTracker, TotalBudget, emptyUsage } from './budget';
import type { BudgetReservation } from './budget';
import {
  BREAKING_HARNESS_CHECKS,
  actingCallOutOfTurns,
  apiErrorsOf,
  describeApiError,
  harnessChecks,
  integrityOf,
  modelStopsOf,
  tracedCalls,
} from './integrity';
import { JudgeError, judgeInfoOf } from './judge';
import { isUsageLimit } from './usageLimit';
import {
  RESULTS_DIR,
  assertValidRunSetId,
  catalogPath,
  cellKey,
  ensureDir,
  latestPointerPath,
  listJsonFiles,
  makeRunId,
  manifestPath,
  readJson,
  readJsonIfExists,
  runsDir,
  tracesDir,
  writeJson,
} from './paths';
import { collectProvenance } from './provenance';
import { buildSystemPrompt } from './systemPrompt';
import { TraceCollector } from './trace';
import type {
  ApiError,
  BudgetStopReason,
  EffortLevel,
  FailureMode,
  FixtureMode,
  IntegrityCheck,
  Judge,
  JudgeCallOptions,
  JudgeRequest,
  JudgeResponse,
  ManifestSession,
  Provenance,
  RetryPolicy,
  RunContext,
  RunRecord,
  RunSetManifest,
  RunSetStatus,
  RunSetStopReason,
  Strategy,
  StrategyInfo,
  StrategyOutcome,
  Task,
  TaskEnvironment,
  TaskInfo,
  TaskScore,
  TraceEvent,
} from './types';

/** `RunRecord.effectiveEffort` when the calls behind it reported different levels. */
export const EFFORT_MIXED = 'mixed';

/** Three attempts, 5 s then 10 s apart (each ± jitter), never more than a minute. */
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 5_000,
  maxDelayMs: 60_000,
};

export interface RunnerConfig {
  runSetId: string;
  strategies: Strategy[];
  tasks: Task[];
  /**
   * Models under test. A matrix dimension like strategies and tasks: every
   * strategy runs every task on every model.
   */
  models: string[];
  effort: EffortLevel;
  repeats: number;
  concurrency: number;
  /** Ceiling for a single agent run, enforced by `BudgetTracker`. */
  maxCostUsdPerRun: number;
  /** Wall-clock ceiling for the strategy of a single run. */
  maxWallClockMsPerRun: number;
  /**
   * Ceiling for this session. A run starts only when its full per-run cap
   * fits beside what is spent and what the runs in flight have reserved; see
   * `TotalBudget`. Earlier sessions of a resumed run set do not count.
   */
  totalBudgetUsd: number;
  fixtureMode: FixtureMode;
  fixtureDir: string;
  judge: Judge;
  judgeSamples: number;
  /** When false, nothing is written to `results/` (used by the live demo). */
  persist: boolean;
  /** Overrides the results root. Defaults to the repo's `results/`. */
  resultsRoot?: string;
  /**
   * Cells to leave out because an earlier session already ran them, as
   * `cellKey`s — see `completedCells`. Required to write into a run set that
   * already holds runs, so that nothing is silently mixed into an old one.
   */
  skipCells?: ReadonlySet<string>;
  /**
   * Hard stop: start nothing new and abort the runs in flight. A run cut off
   * this way is not a measurement, so it is discarded rather than recorded,
   * and resuming the run set runs it again.
   */
  signal?: AbortSignal;
  /** Soft stop: start nothing new, and let the runs in flight finish and be recorded. */
  drainSignal?: AbortSignal;
  /** How transient API failures are retried. Defaults to `DEFAULT_RETRY_POLICY`. */
  retry?: Partial<RetryPolicy>;
  /**
   * Point `results/latest.json` at this run set once the session ends with at
   * least one new record. Off by default: the pointer is tracked, and an
   * ordinary run should not rewrite what the site shows.
   */
  updateLatestPointer?: boolean;
  /** Command line recorded in the manifest. Defaults to this process's arguments. */
  argv?: readonly string[];
  onEvent?: (event: RunnerEvent) => void;
  /** Live trace feed, used by the demo endpoint to stream a run as it happens. */
  onTraceEvent?: (runId: string, event: TraceEvent) => void;
  /**
   * Environment for the model subprocess. The live demo uses it to run on a
   * visitor's own API key — see `visitorEnv` in `credentials.ts`.
   */
  subprocessEnv?: Record<string, string | undefined>;
}

export type RunnerEvent =
  /** A cell started. `index` counts from 0 over the cells this session runs, of `total`. */
  | { type: 'run-start'; runId: string; index: number; total: number }
  | { type: 'run-end'; record: RunRecord; index: number; total: number }
  /** An attempt failed at the API and the cell will run again after `delayMs`. */
  | { type: 'run-retry'; runId: string; attempt: number; error: string; delayMs: number }
  /** The hard stop cut a run off; it was discarded. */
  | { type: 'run-interrupted'; runId: string }
  /** A cell produced no record because the runner itself failed. */
  | { type: 'run-error'; runId: string; error: string }
  | { type: 'budget-stop'; spentUsd: number }
  /** The session stopped starting new cells for a reason other than the total budget. */
  | { type: 'stop'; reason: Exclude<RunSetStopReason, 'total_budget'>; message: string };

export interface RunnerResult {
  manifest: RunSetManifest;
  /** The records this session produced, sorted by run id. */
  records: RunRecord[];
}

interface Cell {
  model: string;
  strategy: Strategy;
  task: Task;
  repeat: number;
  key: string;
  runId: string;
}

/** What the run set held before this session started. */
interface ExistingRunSet {
  manifest: RunSetManifest | undefined;
  records: RunRecord[];
  /** What earlier sessions spent that none of `records` carries. */
  unrecordedUsd: number;
}

const STOP_NOTES: Record<RunSetStopReason, string> = {
  signal: 'Interrupted: the runs in flight were aborted and discarded.',
  drain: 'Stopped on request once the runs in flight had finished.',
  total_budget: 'Stopped early: total budget reached.',
  auth: 'Stopped early: the API rejected the credentials.',
  usage_limit: "Stopped early: the account's usage limit was reached. Resume the run set once it resets.",
};

/**
 * Run the matrix: every model × strategy × task × repeat cell, each in a fresh
 * world, on a pool of `concurrency` workers.
 *
 * Cells are ordered repeat → task → model → strategy, so a session that stops
 * early has covered every model and strategy on the same tasks rather than
 * some of them on all tasks.
 */
export async function runMatrix(config: RunnerConfig): Promise<RunnerResult> {
  assertValidRunSetId(config.runSetId);
  if (config.models.length === 0) throw new Error('runMatrix needs at least one model.');

  const startedAt = Date.now();
  const resultsRoot = config.resultsRoot ?? RESULTS_DIR;
  const retry = retryPolicy(config.retry);
  const matrix = buildMatrix(config);
  const skip = config.skipCells ?? new Set<string>();
  const pending = matrix.filter((cell) => !skip.has(cell.key));

  const provenance = await collectProvenance(config.argv ?? process.argv.slice(2));
  const existing = config.persist
    ? await readExistingRunSet(config, resultsRoot)
    : { manifest: undefined, records: [], unrecordedUsd: 0 };

  // Every record of the run set by run id: the earlier sessions' and this one's.
  const recorded = new Map(existing.records.map((record) => [record.runId, record]));
  const fresh: RunRecord[] = [];

  let stoppedBy: RunSetStopReason | undefined;
  let handedOut = 0;
  let discarded = 0;
  // Spend no record carries: runs a hard stop cut off, and the attempts
  // retried before them. Earlier sessions' share comes from their manifest.
  let unrecordedUsd = existing.unrecordedUsd;

  const emit = (event: RunnerEvent): void => {
    try {
      config.onEvent?.(event);
    } catch {
      // A failing listener is a reporting problem; it must not lose a run.
    }
  };

  const manifestNow = (status: RunSetStatus): RunSetManifest =>
    buildManifest({
      config,
      retry,
      provenance,
      startedAt,
      existing,
      matrix,
      recorded,
      unrecordedUsd,
      status,
      ...(status === 'interrupted' && stoppedBy ? { stoppedBy } : {}),
    });

  // The manifest is rewritten after every run; writes are queued so they land in order.
  let manifestWrites = Promise.resolve();
  const writeManifest = (manifest: RunSetManifest): Promise<void> => {
    if (!config.persist) return Promise.resolve();
    manifestWrites = manifestWrites
      .catch(() => undefined)
      .then(() => writeJson(manifestPath(config.runSetId, resultsRoot), manifest));
    return manifestWrites;
  };

  if (config.persist) {
    await ensureDir(runsDir(config.runSetId, resultsRoot));
    await ensureDir(tracesDir(config.runSetId, resultsRoot));
    await writeCatalog(config, resultsRoot);
    await writeManifest(manifestNow('running'));
  }

  const total = new TotalBudget(config.totalBudgetUsd);
  // `hard` cuts off the runs in flight; `halted` ends retry back-off waits on any stop.
  const hard = new AbortController();
  const halted = new AbortController();

  const stop = (reason: RunSetStopReason, message: string): void => {
    if (stoppedBy !== undefined) {
      // A hard stop still cuts off what a softer one let finish.
      if (reason === 'signal') hard.abort();
      return;
    }
    stoppedBy = reason;
    total.close();
    halted.abort();
    if (reason === 'signal') hard.abort();
    if (reason === 'total_budget') emit({ type: 'budget-stop', spentUsd: total.spentUsd });
    else emit({ type: 'stop', reason, message });
  };

  const budgetStop = (): void => stop('total_budget', STOP_NOTES.total_budget);

  const onSignal = () => stop('signal', 'Aborted by the caller: runs in flight were cut off and discarded.');
  const onDrain = () => stop('drain', 'Stopping once the runs in flight have finished.');
  config.signal?.addEventListener('abort', onSignal, { once: true });
  config.drainSignal?.addEventListener('abort', onDrain, { once: true });
  if (config.signal?.aborted) onSignal();
  if (config.drainSignal?.aborted) onDrain();

  const runCell = async (cell: Cell, index: number, reservation: BudgetReservation) => {
    emit({ type: 'run-start', runId: cell.runId, index, total: pending.length });

    // A record being replaced — an api_error from an earlier session — still
    // cost money and attempts, which the replacement inherits.
    const replaced = recorded.get(cell.runId);
    let attempts = replaced ? (replaced.attempts ?? 1) : 0;
    let discardedUsd = replaced ? spendOf(replaced) : 0;
    let lease: BudgetReservation = reservation;
    let note: string | undefined;
    // What this session spent on the cell that no stored record carries yet.
    let uncarriedUsd = 0;

    try {
      for (let attempt = 1; ; attempt++) {
        const result = await executeAttempt(config, cell, { signal: hard.signal, note });
        attempts += 1;
        const spentUsd = result.record.costUsd + result.record.judgeCostUsd;
        lease.settle(spentUsd);
        uncarriedUsd += spentUsd;

        if (result.interrupted) {
          discarded += 1;
          emit({ type: 'run-interrupted', runId: cell.runId });
          return;
        }

        const failure = result.apiError;
        if (failure?.retryable && attempt < retry.maxAttempts && stoppedBy === undefined) {
          const delayMs = retryDelayMs(attempt, retry);
          const error = describeApiError(failure);
          emit({ type: 'run-retry', runId: cell.runId, attempt, error, delayMs });
          await sleep(delayMs, halted.signal);

          const next = stoppedBy === undefined ? await total.acquire(config.maxCostUsdPerRun) : undefined;
          if (next) {
            discardedUsd += spentUsd;
            lease = next;
            note =
              `Attempt ${attempt + 1} of ${retry.maxAttempts}: attempt ${attempt} failed at the API ` +
              `(${error}) and was discarded.`;
            continue;
          }
          if (!total.closed) budgetStop();
          // No retry is possible any more: the failed attempt is the record.
        }

        const record: RunRecord = {
          ...result.record,
          attempts,
          discardedCostUsd: round(discardedUsd, 6),
        };
        if (config.persist) await persistRun(config, resultsRoot, record, result.trace);
        recorded.set(record.runId, record);
        uncarriedUsd = 0;
        fresh.push(record);
        // Best effort: the session's last manifest write is awaited, and a
        // failure there is not swallowed.
        writeManifest(manifestNow('running')).catch(() => undefined);
        emit({ type: 'run-end', record, index, total: pending.length });

        if (failure?.kind === 'auth') {
          stop(
            'auth',
            `The API rejected the credentials (${describeApiError(failure)}). No further runs were ` +
              'started; fix the credentials, then resume the run set.',
          );
        } else if (failure && isUsageLimit(failure)) {
          stop(
            'usage_limit',
            `The account's usage limit was reached (${describeApiError(failure)})` +
              `${failure.resetsAt ? `; it resets at ${failure.resetsAt}` : ''}. No further runs were ` +
              'started; resume the run set once it has reset.',
          );
        }
        return;
      }
    } finally {
      lease.settle(0);
      unrecordedUsd += uncarriedUsd;
    }
  };

  const worker = async (): Promise<void> => {
    for (;;) {
      if (stoppedBy !== undefined || handedOut >= pending.length) return;
      // Reserve before taking a cell, so cells start in matrix order.
      const reservation = await total.acquire(config.maxCostUsdPerRun);
      if (!reservation) {
        if (!total.closed) budgetStop();
        return;
      }
      const index = handedOut;
      const cell = pending[index];
      if (!cell || stoppedBy !== undefined) {
        reservation.settle(0);
        return;
      }
      handedOut += 1;

      try {
        await runCell(cell, index, reservation);
      } catch (error) {
        emit({
          type: 'run-error',
          runId: cell.runId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  };

  try {
    await Promise.all(
      Array.from({ length: Math.max(1, Math.min(config.concurrency, pending.length)) }, () =>
        worker(),
      ),
    );
  } finally {
    config.signal?.removeEventListener('abort', onSignal);
    config.drainSignal?.removeEventListener('abort', onDrain);
  }

  const status: RunSetStatus =
    handedOut >= pending.length && discarded === 0 ? 'complete' : 'interrupted';
  // A drain that a hard stop cut short did not let its runs finish: say what
  // happened to them, not what was first asked for.
  if (status === 'interrupted' && (stoppedBy === undefined || (stoppedBy === 'drain' && discarded > 0))) {
    stoppedBy = 'signal';
  }

  const manifest = manifestNow(status);
  await writeManifest(manifest);

  if (config.persist && config.updateLatestPointer && fresh.length > 0) {
    await writeJson(latestPointerPath(resultsRoot), { runSetId: config.runSetId });
  }

  fresh.sort((a, b) => a.runId.localeCompare(b.runId));
  return { manifest, records: fresh };
}

/**
 * Every cell, in matrix order. Refuses a matrix in which two cells would share
 * a run id — a model, strategy or task listed twice, or two model ids that
 * read the same once made file-safe — since the second record would silently
 * replace the first.
 */
function buildMatrix(config: RunnerConfig): Cell[] {
  const cells: Cell[] = [];
  const byRunId = new Map<string, Cell>();
  for (let repeat = 1; repeat <= config.repeats; repeat++) {
    for (const task of config.tasks) {
      for (const model of config.models) {
        for (const strategy of config.strategies) {
          const coordinates = { model, strategyId: strategy.id, taskId: task.id, repeat };
          const cell: Cell = {
            model,
            strategy,
            task,
            repeat,
            key: cellKey(coordinates),
            runId: makeRunId(coordinates),
          };
          const clash = byRunId.get(cell.runId);
          if (clash) {
            throw new Error(
              `Cells ${clash.key} and ${cell.key} would both be recorded as ${cell.runId}: ` +
                'list each model, strategy and task once.',
            );
          }
          byRunId.set(cell.runId, cell);
          cells.push(cell);
        }
      }
    }
  }
  return cells;
}

// ---------------------------------------------------------------------------
// One attempt at one cell
// ---------------------------------------------------------------------------

interface AttemptResult {
  /** The attempt's record, with `attempts` and `discardedCostUsd` still to be set by the caller. */
  record: RunRecord;
  trace: readonly TraceEvent[];
  /** The API failure that makes this attempt something other than a measurement. */
  apiError?: ApiError;
  /** The hard stop cut this attempt off: it is neither recorded nor retried. */
  interrupted: boolean;
}

async function executeAttempt(
  config: RunnerConfig,
  cell: Cell,
  options: { signal: AbortSignal; note: string | undefined },
): Promise<AttemptResult> {
  const { model, strategy, task, runId } = cell;
  const startedAt = Date.now();

  const trace = new TraceCollector(
    config.onTraceEvent ? { onAppend: (event) => config.onTraceEvent?.(runId, event) } : {},
  );
  if (options.note) trace.append({ phase: 'runner', depth: 0, kind: 'note', text: options.note });

  const controller = new AbortController();
  const interrupt = () => controller.abort();
  options.signal.addEventListener('abort', interrupt, { once: true });
  if (options.signal.aborted) controller.abort();

  let cwd: string | undefined;
  let env: TaskEnvironment | undefined;
  let budget: BudgetTracker | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let outcome: StrategyOutcome = { finalText: '', subagentCount: 0, phases: [] };
  let strategyReturned = false;
  let stoppedBy: BudgetStopReason | undefined;
  let interrupted = false;
  let score: TaskScore | undefined;
  let runError: string | undefined;
  let agentApiError: ApiError | undefined;
  let setupMs = 0;
  let latencyMs = 0;
  let gradingMs = 0;

  let judgeCostUsd = 0;
  let judgeCalls = 0;
  let judgeFailures = 0;
  let judgeApiError: ApiError | undefined;
  let judgeInterrupted = false;
  const trackedJudge: Judge = async <T,>(
    req: JudgeRequest,
    callOptions?: JudgeCallOptions,
  ): Promise<JudgeResponse<T>> => {
    judgeCalls += 1;
    try {
      return await config.judge<T>(req, {
        ...callOptions,
        // Grading runs on the same credentials as the run itself: the live
        // demo grades a visitor's run on the visitor's key, never the operator's.
        ...(config.subprocessEnv ? { env: config.subprocessEnv } : {}),
        signal: callOptions?.signal ?? options.signal,
      }).then((reply) => {
        judgeCostUsd += reply.costUsd;
        return reply;
      });
    } catch (caught) {
      // A failed grading call is still billed.
      judgeFailures += 1;
      if (options.signal.aborted) judgeInterrupted = true;
      if (caught instanceof JudgeError) {
        judgeCostUsd += caught.costUsd;
        judgeApiError = caught.apiError ?? judgeApiError;
      }
      throw caught;
    }
  };

  try {
    cwd = await mkdtemp(path.join(tmpdir(), 'scaffoldbench-'));

    const setupStart = Date.now();
    env = await task.createEnvironment({
      cwd,
      fixtureMode: config.fixtureMode,
      fixtureDir: config.fixtureDir,
    });
    setupMs = Date.now() - setupStart;

    // The run's ceilings start with the strategy: building the world is the
    // harness's time, not the architecture's.
    budget = new BudgetTracker({
      maxCostUsd: config.maxCostUsdPerRun,
      maxWallClockMs: config.maxWallClockMsPerRun,
    });
    let timedOut = false;
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, config.maxWallClockMsPerRun);

    const ctx: RunContext = {
      runId,
      task,
      strategyId: strategy.id,
      model,
      effort: config.effort,
      env,
      cwd,
      signal: controller.signal,
      budget,
      trace,
      systemPrompt: buildSystemPrompt(task),
      ...(config.subprocessEnv ? { subprocessEnv: config.subprocessEnv } : {}),
    };

    const strategyStart = Date.now();
    try {
      outcome = await strategy.run(ctx);
      strategyReturned = true;
    } finally {
      latencyMs = Date.now() - strategyStart;
      clearTimeout(timer);
      // How the run ended is settled now, before grading: a slow judge must
      // not turn a run that finished in time into a timeout.
      stoppedBy = budget.stopReason ?? (timedOut ? 'wallclock' : undefined);
      interrupted = options.signal.aborted;
    }

    // A run that lost a call to the API is not a measurement, so grading it
    // would only spend judge money on a number nobody may use.
    agentApiError = apiErrorsOf(tracedCalls(trace.events), outcome.phases)[0];
    if (!interrupted && !agentApiError) {
      const gradingStart = Date.now();
      try {
        score = await task.score({
          env,
          outcome,
          trace: trace.events,
          deps: { judge: trackedJudge, judgeSamples: config.judgeSamples },
        });
      } finally {
        gradingMs = Date.now() - gradingStart;
      }
      if (judgeInterrupted) interrupted = true;
    }
  } catch (caught) {
    runError = caught instanceof Error ? caught.message : String(caught);
    trace.append({ phase: 'runner', depth: 0, kind: 'error', isError: true, text: runError });
  } finally {
    clearTimeout(timer);
    options.signal.removeEventListener('abort', interrupt);
    try {
      await env?.dispose?.();
    } catch {
      // Disposal problems must not mask the run's own result.
    }
    if (cwd) await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
  }

  const calls = tracedCalls(trace.events);
  // Also when the strategy threw: a run that lost a call to the API is an
  // API failure, whatever the strategy did next.
  agentApiError ??= apiErrorsOf(calls, outcome.phases)[0];
  const modelStops = modelStopsOf(calls);
  const effectiveEffort = commonEffort(
    calls.flatMap((call) => (call.end?.effectiveEffort !== undefined ? [call.end.effectiveEffort] : [])),
  );
  const judgeOutage = judgeCalls > 0 && judgeFailures >= judgeCalls;
  const apiError = agentApiError ?? (judgeOutage ? judgeApiError : undefined);

  const checks: IntegrityCheck[] = harnessChecks({
    trace: trace.events,
    phases: outcome.phases,
    ...(runError !== undefined ? { runError } : {}),
    ...(judgeCalls > 0 ? { judge: { calls: judgeCalls, failures: judgeFailures } } : {}),
  });
  if (strategyReturned && env && strategy.fidelityChecks) {
    checks.push(...fidelityChecksOf(strategy, { task, env, outcome, trace: trace.events, stoppedBy }));
  }
  const integrity = integrityOf(checks);

  const verdict = classify({
    score,
    runError,
    stoppedBy,
    apiError,
    agentApiError,
    judgeOutage,
    checks,
    modelStop: modelStops.length > 0,
    maxTurns: env ? actingCallOutOfTurns(calls, actingTools(env)) !== undefined : false,
  });

  const journal = env?.journal ?? [];
  const record: RunRecord = {
    runId,
    runSetId: config.runSetId,
    taskId: task.id,
    taskTitle: task.title,
    taskCategory: task.category,
    taskWorld: task.world,
    taskDifficulty: task.difficulty,
    strategyId: strategy.id,
    model,
    effort: config.effort,
    repeat: cell.repeat,
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date().toISOString(),
    latencyMs,
    setupMs,
    gradingMs,
    attempts: 1,
    score: round(verdict.score.score, 4),
    passed: verdict.score.passed,
    failureMode: verdict.score.failureMode,
    integrity,
    breakdown: verdict.score.breakdown,
    penalties: verdict.score.penalties,
    scoreMetadata: verdict.score.metadata ?? {},
    costUsd: round(budget?.spentUsd ?? 0, 6),
    judgeCostUsd: round(judgeCostUsd, 6),
    discardedCostUsd: 0,
    usage: budget?.usage ?? emptyUsage(),
    turns: budget?.turns ?? 0,
    toolCalls: journal.length,
    deniedToolCalls: trace.countOf('tool_denied'),
    subagentCount: outcome.subagentCount,
    phases: outcome.phases,
    finalText: outcome.finalText.slice(0, 20_000),
    ...(verdict.error !== undefined ? { error: verdict.error } : {}),
    ...(apiError ? { apiError } : {}),
    modelStops,
    ...(effectiveEffort !== undefined ? { effectiveEffort } : {}),
  };

  return {
    record,
    trace: trace.events,
    ...(apiError ? { apiError } : {}),
    interrupted,
  };
}

interface ClassifyInput {
  /** Undefined when grading never ran. */
  score: TaskScore | undefined;
  runError: string | undefined;
  stoppedBy: BudgetStopReason | undefined;
  /** The failure that makes the run an `api_error`: an agent call's, or the judge's. */
  apiError: ApiError | undefined;
  agentApiError: ApiError | undefined;
  judgeOutage: boolean;
  checks: readonly IntegrityCheck[];
  /** True when any call ended on a model stop. */
  modelStop: boolean;
  /** True when a phase acting on the task ran out of turns. */
  maxTurns: boolean;
}

/**
 * Settle a run's failure mode, most fundamental cause first: the
 * infrastructure, then the harness, then how the scorer saw the answer, then
 * the run's own limits — its ceilings, then a model that could not finish a
 * turn, then an acting phase out of turns.
 *
 * Running out of turns names the failure only in a phase acting on the task:
 * a planner that runs out of turns has lost its plan, which is a fidelity
 * problem. A model stop names it wherever it happened, because that a model
 * refused or overflowed is worth knowing in any phase: how often each
 * architecture provokes one is part of what it costs.
 */
function classify(input: ClassifyInput): { score: TaskScore; error?: string } {
  const unscored = (failureMode: FailureMode, metadata: Record<string, unknown> = {}): TaskScore => ({
    score: 0,
    passed: false,
    breakdown: input.score?.breakdown ?? [],
    penalties: input.score?.penalties ?? [],
    failureMode,
    metadata: { ...input.score?.metadata, ...metadata },
  });

  // An API failure makes the run no measurement at all. It scores 0 and its
  // integrity check fails, so it is never counted against the architecture.
  if (input.apiError) {
    const error = input.agentApiError
      ? `API error (${describeApiError(input.apiError)})`
      : `judge unavailable: ${input.apiError.message}`;
    return {
      score: unscored('api_error', input.judgeOutage ? { judgeOutage: true } : {}),
      error,
    };
  }

  if (input.runError !== undefined || !input.score) {
    return {
      score: unscored(runtimeFailure(input.stoppedBy) ?? 'harness_error'),
      error: input.runError ?? 'the run produced no score',
    };
  }

  // Every grading call failed without an API error to blame: the judge
  // answered, but never usably. The score says nothing about the answer.
  if (input.judgeOutage) {
    return {
      score: unscored('harness_error', { judgeOutage: true }),
      error: 'judge returned no usable verdict',
    };
  }

  const score = input.score;
  if (score.passed || score.failureMode !== 'wrong_answer') return { score };

  const broken = input.checks.find((check) => !check.ok && BREAKING_HARNESS_CHECKS.has(check.id));
  if (broken) {
    return {
      score: { ...score, failureMode: 'harness_error' },
      error: `harness failure (${broken.id}): ${broken.detail ?? 'see integrity'}`,
    };
  }

  const runtime = runtimeFailure(input.stoppedBy);
  if (runtime) return { score: { ...score, failureMode: runtime } };
  if (input.modelStop) return { score: { ...score, failureMode: 'model_stop' } };
  if (input.maxTurns) return { score: { ...score, failureMode: 'max_turns' } };
  return { score };
}

function runtimeFailure(stoppedBy: BudgetStopReason | undefined): FailureMode | undefined {
  if (stoppedBy === 'cost') return 'budget_exceeded';
  if (stoppedBy === 'wallclock') return 'timeout';
  return undefined;
}

/**
 * The tools that act on the task: its mutating tools, or every tool when it
 * has nothing to mutate (research). A phase holding one of these is doing
 * the work, so running out of turns there is the run's failure.
 */
function actingTools(env: TaskEnvironment): string[] {
  const mutating = env.allowedTools.filter((tool) => !env.readOnlyTools.includes(tool));
  return mutating.length > 0 ? mutating : env.allowedTools;
}

/**
 * The one effort level several reports share, `EFFORT_MIXED` when they
 * differ, or undefined when there are none.
 */
function commonEffort(levels: readonly (string | null)[]): string | null | undefined {
  return levels.every((level) => level === levels[0]) ? levels[0] : EFFORT_MIXED;
}

/** A strategy's fidelity checks, with a check of its own when they throw. */
function fidelityChecksOf(
  strategy: Strategy,
  input: Parameters<NonNullable<Strategy['fidelityChecks']>>[0],
): IntegrityCheck[] {
  try {
    return strategy.fidelityChecks?.(input) ?? [];
  } catch (error) {
    return [
      {
        id: `${strategy.id}.fidelity-checks`,
        ok: false,
        detail: `the fidelity checks threw: ${error instanceof Error ? error.message : String(error)}`,
      },
    ];
  }
}

// ---------------------------------------------------------------------------
// Retries
// ---------------------------------------------------------------------------

function retryPolicy(overrides: Partial<RetryPolicy> | undefined): RetryPolicy {
  const policy = { ...DEFAULT_RETRY_POLICY, ...overrides };
  return { ...policy, maxAttempts: Math.max(1, Math.floor(policy.maxAttempts)) };
}

/**
 * Delay before retry number `retry` (1 for the first): exponential, capped,
 * with equal jitter — half of it fixed, half random — so cells that failed
 * together on a rate limit do not all come back at the same instant.
 */
export function retryDelayMs(
  retry: number,
  policy: RetryPolicy,
  random: () => number = Math.random,
): number {
  const ceiling = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** Math.max(0, retry - 1));
  return Math.round(ceiling / 2 + (random() * ceiling) / 2);
}

/** Resolve after `ms`, or as soon as `signal` aborts. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

// ---------------------------------------------------------------------------
// Run sets on disk
// ---------------------------------------------------------------------------

/**
 * The cells of a stored run set that a resumed session should skip: every
 * recorded cell except `api_error` ones, which never measured anything and
 * are run again. Pass the result as `skipCells`.
 *
 * Records whose integrity failed are skipped like any other: running those
 * cells again until they pass would be selecting which runs to keep.
 */
export async function completedCells(
  runSetId: string,
  root: string = RESULTS_DIR,
): Promise<Set<string>> {
  assertValidRunSetId(runSetId);
  const keys = new Set<string>();
  for (const record of await readRecords(runsDir(runSetId, root))) {
    if (record.failureMode === 'api_error') continue;
    keys.add(cellKeyOf(record));
  }
  return keys;
}

/** The `cellKey` of a stored record. */
export function cellKeyOf(record: Pick<RunRecord, 'model' | 'strategyId' | 'taskId' | 'repeat'>): string {
  return cellKey({
    model: record.model,
    strategyId: record.strategyId,
    taskId: record.taskId,
    repeat: record.repeat,
  });
}

async function readRecords(dir: string): Promise<RunRecord[]> {
  const files = await listJsonFiles(dir);
  return Promise.all(files.map((file) => readJson<RunRecord>(file)));
}

/**
 * Load what the run set already holds, refusing to mix: a run set with runs
 * in it is only written to when resuming (`skipCells`), and only with the
 * settings it was measured under. A manifest whose sessions recorded nothing
 * measured nothing either, so new settings simply start the run set over.
 */
async function readExistingRunSet(
  config: RunnerConfig,
  resultsRoot: string,
): Promise<ExistingRunSet> {
  const manifest = await readJsonIfExists<RunSetManifest>(manifestPath(config.runSetId, resultsRoot));
  const records = await readRecords(runsDir(config.runSetId, resultsRoot));

  if (records.length > 0 && config.skipCells === undefined) {
    throw new Error(
      `Run set "${config.runSetId}" already holds ${records.length} run(s). Resume it (skip the ` +
        'cells it has finished, see completedCells) or choose a new run set id.',
    );
  }

  const differences = manifest ? settingDifferences(manifest, config) : [];
  if (differences.length > 0) {
    if (records.length > 0) {
      throw new Error(
        `Run set "${config.runSetId}" was measured under different settings, so it cannot be ` +
          `resumed with these: ${differences.join('; ')}.`,
      );
    }
    return { manifest: undefined, records, unrecordedUsd: 0 };
  }

  const carried = records.reduce((sum, record) => sum + (record.discardedCostUsd ?? 0), 0);
  const unrecordedUsd = Math.max(0, (manifest?.totalDiscardedCostUsd ?? 0) - carried);
  return { manifest, records, unrecordedUsd };
}

/** What makes two sessions measure the same thing. Operational settings (concurrency, budgets, retries) may differ. */
function measurementSettings(source: {
  models: readonly string[];
  strategyIds: readonly string[];
  taskIds: readonly string[];
  repeats: number;
  effort: EffortLevel;
  fixtureMode: FixtureMode;
  maxCostUsdPerRun: number;
  maxWallClockMsPerRun: number | undefined;
  judgeModel: string | null | undefined;
  judgeEffort: EffortLevel | null | undefined;
  judgeSamples: number | undefined;
}): Record<string, unknown> {
  return {
    models: source.models,
    strategies: source.strategyIds,
    tasks: source.taskIds,
    repeats: source.repeats,
    effort: source.effort,
    fixtureMode: source.fixtureMode,
    maxCostUsdPerRun: source.maxCostUsdPerRun,
    maxWallClockMsPerRun: source.maxWallClockMsPerRun,
    judgeModel: source.judgeModel,
    judgeEffort: source.judgeEffort,
    judgeSamples: source.judgeSamples,
  };
}

function settingDifferences(manifest: RunSetManifest, config: RunnerConfig): string[] {
  const judge = judgeInfoOf(config.judge);
  const before = measurementSettings({
    models: manifest.models ?? [manifest.model],
    strategyIds: manifest.strategyIds,
    taskIds: manifest.taskIds,
    repeats: manifest.repeats,
    effort: manifest.effort,
    fixtureMode: manifest.fixtureMode,
    maxCostUsdPerRun: manifest.maxCostUsdPerRun,
    maxWallClockMsPerRun: manifest.maxWallClockMsPerRun,
    judgeModel: manifest.judge?.model,
    judgeEffort: manifest.judge?.effort,
    judgeSamples: manifest.judge?.samples,
  });
  const now = measurementSettings({
    models: config.models,
    strategyIds: config.strategies.map((s) => s.id),
    taskIds: config.tasks.map((t) => t.id),
    repeats: config.repeats,
    effort: config.effort,
    fixtureMode: config.fixtureMode,
    maxCostUsdPerRun: config.maxCostUsdPerRun,
    maxWallClockMsPerRun: config.maxWallClockMsPerRun,
    judgeModel: judge?.model ?? null,
    judgeEffort: judge?.effort ?? null,
    judgeSamples: config.judgeSamples,
  });

  const differences: string[] = [];
  for (const [name, was] of Object.entries(before)) {
    // An older manifest may not have recorded a setting; it cannot conflict.
    if (was === undefined) continue;
    const is = now[name];
    if (JSON.stringify(was) !== JSON.stringify(is)) {
      differences.push(`${name} was ${JSON.stringify(was)}, now ${JSON.stringify(is)}`);
    }
  }
  return differences;
}

async function persistRun(
  config: RunnerConfig,
  resultsRoot: string,
  record: RunRecord,
  trace: readonly TraceEvent[],
): Promise<void> {
  const traceFile = path.join(tracesDir(config.runSetId, resultsRoot), `${record.runId}.jsonl`);
  await ensureDir(path.dirname(traceFile));
  await writeFile(traceFile, `${trace.map((event) => JSON.stringify(event)).join('\n')}\n`, 'utf8');
  record.traceFile = path.posix.join('traces', `${record.runId}.jsonl`);
  // The record goes last: its presence is what marks the cell as done.
  await writeJson(path.join(runsDir(config.runSetId, resultsRoot), `${record.runId}.json`), record);
}

interface ManifestInput {
  config: RunnerConfig;
  retry: RetryPolicy;
  provenance: Provenance;
  startedAt: number;
  existing: ExistingRunSet;
  matrix: readonly Cell[];
  recorded: ReadonlyMap<string, RunRecord>;
  /** Spend no record carries, this session's and earlier ones'. */
  unrecordedUsd: number;
  status: RunSetStatus;
  stoppedBy?: RunSetStopReason;
}

function buildManifest(input: ManifestInput): RunSetManifest {
  const { config, existing, recorded } = input;
  const earlier = existing.manifest;
  const judge = judgeInfoOf(config.judge);

  let totalCostUsd = 0;
  let totalJudgeCostUsd = 0;
  let totalDiscardedCostUsd = input.unrecordedUsd;
  for (const record of recorded.values()) {
    totalCostUsd += record.costUsd;
    totalJudgeCostUsd += record.judgeCostUsd;
    totalDiscardedCostUsd += record.discardedCostUsd ?? 0;
  }

  const previousSessions: ManifestSession[] = earlier
    ? [...(earlier.previousSessions ?? []), sessionOf(earlier)]
    : [];
  const sessionMs = Date.now() - input.startedAt;
  const earlierMs = previousSessions.reduce((sum, session) => sum + session.durationMs, 0);
  const finished = input.status !== 'running';

  return {
    runSetId: config.runSetId,
    createdAt: earlier?.createdAt ?? new Date(input.startedAt).toISOString(),
    startedAt: new Date(input.startedAt).toISOString(),
    ...(finished ? { finishedAt: new Date().toISOString() } : {}),
    status: input.status,
    ...(input.stoppedBy ? { stoppedBy: input.stoppedBy } : {}),
    gitSha: input.provenance.gitSha,
    model: config.models.join(', '),
    models: [...config.models],
    effort: config.effort,
    effectiveEffort: effortByModel(config.models, [...recorded.values()]),
    repeats: config.repeats,
    fixtureMode: config.fixtureMode,
    strategyIds: config.strategies.map((s) => s.id),
    taskIds: config.tasks.map((t) => t.id),
    totalRuns: input.matrix.length,
    completedRuns: input.matrix.filter((cell) => recorded.has(cell.runId)).length,
    totalCostUsd: round(totalCostUsd, 6),
    totalJudgeCostUsd: round(totalJudgeCostUsd, 6),
    totalDiscardedCostUsd: round(totalDiscardedCostUsd, 6),
    durationMs: earlierMs + sessionMs,
    maxCostUsdPerRun: config.maxCostUsdPerRun,
    maxWallClockMsPerRun: config.maxWallClockMsPerRun,
    totalBudgetUsd: config.totalBudgetUsd,
    concurrency: config.concurrency,
    judge: {
      model: judge?.model ?? null,
      effort: judge?.effort ?? null,
      samples: config.judgeSamples,
    },
    retry: input.retry,
    provenance: input.provenance,
    ...(previousSessions.length > 0 ? { previousSessions } : {}),
    ...(input.stoppedBy ? { notes: STOP_NOTES[input.stoppedBy] } : {}),
  };
}

/** Summarise an earlier session from the manifest it left behind. */
function sessionOf(manifest: RunSetManifest): ManifestSession {
  const before = (manifest.previousSessions ?? []).reduce((sum, s) => sum + s.durationMs, 0);
  return {
    startedAt: manifest.startedAt ?? manifest.createdAt,
    ...(manifest.finishedAt ? { finishedAt: manifest.finishedAt } : {}),
    ...(manifest.status ? { status: manifest.status } : {}),
    ...(manifest.stoppedBy ? { stoppedBy: manifest.stoppedBy } : {}),
    durationMs: Math.max(0, manifest.durationMs - before),
    ...(manifest.concurrency !== undefined ? { concurrency: manifest.concurrency } : {}),
    ...(manifest.provenance ? { provenance: manifest.provenance } : {}),
  };
}

/** `RunSetManifest.effectiveEffort`: each model's level, from the records that report one. */
function effortByModel(models: readonly string[], records: readonly RunRecord[]): Record<string, string | null> {
  const byModel: Record<string, string | null> = {};
  for (const model of models) {
    const level = commonEffort(
      records.flatMap((record) =>
        record.model === model && record.effectiveEffort !== undefined ? [record.effectiveEffort] : [],
      ),
    );
    if (level !== undefined) byModel[model] = level;
  }
  return byModel;
}

async function writeCatalog(config: RunnerConfig, resultsRoot: string): Promise<void> {
  const strategies: StrategyInfo[] = config.strategies.map((s) => ({
    id: s.id,
    label: s.label,
    description: s.description,
  }));
  const tasks: TaskInfo[] = config.tasks.map((t) => ({
    id: t.id,
    category: t.category,
    world: t.world,
    title: t.title,
    prompt: t.prompt,
    ...(t.policy ? { policy: t.policy } : {}),
    difficulty: t.difficulty,
    tags: t.tags,
    maxTurns: t.maxTurns,
  }));
  await writeJson(catalogPath(config.runSetId, resultsRoot), { strategies, tasks });
}

/** Everything a record's attempt cost: agent, judge and anything discarded before it. */
function spendOf(record: RunRecord): number {
  return record.costUsd + record.judgeCostUsd + (record.discardedCostUsd ?? 0);
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

