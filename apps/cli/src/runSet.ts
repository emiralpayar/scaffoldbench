/**
 * Reading run sets from disk for `report`, `run --resume` and `run --dry-run`.
 *
 * Records written before the runner checked integrity carry no `integrity`.
 * When such a record's trace is on disk, it is audited here with the
 * runner's own checks in legacy mode, so a report of an old run set says
 * what its traces say instead of passing its runs off as healthy. Without a
 * trace, the record is reported as unverified, never as ok.
 */

import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import {
  RESULTS_DIR,
  catalogPath,
  harnessChecks,
  integrityOf,
  isValidRunSetId,
  latestPointerPath,
  listJsonFiles,
  manifestPath,
  readJson,
  readJsonIfExists,
  runSetDir,
  runsDir,
} from '@arena/core';
import type {
  Integrity,
  RunRecord,
  RunSetManifest,
  StrategyInfo,
  TaskInfo,
  TraceEvent,
} from '@arena/core';

export interface Catalog {
  strategies: StrategyInfo[];
  tasks: TaskInfo[];
}

export const EMPTY_CATALOG: Catalog = { strategies: [], tasks: [] };

export interface LoadedRunSet {
  runSetId: string;
  manifest: RunSetManifest | undefined;
  catalog: Catalog;
  records: RunRecord[];
  /** Integrity re-derived from the trace, for records that predate `integrity`. */
  audits: Map<string, Integrity>;
  /** The tools the guard denied in each run, read from the traces of runs that had denials. */
  deniedTools: Map<string, string[]>;
}

export interface LoadOptions {
  root?: string;
  /**
   * Read traces where they add something: to audit records without
   * integrity, and to name the tools behind denied calls. Off for callers
   * that only need records, such as the cost history.
   */
  traces?: boolean;
}

/** The run set's records, manifest and catalog. Throws on an invalid id. */
export async function loadRunSet(runSetId: string, options: LoadOptions = {}): Promise<LoadedRunSet> {
  const root = options.root ?? RESULTS_DIR;
  const manifest = await readJsonIfExists<RunSetManifest>(manifestPath(runSetId, root));
  const catalog = (await readJsonIfExists<Catalog>(catalogPath(runSetId, root))) ?? EMPTY_CATALOG;
  const files = await listJsonFiles(runsDir(runSetId, root));
  const records = await Promise.all(files.map((file) => readJson<RunRecord>(file)));

  const audits = new Map<string, Integrity>();
  const deniedTools = new Map<string, string[]>();
  if (options.traces) {
    await Promise.all(
      records.map(async (record) => {
        if (record.integrity && record.deniedToolCalls === 0) return;
        const trace = await readTrace(runSetDir(runSetId, root), record);
        if (!trace) return;
        if (!record.integrity) audits.set(record.runId, auditLegacy(record, trace));
        const denied = trace.filter((event) => event.kind === 'tool_denied').map((e) => e.toolName ?? 'unknown');
        if (denied.length > 0) deniedTools.set(record.runId, denied);
      }),
    );
  }

  return { runSetId, manifest, catalog, records, audits, deniedTools };
}

/**
 * The runner's harness checks, run over a trace from before calls had ids.
 * The judge is not traced, so grading health cannot be audited after the fact.
 */
export function auditLegacy(record: RunRecord, trace: readonly TraceEvent[]): Integrity {
  return integrityOf(
    harnessChecks({
      trace,
      phases: record.phases,
      legacy: true,
      ...(record.failureMode === 'harness_error' && record.error ? { runError: record.error } : {}),
    }),
  );
}

async function readTrace(dir: string, record: RunRecord): Promise<TraceEvent[] | undefined> {
  const relative = record.traceFile ?? path.posix.join('traces', `${record.runId}.jsonl`);
  const file = path.resolve(dir, relative);
  // A record names its own trace file; never follow it out of the run set.
  if (!file.startsWith(path.resolve(dir) + path.sep) || !existsSync(file)) return undefined;
  const events: TraceEvent[] = [];
  for (const line of (await readFile(file, 'utf8')).split('\n')) {
    if (line.trim() === '') continue;
    try {
      events.push(JSON.parse(line) as TraceEvent);
    } catch {
      // A torn last line (the process was killed mid-write) loses only itself.
    }
  }
  return events;
}

/** The integrity that applies to a record: its own, or the audit of its trace. */
export function integrityFor(runSet: Pick<LoadedRunSet, 'audits'>, record: RunRecord): Integrity | undefined {
  return record.integrity ?? runSet.audits.get(record.runId);
}

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

export interface RunSetEntry {
  runSetId: string;
  manifest: RunSetManifest | undefined;
}

/** Every directory under `root` that looks like a run set: a valid id holding a manifest or runs. */
export async function listRunSets(root: string = RESULTS_DIR): Promise<RunSetEntry[]> {
  if (!existsSync(root)) return [];
  const entries = await readdir(root, { withFileTypes: true });
  const sets: RunSetEntry[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !isValidRunSetId(entry.name)) continue;
    const dir = path.join(root, entry.name);
    if (!existsSync(path.join(dir, 'manifest.json')) && !existsSync(path.join(dir, 'runs'))) continue;
    const manifest = await readJsonIfExists<RunSetManifest>(manifestPath(entry.name, root)).catch(
      () => undefined,
    );
    sets.push({ runSetId: entry.name, manifest });
  }
  return sets.sort((a, b) => a.runSetId.localeCompare(b.runSetId));
}

/** The run set `results/latest.json` points at, if it names a valid one. */
export async function readLatestPointer(root: string = RESULTS_DIR): Promise<string | undefined> {
  const pointer = await readJsonIfExists<{ runSetId?: unknown }>(latestPointerPath(root)).catch(
    () => undefined,
  );
  const id = pointer?.runSetId;
  return typeof id === 'string' && isValidRunSetId(id) ? id : undefined;
}
