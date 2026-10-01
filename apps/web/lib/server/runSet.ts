/**
 * Everything in the site that touches the filesystem.
 *
 * Kept apart from the pure modules (`format`, `derive`, `analysis`…) so a
 * client component can never pull `node:fs` into the browser bundle by
 * importing a formatter. Webpack fails the build if one tries, which is the
 * guard: nothing under `lib/server/` may be imported from a `'use client'`
 * file.
 *
 * Which run set is published is decided here, and the rule is strict about
 * fabricated data: synthetic run sets are only ever read when they are asked
 * for by name — `ARENA_DEMO=1`, or a `latest.json` that points at one — and
 * `ARENA_REQUIRE_REAL_DATA=1` (set by the GitHub Pages build) turns even an
 * explicit request into a build failure. There is no code path that falls
 * back to synthetic numbers because the real ones are missing.
 */

import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import { REPO_ROOT } from '@arena/core';
import type { TraceEvent } from '@arena/core';

import { buildCatalog, parseTraceLines } from '../derive';
import { compareModels } from '../models';
import type { Catalog, RunRecord, RunSetManifest } from '../records';
import { hasIntegrity, normalizeRecord, runSetModels } from '../records';

/** The committed run set whose traces exposed the harness bug: Act 1's evidence. */
export const POSTMORTEM_RUN_SET_ID = '2026-07-25T20-18-35Z-3fs5';

export const DEMO_RUN_SET_ID = 'demo-synthetic';

/**
 * The single route param a dynamic page exports when there is nothing to
 * list. `output: 'export'` rejects an empty `generateStaticParams`; this
 * placeholder renders the empty state instead.
 */
export const EMPTY_PARAM = '__none__';

/**
 * Next may run from the repo root or from `apps/web`, and core's `REPO_ROOT`
 * is found by package name, which a rename would break. Probe instead of
 * trusting one answer.
 */
function firstExisting(candidates: string[]): string {
  return candidates.find((candidate) => existsSync(candidate)) ?? (candidates[0] as string);
}

/** Where `npm run demo:data` writes its fabricated run set (gitignored). */
export function demoDataDir(): string {
  return firstExisting([
    path.join(REPO_ROOT, 'apps', 'web', 'demo-data'),
    path.join(process.cwd(), 'demo-data'),
    path.join(process.cwd(), 'apps', 'web', 'demo-data'),
  ]);
}

/**
 * How much the published numbers can be trusted.
 *
 * - `verified`: every record carries the fidelity verdict, so rankings can
 *   exclude runs whose architecture did not execute as designed.
 * - `unverified`: recorded before the fidelity gate existed. Shown, never
 *   promoted to a headline.
 * - `synthetic`: fabricated for interface work. Always bannered.
 */
export type Verification = 'verified' | 'unverified' | 'synthetic';

export interface RunSetData {
  runSetId: string;
  /** Absolute directory the set was read from. Server-side only; never render it. */
  dir: string;
  manifest: RunSetManifest | null;
  catalog: Catalog;
  /** Every record, normalised to current architecture ids. */
  records: RunRecord[];
  /** Models in capability order. */
  models: string[];
  verification: Verification;
}

export class SyntheticDataRefusedError extends Error {
  constructor(runSetId: string) {
    super(
      `Refusing to publish run set "${runSetId}": its manifest says it is synthetic and ` +
        'ARENA_REQUIRE_REAL_DATA is set. Point results/latest.json at a measured run set.',
    );
    this.name = 'SyntheticDataRefusedError';
  }
}

/**
 * `results/` sits at the repo root, but Next may be started from the repo root
 * or from `apps/web`. Probing beats hard-coding a relative depth, and the env
 * override lets a deployment point the site at a results tree it fetched.
 */
export function resultsRoot(): string {
  // An explicit override wins even when it does not exist: a deployment that
  // points at the wrong directory should render the empty state, not quietly
  // fall back to whatever results happen to be in the checkout.
  const override = process.env.ARENA_RESULTS_DIR;
  if (override) return path.resolve(override);
  return firstExisting([
    path.join(REPO_ROOT, 'results'),
    path.join(process.cwd(), 'results'),
    path.join(process.cwd(), '..', '..', 'results'),
  ]);
}

async function readJsonFile<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

async function readRunRecords(dir: string): Promise<RunRecord[]> {
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => path.join(dir, entry.name))
    .sort();

  const records: RunRecord[] = [];
  for (const file of files) {
    const record = await readJsonFile<RunRecord>(file);
    if (record && typeof record.runId === 'string') records.push(normalizeRecord(record));
  }
  return records;
}

