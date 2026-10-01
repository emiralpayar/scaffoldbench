import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Locate the workspace root.
 *
 * Resolving from `import.meta.url` is the accurate answer and the one used
 * whenever it works. It cannot be the only answer: this module is imported by
 * the Next.js app, and a bundler rewrites `import.meta.url` such that the
 * `URL` handed to `fileURLToPath` comes from a different realm — the built-in
 * `instanceof URL` check then fails with the memorable "must be of type string
 * or an instance of URL. Received an instance of URL". Evaluating that at
 * module scope took the whole web build down.
 *
 * So: an explicit override wins, then the module path, then walking up from the
 * working directory looking for this workspace's package.json.
 */
function resolveRepoRoot(): string {
  const override = process.env.ARENA_REPO_ROOT;
  if (override && existsSync(override)) return override;

  try {
    const fromModule = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..');
    if (isWorkspaceRoot(fromModule)) return fromModule;
  } catch {
    // Bundled: fall through to the directory walk.
  }

  let dir = process.cwd();
  for (let depth = 0; depth < 8; depth++) {
    if (isWorkspaceRoot(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return process.cwd();
}

function isWorkspaceRoot(dir: string): boolean {
  try {
    const pkg = path.join(dir, 'package.json');
    if (!existsSync(pkg)) return false;
    const parsed = JSON.parse(readFileSync(pkg, 'utf8')) as { name?: string };
    return parsed.name === 'agent-arena';
  } catch {
    return false;
  }
}

/** Repo root, resolved from this file rather than `process.cwd()` where possible. */
export const REPO_ROOT = resolveRepoRoot();

export const RESULTS_DIR = path.join(REPO_ROOT, 'results');
export const FIXTURES_DIR = path.join(REPO_ROOT, 'fixtures');

/**
 * What a run set id may look like: a letter or digit, then letters, digits,
 * dots, dashes and underscores. The id becomes a directory under `results/`,
 * so anything that could climb out of it (`../`, an absolute path, a
 * separator) is refused rather than resolved.
 */
const RUN_SET_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

export function isValidRunSetId(runSetId: string): boolean {
  return RUN_SET_ID.test(runSetId);
}

export function assertValidRunSetId(runSetId: string): void {
  if (!isValidRunSetId(runSetId)) {
    throw new Error(
      `Invalid run set id ${JSON.stringify(runSetId)}: use up to 100 letters, digits, dots, ` +
        'dashes and underscores, starting with a letter or digit.',
    );
  }
}

/**
 * Every path helper takes an optional root so a run set can be written
 * somewhere other than `results/` — used by the integration tests and by the
 * live demo, which must never touch published results.
 *
 * Every run-set path goes through here, so an id that could climb out of the
 * root is refused for reading as well as for writing.
 */
export function runSetDir(runSetId: string, root: string = RESULTS_DIR): string {
  assertValidRunSetId(runSetId);
  return path.join(root, runSetId);
}

export function runsDir(runSetId: string, root: string = RESULTS_DIR): string {
  return path.join(runSetDir(runSetId, root), 'runs');
}

export function tracesDir(runSetId: string, root: string = RESULTS_DIR): string {
  return path.join(runSetDir(runSetId, root), 'traces');
}

export function manifestPath(runSetId: string, root: string = RESULTS_DIR): string {
  return path.join(runSetDir(runSetId, root), 'manifest.json');
}

export function catalogPath(runSetId: string, root: string = RESULTS_DIR): string {
  return path.join(runSetDir(runSetId, root), 'catalog.json');
}

export function latestPointerPath(root: string = RESULTS_DIR): string {
  return path.join(root, 'latest.json');
}

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

/**
 * Write JSON atomically: to a temporary file beside the target, then renamed
 * over it. A run set is read while it is being written — the manifest is
 * rewritten after every run, and a resumed session reads every record — so a
 * reader must never see half a file, not even when the writer is killed.
 */
export async function writeJson(file: string, value: unknown): Promise<void> {
  await ensureDir(path.dirname(file));
  const temporary = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, 'utf8')) as T;
}

export async function readJsonIfExists<T>(file: string): Promise<T | undefined> {
  if (!existsSync(file)) return undefined;
  return readJson<T>(file);
}

export async function listJsonFiles(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => path.join(dir, entry.name))
    .sort();
}

/** `2026-07-25T14-03-02Z-a1b2` — sorts chronologically and stays unique. */
export function makeRunSetId(now: Date = new Date(), suffix?: string): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-').replace(/-\d{3}Z$/, 'Z');
  return `${stamp}-${suffix ?? Math.random().toString(36).slice(2, 6)}`;
}

/** The coordinates of one cell of the matrix. */
export interface CellCoordinates {
  model: string;
  strategyId: string;
  taskId: string;
  repeat: number;
}

/**
 * `claude-sonnet-5-5__single__airline-easy__r1`, unique within a run set.
 *
 * Also the file name of the cell's record and trace, so the model id is
 * reduced to filename- and URL-safe characters: ids such as
 * `claude-opus-4-6[1m]` exist.
 */
export function makeRunId(cell: CellCoordinates): string {
  const model = cell.model.replace(/[^A-Za-z0-9._-]+/g, '-');
  return `${model}__${cell.strategyId}__${cell.taskId}__r${cell.repeat}`;
}

/**
 * `model|strategy|task|repeat`: identifies a cell regardless of how its run id
 * was spelled, which is what resuming a run set matches on.
 */
export function cellKey(cell: CellCoordinates): string {
  return `${cell.model}|${cell.strategyId}|${cell.taskId}|${cell.repeat}`;
}
