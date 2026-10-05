/**
 * Dependency-free argument parsing for the scaffoldbench CLI.
 *
 * The parser never exits the process and never touches the filesystem: it maps
 * an argv array plus an environment onto either a typed command or a typed
 * error. Everything that decides how much money a run can spend is decided
 * here, which is exactly why it has to be testable without a terminal.
 *
 * The flag tables below are also the source of the help text, so a flag
 * cannot exist without being documented, nor be documented without existing.
 */

import { isValidRunSetId } from '@scaffoldbench/core';
import type { EffortLevel, FixtureMode } from '@scaffoldbench/core';

import { closest } from './suggest';

export const EFFORT_LEVELS: readonly EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];

export const DEFAULT_MODEL = 'claude-sonnet-5-5';
/**
 * Grading is a single tool-less structured-output call against a fixed
 * rubric, taken `--judge-samples` times. It runs on the same mid-tier model
 * by default so a sweep over cheaper models is not graded by a weaker judge.
 */
export const DEFAULT_JUDGE_MODEL = 'claude-sonnet-5-5';
/** Matches `DEFAULT_JUDGE_EFFORT` in core: pinned, so grading costs the same on any model. */
export const DEFAULT_JUDGE_EFFORT: EffortLevel = 'medium';

export const DEFAULT_REPEATS = 3;
/**
 * Far above any sensible study (a pre-registered one uses a handful) and far
 * below what the cell list would need gigabytes to hold: a typo such as
 * `--repeats 100000` is refused instead of being planned.
 */
export const MAX_REPEATS = 100;
export const DEFAULT_EFFORT: EffortLevel = 'high';
export const DEFAULT_CONCURRENCY = 4;
export const MAX_CONCURRENCY = 32;
export const DEFAULT_MAX_COST_USD = 1.0;
export const DEFAULT_MAX_SECONDS = 600;
/**
 * A day. The runner arms one timer per run, and Node fires a timer set beyond
 * 2^31 ms (24.8 days) after 1 ms instead, which would time out every run at
 * once: "no limit" has to be a big number, not an enormous one.
 */
export const MAX_SECONDS = 86_400;
export const DEFAULT_TOTAL_BUDGET_USD = 25;
/**
 * On a terminal, a run whose ceiling is above this asks before it starts,
 * unless the budget was chosen on the command line (see `needsConfirmation`).
 */
export const CONFIRM_ABOVE_USD = 5;
export const DEFAULT_JUDGE_SAMPLES = 3;
export const DEFAULT_FIXTURE_MODE: FixtureMode = 'replay';

/** Settings that define what a run set measures; a resumed run set keeps its own. */
export type MeasurementSetting =
  | 'strategies'
  | 'tasks'
  | 'models'
  | 'repeats'
  | 'effort'
  | 'fixtureMode'
  | 'maxCostUsd'
  | 'maxSeconds'
  | 'judgeModel'
  | 'judgeEffort'
  | 'judgeSamples';

export interface RunArgs {
  strategies: string[];
  tasks: string[];
  /** Models under test, a matrix dimension like strategies and tasks. */
  models: string[];
  repeats: number;
  effort: EffortLevel;
  concurrency: number;
  /** Ceiling for a single run, enforced by the budget ledger. */
  maxCostUsd: number;
  /** Wall-clock ceiling for a single run. */
  maxSeconds: number;
  /** Ceiling for this session; a run starts only when its cap still fits. */
  totalBudgetUsd: number;
  judgeModel: string;
  judgeEffort: EffortLevel;
  judgeSamples: number;
  fixtureMode: FixtureMode;
  /** Explicit run set id; a timestamped one is generated when absent. */
  runSetId?: string;
  /** Run set to resume: only its missing cells run, under its own settings. */
  resume?: string;
  /**
   * Models planned into the run set whose cells this session leaves for a
   * later `--resume`: one run set measured in sessions split by model, decided
   * up front rather than by any outcome.
   */
  deferModels: string[];
  /** Results root, when not the repository's `results/`. */
  resultsDir?: string;
  persist: boolean;
  /** Print the plan and the expected spend, then stop. */
  dryRun: boolean;
  /** Point `results/latest.json`, which the site renders, at this run set. */
  updateLatest: boolean;
  /** Line-per-run output even on a terminal. */
  plain: boolean;
  /** Start without asking, whatever the run could cost. */
  yes: boolean;
  /** `--total-budget` was typed: a limit someone chose rather than the default. */
  budgetGiven: boolean;
  /** Measurement settings set by a flag, which a resume must not contradict. */
  explicit: ReadonlySet<MeasurementSetting>;
}

