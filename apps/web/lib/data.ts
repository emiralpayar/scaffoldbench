/**
 * The site's whole data layer.
 *
 * Everything below `Filesystem` touches disk; everything above it is a pure
 * function over already-parsed JSON. The split is deliberate: the derivations
 * are what the pages actually depend on, and keeping them free of `fs` is what
 * lets them be tested without building a fixture tree.
 *
 * Statistics are never recomputed here. `summarizeRuns` in @arena/core owns the
 * means, the bootstrap intervals and the Pareto frontier; this module only
 * joins them to catalog metadata and shapes them for rendering.
 */

import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import { comparisonVerdict, median, paretoFrontier } from '@arena/core';
import type {
  Aggregate,
  CellSummary,
  ReportSummary,
  RunRecord,
  RunSetManifest,
  StrategyInfo,
  TaskCategory,
  TaskInfo,
  TraceEvent,
} from '@arena/core';

/** An assertion earning less than this is credit, not a pass. */
const FULL_CREDIT = 0.999;

export interface Catalog {
  strategies: StrategyInfo[];
  tasks: TaskInfo[];
}

export interface RunSetData {
  runSetId: string;
  manifest: RunSetManifest | null;
  catalog: Catalog;
  records: RunRecord[];
  summary: ReportSummary;
}

export type CategoryFilter = 'all' | TaskCategory;

export const CATEGORY_FILTERS: { id: CategoryFilter; label: string }[] = [
  { id: 'all', label: 'All tasks' },
  { id: 'tool-use', label: 'Tool use' },
  { id: 'research', label: 'Research' },
];

export function emptyCatalog(): Catalog {
  return { strategies: [], tasks: [] };
}

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

/**
 * Merge the catalog written next to the results with whatever the run records
 * mention. A run set produced by an older CLI, or hand-trimmed, can name a
 * strategy the catalog has never heard of; the site shows it rather than
 * silently dropping a measured row.
 */
export function buildCatalog(
  raw: Partial<Catalog> | null | undefined,
  records: readonly RunRecord[],
): Catalog {
  const strategies: StrategyInfo[] = Array.isArray(raw?.strategies) ? [...raw.strategies] : [];
  const tasks: TaskInfo[] = Array.isArray(raw?.tasks) ? [...raw.tasks] : [];

  const knownStrategies = new Set(strategies.map((s) => s.id));
  const knownTasks = new Set(tasks.map((t) => t.id));

  for (const record of records) {
    if (!knownStrategies.has(record.strategyId)) {
      knownStrategies.add(record.strategyId);
      strategies.push({ id: record.strategyId, label: record.strategyId, description: '' });
    }
    if (!knownTasks.has(record.taskId)) {
      knownTasks.add(record.taskId);
      tasks.push({
        id: record.taskId,
        category: record.taskCategory,
        world: record.taskWorld,
        title: record.taskTitle,
        prompt: '',
        difficulty: record.taskDifficulty,
        tags: [],
        maxTurns: 0,
      });
    }
  }

  return { strategies, tasks };
}

const DIFFICULTY_RANK: Record<TaskInfo['difficulty'], number> = { easy: 0, medium: 1, hard: 2 };
const CATEGORY_RANK: Record<TaskCategory, number> = { 'tool-use': 0, research: 1 };

/** Reading order for every task list on the site: category, world, then difficulty. */
export function sortTasks(tasks: readonly TaskInfo[]): TaskInfo[] {
  return [...tasks].sort(
    (a, b) =>
      CATEGORY_RANK[a.category] - CATEGORY_RANK[b.category] ||
      a.world.localeCompare(b.world) ||
      DIFFICULTY_RANK[a.difficulty] - DIFFICULTY_RANK[b.difficulty] ||
      a.id.localeCompare(b.id),
  );
}

export function findTask(catalog: Catalog, taskId: string): TaskInfo | undefined {
  return catalog.tasks.find((task) => task.id === taskId);
}

