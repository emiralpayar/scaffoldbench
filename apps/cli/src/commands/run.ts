/**
 * `arena run`: the only command that spends money.
 *
 * Before the first call it prints what it is about to run, what that is
 * expected to cost (from earlier run sets) and the most it can cost; with
 * `--dry-run` it stops there. While it runs it draws the live grid on a
 * terminal and one line per run elsewhere. Ctrl-C drains, a second Ctrl-C
 * aborts, and either way the run set can be resumed.
 */

import path from 'node:path';

import {
  FIXTURES_DIR,
  RESULTS_DIR,
  cellKeyOf,
  completedCells,
  createJudge,
  listJsonFiles,
  makeRunSetId,
  manifestPath,
  readJsonIfExists,
  runMatrix,
  runSetDir,
  runsDir,
} from '@arena/core';
import type { RunRecord, RunSetManifest, Strategy, Task, TraceEvent } from '@arena/core';
import { getStrategies } from '@arena/strategies';
import { getTasks } from '@arena/tasks';

import type { RunArgs } from '../args';
import { credentialText, describeCredential } from '../env';
import { displayPath, formatBudget, formatDuration, formatUsd, plural } from '../format';
import { emptyHistory, expectedCost, loadCostHistory } from '../history';
import { createLiveState } from '../live';
import { acquireRunSetLock } from '../lock';
import {
  JUDGE_CALL_CAP_USD,
  MAX_ATTEMPTS,
  capsText,
  ceilingText,
  firstRunIdClash,
  matrixCells,
  needsConfirmation,
  resolveResume,
  spendPlan,
} from '../plan';
import { formatReport } from '../report';
import { listRunSets, loadRunSet } from '../runSet';
import type { LoadedRunSet } from '../runSet';
import { StopController, installInterruptHandlers } from '../stop';
import { LiveReporter, PlainReporter, canDrawLive } from '../terminal';
import type { Reporter } from '../terminal';
import { closest } from '../suggest';
import { buildReportView } from '../view';
import type { CliContext } from './context';

/** Exit status when the session stopped before every cell ran: total budget or rejected credentials. */
export const EXIT_STOPPED_EARLY = 2;
/** Exit status after Ctrl-C, by shell convention (128 + SIGINT). */
export const EXIT_INTERRUPTED = 130;

export async function runCommand(input: RunArgs, ctx: CliContext): Promise<number> {
  const resultsRoot = input.resultsDir ? path.resolve(ctx.cwd, input.resultsDir) : RESULTS_DIR;

  // A run set named on the command line may be in use by another process: two
  // would run the same cells and spend twice. A new, timestamped one cannot be.
  const named = input.resume ?? input.runSetId;
  const lock = input.persist && !input.dryRun && named !== undefined ? await acquireRunSetLock(resultsRoot, named) : undefined;
  if (lock && !lock.acquired) {
    ctx.fail(
      `Run set "${named}" is already being run by process ${lock.holder.pid}` +
        `${lock.holder.startedAt ? ` (started ${lock.holder.startedAt})` : ''}. Wait for it to finish, or interrupt it, ` +
        `then resume; two runs of one run set would repeat each other's cells and spend twice. If process ${lock.holder.pid} ` +
        `is not an arena run, delete ${lock.file}.`,
    );
    return 1;
  }
  try {
    return await startRun(input, ctx, resultsRoot);
  } finally {
    await lock?.release();
  }
}

