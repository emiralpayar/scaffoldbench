/**
 * Dependency-free argument parsing for the arena CLI.
 *
 * The parser never exits the process and never touches the filesystem: it maps
 * an argv array plus an environment onto either a typed command or a typed
 * error. Everything that decides how much money a run can spend is decided
 * here, which is exactly why it has to be testable without a terminal.
 */

import type { EffortLevel, FixtureMode } from '@arena/core';

export const EFFORT_LEVELS: readonly EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];

export const DEFAULT_MODEL = 'claude-opus-5';
/**
 * Grading is a single tool-less structured-output call against a fixed rubric.
 * A cheaper model is used by default so judge spend stays a rounding error next
 * to the runs it grades; `--judge-model` overrides it.
 */
export const DEFAULT_JUDGE_MODEL = 'claude-sonnet-5';

export const DEFAULT_REPEATS = 3;
export const DEFAULT_EFFORT: EffortLevel = 'high';
export const DEFAULT_CONCURRENCY = 4;
export const DEFAULT_MAX_COST_USD = 1.0;
export const DEFAULT_MAX_SECONDS = 600;
export const DEFAULT_TOTAL_BUDGET_USD = 25;
export const DEFAULT_JUDGE_SAMPLES = 3;
export const DEFAULT_FIXTURE_MODE: FixtureMode = 'replay';

export interface RunArgs {
  strategies: string[];
  tasks: string[];
  repeats: number;
  model: string;
  effort: EffortLevel;
  concurrency: number;
  /** Ceiling for a single run, enforced by the budget ledger. */
  maxCostUsd: number;
  /** Wall-clock ceiling for a single run. */
  maxSeconds: number;
  /** Ceiling for the whole matrix; remaining cells are skipped once hit. */
  totalBudgetUsd: number;
  judgeModel: string;
  judgeSamples: number;
  fixtureMode: FixtureMode;
  /** Explicit run set id; a timestamped one is generated when absent. */
  runSetId?: string;
  persist: boolean;
}

export interface ReportArgs {
  /** Absent means "whatever results/latest.json points at". */
  runSetId?: string;
  markdown: boolean;
}

export type ParsedCommand =
  | { ok: true; command: 'run'; args: RunArgs }
  | { ok: true; command: 'report'; args: ReportArgs }
  | { ok: true; command: 'tasks' }
  | { ok: true; command: 'strategies' }
  | { ok: true; command: 'help' }
  | { ok: false; error: string };

type FlagKind = 'value' | 'boolean';

const RUN_FLAGS: Record<string, FlagKind> = {
  strategies: 'value',
  tasks: 'value',
  repeats: 'value',
  model: 'value',
  effort: 'value',
  concurrency: 'value',
  'max-cost': 'value',
  'max-seconds': 'value',
  'total-budget': 'value',
  'judge-model': 'value',
  'judge-samples': 'value',
  'run-set': 'value',
  record: 'boolean',
  replay: 'boolean',
  live: 'boolean',
  'no-persist': 'boolean',
};

const REPORT_FLAGS: Record<string, FlagKind> = {
  'run-set': 'value',
  markdown: 'boolean',
};

const NO_FLAGS: Record<string, FlagKind> = {};

const COMMAND_FLAGS: Record<string, Record<string, FlagKind>> = {
  run: RUN_FLAGS,
  report: REPORT_FLAGS,
  tasks: NO_FLAGS,
  strategies: NO_FLAGS,
};

const KNOWN_FLAGS = new Set([...Object.keys(RUN_FLAGS), ...Object.keys(REPORT_FLAGS)]);