export function findStrategy(catalog: Catalog, strategyId: string): StrategyInfo | undefined {
  return catalog.strategies.find((strategy) => strategy.id === strategyId);
}

export function strategyLabel(catalog: Catalog, strategyId: string): string {
  return findStrategy(catalog, strategyId)?.label ?? strategyId;
}

// ---------------------------------------------------------------------------
// Leaderboard
// ---------------------------------------------------------------------------

export interface LeaderboardRow {
  rank: number;
  strategyId: string;
  label: string;
  description: string;
  runs: number;
  score: Aggregate;
  costUsd: Aggregate;
  latencyMs: Aggregate;
  passRate: number;
  scorePerDollar: number;
  totalCostUsd: number;
  onFrontier: boolean;
}

/**
 * A row with every figure already rendered to a string.
 *
 * The leaderboard's category toggle is client state, and this module reaches
 * for `node:fs`; formatting on the server keeps the interactive table free of
 * any import from here beyond the types.
 */
export interface LeaderboardRowView extends LeaderboardRow {
  scoreText: string;
  ciText: string;
  passRateText: string;
  costText: string;
  latencyText: string;
  valueText: string;
}

export interface LeaderboardViewModel {
  id: CategoryFilter;
  label: string;
  runs: number;
  taskCount: number;
  prose: string;
  rows: LeaderboardRowView[];
}

/** One view model per category tab, ready to hand to a client component. */
export function buildLeaderboardViews(
  summary: ReportSummary,
  catalog: Catalog,
  records: readonly RunRecord[],
): LeaderboardViewModel[] {
  return CATEGORY_FILTERS.map((filter) => {
    const scoped =
      filter.id === 'all' ? records : records.filter((r) => r.taskCategory === filter.id);
    const rows = buildLeaderboardRows(summary, catalog, filter.id);
    const context: FindingsContext = {
      runs: scoped.length,
      taskCount: new Set(scoped.map((r) => r.taskId)).size,
      scope: filter.id,
    };
    return {
      id: filter.id,
      label: filter.label,
      runs: context.runs,
      taskCount: context.taskCount,
      prose: describeFindings(rows, context),
      rows: rows.map((row) => ({
        ...row,
        scoreText: formatScore(row.score.mean),
        ciText: `${formatScore(row.score.ciLow)}–${formatScore(row.score.ciHigh)}`,
        passRateText: formatPercent(row.passRate),
        costText: formatUsd(row.costUsd.mean),
        latencyText: formatDuration(row.latencyMs.mean),
        valueText: row.scorePerDollar > 0 ? row.scorePerDollar.toFixed(1) : '—',
      })),
    };
  });
}

export function buildLeaderboardRows(
  summary: ReportSummary,
  catalog: Catalog,
  filter: CategoryFilter = 'all',
): LeaderboardRow[] {
  const strategies = filter === 'all' ? summary.strategies : summary.byCategory[filter];
  if (!strategies || strategies.length === 0) return [];

  // The published frontier is computed over the whole set; a category view is a
  // different plane and needs its own.
  const frontier = new Set(
    filter === 'all'
      ? summary.paretoStrategyIds
      : paretoFrontier(
          strategies,
          (s) => s.score.mean,
          (s) => s.costUsd.mean,
        ).map((s) => s.strategyId),
  );

  return [...strategies]
    .sort((a, b) => b.score.mean - a.score.mean)
    .map((strategy, index) => {
      const info = findStrategy(catalog, strategy.strategyId);
      return {
        rank: index + 1,
        strategyId: strategy.strategyId,
        label: info?.label ?? strategy.strategyId,
        description: info?.description ?? '',
        runs: strategy.runs,
        score: strategy.score,
        costUsd: strategy.costUsd,
        latencyMs: strategy.latencyMs,
        passRate: strategy.passRate,
        scorePerDollar: strategy.scorePerDollar,
        totalCostUsd: strategy.totalCostUsd,
        onFrontier: frontier.has(strategy.strategyId),
      };
    });
}

