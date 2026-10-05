/**
 * Pure view-model derivations over already-parsed run records.
 *
 * No filesystem access here (that is `lib/server/`), so every function is
 * testable on a literal and usable from any component. Means, bootstrap
 * intervals and the Pareto frontier come from `@scaffoldbench/core` (`summarizeRuns`)
 * or from `lib/analysis`; this module joins them to catalog metadata and
 * shapes them for rendering.
 */

import { comparisonVerdict, median, paretoFrontier, summarizeRuns } from '@scaffoldbench/core';
import type {
  Aggregate,
  CellSummary,
  ReportSummary,
  RunRecord as CoreRunRecord,
  StrategyInfo,
  TaskCategory,
  TraceEvent,
} from '@scaffoldbench/core';

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
import { runReceipts } from './postmortem';
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
  costUsd: number;
  latencyMs: number;
  failureMode: string;
  /**
   * For a run recorded before integrity checks existed, how many things its
   * own records show went wrong (`runReceipts`): the only fidelity signal such
   * a run has. Always 0 for a run with an integrity verdict, which `outcome`
   * already reflects.
   */
  legacyProblems: number;
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
      costUsd: record.costUsd,
      latencyMs: record.latencyMs,
      failureMode: record.failureMode,
      legacyProblems: record.integrity ? 0 : runReceipts(record).length,
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

export interface ArchitectureMean {
  strategyId: string;
  mean: number;
  runs: number;
}

/** Mean score of each architecture on a task, highest first. Pass the runs that count. */
export function architectureMeans(records: readonly RunRecord[], taskId: string): ArchitectureMean[] {
  const runs = selectRunsForTask(records, taskId);
  return [...new Set(runs.map((record) => record.strategyId))]
    .map((strategyId) => {
      const mine = runs.filter((record) => record.strategyId === strategyId);
      return { strategyId, mean: mine.reduce((sum, record) => sum + record.score, 0) / mine.length, runs: mine.length };
    })
    .sort((a, b) => b.mean - a.mean || compareArchitectures(a.strategyId, b.strategyId));
}

export interface AnatomyRow {
  id: string;
  label: string;
  /** A graded assertion, or a rule whose breach applies a penalty. */
  kind: 'assertion' | 'rule';
  weight?: number;
  /** Per architecture: runs that fell short of this item, of runs that had it. */
  cells: Record<string, { count: number; runs: number }>;
}

export interface TaskAnatomy {
  architectures: string[];
  rows: AnatomyRow[];
}

/**
 * Where a task is lost, item by item and architecture by architecture: for
 * each graded assertion, how many of an architecture's runs earned less than
 * full credit, and for each rule, how many breached it. A mean score says an
 * architecture lost points; this says which ones. Pass the records the
 * caller trusts (one model, ranked runs).
 */
export function taskAnatomy(records: readonly RunRecord[], taskId: string): TaskAnatomy {
  const runs = selectRunsForTask(records, taskId);
  const architectures = [...new Set(runs.map((record) => record.strategyId))].sort(compareArchitectures);
  const rows = new Map<string, AnatomyRow>();

  const row = (id: string, label: string, kind: AnatomyRow['kind'], weight?: number): AnatomyRow => {
    const key = `${kind}:${id}`;
    let found = rows.get(key);
    if (!found) {
      found = { id, label, kind, ...(weight !== undefined ? { weight } : {}), cells: {} };
      rows.set(key, found);
    }
    return found;
  };
  const tally = (target: AnatomyRow, architecture: string, fell: boolean) => {
    const cell = (target.cells[architecture] ??= { count: 0, runs: 0 });
    cell.runs += 1;
    if (fell) cell.count += 1;
  };

  for (const record of runs) {
    for (const item of record.breakdown) {
      tally(row(item.id, item.label, 'assertion', item.weight), record.strategyId, clamp01(item.earned) < FULL_CREDIT);
    }
  }
  // A rule only appears in a run that breached it, so a run without the
  // penalty still counts toward the architecture's total for that rule.
  for (const record of runs) {
    for (const penalty of record.penalties) row(penalty.id, penalty.label, 'rule');
  }
  for (const target of rows.values()) {
    if (target.kind !== 'rule') continue;
    for (const record of runs) {
      tally(target, record.strategyId, record.penalties.some((penalty) => penalty.id === target.id));
    }
  }

  return { architectures, rows: [...rows.values()] };
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