export interface ReportArgs {
  /** Absent means "whatever results/latest.json points at". */
  runSetId?: string;
  markdown: boolean;
  /** Exit 3 unless the run set is fit to publish. */
  strict: boolean;
  resultsDir?: string;
}

export type WiringMode = 'none' | 'init' | 'live';

export interface DoctorArgs {
  wiring: WiringMode;
}

export type CommandName = 'run' | 'report' | 'doctor' | 'tasks' | 'strategies' | 'help' | 'version';

export type ParsedCommand =
  | { ok: true; command: 'run'; args: RunArgs }
  | { ok: true; command: 'report'; args: ReportArgs }
  | { ok: true; command: 'doctor'; args: DoctorArgs }
  | { ok: true; command: 'tasks' }
  | { ok: true; command: 'strategies' }
  | { ok: true; command: 'help'; topic?: CommandName }
  | { ok: true; command: 'version' }
  | { ok: false; error: string; topic?: CommandName };

// ---------------------------------------------------------------------------
// Flag tables
// ---------------------------------------------------------------------------

export interface FlagSpec {
  name: string;
  kind: 'value' | 'boolean';
  /** Placeholder for the value in help, e.g. `<ids>`. */
  value?: string;
  help: string;
  /** Shown as `(default: …)` in help. */
  fallback?: string;
  /** Another flag this one is spelled the same as, e.g. `--model` for `--models`. */
  aliasOf?: string;
}

export interface CommandSpec {
  name: CommandName;
  synopsis: string;
  summary: string;
  flags: FlagSpec[];
  examples: string[];
  /** Extra paragraphs printed after the flags. */
  notes?: string[];
}

const money = (usd: number) => `$${usd.toFixed(2)}`;

const RUN_FLAGS: FlagSpec[] = [
  { name: 'strategies', kind: 'value', value: '<ids>', help: 'Comma-separated strategy ids, or "all"', fallback: 'all' },
  {
    name: 'tasks',
    kind: 'value',
    value: '<selectors>',
    help: 'Task ids, worlds, categories or globs such as airline-*',
    fallback: 'all',
  },
  {
    name: 'models',
    kind: 'value',
    value: '<ids>',
    help: 'Models under test, comma-separated, or $SCAFFOLDBENCH_MODEL',
    fallback: DEFAULT_MODEL,
  },
  { name: 'model', kind: 'value', value: '<id>', help: 'Same as --models', aliasOf: 'models' },
  {
    name: 'defer-models',
    kind: 'value',
    value: '<ids>',
    help: 'Plan these models into the run set but run none of their cells now; --resume runs them later',
  },
  {
    name: 'repeats',
    kind: 'value',
    value: '<n>',
    help: `Runs per model x strategy x task cell, at most ${MAX_REPEATS}`,
    fallback: String(DEFAULT_REPEATS),
  },
  { name: 'effort', kind: 'value', value: '<level>', help: EFFORT_LEVELS.join(' | '), fallback: DEFAULT_EFFORT },
  { name: 'concurrency', kind: 'value', value: '<n>', help: `Runs in flight at once, at most ${MAX_CONCURRENCY}`, fallback: String(DEFAULT_CONCURRENCY) },
  {
    name: 'max-cost',
    kind: 'value',
    value: '<usd>',
    help: 'Cost ceiling for ONE run, or $SCAFFOLDBENCH_MAX_COST_USD',
    fallback: money(DEFAULT_MAX_COST_USD),
  },
  {
    name: 'max-seconds',
    kind: 'value',
    value: '<s>',
    help: `Wall-clock ceiling for ONE run, at most ${MAX_SECONDS}`,
    fallback: String(DEFAULT_MAX_SECONDS),
  },
  {
    name: 'total-budget',
    kind: 'value',
    value: '<usd>',
    help: 'Ceiling for the session: a run starts only if its cap still fits',
    fallback: money(DEFAULT_TOTAL_BUDGET_USD),
  },
  {
    name: 'judge-model',
    kind: 'value',
    value: '<id>',
    help: 'Model that grades research answers, or $SCAFFOLDBENCH_JUDGE_MODEL',
    fallback: DEFAULT_JUDGE_MODEL,
  },
  { name: 'judge-effort', kind: 'value', value: '<level>', help: 'Effort of each grading call', fallback: DEFAULT_JUDGE_EFFORT },
  {
    name: 'judge-samples',
    kind: 'value',
    value: '<n>',
    help: 'Independent grades per run, reduced by median',
    fallback: String(DEFAULT_JUDGE_SAMPLES),
  },
  { name: 'replay', kind: 'boolean', help: 'Fixture mode kept in the manifest; research tasks always read the frozen corpus', fallback: 'on' },
  { name: 'record', kind: 'boolean', help: 'Like --replay: the frozen corpus is the only web, so there is nothing to record' },
  { name: 'live', kind: 'boolean', help: 'Like --replay: no run touches the network' },
  { name: 'run-set', kind: 'value', value: '<id>', help: 'Name the new run set instead of a timestamp' },
  { name: 'resume', kind: 'value', value: '<id>', help: 'Run only the cells a stored run set is missing' },
  {
    name: 'results-dir',
    kind: 'value',
    value: '<dir>',
    help: 'Results root, or $SCAFFOLDBENCH_RESULTS_DIR',
    fallback: 'results/',
  },
  { name: 'update-latest', kind: 'boolean', help: 'Point results/latest.json (what the site shows) here' },
  { name: 'no-persist', kind: 'boolean', help: 'Score everything but write nothing' },
  { name: 'dry-run', kind: 'boolean', help: 'Print the plan and the expected spend, then stop' },
  { name: 'plain', kind: 'boolean', help: 'One line per run, even on a terminal' },
  { name: 'yes', kind: 'boolean', help: 'Never ask before starting; see the note on asking below' },
];

