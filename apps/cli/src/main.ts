/**
 * The arena command line.
 *
 *   arena run [flags]        execute the matrix and score it
 *   arena report [runSetId]  render a stored run set
 *   arena tasks              list the task set
 *   arena strategies         list the harness architectures
 *
 * `run` is the only command that spends money, and it prints the matrix size
 * and the worst-case spend before it starts one. `tasks` and `strategies` exist
 * so the wiring can be smoke-tested for free.
 */

import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  FIXTURES_DIR,
  RESULTS_DIR,
  catalogPath,
  createJudge,
  ensureDir,
  latestPointerPath,
  listJsonFiles,
  makeRunSetId,
  manifestPath,
  readJson,
  readJsonIfExists,
  runSetDir,
  runsDir,
  summarizeRuns,
  writeJson,
} from '@arena/core';
import type { RunRecord, RunSetManifest, RunnerEvent } from '@arena/core';
import { runMatrix } from '@arena/core';
import { STRATEGIES, getStrategies } from '@arena/strategies';
import { ALL_TASKS, getTasks } from '@arena/tasks';

import { USAGE, parseArgs } from './args';
import type { ReportArgs, RunArgs } from './args';
import {
  EMPTY_CATALOG,
  formatDuration,
  formatReport,
  formatUsd,
  toMarkdown,
} from './report';
import type { Catalog } from './report';

const WRAP_WIDTH = 96;

export async function main(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv);

  if (!parsed.ok) {
    console.error(parsed.error);
    console.error('');
    console.error(USAGE);
    return 1;
  }

  switch (parsed.command) {
    case 'help':
      console.log(USAGE);
      return 0;
    case 'tasks':
      return listTasks();
    case 'strategies':
      return listStrategies();
    case 'report':
      return reportCommand(parsed.args);
    case 'run':
      return runCommand(parsed.args);
  }
}

// ---------------------------------------------------------------------------
// arena tasks / arena strategies
// ---------------------------------------------------------------------------

function listTasks(): number {
  const idWidth = Math.max(...ALL_TASKS.map((task) => task.id.length));
  const worldWidth = Math.max(...ALL_TASKS.map((task) => task.world.length));

  console.log(`TASKS (${ALL_TASKS.length})`);
  console.log('');
  console.log(
    `  ${'ID'.padEnd(idWidth)}  ${'CATEGORY'.padEnd(9)}  ${'WORLD'.padEnd(worldWidth)}  ${'DIFFICULTY'.padEnd(10)}  TURNS  TITLE`,
  );
  for (const task of ALL_TASKS) {
    console.log(
      `  ${task.id.padEnd(idWidth)}  ${task.category.padEnd(9)}  ${task.world.padEnd(worldWidth)}  ` +
        `${task.difficulty.padEnd(10)}  ${String(task.maxTurns).padStart(5)}  ${task.title}`,
    );
  }
  console.log('');
  console.log('Select with --tasks: an id, a world, a category, a glob such as airline-*, or all.');
  return 0;
}

function listStrategies(): number {
  console.log(`STRATEGIES (${STRATEGIES.length})`);
  console.log('');
  for (const strategy of STRATEGIES) {
    console.log(`  ${strategy.id}  —  ${strategy.label}`);
    for (const line of wrap(strategy.description, WRAP_WIDTH - 6)) {
      console.log(`      ${line}`);
    }
    console.log('');
  }
  console.log('Select with --strategies: a comma-separated list of ids, or all.');
  return 0;
}

function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let current = '';
  for (const word of text.split(/\s+/)) {
    if (current === '') current = word;
    else if (current.length + 1 + word.length <= width) current = `${current} ${word}`;
    else {
      lines.push(current);
      current = word;
    }
  }
  if (current !== '') lines.push(current);
  return lines;
}

// ---------------------------------------------------------------------------
// arena run
// ---------------------------------------------------------------------------

/** True when a credential was supplied explicitly rather than inherited. */
function hasExplicitCredential(): boolean {
  return (
    (process.env.ANTHROPIC_API_KEY ?? '').trim() !== '' ||
    (process.env.ANTHROPIC_AUTH_TOKEN ?? '').trim() !== ''
  );
}