export const USAGE = `arena — measure agent harness architectures on the same task set

USAGE
  arena run [flags]              Execute the strategy x task matrix and score it
  arena report [runSetId]        Render a stored run set (defaults to results/latest.json)
  arena tasks                    List the available tasks
  arena strategies               List the available harness architectures
  arena --help                   Show this message

RUN FLAGS
  --strategies <ids>       Comma-separated strategy ids, or "all"          (default: all)
  --tasks <selectors>      Comma-separated ids, worlds, categories, globs  (default: all)
  --repeats <n>            Runs per strategy x task cell                   (default: ${DEFAULT_REPEATS})
  --model <id>             Model under test, or $ARENA_MODEL               (default: ${DEFAULT_MODEL})
  --effort <level>         ${EFFORT_LEVELS.join(' | ')}                   (default: ${DEFAULT_EFFORT})
  --concurrency <n>        Runs executed in parallel                       (default: ${DEFAULT_CONCURRENCY})
  --max-cost <usd>         Cost ceiling for ONE run, or $ARENA_MAX_COST_USD (default: ${DEFAULT_MAX_COST_USD})
  --max-seconds <s>        Wall-clock ceiling for ONE run                  (default: ${DEFAULT_MAX_SECONDS})
  --total-budget <usd>     Cost ceiling for the whole matrix               (default: ${DEFAULT_TOTAL_BUDGET_USD})
  --judge-model <id>       Model used for rubric grading                   (default: ${DEFAULT_JUDGE_MODEL})
  --judge-samples <n>      Independent grades per run, reduced by median   (default: ${DEFAULT_JUDGE_SAMPLES})
  --replay | --record | --live
                           Web fixture mode for research tasks             (default: ${DEFAULT_FIXTURE_MODE})
  --run-set <id>           Write under this run set id instead of a new one
  --no-persist             Score everything but write nothing to results/

REPORT FLAGS
  --markdown               Also write results/<runSetId>/REPORT.md

EXAMPLES
  arena tasks
  arena run --strategies single,plan-execute --tasks airline-* --repeats 2
  arena run --tasks research --record --total-budget 5
  arena report --markdown`;

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): ParsedCommand {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    return { ok: true, command: 'help' };
  }

  const command = argv[0];
  if (command === undefined) return { ok: true, command: 'help' };

  const spec = COMMAND_FLAGS[command];
  if (spec === undefined) {
    return {
      ok: false,
      error: `Unknown command: ${command}. Expected one of: ${Object.keys(COMMAND_FLAGS).join(', ')}.`,
    };
  }

  const collected = collect(argv.slice(1), spec, command);
  if ('error' in collected) return { ok: false, error: collected.error };

  if (command === 'tasks' || command === 'strategies') {
    return (
      rejectPositionals(collected.positionals, command) ?? { ok: true, command }
    );
  }
  if (command === 'report') return parseReport(collected);
  return parseRun(collected, env);
}

interface Collected {
  flags: Map<string, string[]>;
  positionals: string[];
}

function collect(
  tokens: string[],
  spec: Record<string, FlagKind>,
  command: string,
): Collected | { error: string } {
  const flags = new Map<string, string[]>();
  const positionals: string[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === undefined) continue;

    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }

    const body = token.slice(2);
    const eq = body.indexOf('=');
    const name = eq === -1 ? body : body.slice(0, eq);
    const inline = eq === -1 ? undefined : body.slice(eq + 1);

    const kind = spec[name];
    if (kind === undefined) {
      return {
        error: KNOWN_FLAGS.has(name)
          ? `--${name} is not a flag of the "${command}" command.`
          : `Unknown flag: --${name}`,
      };
    }

    if (kind === 'boolean') {
      if (inline !== undefined) return { error: `--${name} does not take a value.` };
      append(flags, name, '');
      continue;
    }

    let value = inline;
    if (value === undefined) {
      const next = tokens[i + 1];
      if (next === undefined || next.startsWith('--')) {
        return { error: `--${name} needs a value.` };
      }
      value = next;
      i += 1;
    }
    append(flags, name, value);
  }

  return { flags, positionals };
}

function append(flags: Map<string, string[]>, name: string, value: string): void {
  const existing = flags.get(name);
  if (existing) existing.push(value);
  else flags.set(name, [value]);
}

function rejectPositionals(positionals: string[], command: string): ParsedCommand | undefined {
  const extra = positionals[0];
  if (extra === undefined) return undefined;
  return { ok: false, error: `The "${command}" command takes no arguments, but got: ${extra}` };
}

function parseReport(collected: Collected): ParsedCommand {
  const positional = collected.positionals[0];
  if (collected.positionals.length > 1) {
    return { ok: false, error: 'Expected at most one run set id.' };
  }
  const fromFlag = last(collected.flags, 'run-set');
  if (positional !== undefined && fromFlag !== undefined && positional !== fromFlag) {
    return { ok: false, error: 'Two different run set ids were given.' };
  }

  return {
    ok: true,
    command: 'report',
    args: { runSetId: positional ?? fromFlag, markdown: collected.flags.has('markdown') },
  };
}