const REPORT_FLAGS: FlagSpec[] = [
  { name: 'run-set', kind: 'value', value: '<id>', help: 'Same as the positional run set id' },
  { name: 'markdown', kind: 'boolean', help: 'Also write <run set>/REPORT.md' },
  {
    name: 'strict',
    kind: 'boolean',
    help: 'Exit 3 unless the run set is complete and every run is healthy',
  },
  {
    name: 'results-dir',
    kind: 'value',
    value: '<dir>',
    help: 'Results root, or $SCAFFOLDBENCH_RESULTS_DIR',
    fallback: 'results/',
  },
];

const DOCTOR_FLAGS: FlagSpec[] = [
  {
    name: 'wiring',
    kind: 'boolean',
    help: 'Also start the wiring canary: 4 SDK sessions that cannot reach the API (free)',
  },
  {
    name: 'wiring-live',
    kind: 'boolean',
    help: 'Run the canary for real on Haiku: structured output, concurrent tools (~$0.02)',
  },
];

export const COMMANDS: readonly CommandSpec[] = [
  {
    name: 'run',
    synopsis: 'scaffoldbench run [flags]',
    summary: 'Run the model x strategy x task matrix and score it',
    flags: RUN_FLAGS,
    examples: [
      'scaffoldbench run --strategies single,plan-execute --tasks airline-* --repeats 2',
      'scaffoldbench run --models claude-haiku-4-5-20251001,claude-sonnet-5-5 --tasks support --dry-run',
      'scaffoldbench run --resume 2026-10-02T09-14-03Z-k2p9',
    ],
    notes: [
      `On a terminal, a run that can cost more than ${money(CONFIRM_ABOVE_USD)} and uses the default --total-budget asks before it starts. Typing --total-budget (or --yes) is the answer; scripts and pipes are never asked.`,
      'Ctrl-C once stops starting runs and lets the runs in flight finish and be recorded; Ctrl-C again aborts them. Either way the manifest says the run set was interrupted, and --resume picks it up.',
      'Exit status: 0 every cell ran · 1 usage or setup error, a start declined at the prompt, no run recorded, or nothing measured (every run hit an API error) · 2 stopped early (total budget, rejected credentials, spent usage limit) · 130 interrupted. Runs that failed their integrity checks do not change it: "scaffoldbench report --strict" is the gate for that.',
    ],
  },
  {
    name: 'report',
    synopsis: 'scaffoldbench report [runSetId] [flags]',
    summary: 'Render a stored run set (defaults to results/latest.json)',
    flags: REPORT_FLAGS,
    examples: ['scaffoldbench report', 'scaffoldbench report 2026-07-25T20-18-35Z-3fs5 --markdown', 'scaffoldbench report <id> --strict'],
  },
  {
    name: 'doctor',
    synopsis: 'scaffoldbench doctor [flags]',
    summary: 'Check this machine is ready to run the benchmark',
    flags: DOCTOR_FLAGS,
    examples: ['scaffoldbench doctor', 'scaffoldbench doctor --wiring'],
  },
  { name: 'tasks', synopsis: 'scaffoldbench tasks', summary: 'List the task set', flags: [], examples: [] },
  { name: 'strategies', synopsis: 'scaffoldbench strategies', summary: 'List the harness architectures', flags: [], examples: [] },
  { name: 'help', synopsis: 'scaffoldbench help [command]', summary: 'Show help for a command', flags: [], examples: [] },
  { name: 'version', synopsis: 'scaffoldbench --version', summary: 'Print the version, commit and SDK', flags: [], examples: [] },
];