async function startRun(input: RunArgs, ctx: CliContext, resultsRoot: string): Promise<number> {
  const { err, out } = ctx;

  // -- What to run ----------------------------------------------------------
  let args = input;
  let resumeNotes: string[] = [];
  // What the run set had spent before this session, so the session's own spend can be told apart.
  let earlierUsd = 0;
  if (input.resume !== undefined) {
    const id = input.resume;
    const records = await listJsonFiles(runsDir(id, resultsRoot));
    const manifest = await readJsonIfExists<RunSetManifest>(manifestPath(id, resultsRoot));
    if (!manifest && records.length === 0) {
      const known = (await listRunSets(resultsRoot)).map((entry) => entry.runSetId);
      const guess = closest(id, known);
      ctx.fail(
        `There is no run set "${id}" under ${displayPath(ctx.cwd, resultsRoot)} to resume.` +
          (guess.length > 0 ? ` Did you mean ${guess.join(' or ')}?` : ''),
      );
      return 1;
    }
    const resumed = resolveResume(input, manifest, {
      strategies: (selectors) => getStrategies(selectors).map((s) => s.id),
      tasks: (selectors) => getTasks(selectors).map((t) => t.id),
    });
    if (!resumed.ok) {
      ctx.fail(resumed.error);
      return 1;
    }
    args = resumed.args;
    resumeNotes = resumed.notes;
    if (manifest) earlierUsd = runSetSpend(manifest);
  } else if (args.runSetId !== undefined && args.persist) {
    const existing = await listJsonFiles(runsDir(args.runSetId, resultsRoot));
    if (existing.length > 0) {
      ctx.fail(
        `Run set "${args.runSetId}" already holds ${plural(existing.length, 'run')}. ` +
          `Resume it with --resume ${args.runSetId}, or choose another id.`,
      );
      return 1;
    }
  }

  let strategies: Strategy[];
  let tasks: Task[];
  try {
    strategies = getStrategies(args.strategies);
    tasks = getTasks(args.tasks);
  } catch (error) {
    ctx.fail(error instanceof Error ? error.message : String(error));
    return 1;
  }
  if (strategies.length === 0 || tasks.length === 0) {
    ctx.fail('The selection is empty: nothing to run.');
    return 1;
  }

  const runSetId = args.runSetId ?? args.resume ?? makeRunSetId();
  const cells = matrixCells(
    args.models,
    strategies.map((s) => s.id),
    tasks.map((t) => t.id),
    args.repeats,
  );
  const clash = firstRunIdClash(cells);
  if (clash) {
    ctx.fail(
      `The models ${JSON.stringify(clash[0].model)} and ${JSON.stringify(clash[1].model)} would both be recorded as ` +
        `${clash[1].runId}: file names allow only letters, digits, dots, dashes and underscores, and both spell the ` +
        'same one. List the model once.',
    );
    return 1;
  }
  const skip = args.resume !== undefined ? await completedCells(runSetId, resultsRoot) : new Set<string>();
  const pending = cells.filter((cell) => !skip.has(cell.key));
  const recorded = args.resume !== undefined ? await recordedByCell(runSetId, resultsRoot) : new Map<string, RunRecord>();

  // -- The plan -------------------------------------------------------------
  const graded = new Set(tasks.filter((task) => task.category === 'research').map((task) => task.id));
  const spendInput = {
    runs: pending.length,
    gradedRuns: pending.filter((cell) => graded.has(cell.taskId)).length,
    maxCostUsd: args.maxCostUsd,
    totalBudgetUsd: args.totalBudgetUsd,
    concurrency: args.concurrency,
    judgeSamples: args.judgeSamples,
    attempts: MAX_ATTEMPTS,
  };
  const spend = spendPlan(spendInput);
  const history = await loadCostHistory(resultsRoot).catch(() => emptyHistory());
  const expected = expectedCost(pending, history);

  const style = ctx.errStyle;
  const row = (key: string, value: string) => err(`  ${style.dim(key.padEnd(13))}${value}`);
  err(`${style.bold('ScaffoldBench')}  ${style.dim(args.dryRun ? 'dry run of' : 'run set')} ${style.accent(runSetId)}`);
  err('');
  row(args.models.length === 1 ? 'Model' : 'Models', `${args.models.join(', ')} · effort ${args.effort}`);
  row('Strategies', strategies.map((s) => s.id).join(', '));
  row('Tasks', describeList(tasks.map((t) => t.id)));
  row(
    'Matrix',
    `${plural(args.models.length, 'model')} × ${plural(strategies.length, 'strategy', 'strategies')} × ` +
      `${plural(tasks.length, 'task')} × ${plural(args.repeats, 'repeat')} = ${plural(cells.length, 'run')}` +
      (skip.size > 0 ? style.dim(` · ${skip.size} already recorded, ${pending.length} to run`) : ''),
  );
  row(
    'Judge',
    graded.size > 0
      ? `${args.judgeModel} · effort ${args.judgeEffort} · ${plural(args.judgeSamples, 'sample')} per graded run`
      : style.dim(`${args.judgeModel} (no task in this selection is graded by the judge)`),
  );
  row('Fixtures', args.fixtureMode);
  const credential = describeCredential(ctx.env, ctx.dotEnvKeys);
  row('Credentials', credential.problem ? style.bad(`${credentialText(credential)}: ${credential.problem}`) : credentialText(credential));
  row('Caps', capsText(args, spend.maxInFlight));
  row('Expected', expectedText(expected, pending.length, history.runs, style));
  row('Ceiling', ceilingText(spendInput, spend));
  row(
    'Writing to',
    args.persist
      ? `${displayPath(ctx.cwd, runSetDir(runSetId, resultsRoot))}${args.updateLatest ? ' and results/latest.json' : style.dim(' (results/latest.json left alone)')}`
      : style.dim('nothing (--no-persist)'),
  );
  for (const note of resumeNotes) err(style.dim(`  ${note}`));
  err(style.dim('  Caps are checked between model turns: a run can pass its cap by one turn of each call in flight.'));
  err(
    style.dim(
      `  A run hit by a transient API error is tried up to ${MAX_ATTEMPTS} times, each attempt with a cap of its own; ` +
        'the ceiling counts them.',
    ),
  );
  err('');

  if (args.dryRun) {
    err(style.dim('Dry run: nothing was started.'));
    return 0;
  }
  if (pending.length === 0) {
    err(`Nothing to run: every cell of ${runSetId} is recorded.`);
    return 0;
  }

  if (
    ctx.ask &&
    needsConfirmation({ interactive: true, yes: args.yes, budgetGiven: args.budgetGiven, ceilingUsd: spend.ceiling })
  ) {
    const answer = await ctx.ask(
      `This can spend up to ${formatBudget(spend.ceiling)} on the default budget. Start? [y/N] `,
    );
    if (!/^y(es)?$/i.test((answer ?? '').trim())) {
      // An abandoned question (Ctrl-C, Ctrl-D) leaves the cursor at the end of it.
      if (answer === undefined) err('');
      err(style.dim('Not started. Choose a limit with --total-budget (or pass --yes) to run without being asked.'));
      return 1;
    }
    err('');
  }

  // -- Running --------------------------------------------------------------
  const state = createLiveState({
    runSetId,
    cells,
    recorded,
    total: pending.length,
    effort: args.effort,
    budgetUsd: args.totalBudgetUsd,
    now: Date.now(),
  });
  const useLive = !args.plain && canDrawLive(ctx.stderr, ctx.env);
  const reporter: Reporter = useLive
    ? new LiveReporter(state, ctx.stderr, style)
    : new PlainReporter(state, ctx.stderr, style);

  const stop = new StopController();
  stop.onChange((stage) => reporter.onStop(stage));
  const uninstall = installInterruptHandlers(stop, {
    ...(ctx.stdin ? { input: ctx.stdin } : {}),
    signals: ctx.signals,
    onForce: () => {
      reporter.finish();
      err(style.bad('Exiting now. Runs in flight were not recorded; resume the run set to run them again.'));
      process.exit(EXIT_INTERRUPTED);
    },
  });

  const started = Date.now();
  let result;
  try {
    result = await runMatrix({
      runSetId,
      strategies,
      tasks,
      models: args.models,
      effort: args.effort,
      repeats: args.repeats,
      concurrency: args.concurrency,
      maxCostUsdPerRun: args.maxCostUsd,
      maxWallClockMsPerRun: args.maxSeconds * 1_000,
      totalBudgetUsd: args.totalBudgetUsd,
      fixtureMode: args.fixtureMode,
      fixtureDir: FIXTURES_DIR,
      judge: createJudge({ model: args.judgeModel, effort: args.judgeEffort, maxBudgetUsd: JUDGE_CALL_CAP_USD }),
      judgeSamples: args.judgeSamples,
      persist: args.persist,
      resultsRoot,
      ...(args.resume !== undefined ? { skipCells: skip } : {}),
      signal: stop.abort.signal,
      drainSignal: stop.drain.signal,
      updateLatestPointer: args.updateLatest,
      argv: ctx.argv,
      onEvent: (event) => reporter.onEvent(event),
      ...(useLive ? { onTraceEvent: (runId: string, event: TraceEvent) => reporter.onTrace?.(runId, event) } : {}),
    });
  } finally {
    reporter.finish();
    uninstall();
  }

  // -- After ----------------------------------------------------------------
  const manifest = result.manifest;
  const runSetUsd = runSetSpend(manifest);
  const sessionUsd = Math.max(0, runSetUsd - earlierUsd);
  const apiErrors = result.records.filter((record) => record.failureMode === 'api_error').length;
  // Runs that lost a call to the API measured nothing: they are neither scores nor failures of an architecture.
  const nothingMeasured = result.records.length > 0 && apiErrors === result.records.length;
  const discardedUsd = manifest.totalDiscardedCostUsd ?? 0;
  err('');
  err(
    [
      `${manifest.status === 'complete' ? style.ok('Finished') : style.warn('Stopped')}: ` +
        `${plural(result.records.length, 'run')} recorded` +
        (apiErrors > 0 ? style.bad(` (${apiErrors === result.records.length ? 'all' : apiErrors} hit an API error)`) : '') +
        ` in ${formatDuration(Date.now() - started)} this session`,
      `run set ${manifest.completedRuns} of ${manifest.totalRuns}`,
      // A resumed run set has spent more than this session did: say which is which.
      // (The discarded share is the run set's, so it is only this session's when nothing came before.)
      `spent ${formatUsd(sessionUsd)} this session` +
        (earlierUsd > 0 ? `, ${formatUsd(runSetUsd)} on the run set` : '') +
        (earlierUsd === 0 && discardedUsd > 0 ? style.dim(` (${formatUsd(discardedUsd)} of it on discarded attempts)`) : ''),
    ].join(' · '),
  );

  if (result.records.length > 0 || args.resume !== undefined) {
    const runSet: LoadedRunSet = args.persist
      ? await loadRunSet(runSetId, { root: resultsRoot, traces: true })
      : { runSetId, manifest, catalog: catalogOf(strategies, tasks), records: result.records, audits: new Map(), deniedTools: new Map() };
    out('');
    out(formatReport(buildReportView(runSet), { style: ctx.outStyle, width: ctx.width }));
  } else {
    err(style.bad('No run produced a record, so there is nothing to report.'));
  }

  err('');
  if (args.persist) {
    err(`Results in ${displayPath(ctx.cwd, runSetDir(runSetId, resultsRoot))}. Render them again with: arena report ${runSetId}`);
    if (!args.updateLatest) err(style.dim('results/latest.json, which the site shows, was left alone; --update-latest moves it.'));
  }
  if (manifest.status !== 'complete') {
    if (args.persist) err(`Resume with: arena run --resume ${runSetId}`);
    if (manifest.stoppedBy === 'signal' || manifest.stoppedBy === 'drain') return EXIT_INTERRUPTED;
    return EXIT_STOPPED_EARLY;
  }
  if (nothingMeasured) {
    err(style.bad('Nothing was measured: every run hit an API error. Check the model id and the credentials above.'));
    if (args.persist) err(`Run them again with: arena run --resume ${runSetId}`);
    return 1;
  }
  if (apiErrors > 0 && args.persist) {
    err(
      style.warn(
        `${plural(apiErrors, 'run')} hit an API error and ${apiErrors === 1 ? 'was' : 'were'} not scored. ` +
          `Run ${apiErrors === 1 ? 'it' : 'them'} again with: arena run --resume ${runSetId}`,
      ),
    );
  }
  return result.records.length > 0 ? 0 : 1;
}

