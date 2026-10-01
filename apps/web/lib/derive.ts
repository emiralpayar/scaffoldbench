/**
 * Pure view-model derivations over already-parsed run records.
 *
 * No filesystem access here (that is `lib/server/`), so every function is
 * testable on a literal and usable from any component. Means, bootstrap
 * intervals and the Pareto frontier come from `@arena/core` (`summarizeRuns`)
 * or from `lib/analysis`; this module joins them to catalog metadata and
 * shapes them for rendering.
 */

import { comparisonVerdict, median, paretoFrontier, summarizeRuns } from '@arena/core';
import type {
  Aggregate,
  CellSummary,
  ReportSummary,
  RunRecord as CoreRunRecord,
  StrategyInfo,
  TaskCategory,
  TraceEvent,
} from '@arena/core';

import {
  architectureName,
  canonicalArchitectureId,
  compareArchitectures,
  isKnownArchitecture,
} from './architectures';
import {
  FULL_CREDIT,
  clamp01,
  formatDuration,
  formatPercent,
  formatScore,
  formatUsd,
  joinList,
  plural,
} from './format';
import type { Catalog, Difficulty, RunRecord, TaskInfo } from './records';
import { isRankable } from './records';

export type CategoryFilter = 'all' | TaskCategory;

export const CATEGORY_FILTERS: { id: CategoryFilter; label: string }[] = [
  { id: 'all', label: 'All tasks' },
  { id: 'tool-use', label: 'Tool use' },
  { id: 'research', label: 'Research' },
];

/**
 * `summarizeRuns` reads only fields both record shapes share; the cast is the
 * one place the site's contract-ahead record type meets core's current one.
 */
export function summarize(records: readonly RunRecord[]): ReportSummary {
  return summarizeRuns(records as unknown as CoreRunRecord[]);
}

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

/**
 * Merge the catalog written next to the results with whatever the run records
 * mention. A run set produced by an older CLI, or hand-trimmed, can name a
 * strategy the catalog has never heard of; the site shows it rather than
 * silently dropping a measured row. Strategy ids are mapped to their current
 * names (`debate-select` became `propose-select`).
 */