export function commandSpec(name: CommandName): CommandSpec {
  const spec = COMMANDS.find((command) => command.name === name);
  if (!spec) throw new Error(`no such command: ${name}`);
  return spec;
}

const COMMAND_NAMES = COMMANDS.map((command) => command.name);

function isCommandName(name: string): name is CommandName {
  return (COMMAND_NAMES as readonly string[]).includes(name);
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

export function parseArgs(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): ParsedCommand {
  const first = argv[0];
  if (first === undefined || first === '--help' || first === '-h') return { ok: true, command: 'help' };
  if (first === '--version' || first === '-v' || first === '-V') return { ok: true, command: 'version' };

  if (!isCommandName(first)) {
    const guess = closest(first, COMMAND_NAMES);
    return {
      ok: false,
      error:
        `Unknown command: ${first}.` +
        (guess.length > 0 ? ` Did you mean ${guess.join(' or ')}?` : ` Commands: ${COMMAND_NAMES.join(', ')}.`),
    };
  }

  const rest = argv.slice(1);
  if (first === 'help') {
    const topic = rest[0];
    if (topic === undefined) return { ok: true, command: 'help' };
    if (!isCommandName(topic) || rest.length > 1) {
      const guess = closest(topic, COMMAND_NAMES);
      return {
        ok: false,
        error: `No help for "${rest.join(' ')}".${guess.length > 0 ? ` Did you mean ${guess.join(' or ')}?` : ''}`,
      };
    }
    return { ok: true, command: 'help', topic };
  }
  if (rest.includes('--help') || rest.includes('-h')) return { ok: true, command: 'help', topic: first };
  if (first === 'version') {
    return rest.length === 0 ? { ok: true, command: 'version' } : unexpected(rest[0] ?? '', first);
  }

  const spec = commandSpec(first);
  const collected = collect(rest, spec);
  if ('error' in collected) return { ok: false, error: collected.error, topic: first };

  switch (first) {
    case 'tasks':
    case 'strategies':
      return collected.positionals.length > 0
        ? unexpected(collected.positionals[0] ?? '', first)
        : { ok: true, command: first };
    case 'report':
      return parseReport(collected, env);
    case 'doctor':
      return parseDoctor(collected);
    default:
      return parseRun(collected, env);
  }
}

function unexpected(token: string, command: CommandName): ParsedCommand {
  return { ok: false, error: `The "${command}" command takes no arguments, but got: ${token}`, topic: command };
}

interface Collected {
  flags: Map<string, string[]>;
  positionals: string[];
}

function collect(tokens: readonly string[], spec: CommandSpec): Collected | { error: string } {
  const flags = new Map<string, string[]>();
  const positionals: string[] = [];
  const known = new Map(spec.flags.map((flag) => [flag.name, flag]));

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === undefined) continue;

    if (token === '--') {
      positionals.push(...tokens.slice(i + 1));
      break;
    }
    if (!token.startsWith('-') || token === '-') {
      positionals.push(token);
      continue;
    }
    if (!token.startsWith('--')) {
      return {
        error: `Unknown flag: ${token}. Flags are spelled out in full; see "scaffoldbench help ${spec.name}".`,
      };
    }

    const body = token.slice(2);
    const eq = body.indexOf('=');
    const name = eq === -1 ? body : body.slice(0, eq);
    const inline = eq === -1 ? undefined : body.slice(eq + 1);

    const flag = known.get(name);
    if (flag === undefined) return { error: unknownFlag(name, spec) };

    const key = flag.aliasOf ?? flag.name;
    if (flag.kind === 'boolean') {
      if (inline !== undefined) return { error: `--${name} does not take a value.` };
      append(flags, key, '');
      continue;
    }

    let value = inline;
    if (value === undefined) {
      const next = tokens[i + 1];
      if (next === undefined || (next.startsWith('--') && next.length > 2)) {
        return { error: `--${name} needs a value${flag.value ? ` ${flag.value}` : ''}.` };
      }
      value = next;
      i += 1;
    }
    append(flags, key, value);
  }

  return { flags, positionals };
}