/**
 * Without a `latest.json`, publish the most recently created measured run set.
 * Synthetic sets are skipped here by design, and order comes from the
 * manifest's `createdAt` rather than the directory name (a lexical sort ranks
 * `demo-…` above every timestamp).
 */
async function newestMeasuredRunSetId(root: string): Promise<string | null> {
  const entries = await readdir(root, { withFileTypes: true });
  const candidates: { id: string; createdAt: string }[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const manifest = await readJsonFile<RunSetManifest>(
      path.join(root, entry.name, 'manifest.json'),
    );
    if (!manifest || manifest.synthetic) continue;
    candidates.push({ id: entry.name, createdAt: manifest.createdAt ?? '' });
  }
  candidates.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  return candidates[0]?.id ?? null;
}

function isSafeSegment(value: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(value) && !value.startsWith('.');
}

export async function readRunSet(root: string, runSetId: string): Promise<RunSetData | null> {
  if (!isSafeSegment(runSetId)) return null;
  const dir = path.join(root, runSetId);
  if (!existsSync(dir)) return null;

  const [manifest, rawCatalog, records] = await Promise.all([
    readJsonFile<RunSetManifest>(path.join(dir, 'manifest.json')),
    readJsonFile<Partial<Catalog>>(path.join(dir, 'catalog.json')),
    readRunRecords(path.join(dir, 'runs')),
  ]);

  const verification: Verification = manifest?.synthetic
    ? 'synthetic'
    : records.length > 0 && records.every(hasIntegrity)
      ? 'verified'
      : 'unverified';

  return {
    runSetId,
    dir,
    manifest,
    catalog: buildCatalog(rawCatalog, records),
    records,
    models: runSetModels(manifest, records).sort(compareModels),
    verification,
  };
}

async function resolvePublished(): Promise<RunSetData | null> {
  if (process.env.ARENA_DEMO === '1') {
    if (process.env.ARENA_REQUIRE_REAL_DATA === '1') {
      throw new SyntheticDataRefusedError(DEMO_RUN_SET_ID);
    }
    const demo = await readRunSet(demoDataDir(), DEMO_RUN_SET_ID);
    if (!demo) {
      throw new Error(
        `ARENA_DEMO=1 but ${path.join(demoDataDir(), DEMO_RUN_SET_ID)} does not exist. ` +
          'Generate it with `npm run demo:data`.',
      );
    }
    return demo;
  }

  const root = resultsRoot();
  if (!existsSync(root)) return null;

  const pointer = await readJsonFile<{ runSetId?: string }>(path.join(root, 'latest.json'));
  const runSetId = pointer?.runSetId ?? (await newestMeasuredRunSetId(root));
  if (!runSetId) return null;

  const data = await readRunSet(root, runSetId);
  if (data?.verification === 'synthetic' && process.env.ARENA_REQUIRE_REAL_DATA === '1') {
    throw new SyntheticDataRefusedError(runSetId);
  }
  return data;
}

let cached: Promise<RunSetData | null> | undefined;

/** The published run set, or `null` when nothing has been benchmarked yet. */
export function loadRunSet(): Promise<RunSetData | null> {
  if (process.env.NODE_ENV === 'development') return resolvePublished();
  cached ??= resolvePublished();
  return cached;
}

let postmortemCached: Promise<RunSetData | null> | undefined;

/**
 * The legacy run set behind Act 1, read straight from `results/` whatever is
 * currently published. `null` when a checkout has cleared its results.
 */
export function loadPostmortemRunSet(): Promise<RunSetData | null> {
  postmortemCached ??= readRunSet(resultsRoot(), POSTMORTEM_RUN_SET_ID);
  return postmortemCached;
}

/**
 * Traces are gitignored by default, so a missing file is the normal case rather
 * than an error. `null` means "not committed"; `[]` means "committed but empty".
 */
export async function loadTrace(
  data: Pick<RunSetData, 'dir'>,
  record: RunRecord,
): Promise<TraceEvent[] | null> {
  if (!isSafeSegment(record.runId)) return null;

  const dir = data.dir;
  const relative = record.traceFile ?? path.join('traces', `${record.runId}.jsonl`);
  const file = path.resolve(dir, relative);
  if (!file.startsWith(path.resolve(dir) + path.sep)) return null;
  if (!existsSync(file)) return null;

  try {
    return parseTraceLines(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
}
