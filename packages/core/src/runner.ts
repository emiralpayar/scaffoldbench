import { execFile } from 'node:child_process';
import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { BudgetTracker } from './budget';
import {
  RESULTS_DIR,
  SCRATCH_DIR,
  catalogPath,
  ensureDir,
  manifestPath,
  makeRunId,
  runsDir,
  tracesDir,
  writeJson,
} from './paths';
import { buildSystemPrompt } from './systemPrompt';
import { TraceCollector } from './trace';
import type {
  EffortLevel,
  FailureMode,
  FixtureMode,
  Judge,
  JudgeRequest,
  JudgeResponse,
  RunContext,
  RunRecord,
  RunSetManifest,
  Strategy,
  StrategyInfo,
  Task,
  TaskEnvironment,
  TaskInfo,
  TaskScore,
  TraceEvent,
} from './types';

const execFileAsync = promisify(execFile);

export interface RunnerConfig {
  runSetId: string;
  strategies: Strategy[];
  tasks: Task[];
  model: string;
  effort: EffortLevel;
  repeats: number;
  concurrency: number;
  /** Ceiling for a single agent run, enforced by `BudgetTracker`. */
  maxCostUsdPerRun: number;
  maxWallClockMsPerRun: number;
  /** Ceiling for the whole matrix. Remaining cells are skipped once hit. */
  totalBudgetUsd: number;
  fixtureMode: FixtureMode;
  fixtureDir: string;
  judge: Judge;
  judgeSamples: number;
  /** When false, nothing is written to `results/` (used by the live demo). */
  persist: boolean;
  /** Overrides the results root. Defaults to the repo's `results/`. */
  resultsRoot?: string;
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
  | { type: 'run-start'; runId: string; index: number; total: number }
  | { type: 'run-end'; record: RunRecord; index: number; total: number }
  | { type: 'run-error'; runId: string; error: string }
  | { type: 'budget-stop'; spentUsd: number };

export interface RunnerResult {
  manifest: RunSetManifest;
  records: RunRecord[];
}

interface Cell {
  strategy: Strategy;
  task: Task;
  repeat: number;
}

export async function runMatrix(config: RunnerConfig): Promise<RunnerResult> {
  const startedAt = Date.now();
  const cells = buildMatrix(config);
  const records: RunRecord[] = [];
  let totalCostUsd = 0;
  let totalJudgeCostUsd = 0;
  let budgetStopped = false;

  const resultsRoot = config.resultsRoot ?? RESULTS_DIR;

  if (config.persist) {
    await ensureDir(runsDir(config.runSetId, resultsRoot));
    await ensureDir(tracesDir(config.runSetId, resultsRoot));
    await writeCatalog(config, resultsRoot);
  }

  let cursor = 0;
  const total = cells.length;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor++;
      if (index >= total) return;
      const cell = cells[index];
      if (!cell) return;

      if (totalCostUsd + totalJudgeCostUsd >= config.totalBudgetUsd) {
        if (!budgetStopped) {
          budgetStopped = true;
          config.onEvent?.({ type: 'budget-stop', spentUsd: totalCostUsd + totalJudgeCostUsd });
        }
        return;
      }

      const runId = makeRunId({
        strategyId: cell.strategy.id,
        taskId: cell.task.id,
        repeat: cell.repeat,
      });
      config.onEvent?.({ type: 'run-start', runId, index, total });

      try {
        const record = await executeRun(config, cell, runId, resultsRoot);
        records.push(record);
        totalCostUsd += record.costUsd;
        totalJudgeCostUsd += record.judgeCostUsd;
        config.onEvent?.({ type: 'run-end', record, index, total });
      } catch (error) {
        const messageText = error instanceof Error ? error.message : String(error);
        config.onEvent?.({ type: 'run-error', runId, error: messageText });
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(config.concurrency, total)) }, () => worker()),
  );

  records.sort((a, b) => a.runId.localeCompare(b.runId));

  const manifest: RunSetManifest = {
    runSetId: config.runSetId,
    createdAt: new Date(startedAt).toISOString(),
    finishedAt: new Date().toISOString(),
    gitSha: await currentGitSha(),
    model: config.model,
    effort: config.effort,
    repeats: config.repeats,
    fixtureMode: config.fixtureMode,
    strategyIds: config.strategies.map((s) => s.id),
    taskIds: config.tasks.map((t) => t.id),
    totalRuns: total,
    completedRuns: records.length,
    totalCostUsd: round(totalCostUsd, 6),
    totalJudgeCostUsd: round(totalJudgeCostUsd, 6),
    durationMs: Date.now() - startedAt,
    maxCostUsdPerRun: config.maxCostUsdPerRun,
    ...(budgetStopped ? { notes: 'Stopped early: total budget reached.' } : {}),
  };

  if (config.persist) {
    await writeJson(manifestPath(config.runSetId, resultsRoot), manifest);
  }

  return { manifest, records };
}