// ---------------------------------------------------------------------------
// Pareto
// ---------------------------------------------------------------------------

export interface ParetoPoint {
  strategyId: string;
  label: string;
  cost: number;
  score: number;
  ciLow: number;
  ciHigh: number;
  passRate: number;
  scorePerDollar: number;
  runs: number;
  onFrontier: boolean;
  /** Pre-rendered so the chart, which runs on the client, imports no formatter. */
  costText: string;
  scoreText: string;
  ciText: string;
  valueText: string;
}

export interface ParetoModel {
  points: ParetoPoint[];
  /** The non-dominated subset, ordered left to right so it can be drawn as a line. */
  frontier: ParetoPoint[];
  medianCost: number;
  medianScore: number;
}

export function buildParetoModel(rows: readonly LeaderboardRow[]): ParetoModel {
  const points: ParetoPoint[] = rows.map((row) => ({
    strategyId: row.strategyId,
    label: row.label,
    cost: row.costUsd.mean,
    score: row.score.mean,
    ciLow: row.score.ciLow,
    ciHigh: row.score.ciHigh,
    passRate: row.passRate,
    scorePerDollar: row.scorePerDollar,
    runs: row.runs,
    onFrontier: row.onFrontier,
    costText: formatUsd(row.costUsd.mean),
    scoreText: formatScore(row.score.mean),
    ciText: `${formatScore(row.score.ciLow)}–${formatScore(row.score.ciHigh)}`,
    valueText: row.scorePerDollar > 0 ? `${row.scorePerDollar.toFixed(1)} / $1` : '—',
  }));

  return {
    points,
    frontier: points.filter((p) => p.onFrontier).sort((a, b) => a.cost - b.cost),
    medianCost: median(points.map((p) => p.cost)),
    medianScore: median(points.map((p) => p.score)),
  };
}

// ---------------------------------------------------------------------------
// Matrix
// ---------------------------------------------------------------------------

export interface MatrixModel {
  strategies: { id: string; label: string; meanScore: number }[];
  tasks: { id: string; title: string; category: TaskCategory; difficulty: TaskInfo['difficulty']; world: string }[];
  cells: Record<string, CellSummary>;
}

export function matrixKey(strategyId: string, taskId: string): string {
  return `${strategyId}::${taskId}`;
}

export function buildMatrix(summary: ReportSummary, catalog: Catalog): MatrixModel {
  const cells: Record<string, CellSummary> = {};
  for (const cell of summary.cells) {
    cells[matrixKey(cell.strategyId, cell.taskId)] = cell;
  }

  const strategies = [...summary.strategies]
    .sort((a, b) => b.score.mean - a.score.mean)
    .map((strategy) => ({
      id: strategy.strategyId,
      label: strategyLabel(catalog, strategy.strategyId),
      meanScore: strategy.score.mean,
    }));

  const tasks = sortTasks(catalog.tasks).map((task) => ({
    id: task.id,
    title: task.title,
    category: task.category,
    difficulty: task.difficulty,
    world: task.world,
  }));

  return { strategies, tasks, cells };
}

// ---------------------------------------------------------------------------
// Task detail
// ---------------------------------------------------------------------------

export function selectRunsForTask(records: readonly RunRecord[], taskId: string): RunRecord[] {
  return records
    .filter((record) => record.taskId === taskId)
    .sort((a, b) => a.strategyId.localeCompare(b.strategyId) || a.repeat - b.repeat);
}

export interface AssertionStat {
  id: string;
  label: string;
  weight: number;
  /** Runs of this task whose breakdown contained the assertion. */
  runs: number;
  /** Runs that earned full credit. */
  passed: number;
  /** Runs that earned something but not everything. */
  partial: number;
  passRate: number;
  meanEarned: number;
}

/**
 * How often each graded assertion of a task was satisfied, across every
 * strategy and repeat. This is the view that says *which part* of a task the
 * architectures keep getting wrong, which a single mean score never can.
 */