function unknownFlag(name: string, spec: CommandSpec): string {
  const elsewhere = COMMANDS.find(
    (command) => command.name !== spec.name && command.flags.some((flag) => flag.name === name),
  );
  if (elsewhere) return `--${name} is not a flag of the "${spec.name}" command (it belongs to "${elsewhere.name}").`;
  const guess = closest(
    name,
    spec.flags.map((flag) => flag.name),
  );
  return `Unknown flag: --${name}.${guess.length > 0 ? ` Did you mean ${guess.map((g) => `--${g}`).join(' or ')}?` : ''}`;
}

function append(flags: Map<string, string[]>, name: string, value: string): void {
  const existing = flags.get(name);
  if (existing) existing.push(value);
  else flags.set(name, [value]);
}

function last(flags: Map<string, string[]>, name: string): string | undefined {
  const values = flags.get(name);
  return values === undefined ? undefined : values[values.length - 1];
}

// ---------------------------------------------------------------------------
// report / doctor
// ---------------------------------------------------------------------------

function parseReport(collected: Collected, env: NodeJS.ProcessEnv): ParsedCommand {
  const fail = (error: string): ParsedCommand => ({ ok: false, error, topic: 'report' });
  if (collected.positionals.length > 1) return fail('Expected at most one run set id.');
  const positional = collected.positionals[0];
  const fromFlag = last(collected.flags, 'run-set');
  if (positional !== undefined && fromFlag !== undefined && positional !== fromFlag) {
    return fail('Two different run set ids were given.');
  }
  const runSetId = positional ?? fromFlag;
  if (runSetId !== undefined && !isValidRunSetId(runSetId)) return fail(invalidRunSetId(runSetId));

  const resultsDir = resultsDirOf(collected.flags, env);
  if (resultsDir === '') return fail('--results-dir needs a directory.');
  return {
    ok: true,
    command: 'report',
    args: {
      ...(runSetId !== undefined ? { runSetId } : {}),
      markdown: collected.flags.has('markdown'),
      strict: collected.flags.has('strict'),
      ...(resultsDir !== undefined ? { resultsDir } : {}),
    },
  };
}

function parseDoctor(collected: Collected): ParsedCommand {
  if (collected.positionals.length > 0) return unexpected(collected.positionals[0] ?? '', 'doctor');
  const wiring: WiringMode = collected.flags.has('wiring-live')
    ? 'live'
    : collected.flags.has('wiring')
      ? 'init'
      : 'none';
  return { ok: true, command: 'doctor', args: { wiring } };
}

function invalidRunSetId(id: string): string {
  return (
    `Invalid run set id ${JSON.stringify(id)}: use up to 100 letters, digits, dots, dashes and ` +
    'underscores, starting with a letter or digit.'
  );
}