/** Everything a run set has spent, as its manifest adds it up. */
function runSetSpend(manifest: RunSetManifest): number {
  return manifest.totalCostUsd + manifest.totalJudgeCostUsd + (manifest.totalDiscardedCostUsd ?? 0);
}

/** The stored records of a run set, by cell key, for drawing what earlier sessions finished. */
async function recordedByCell(runSetId: string, root: string): Promise<Map<string, RunRecord>> {
  const runSet = await loadRunSet(runSetId, { root });
  return new Map(runSet.records.map((record) => [cellKeyOf(record), record]));
}

function catalogOf(strategies: readonly Strategy[], tasks: readonly Task[]): LoadedRunSet['catalog'] {
  return {
    strategies: strategies.map(({ id, label, description }) => ({ id, label, description })),
    tasks: tasks.map((task) => ({
      id: task.id,
      category: task.category,
      world: task.world,
      title: task.title,
      prompt: task.prompt,
      ...(task.policy ? { policy: task.policy } : {}),
      difficulty: task.difficulty,
      tags: task.tags,
      maxTurns: task.maxTurns,
    })),
  };
}

function describeList(ids: readonly string[]): string {
  if (ids.length <= 4) return ids.join(', ');
  return `${ids.length}: ${ids.slice(0, 2).join(', ')}, … ${ids[ids.length - 1]}`;
}

function expectedText(
  expected: ReturnType<typeof expectedCost>,
  cells: number,
  historyRuns: number,
  style: CliContext['errStyle'],
): string {
  if (cells === 0) return formatUsd(0);
  if (historyRuns === 0) return style.dim('no earlier run sets to estimate from');
  if (expected.exact + expected.fromArm === 0) {
    return style.dim('no earlier runs of these models and strategies to estimate from');
  }
  const covered = expected.exact + expected.fromArm;
  const parts = [`${expected.exact} from their own earlier runs`];
  if (expected.fromArm > 0) parts.push(`${expected.fromArm} from the same model and strategy on other tasks`);
  const unknown = expected.unknown > 0 ? style.warn(` · ${expected.unknown} with no history, not included`) : '';
  return `~${formatUsd(expected.usd)} for ${covered} of ${plural(cells, 'run')} ${style.dim(`(${parts.join(', ')})`)}${unknown}`;
}