export function assertionPassRates(
  records: readonly RunRecord[],
  taskId: string,
): AssertionStat[] {
  const order: string[] = [];
  const acc = new Map<string, { label: string; weight: number; earned: number[] }>();

  for (const record of selectRunsForTask(records, taskId)) {
    for (const item of record.breakdown) {
      let bucket = acc.get(item.id);
      if (!bucket) {
        bucket = { label: item.label, weight: item.weight, earned: [] };
        acc.set(item.id, bucket);
        order.push(item.id);
      }
      bucket.earned.push(clamp01(item.earned));
    }
  }

  return order.map((id) => {
    const bucket = acc.get(id);
    const earned = bucket?.earned ?? [];
    const passed = earned.filter((value) => value >= FULL_CREDIT).length;
    const partial = earned.filter((value) => value > 0 && value < FULL_CREDIT).length;
    const total = earned.reduce((sum, value) => sum + value, 0);
    return {
      id,
      label: bucket?.label ?? id,
      weight: bucket?.weight ?? 0,
      runs: earned.length,
      passed,
      partial,
      passRate: earned.length === 0 ? 0 : passed / earned.length,
      meanEarned: earned.length === 0 ? 0 : total / earned.length,
    };
  });
}

export function findRun(records: readonly RunRecord[], runId: string): RunRecord | undefined {
  return records.find((record) => record.runId === runId);
}

// ---------------------------------------------------------------------------
// Trace
// ---------------------------------------------------------------------------

export interface PhaseGroup {
  phase: string;
  /** Shallowest depth observed, i.e. the thread this phase belongs to. */
  depth: number;
  agent?: string;
  events: TraceEvent[];
  startMs: number;
  endMs: number;
}

/**
 * Bucket a trace into phases, keeping the order in which the phases first
 * appear. A strategy that interleaves subagents produces interleaved events;
 * grouping them makes the shape of the architecture legible while first-
 * appearance ordering keeps the timeline honest about what started when.
 */
export function groupTraceByPhase(events: readonly TraceEvent[]): PhaseGroup[] {
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  const order: string[] = [];
  const groups = new Map<string, PhaseGroup>();

  for (const event of ordered) {
    let group = groups.get(event.phase);
    if (!group) {
      group = {
        phase: event.phase,
        depth: event.depth,
        events: [],
        startMs: event.tMs,
        endMs: event.tMs,
      };
      groups.set(event.phase, group);
      order.push(event.phase);
    }
    group.events.push(event);
    group.depth = Math.min(group.depth, event.depth);
    group.startMs = Math.min(group.startMs, event.tMs);
    group.endMs = Math.max(group.endMs, event.tMs);
    if (!group.agent && event.agent) group.agent = event.agent;
  }

  return order.map((phase) => groups.get(phase)).filter((group): group is PhaseGroup => !!group);
}

export function indexToolResults(events: readonly TraceEvent[]): Record<string, TraceEvent> {
  const index: Record<string, TraceEvent> = {};
  for (const event of events) {
    if (event.kind !== 'tool_result') continue;
    if (!event.toolUseId) continue;
    index[event.toolUseId] = event;
  }
  return index;
}

export function parseTraceLines(text: string): TraceEvent[] {
  const events: TraceEvent[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed !== 'object' || parsed === null) continue;
      events.push(parsed as TraceEvent);
    } catch {
      // A truncated final line is normal for a run that was killed; the rest of
      // the trace is still worth showing.
    }
  }
  return events;
}

export interface PhaseRow {
  phase: string;
  label: string;
  depth: number;
  durationMs: number;
  costUsd: number;
  turns: number;
  toolCalls: number;
  model?: string;
  aborted: boolean;
  error?: string;
  /** True when the row was reconstructed from the trace, not recorded by the strategy. */
  derived: boolean;
}