/** `--results-dir`, else `$SCAFFOLDBENCH_RESULTS_DIR` (which the site reads too); '' when given empty. */
function resultsDirOf(flags: Map<string, string[]>, env: NodeJS.ProcessEnv): string | undefined {
  const fromFlag = last(flags, 'results-dir');
  if (fromFlag !== undefined) return fromFlag.trim();
  const fromEnv = env.SCAFFOLDBENCH_RESULTS_DIR?.trim();
  return fromEnv ? fromEnv : undefined;
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

function parseRun(collected: Collected, env: NodeJS.ProcessEnv): ParsedCommand {
  const extra = collected.positionals[0];
  if (extra !== undefined) {
    return { ok: false, error: `Unexpected argument: ${extra}. Did you mean --tasks ${extra}?`, topic: 'run' };
  }

  const { flags } = collected;
  const errors: string[] = [];
  const explicit = new Set<MeasurementSetting>();
  const given = (flag: string, setting: MeasurementSetting) => {
    if (flags.has(flag)) explicit.add(setting);
  };
  given('strategies', 'strategies');
  given('tasks', 'tasks');
  given('models', 'models');
  given('repeats', 'repeats');
  given('effort', 'effort');
  given('max-cost', 'maxCostUsd');
  given('max-seconds', 'maxSeconds');
  given('judge-model', 'judgeModel');
  given('judge-effort', 'judgeEffort');
  given('judge-samples', 'judgeSamples');

  const fixtureFlags = (['record', 'replay', 'live'] as const).filter((name) => flags.has(name));
  if (fixtureFlags.length > 1) {
    errors.push(`Choose at most one fixture mode, but got: ${fixtureFlags.map((f) => `--${f}`).join(', ')}.`);
  }
  if (fixtureFlags.length > 0) explicit.add('fixtureMode');
  const fixtureMode: FixtureMode = fixtureFlags[0] ?? DEFAULT_FIXTURE_MODE;

  const envMaxCost = moneyFromEnv(env, 'SCAFFOLDBENCH_MAX_COST_USD', errors);
  const envModels = listFromEnv(env, 'SCAFFOLDBENCH_MODEL');
  const envJudge = env.SCAFFOLDBENCH_JUDGE_MODEL?.trim();

  const runSetId = last(flags, 'run-set');
  const resume = last(flags, 'resume');
  for (const [flag, id] of [
    ['run-set', runSetId],
    ['resume', resume],
  ] as const) {
    if (id !== undefined && !isValidRunSetId(id)) errors.push(`--${flag}: ${invalidRunSetId(id)}`);
  }
  if (runSetId !== undefined && resume !== undefined && runSetId !== resume) {
    errors.push('--run-set and --resume name different run sets; --resume alone is enough.');
  }

  const persist = !flags.has('no-persist');
  if (!persist && resume !== undefined) errors.push('--resume with --no-persist would record nothing.');
  if (!persist && flags.has('update-latest')) errors.push('--update-latest with --no-persist has nothing to point at.');

  const resultsDir = resultsDirOf(flags, env);
  if (resultsDir === '') errors.push('--results-dir needs a directory.');

  const args: RunArgs = {
    strategies: list(flags, 'strategies', ['all'], errors),
    tasks: list(flags, 'tasks', ['all'], errors),
    models: unique(list(flags, 'models', envModels.length > 0 ? envModels : [DEFAULT_MODEL], errors)),
    repeats: integer(flags, 'repeats', DEFAULT_REPEATS, 1, MAX_REPEATS, errors),
    effort: level(flags, 'effort', DEFAULT_EFFORT, errors),
    concurrency: integer(flags, 'concurrency', DEFAULT_CONCURRENCY, 1, MAX_CONCURRENCY, errors),
    maxCostUsd: positive(flags, 'max-cost', envMaxCost ?? DEFAULT_MAX_COST_USD, errors),
    maxSeconds: positive(flags, 'max-seconds', DEFAULT_MAX_SECONDS, errors, MAX_SECONDS),
    totalBudgetUsd: positive(flags, 'total-budget', DEFAULT_TOTAL_BUDGET_USD, errors),
    judgeModel: nonEmpty(flags, 'judge-model', envJudge || DEFAULT_JUDGE_MODEL, errors),
    judgeEffort: level(flags, 'judge-effort', DEFAULT_JUDGE_EFFORT, errors),
    judgeSamples: integer(flags, 'judge-samples', DEFAULT_JUDGE_SAMPLES, 1, 15, errors),
    fixtureMode,
    ...(runSetId !== undefined ? { runSetId } : {}),
    ...(resume !== undefined ? { resume } : {}),
    deferModels: unique(list(flags, 'defer-models', [], errors)),
    ...(resultsDir ? { resultsDir } : {}),
    persist,
    dryRun: flags.has('dry-run'),
    updateLatest: flags.has('update-latest'),
    plain: flags.has('plain'),
    yes: flags.has('yes'),
    budgetGiven: flags.has('total-budget'),
    explicit,
  };

  // A per-run cap above the session's budget means no run could ever start.
  // (A resumed run set keeps its own cap; that is checked once it is read.)
  if (errors.length === 0 && resume === undefined && args.maxCostUsd > args.totalBudgetUsd) {
    errors.push(
      `The per-run cap (--max-cost ${money(args.maxCostUsd)}) is above --total-budget ` +
        `${money(args.totalBudgetUsd)}: every run reserves its full cap before it starts, so no run could start.`,
    );
  }

  if (errors.length > 0) return { ok: false, error: errors.join('\n'), topic: 'run' };
  return { ok: true, command: 'run', args };
}

/**
 * List flags accumulate, so `--tasks a --tasks b` and `--tasks a,b` agree.
 * A flag that was given but selects nothing (`--tasks ""`, or `--tasks ,`
 * from an unset shell variable) is an error, not "all": in a tool that
 * spends money, an empty selection must never widen to the full matrix.
 */
function list(flags: Map<string, string[]>, name: string, fallback: string[], errors: string[]): string[] {
  const values = flags.get(name);
  if (values === undefined) return fallback;
  const items = values
    .flatMap((value) => value.split(','))
    .map((item) => item.trim())
    .filter((item) => item !== '');
  if (items.length === 0) {
    errors.push(`--${name} was given but selects nothing.`);
    return fallback;
  }
  return items;
}

function listFromEnv(env: NodeJS.ProcessEnv, name: string): string[] {
  return (env[name] ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '');
}

function unique(items: string[]): string[] {
  return [...new Set(items)];
}

function nonEmpty(flags: Map<string, string[]>, name: string, fallback: string, errors: string[]): string {
  const raw = last(flags, name);
  if (raw === undefined) return fallback;
  if (raw.trim() === '') {
    errors.push(`--${name} was given but is empty.`);
    return fallback;
  }
  return raw.trim();
}

const INTEGER = /^\d+$/;
const DECIMAL = /^(\d+(\.\d*)?|\.\d+)$/;

/** Plain decimal integers only: `1e3` and `0x10` are typos here, not numbers. */
function integer(
  flags: Map<string, string[]>,
  name: string,
  fallback: number,
  min: number,
  max: number,
  errors: string[],
): number {
  const raw = last(flags, name);
  if (raw === undefined) return fallback;
  const value = Number(raw.trim());
  if (!INTEGER.test(raw.trim()) || value < min || value > max) {
    errors.push(
      `--${name} expects a whole number ${max === Number.MAX_SAFE_INTEGER ? `of at least ${min}` : `from ${min} to ${max}`}, but got: ${raw}`,
    );
    return fallback;
  }
  return value;
}

/**
 * A decimal greater than zero. `Infinity` is what a 400-digit number parses
 * to, and a budget of infinity is not a budget.
 */
function positive(
  flags: Map<string, string[]>,
  name: string,
  fallback: number,
  errors: string[],
  max = Number.POSITIVE_INFINITY,
): number {
  const raw = last(flags, name);
  if (raw === undefined) return fallback;
  const text = raw.trim().replace(/^\$/, '');
  const value = Number(text);
  if (!DECIMAL.test(text) || !(value > 0) || !Number.isFinite(value)) {
    errors.push(`--${name} expects a number greater than zero, but got: ${raw.length > 40 ? `${raw.slice(0, 37)}...` : raw}`);
    return fallback;
  }
  if (value > max) {
    errors.push(`--${name} expects at most ${max}, but got: ${raw}`);
    return fallback;
  }
  return value;
}

function level(flags: Map<string, string[]>, name: string, fallback: EffortLevel, errors: string[]): EffortLevel {
  const raw = last(flags, name);
  if (raw === undefined) return fallback;
  const candidate = raw.trim().toLowerCase();
  if (!(EFFORT_LEVELS as readonly string[]).includes(candidate)) {
    errors.push(`--${name} expects one of ${EFFORT_LEVELS.join(', ')}, but got: ${raw}`);
    return fallback;
  }
  return candidate as EffortLevel;
}

/**
 * A malformed budget variable is reported rather than ignored: silently falling
 * back to the default is how someone ends up with a bill they did not agree to.
 * An empty one (`SCAFFOLDBENCH_MAX_COST_USD=` in a .env) is simply unset.
 */
function moneyFromEnv(env: NodeJS.ProcessEnv, name: string, errors: string[]): number | undefined {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return undefined;
  const text = raw.trim().replace(/^\$/, '');
  const value = Number(text);
  if (!DECIMAL.test(text) || !(value > 0) || !Number.isFinite(value)) {
    errors.push(`${name} must be a positive number, but is: ${raw.length > 40 ? `${raw.slice(0, 37)}...` : raw}`);
    return undefined;
  }
  return value;
}