function buildMatrix(config: RunnerConfig): Cell[] {
  const cells: Cell[] = [];
  for (let repeat = 1; repeat <= config.repeats; repeat++) {
    for (const task of config.tasks) {
      for (const strategy of config.strategies) {
        cells.push({ strategy, task, repeat });
      }
    }
  }
  return cells;
}

async function executeRun(
  config: RunnerConfig,
  cell: Cell,
  runId: string,
  resultsRoot: string,
): Promise<RunRecord> {
  const { strategy, task, repeat } = cell;
  const startedAt = Date.now();
  const cwd = path.join(SCRATCH_DIR, config.runSetId, runId);
  await ensureDir(cwd);

  const trace = new TraceCollector(
    config.onTraceEvent
      ? { onAppend: (event) => config.onTraceEvent?.(runId, event) }
      : {},
  );
  const budget = new BudgetTracker({
    maxCostUsd: config.maxCostUsdPerRun,
    maxWallClockMs: config.maxWallClockMsPerRun,
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.maxWallClockMsPerRun);

  let env: TaskEnvironment | undefined;
  let judgeCostUsd = 0;
  let error: string | undefined;
  let score: TaskScore;
  let outcome = { finalText: '', subagentCount: 0, phases: [] as RunRecord['phases'] };

  const trackedJudge: Judge = async <T,>(req: JudgeRequest): Promise<JudgeResponse<T>> => {
    const reply = await config.judge<T>(req);
    judgeCostUsd += reply.costUsd;
    return reply;
  };

  try {
    env = await task.createEnvironment({
      cwd,
      fixtureMode: config.fixtureMode,
      fixtureDir: config.fixtureDir,
    });

    const ctx: RunContext = {
      runId,
      task,
      strategyId: strategy.id,
      model: config.model,
      effort: config.effort,
      env,
      cwd,
      signal: controller.signal,
      budget,
      trace,
      systemPrompt: buildSystemPrompt(task),
      ...(config.subprocessEnv ? { subprocessEnv: config.subprocessEnv } : {}),
    };

    outcome = await strategy.run(ctx);

    score = await task.score({
      env,
      outcome,
      trace: trace.events,
      deps: { judge: trackedJudge, judgeSamples: config.judgeSamples },
    });

    const runtimeFailure = inferRuntimeFailure(budget.stopReason, controller.signal.aborted);
    if (runtimeFailure && score.failureMode === 'wrong_answer') {
      score = { ...score, failureMode: runtimeFailure };
    }
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
    trace.append({ phase: 'runner', depth: 0, kind: 'error', isError: true, text: error });
    score = {
      score: 0,
      passed: false,
      breakdown: [],
      penalties: [],
      failureMode: inferRuntimeFailure(budget.stopReason, controller.signal.aborted) ?? 'harness_error',
      metadata: {},
    };
  } finally {
    clearTimeout(timer);
    try {
      await env?.dispose?.();
    } catch {
      // Disposal problems must not mask the run's own result.
    }
    await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
  }

  const finishedAt = Date.now();
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
    model: config.model,
    effort: config.effort,
    repeat,
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date(finishedAt).toISOString(),
    latencyMs: finishedAt - startedAt,
    score: round(score.score, 4),
    passed: score.passed,
    breakdown: score.breakdown,
    penalties: score.penalties,
    failureMode: score.failureMode,
    scoreMetadata: score.metadata ?? {},
    costUsd: round(budget.spentUsd, 6),
    judgeCostUsd: round(judgeCostUsd, 6),
    usage: budget.usage,
    turns: budget.turns,
    toolCalls: journal.length,
    deniedToolCalls: trace.countOf('tool_denied'),
    subagentCount: outcome.subagentCount,
    phases: outcome.phases,
    finalText: outcome.finalText.slice(0, 20_000),
    ...(error ? { error } : {}),
  };

  if (config.persist) {
    const traceFile = path.join(tracesDir(config.runSetId, resultsRoot), `${runId}.jsonl`);
    await ensureDir(path.dirname(traceFile));
    await writeFile(
      traceFile,
      `${trace.events.map((event) => JSON.stringify(event)).join('\n')}\n`,
      'utf8',
    );
    record.traceFile = path.posix.join('traces', `${runId}.jsonl`);
    await writeJson(path.join(runsDir(config.runSetId, resultsRoot), `${runId}.json`), record);
  }

  return record;
}

function inferRuntimeFailure(
  stopReason: 'cost' | 'wallclock' | undefined,
  aborted: boolean,
): FailureMode | undefined {
  if (stopReason === 'cost') return 'budget_exceeded';
  if (stopReason === 'wallclock') return 'timeout';
  if (aborted) return 'timeout';
  return undefined;
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
    ...(t.hypothesis ? { hypothesis: t.hypothesis } : {}),
    ...(t.traps ? { traps: t.traps } : {}),
  }));
  await writeJson(catalogPath(config.runSetId, resultsRoot), { strategies, tasks });
}

async function currentGitSha(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD']);
    return stdout.trim();
  } catch {
    return null;
  }
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