export function buildPhaseRows(record: RunRecord, events: readonly TraceEvent[]): PhaseRow[] {
  if (record.phases.length > 0) {
    return record.phases.map((phase) => ({
      phase: phase.phase,
      label: phase.label,
      depth: 0,
      durationMs: phase.durationMs,
      costUsd: phase.costUsd,
      turns: phase.turns,
      toolCalls: phase.toolCalls,
      ...(phase.model ? { model: phase.model } : {}),
      aborted: phase.aborted,
      ...(phase.error ? { error: phase.error } : {}),
      derived: false,
    }));
  }

  return groupTraceByPhase(events).map((group) => ({
    phase: group.phase,
    label: group.phase,
    depth: group.depth,
    durationMs: group.endMs - group.startMs,
    costUsd: group.events.reduce((sum, event) => sum + (event.costUsd ?? 0), 0),
    turns: group.events.filter((event) => event.kind === 'assistant_text').length,
    toolCalls: group.events.filter((event) => event.kind === 'tool_call').length,
    aborted: group.events.some((event) => event.kind === 'error'),
    derived: true,
  }));
}

// ---------------------------------------------------------------------------
// Prose
// ---------------------------------------------------------------------------

export interface FindingsContext {
  runs: number;
  taskCount: number;
  scope: CategoryFilter;
}

/**
 * State what the table currently supports, in words, including where it does
 * not support anything. A leaderboard that only ever announces a winner
 * encourages readers to over-interpret three repeats.
 */
export function describeFindings(
  rows: readonly LeaderboardRow[],
  context: FindingsContext,
): string {
  if (rows.length === 0) {
    return 'No runs have been published for this selection yet.';
  }

  const top = rows[0];
  if (!top) return 'No runs have been published for this selection yet.';

  const scope =
    context.scope === 'all'
      ? ''
      : context.scope === 'tool-use'
        ? ' in the tool-use category'
        : ' in the research category';

  const sentences: string[] = [
    `Across ${plural(context.runs, 'run')} on ${plural(context.taskCount, 'task')}${scope}, ` +
      `${top.label} leads on mean score at ${formatScore(top.score.mean)} ` +
      `(95% CI ${formatScore(top.score.ciLow)}–${formatScore(top.score.ciHigh)}, n=${top.runs}).`,
  ];

  const challenger = rows[1];
  if (!challenger) {
    sentences.push('Only one strategy has runs here, so no comparison is possible yet.');
  } else {
    const verdict = comparisonVerdict(top.score, challenger.score);
    const delta = formatScore(top.score.mean - challenger.score.mean);
    sentences.push(
      verdict === 'inconclusive'
        ? `Its ${delta} lead over ${challenger.label} is not separable at this sample size — the confidence intervals overlap.`
        : `Its ${delta} lead over ${challenger.label} holds: the confidence intervals do not overlap.`,
    );

    let inconclusive = 0;
    let total = 0;
    for (let i = 0; i < rows.length; i++) {
      for (let j = i + 1; j < rows.length; j++) {
        const a = rows[i];
        const b = rows[j];
        if (!a || !b) continue;
        total += 1;
        if (comparisonVerdict(a.score, b.score) === 'inconclusive') inconclusive += 1;
      }
    }
    sentences.push(
      inconclusive === 0
        ? `Every one of the ${plural(total, 'pairwise comparison')} separates.`
        : `${inconclusive} of ${plural(total, 'pairwise comparison')} ${inconclusive === 1 ? 'is' : 'are'} inconclusive; the ranking below that point is noise.`,
    );
  }

  const value = [...rows]
    .filter((row) => row.costUsd.mean > 0)
    .sort((a, b) => b.scorePerDollar - a.scorePerDollar)[0];
  if (value) {
    sentences.push(
      `${value.label} returns the most score per dollar — ${value.scorePerDollar.toFixed(1)} points of score per $1, at ${formatUsd(value.costUsd.mean)} a run.`,
    );
  }

  const dominated = rows.filter((row) => !row.onFrontier);
  if (dominated.length > 0) {
    sentences.push(
      `${joinList(dominated.map((row) => row.label))} ${dominated.length === 1 ? 'is' : 'are'} dominated: something else scores at least as well for no more money.`,
    );
  }

  return sentences.join(' ');
}