export function buildCatalog(
  raw: Partial<Catalog> | null | undefined,
  records: readonly RunRecord[],
): Catalog {
  const strategies: StrategyInfo[] = [];
  const seen = new Set<string>();
  for (const strategy of Array.isArray(raw?.strategies) ? raw.strategies : []) {
    const id = canonicalArchitectureId(strategy.id);
    if (seen.has(id)) continue;
    seen.add(id);
    strategies.push({ ...strategy, id });
  }

  const tasks: TaskInfo[] = Array.isArray(raw?.tasks) ? [...raw.tasks] : [];
  const knownTasks = new Set(tasks.map((t) => t.id));

  for (const record of records) {
    if (!seen.has(record.strategyId)) {
      seen.add(record.strategyId);
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

  strategies.sort((a, b) => compareArchitectures(a.id, b.id));
  return { strategies, tasks };
}

const DIFFICULTY_RANK: Record<Difficulty, number> = { easy: 0, medium: 1, hard: 2, expert: 3 };
const CATEGORY_RANK: Record<TaskCategory, number> = { 'tool-use': 0, research: 1 };

/** Reading order for every task list on the site: category, world, then difficulty. */
export function sortTasks(tasks: readonly TaskInfo[]): TaskInfo[] {
  return [...tasks].sort(
    (a, b) =>
      (CATEGORY_RANK[a.category] ?? 9) - (CATEGORY_RANK[b.category] ?? 9) ||
      a.world.localeCompare(b.world) ||
      (DIFFICULTY_RANK[a.difficulty] ?? 9) - (DIFFICULTY_RANK[b.difficulty] ?? 9) ||
      a.id.localeCompare(b.id),
  );
}

export function findTask(catalog: Catalog, taskId: string): TaskInfo | undefined {
  return catalog.tasks.find((task) => task.id === taskId);
}

export function findStrategy(catalog: Catalog, strategyId: string): StrategyInfo | undefined {
  return catalog.strategies.find((strategy) => strategy.id === strategyId);
}

/** The short architecture name everywhere; the catalog's label only for unknown ids. */
export function strategyLabel(catalog: Catalog, strategyId: string): string {
  if (isKnownArchitecture(strategyId)) return architectureName(strategyId);
  return findStrategy(catalog, strategyId)?.label ?? strategyId;
}

// ---------------------------------------------------------------------------
// Model scoping
// ---------------------------------------------------------------------------

/**
 * A model is a matrix dimension, so pooling records across models would
 * average Haiku with Opus. Every per-architecture view is scoped to one model.
 */
export function recordsForModel(records: readonly RunRecord[], model: string): RunRecord[] {
  return records.filter((record) => record.model === model);
}

/** The model a single-model view shows by default: the middle tier if present. */
export function defaultModel(models: readonly string[]): string | undefined {
  if (models.includes('claude-sonnet-5-5')) return 'claude-sonnet-5-5';
  return models[Math.floor((models.length - 1) / 2)];
}

// ---------------------------------------------------------------------------
// Leaderboard
// ---------------------------------------------------------------------------

export interface LeaderboardRow {
  /** Competition rank: rows with the same mean score (to 3 dp) share one. */
  rank: number;
  tied: boolean;
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
 * A row with every figure already rendered to a string, so the interactive
 * table imports no formatter it could disagree with.
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

/** One view model per category that has runs, ready to hand to a client component. */
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
  }).filter((view) => view.id === 'all' || view.rows.length > 0);
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

  // Equal means are ordered by cost, so the cheaper of two tied rows is read
  // first, and they share a rank instead of inventing an order.
  const sorted = [...strategies].sort(
    (a, b) =>
      roundScore(b.score.mean) - roundScore(a.score.mean) || a.costUsd.mean - b.costUsd.mean,
  );

  return sorted.map((strategy, index) => {
    const info = findStrategy(catalog, strategy.strategyId);
    const firstEqual = sorted.findIndex(
      (other) => roundScore(other.score.mean) === roundScore(strategy.score.mean),
    );
    const tied = sorted.some(
      (other, otherIndex) =>
        otherIndex !== index && roundScore(other.score.mean) === roundScore(strategy.score.mean),
    );
    return {
      rank: firstEqual + 1,
      tied,
      strategyId: strategy.strategyId,
      label: strategyLabel(catalog, strategy.strategyId),
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

function roundScore(value: number): number {
  return Math.round(value * 1000);
}

// ---------------------------------------------------------------------------
// Pareto
// ---------------------------------------------------------------------------

export interface ParetoPoint {
  strategyId: string;
  label: string;
  /** The id, used for the in-chart direct label: it never wraps onto a second line. */
  shortLabel: string;
  cost: number;
  score: number;
  ciLow: number;
  ciHigh: number;
  passRate: number;
  scorePerDollar: number;
  runs: number;
  onFrontier: boolean;
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
    shortLabel: row.strategyId,
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
  tasks: { id: string; title: string; category: TaskCategory; difficulty: Difficulty; world: string }[];
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
    .sort((a, b) => compareArchitectures(a.strategyId, b.strategyId))
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
// Per-repeat outcomes
// ---------------------------------------------------------------------------

/**
 * The outcome of one run, as the per-repeat squares draw it. `excluded` and
 * `api_error` are kept distinct from `fail`: neither is the architecture
 * failing the task, and folding them in would make a flaky API look like a
 * weak design.
 */
export type RunOutcome = 'pass' | 'partial' | 'fail' | 'excluded' | 'api_error';

export function runOutcome(record: RunRecord): RunOutcome {
  if (record.failureMode === 'api_error') return 'api_error';
  if (record.integrity && !record.integrity.ok) return 'excluded';
  if (record.passed) return 'pass';
  return record.score > 0 ? 'partial' : 'fail';
}

export interface RepeatCell {
  runId: string;
  repeat: number;
  outcome: RunOutcome;
  score: number;
}

/** Runs of one architecture on one task, ordered by repeat. */
export function repeatCells(
  records: readonly RunRecord[],
  strategyId: string,
  taskId: string,
): RepeatCell[] {
  return records
    .filter((record) => record.strategyId === strategyId && record.taskId === taskId)
    .sort((a, b) => a.repeat - b.repeat)
    .map((record) => ({
      runId: record.runId,
      repeat: record.repeat,
      outcome: runOutcome(record),
      score: record.score,
    }));
}

// ---------------------------------------------------------------------------
// Task detail
// ---------------------------------------------------------------------------

export function selectRunsForTask(records: readonly RunRecord[], taskId: string): RunRecord[] {
  return records
    .filter((record) => record.taskId === taskId)
    .sort(
      (a, b) =>
        compareArchitectures(a.strategyId, b.strategyId) ||
        a.model.localeCompare(b.model) ||
        a.repeat - b.repeat,
    );
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
 * Groups are keyed by phase *and* agent, so two workers that reuse a phase
 * name are never merged into one.
 */
export function groupTraceByPhase(events: readonly TraceEvent[]): PhaseGroup[] {
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  const order: string[] = [];
  const groups = new Map<string, PhaseGroup>();

  for (const event of ordered) {
    const key = `${event.phase}\u0000${event.agent ?? ''}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        phase: event.phase,
        depth: event.depth,
        events: [],
        startMs: event.tMs,
        endMs: event.tMs,
      };
      if (event.agent) group.agent = event.agent;
      groups.set(key, group);
      order.push(key);
    }
    group.events.push(event);
    group.depth = Math.min(group.depth, event.depth);
    group.startMs = Math.min(group.startMs, event.tMs);
    group.endMs = Math.max(group.endMs, event.tMs);
  }

  return order.map((key) => groups.get(key)).filter((group): group is PhaseGroup => !!group);
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
  degraded?: string;
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
      ...(phase.degraded ? { degraded: phase.degraded } : {}),
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
 * encourages readers to over-interpret a handful of repeats.
 */
export function describeFindings(
  rows: readonly LeaderboardRow[],
  context: FindingsContext,
): string {
  const top = rows[0];
  if (!top) return 'No runs have been published for this selection yet.';

  const scope =
    context.scope === 'all'
      ? ''
      : context.scope === 'tool-use'
        ? ' in the tool-use category'
        : ' in the research category';
  const opening = `Across ${plural(context.runs, 'run')} on ${plural(context.taskCount, 'task')}${scope}`;

  if (rows.length === 1) {
    return `${opening}, ${top.label} scores ${formatScore(top.score.mean)} (95% CI ${formatScore(top.score.ciLow)}–${formatScore(top.score.ciHigh)}, n=${top.runs}). Only one architecture has runs here, so no comparison is possible yet.`;
  }

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

  const sentences: string[] = [];
  const cheapest = [...rows]
    .filter((row) => row.costUsd.mean > 0)
    .sort((a, b) => a.costUsd.mean - b.costUsd.mean)[0];

  if (inconclusive === total) {
    sentences.push(
      total === 1
        ? `${opening}, the two architectures do not separate: their intervals overlap.`
        : `${opening}, no architecture separates from any other: all ${total} pairwise intervals overlap.`,
    );
    if (cheapest) {
      sentences.push(
        `The cheapest is ${cheapest.label} at ${formatUsd(cheapest.costUsd.mean)} a run.`,
      );
    }
  } else {
    sentences.push(
      `${opening}, ${top.label} has the highest mean score at ${formatScore(top.score.mean)} ` +
        `(95% CI ${formatScore(top.score.ciLow)}–${formatScore(top.score.ciHigh)}, n=${top.runs}).`,
    );
    const challenger = rows[1];
    if (challenger) {
      const verdict = comparisonVerdict(top.score, challenger.score);
      const delta = formatScore(top.score.mean - challenger.score.mean);
      sentences.push(
        verdict === 'inconclusive'
          ? `Its ${delta} lead over ${challenger.label} is not separable at this sample size; the intervals overlap.`
          : `Its ${delta} lead over ${challenger.label} holds: the intervals do not overlap.`,
      );
    }
    sentences.push(
      inconclusive === 0
        ? `Every one of the ${plural(total, 'pairwise comparison')} separates.`
        : `${inconclusive} of ${plural(total, 'pairwise comparison')} ${inconclusive === 1 ? 'is' : 'are'} inconclusive.`,
    );
  }

  const dominated = rows.filter((row) => !row.onFrontier);
  if (dominated.length > 0) {
    sentences.push(
      `On means alone, ${joinList(dominated.map((row) => row.label))} ${dominated.length === 1 ? 'is' : 'are'} dominated: something else scores at least as well for no more money.`,
    );
  }

  return sentences.join(' ');
}

// ---------------------------------------------------------------------------
// Model views
// ---------------------------------------------------------------------------

export interface ModelView {
  model: string;
  /** Every record of this model, including excluded ones (for health and run lists). */
  records: RunRecord[];
  /** The records rankings are computed over (contract 3). */
  ranked: RunRecord[];
  summary: ReportSummary;
}

/** Scope a run set to one model and summarise the rankable runs. */
export function modelView(records: readonly RunRecord[], model: string): ModelView {
  const scoped = recordsForModel(records, model);
  const ranked = scoped.filter(isRankable);
  return { model, records: scoped, ranked, summary: summarize(ranked) };
}
