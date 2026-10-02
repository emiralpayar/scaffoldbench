import type { KeyInput, SignalSource } from '../stop';
import type { Style } from '../style';
import type { OutputStream } from '../terminal';

/**
 * What a command needs from the process, gathered once by `main`. Data goes
 * to stdout and everything about the session (plans, progress, warnings,
 * errors) to stderr, so `arena report > report.txt` captures the report and
 * nothing else.
 */
export interface CliContext {
  /** The command line after the script name, recorded in manifests. */
  argv: readonly string[];
  env: NodeJS.ProcessEnv;
  /** Where the user typed the command; `npm run` moves the process to the repository root. */
  cwd: string;
  stdout: OutputStream;
  stderr: OutputStream;
  stdin?: KeyInput;
  /** Where SIGINT, SIGTERM and SIGHUP arrive: the process, or a stand-in in tests. */
  signals: SignalSource;
  out(line: string): void;
  err(line: string): void;
  /** An error message on stderr, in red when colour is on. */
  fail(message: string): void;
  outStyle: Style;
  errStyle: Style;
  /** Columns to lay stdout out for. */
  width: number;
  /** Variables `.env` supplied. */
  dotEnvKeys: ReadonlySet<string>;
}