function joinList(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

export function formatScore(value: number): string {
  return value.toFixed(3);
}

export function formatPercent(value: number, digits = 0): string {
  return `${(value * 100).toFixed(digits)}%`;
}

/**
 * Per-run costs live between a tenth of a cent and a few dollars, so a fixed
 * two decimals would print most of the table as `$0.00`.
 */
export function formatUsd(value: number): string {
  if (value === 0) return '$0';
  if (Math.abs(value) >= 1) return `$${value.toFixed(2)}`;
  if (Math.abs(value) >= 0.01) return `$${value.toFixed(3)}`;
  return `$${value.toFixed(4)}`;
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

export function formatInt(value: number): string {
  return Number.isFinite(value) ? Math.round(value).toLocaleString('en-US') : '—';
}

export function formatFailureMode(mode: string): string {
  return mode.replace(/_/g, ' ');
}

// ---------------------------------------------------------------------------
// Filesystem
// ---------------------------------------------------------------------------

/**
 * `results/` sits at the repo root, but Next may be started from the repo root
 * or from `apps/web`. Probing beats hard-coding a relative depth, and the env
 * override lets a deployment point the site at a results tree it fetched.
 */
export function resultsRoot(): string {
  const candidates = [
    process.env.ARENA_RESULTS_DIR,
    path.join(process.cwd(), 'results'),
    path.join(process.cwd(), '..', '..', 'results'),
    path.join(process.cwd(), '..', 'results'),
  ];
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return path.join(process.cwd(), 'results');
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
    if (record && typeof record.runId === 'string') records.push(record);
  }
  return records;
}

async function newestRunSetId(root: string): Promise<string | null> {
  const entries = await readdir(root, { withFileTypes: true });
  const dirs = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  return dirs[dirs.length - 1] ?? null;
}

async function readRunSet(): Promise<RunSetData | null> {
  // `summarizeRuns` is imported lazily so the pure half of this module stays
  // importable without pulling the aggregation code into every bundle.
  const { summarizeRuns } = await import('@arena/core');

  const root = resultsRoot();
  if (!existsSync(root)) return null;

  const pointer = await readJsonFile<{ runSetId?: string }>(path.join(root, 'latest.json'));
  const runSetId = pointer?.runSetId ?? (await newestRunSetId(root));
  if (!runSetId) return null;

  const dir = path.join(root, runSetId);
  if (!existsSync(dir)) return null;

  const [manifest, rawCatalog, records] = await Promise.all([
    readJsonFile<RunSetManifest>(path.join(dir, 'manifest.json')),
    readJsonFile<Partial<Catalog>>(path.join(dir, 'catalog.json')),
    readRunRecords(path.join(dir, 'runs')),
  ]);

  return {
    runSetId,
    manifest,
    catalog: buildCatalog(rawCatalog, records),
    records,
    summary: summarizeRuns(records),
  };
}

let cached: Promise<RunSetData | null> | undefined;

/** The published run set, or `null` when nothing has been benchmarked yet. */
export function loadRunSet(): Promise<RunSetData | null> {
  if (process.env.NODE_ENV === 'development') return readRunSet();
  cached ??= readRunSet();
  return cached;
}

export function hasResults(data: RunSetData | null): data is RunSetData {
  return !!data && data.records.length > 0;
}

/** Reject anything that could climb out of the traces directory. */
function isSafeSegment(value: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(value) && !value.startsWith('.');
}

/**
 * Traces are gitignored by default, so a missing file is the normal case rather
 * than an error. `null` means "not committed"; `[]` means "committed but empty".
 */
export async function loadTrace(
  runSetId: string,
  record: RunRecord,
): Promise<TraceEvent[] | null> {
  if (!isSafeSegment(runSetId) || !isSafeSegment(record.runId)) return null;

  const dir = path.join(resultsRoot(), runSetId);
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