async function runCommand(args: RunArgs): Promise<number> {
  // Deliberately not a hard gate on ANTHROPIC_API_KEY. The SDK resolves
  // credentials in its own order — API key, auth token, then an interactive
  // Claude Code login on this machine — and running a local benchmark on that
  // login is ordinary developer usage. Refusing to start without an exported
  // key would reject a perfectly working setup. If nothing is available the
  // first run fails with a 401 and is recorded as such, which is a clearer
  // signal than a guess made before any request.
  if (!hasExplicitCredential()) {
    console.log('No ANTHROPIC_API_KEY set — falling back to this machine\'s Claude Code login.');
    console.log('Runs are billed to that account. Export a key to bill one explicitly.');
    console.log('');
  }

  let strategies;
  let tasks;
  try {
    strategies = getStrategies(args.strategies);
    tasks = getTasks(args.tasks);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  if (strategies.length === 0 || tasks.length === 0) {
    console.error('The selection is empty: nothing to run.');
    return 1;
  }

  const runSetId = args.runSetId ?? makeRunSetId();
  const totalRuns = strategies.length * tasks.length * args.repeats;
  const uncappedWorstCase = totalRuns * args.maxCostUsd;
  const worstCase = Math.min(uncappedWorstCase, args.totalBudgetUsd);

  console.log(`Run set        ${runSetId}`);
  console.log(`Model          ${args.model} (effort ${args.effort})`);
  console.log(`Judge          ${args.judgeModel}, ${args.judgeSamples} sample(s) per graded run`);
  console.log(`Fixtures       ${args.fixtureMode}`);
  console.log(
    `Matrix         ${strategies.length} strategies x ${tasks.length} tasks x ${args.repeats} repeats = ${totalRuns} runs`,
  );
  console.log(`Concurrency    ${args.concurrency}`);
  console.log(`Per-run cap    ${formatUsd(args.maxCostUsd)} / ${args.maxSeconds}s`);
  console.log(`Total budget   ${formatUsd(args.totalBudgetUsd)}`);
  console.log(
    `Worst case     ${formatUsd(worstCase)}` +
      (uncappedWorstCase > args.totalBudgetUsd
        ? `  (${totalRuns} x ${formatUsd(args.maxCostUsd)} = ${formatUsd(uncappedWorstCase)}, stopped at the total budget)`
        : ''),
  );
  console.log(`Persisting     ${args.persist ? runSetDir(runSetId) : 'no (--no-persist)'}`);
  console.log('');

  const idWidth = Math.max(
    ...strategies.flatMap((strategy) =>
      tasks.map(
        (task) => `${strategy.id}__${task.id}__r${args.repeats}`.length,
      ),
    ),
  );

  let completed = 0;
  const started = Date.now();

  const onEvent = (event: RunnerEvent): void => {
    switch (event.type) {
      case 'run-end': {
        completed += 1;
        const record = event.record;
        console.log(
          `[${String(completed).padStart(String(event.total).length)}/${event.total}] ` +
            `${record.runId.padEnd(idWidth)}  ` +
            `score ${record.score.toFixed(3)}  ` +
            `${formatUsd(record.costUsd).padStart(9)}  ` +
            `${formatDuration(record.latencyMs).padStart(7)}  ` +
            `${record.failureMode}`,
        );
        break;
      }
      case 'run-error':
        completed += 1;
        console.log(`[!] ${event.runId} did not produce a record: ${event.error}`);
        break;
      case 'budget-stop':
        console.log(
          `\nTotal budget reached at ${formatUsd(event.spentUsd)}. Remaining cells were skipped.`,
        );
        break;
      default:
        break;
    }
  };

  const result = await runMatrix({
    runSetId,
    strategies,
    tasks,
    models: [args.model],
    effort: args.effort,
    repeats: args.repeats,
    concurrency: args.concurrency,
    maxCostUsdPerRun: args.maxCostUsd,
    maxWallClockMsPerRun: args.maxSeconds * 1_000,
    totalBudgetUsd: args.totalBudgetUsd,
    fixtureMode: args.fixtureMode,
    fixtureDir: FIXTURES_DIR,
    judge: createJudge({ model: args.judgeModel }),
    judgeSamples: args.judgeSamples,
    persist: args.persist,
    onEvent,
  });

  console.log('');
  console.log(
    `Finished ${result.records.length} of ${result.manifest.totalRuns} runs in ${formatDuration(Date.now() - started)}.`,
  );
  console.log('');

  if (result.records.length === 0) {
    console.error('No run produced a record, so there is nothing to report.');
    return 1;
  }

  const catalog: Catalog = {
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

  console.log(formatReport(summarizeRuns(result.records), catalog, result.manifest));

  if (args.persist) {
    await writeJson(latestPointerPath(), { runSetId });
    console.log('');
    console.log(`Results written to ${runSetDir(runSetId)}`);
    console.log(`results/latest.json now points at ${runSetId}`);
    console.log(`Render it again any time with: arena report ${runSetId}`);
  }

  return 0;
}

// ---------------------------------------------------------------------------
// arena report
// ---------------------------------------------------------------------------

interface LoadedRunSet {
  manifest: RunSetManifest | undefined;
  catalog: Catalog;
  records: RunRecord[];
}

async function loadRunSet(runSetId: string, root: string = RESULTS_DIR): Promise<LoadedRunSet> {
  const manifest = await readJsonIfExists<RunSetManifest>(manifestPath(runSetId, root));
  const catalog =
    (await readJsonIfExists<Catalog>(catalogPath(runSetId, root))) ?? EMPTY_CATALOG;
  const files = await listJsonFiles(runsDir(runSetId, root));
  const records = await Promise.all(files.map((file) => readJson<RunRecord>(file)));
  return { manifest, catalog, records };
}

async function reportCommand(args: ReportArgs): Promise<number> {
  let runSetId = args.runSetId;
  if (runSetId === undefined) {
    const pointer = await readJsonIfExists<{ runSetId?: string }>(latestPointerPath());
    runSetId = pointer?.runSetId;
  }

  if (runSetId === undefined) {
    console.error('No run set was given and results/latest.json does not name one.');
    console.error('Run `arena run` first, or pass a run set id: arena report <runSetId>');
    return 1;
  }

  const { manifest, catalog, records } = await loadRunSet(runSetId);

  if (records.length === 0) {
    console.error(`No runs found for "${runSetId}" under ${runSetDir(runSetId)}.`);
    return 1;
  }

  const summary = summarizeRuns(records);
  console.log(formatReport(summary, catalog, manifest));

  if (args.markdown) {
    const target = path.join(runSetDir(runSetId), 'REPORT.md');
    await ensureDir(path.dirname(target));
    await writeFile(target, toMarkdown(summary, catalog, manifest), 'utf8');
    console.log('');
    console.log(target);
  }

  return 0;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const entry = process.argv[1];
const invokedDirectly =
  entry !== undefined && path.resolve(entry) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
      process.exitCode = 1;
    });
}
