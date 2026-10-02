/**
 * The arena command line.
 *
 *   arena run [flags]        execute the matrix and score it
 *   arena report [runSetId]  render a stored run set, health first
 *   arena doctor             check this machine is ready to run
 *   arena tasks              list the task set
 *   arena strategies         list the harness architectures
 *   arena help [command]     flags and examples
 *   arena --version          version, commit and Agent SDK
 *
 * `run` is the only command that spends money, and it prints the matrix, the
 * expected spend and the most it can spend before it starts a single run.
 * Everything else is free, so the wiring can be smoke-tested without a key.
 */

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { parseArgs } from './args';
import { listStrategies, listTasks } from './commands/catalog';
import type { CliContext } from './commands/context';
import { doctorCommand } from './commands/doctor';
import { reportCommand } from './commands/report';
import { runCommand } from './commands/run';
import { versionCommand } from './commands/version';
import { loadDotEnv } from './env';
import type { DotEnv } from './env';
import { commandHelp, generalHelp } from './help';
import { styleFor } from './style';

export interface MainOptions {
  /** What loading `.env` did, so commands can say where a credential came from. */
  dotEnv?: DotEnv;
}

export async function main(argv: string[], options: MainOptions = {}): Promise<number> {
  const ctx = createContext(argv, options);
  const parsed = parseArgs(argv, process.env);

  if (!parsed.ok) {
    ctx.fail(parsed.error);
    ctx.err(ctx.errStyle.dim(`Run "arena help${parsed.topic ? ` ${parsed.topic}` : ''}" for usage.`));
    return 1;
  }

  switch (parsed.command) {
    case 'help':
      ctx.out(parsed.topic ? commandHelp(parsed.topic, ctx.outStyle, ctx.width) : generalHelp(ctx.outStyle, ctx.width));
      return 0;
    case 'version':
      return versionCommand(ctx);
    case 'tasks':
      return listTasks(ctx);
    case 'strategies':
      return listStrategies(ctx);
    case 'doctor':
      return doctorCommand(parsed.args, ctx);
    case 'report':
      return reportCommand(parsed.args, ctx);
    case 'run':
      return runCommand(parsed.args, ctx);
  }
}

function createContext(argv: readonly string[], options: MainOptions): CliContext {
  const outStyle = styleFor(process.stdout);
  const errStyle = styleFor(process.stderr);
  const columns = process.stdout.isTTY ? process.stdout.columns : undefined;
  return {
    argv,
    env: process.env,
    // `npm run` starts scripts in the repository root and records where the
    // user actually was in INIT_CWD; relative paths are theirs, not npm's.
    cwd: process.env.INIT_CWD ?? process.cwd(),
    stdout: process.stdout,
    stderr: process.stderr,
    ...(process.stdin.isTTY ? { stdin: process.stdin } : {}),
    signals: process,
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
    fail: (message) => process.stderr.write(`${errStyle.bad('error:')} ${message}\n`),
    outStyle,
    errStyle,
    width: Math.max(60, Math.min(columns ?? 100, 160)),
    dotEnvKeys: new Set(options.dotEnv?.keys ?? []),
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * True when this file is the program being run. Both sides are resolved
 * through symlinks: an npm `bin` entry is a symlink, and comparing the
 * link's path with the module's would quietly do nothing and exit 0.
 */
function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  // `arena report | head` closes the pipe early; that is the reader's choice, not an error.
  for (const stream of [process.stdout, process.stderr]) {
    stream.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EPIPE') process.exit(0);
      throw error;
    });
  }

  const loaded = loadDotEnv();
  if (loaded && 'error' in loaded) {
    process.stderr.write(`warning: could not read ${loaded.file}: ${loaded.error}\n`);
  }

  main(process.argv.slice(2), loaded && !('error' in loaded) ? { dotEnv: loaded } : {})
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
      process.exitCode = 1;
    });
}