function parseRun(collected: Collected, env: NodeJS.ProcessEnv): ParsedCommand {
  const extra = collected.positionals[0];
  if (extra !== undefined) {
    return { ok: false, error: `Unexpected argument: ${extra}. Did you mean --tasks ${extra}?` };
  }

  const { flags } = collected;
  const errors: string[] = [];

  const fixtureFlags = (['record', 'replay', 'live'] as const).filter((name) => flags.has(name));
  if (fixtureFlags.length > 1) {
    errors.push(
      `Choose at most one fixture mode, but got: ${fixtureFlags.map((f) => `--${f}`).join(', ')}.`,
    );
  }
  const fixtureMode: FixtureMode = fixtureFlags[0] ?? DEFAULT_FIXTURE_MODE;

  const envMaxCost = numberFromEnv(env, 'ARENA_MAX_COST_USD', errors);

  const args: RunArgs = {
    strategies: list(flags, 'strategies', ['all']),
    tasks: list(flags, 'tasks', ['all']),
    repeats: integer(flags, 'repeats', DEFAULT_REPEATS, 1, errors),
    model: last(flags, 'model') ?? env.ARENA_MODEL?.trim() ?? DEFAULT_MODEL,
    effort: effort(flags, errors),
    concurrency: integer(flags, 'concurrency', DEFAULT_CONCURRENCY, 1, errors),
    maxCostUsd: positive(flags, 'max-cost', envMaxCost ?? DEFAULT_MAX_COST_USD, errors),
    maxSeconds: positive(flags, 'max-seconds', DEFAULT_MAX_SECONDS, errors),
    totalBudgetUsd: positive(flags, 'total-budget', DEFAULT_TOTAL_BUDGET_USD, errors),
    judgeModel: last(flags, 'judge-model') ?? env.ARENA_JUDGE_MODEL?.trim() ?? DEFAULT_JUDGE_MODEL,
    judgeSamples: integer(flags, 'judge-samples', DEFAULT_JUDGE_SAMPLES, 1, errors),
    fixtureMode,
    runSetId: last(flags, 'run-set'),
    persist: !flags.has('no-persist'),
  };

  if (errors.length > 0) return { ok: false, error: errors.join('\n') };

  return { ok: true, command: 'run', args };
}

function last(flags: Map<string, string[]>, name: string): string | undefined {
  const values = flags.get(name);
  if (values === undefined) return undefined;
  return values[values.length - 1];
}

/** List flags accumulate, so `--tasks a --tasks b` and `--tasks a,b` agree. */
function list(flags: Map<string, string[]>, name: string, fallback: string[]): string[] {
  const values = flags.get(name);
  if (values === undefined) return fallback;
  const items = values
    .flatMap((value) => value.split(','))
    .map((item) => item.trim())
    .filter((item) => item !== '');
  return items.length > 0 ? items : fallback;
}

function number(
  flags: Map<string, string[]>,
  name: string,
  fallback: number,
  errors: string[],
): number | undefined {
  const raw = last(flags, name);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    errors.push(`--${name} expects a number, but got: ${raw}`);
    return undefined;
  }
  return parsed;
}

function integer(
  flags: Map<string, string[]>,
  name: string,
  fallback: number,
  min: number,
  errors: string[],
): number {
  const parsed = number(flags, name, fallback, errors);
  if (parsed === undefined) return fallback;
  if (!Number.isInteger(parsed) || parsed < min) {
    errors.push(`--${name} expects a whole number of at least ${min}, but got: ${parsed}`);
    return fallback;
  }
  return parsed;
}

function positive(
  flags: Map<string, string[]>,
  name: string,
  fallback: number,
  errors: string[],
): number {
  const parsed = number(flags, name, fallback, errors);
  if (parsed === undefined) return fallback;
  if (parsed <= 0) {
    errors.push(`--${name} expects a value greater than zero, but got: ${parsed}`);
    return fallback;
  }
  return parsed;
}

function effort(flags: Map<string, string[]>, errors: string[]): EffortLevel {
  const raw = last(flags, 'effort');
  if (raw === undefined) return DEFAULT_EFFORT;
  const candidate = raw.trim().toLowerCase();
  if (!(EFFORT_LEVELS as readonly string[]).includes(candidate)) {
    errors.push(`--effort expects one of ${EFFORT_LEVELS.join(', ')}, but got: ${raw}`);
    return DEFAULT_EFFORT;
  }
  return candidate as EffortLevel;
}

/**
 * A malformed budget variable is reported rather than ignored: silently falling
 * back to the default is how someone ends up with a bill they did not agree to.
 */
function numberFromEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  errors: string[],
): number | undefined {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    errors.push(`${name} must be a positive number, but is: ${raw}`);
    return undefined;
  }
  return parsed;
}
