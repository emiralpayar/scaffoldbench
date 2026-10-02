/**
 * The live view of `arena run`: a task × strategy grid per model, one glyph
 * per repeat, over a footer that says how far along the session is, what it
 * has spent against its ceiling, and what is going wrong.
 *
 * State is updated from runner and trace events; `renderLiveFrame` turns it
 * into lines and is pure, so the whole view is tested as text. Drawing the
 * lines on a terminal is `terminal.ts`'s job.
 */

import type { RunRecord, RunnerEvent, TraceEvent } from '@arena/core';

import { formatBudget, formatDuration, formatUsd, plural, shortModel } from './format';
import { abbreviationLegend, abbreviations, renderBar } from './plots';
import type { MatrixCell } from './plan';
import { GLYPH, PLAIN, clipLine, padEnd, spinnerFrame, truncate } from './style';
import type { Style } from './style';
import type { StopStage } from './stop';

export type Outcome = 'pass' | 'partial' | 'fail' | 'api_error' | 'integrity';

export type CellState =
  | { kind: 'queued' }
  | { kind: 'running' }
  | { kind: 'retrying'; until: number }
  | { kind: 'done'; outcome: Outcome }
  | { kind: 'discarded' }
  | { kind: 'error' };

/** How a finished run is drawn: excluded runs first, so they are never mistaken for a score. */
export function outcomeOf(record: Pick<RunRecord, 'failureMode' | 'integrity' | 'passed' | 'score'>): Outcome {
  if (record.failureMode === 'api_error') return 'api_error';
  if (record.integrity && !record.integrity.ok) return 'integrity';
  if (record.passed) return 'pass';
  return record.score > 0 ? 'partial' : 'fail';
}

interface InFlight {
  since: number;
  /** Phases started and not yet ended; parallel phases make this a set. */
  phases: string[];
  /** Agent spend of the calls that have ended so far. */
  costUsd: number;
}

export interface LiveState {
  runSetId: string;
  models: string[];
  strategyIds: string[];
  taskIds: string[];
  repeats: number;
  effort: string;
  budgetUsd: number;
  cells: Map<string, CellState>;
  coordinates: Map<string, MatrixCell>;
  /** Cells this session runs. */
  total: number;
  /**
   * Of those, cells that ended with a record, or with a runner error. Cells
   * a stop cut off are in `discarded` instead: they have no record and run
   * again on --resume, so they are not progress.
   */
  finished: number;
  counts: Record<Outcome, number>;
  retries: number;
  denied: number;
  /** Finished runs that had a call end because the model could not finish the turn. */
  modelStops: number;
  discarded: number;
  /** Settled spend: finished runs, their grading and their discarded attempts. */
  settledUsd: number;
  inFlight: Map<string, InFlight>;
  startedAt: number;
  stage: StopStage | 'finished';
  /** The most recent things worth saying, newest last. */
  notices: string[];
}

export interface LiveSetup {
  runSetId: string;
  cells: readonly MatrixCell[];
  /** Cells an earlier session recorded, drawn as they ended. */
  recorded: ReadonlyMap<string, RunRecord>;
  total: number;
  effort: string;
  budgetUsd: number;
  now: number;
}

export function createLiveState(setup: LiveSetup): LiveState {
  const unique = <T>(values: T[]) => [...new Set(values)];
  const cells = new Map<string, CellState>();
  const coordinates = new Map<string, MatrixCell>();
  for (const cell of setup.cells) {
    coordinates.set(cell.runId, cell);
    const earlier = setup.recorded.get(cell.key);
    cells.set(cell.runId, earlier ? { kind: 'done', outcome: outcomeOf(earlier) } : { kind: 'queued' });
  }
  return {
    runSetId: setup.runSetId,
    models: unique(setup.cells.map((cell) => cell.model)),
    strategyIds: unique(setup.cells.map((cell) => cell.strategyId)),
    taskIds: unique(setup.cells.map((cell) => cell.taskId)),
    repeats: Math.max(0, ...setup.cells.map((cell) => cell.repeat)),
    effort: setup.effort,
    budgetUsd: setup.budgetUsd,
    cells,
    coordinates,
    total: setup.total,
    finished: 0,
    counts: { pass: 0, partial: 0, fail: 0, api_error: 0, integrity: 0 },
    retries: 0,
    denied: 0,
    modelStops: 0,
    discarded: 0,
    settledUsd: 0,
    inFlight: new Map(),
    startedAt: setup.now,
    stage: 'running',
    notices: [],
  };
}

const MAX_NOTICES = 3;

function notice(state: LiveState, text: string): void {
  state.notices.push(text);
  if (state.notices.length > MAX_NOTICES) state.notices.splice(0, state.notices.length - MAX_NOTICES);
}

export function applyRunnerEvent(state: LiveState, event: RunnerEvent, now: number): void {
  switch (event.type) {
    case 'run-start':
      state.cells.set(event.runId, { kind: 'running' });
      state.inFlight.set(event.runId, { since: now, phases: [], costUsd: 0 });
      return;
    case 'run-retry': {
      state.retries += 1;
      state.cells.set(event.runId, { kind: 'retrying', until: now + event.delayMs });
      const flight = state.inFlight.get(event.runId);
      if (flight) flight.phases = [];
      notice(
        state,
        `${GLYPH.retry} ${describeRun(state, event.runId)}: attempt ${event.attempt} failed at the API ` +
          `(${firstLine(event.error)}); retrying in ${formatDuration(event.delayMs)}`,
      );
      return;
    }
    case 'run-end': {
      const record = event.record;
      const outcome = outcomeOf(record);
      state.cells.set(record.runId, { kind: 'done', outcome });
      state.inFlight.delete(record.runId);
      state.finished += 1;
      state.counts[outcome] += 1;
      if ((record.modelStops?.length ?? 0) > 0) state.modelStops += 1;
      state.settledUsd += record.costUsd + record.judgeCostUsd + (record.discardedCostUsd ?? 0);
      if (outcome === 'api_error') {
        notice(state, `${GLYPH.apiError} ${describeRun(state, record.runId)}: ${firstLine(record.error ?? 'API error')}`);
      } else if (outcome === 'integrity') {
        const failed = record.integrity?.checks.filter((check) => !check.ok).map((check) => check.id) ?? [];
        notice(state, `${GLYPH.integrity} ${describeRun(state, record.runId)}: integrity failed (${failed.join(', ')})`);
      }
      return;
    }
    case 'run-interrupted': {
      state.cells.set(event.runId, { kind: 'discarded' });
      // The run is gone but what its finished calls spent is not.
      state.settledUsd += state.inFlight.get(event.runId)?.costUsd ?? 0;
      state.inFlight.delete(event.runId);
      state.discarded += 1;
      return;
    }
    case 'run-error':
      state.cells.set(event.runId, { kind: 'error' });
      state.inFlight.delete(event.runId);
      state.finished += 1;
      notice(state, `${GLYPH.integrity} ${describeRun(state, event.runId)} produced no record: ${firstLine(event.error)}`);
      return;
    case 'budget-stop':
      notice(state, `Total budget reached (${formatUsd(event.spentUsd)} settled): no new runs will start.`);
      return;
    case 'stop':
      notice(state, firstLine(event.message));
      return;
  }
}

export function applyTraceEvent(state: LiveState, runId: string, event: TraceEvent): void {
  const flight = state.inFlight.get(runId);
  if (event.kind === 'tool_denied') state.denied += 1;
  if (!flight) return;
  if (event.kind === 'phase_start') {
    flight.phases.push(event.phase);
  } else if (event.kind === 'phase_end') {
    const index = flight.phases.indexOf(event.phase);
    if (index !== -1) flight.phases.splice(index, 1);
    flight.costUsd += event.costUsd ?? 0;
  }
}

/** Settled spend plus what the calls of runs in flight have spent so far. */
export function spentSoFar(state: LiveState): number {
  let usd = state.settledUsd;
  for (const flight of state.inFlight.values()) usd += flight.costUsd;
  return usd;
}

function describeRun(state: LiveState, runId: string): string {
  const cell = state.coordinates.get(runId);
  if (!cell) return runId;
  const model = state.models.length > 1 ? `${shortModel(cell.model)} · ` : '';
  return `${model}${cell.strategyId} · ${cell.taskId} · r${cell.repeat}`;
}

function firstLine(text: string): string {
  return (text.split('\n')[0] ?? '').trim();
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export interface FrameOptions {
  width: number;
  height: number;
  now: number;
  style?: Style;
  /** Draw spinners and the Ctrl-C hint; off for the final frame. */
  live?: boolean;
}

export function cellGlyph(state: CellState, now: number, style: Style): string {
  switch (state.kind) {
    case 'queued':
      return style.dim(GLYPH.queued);
    case 'running':
      return style.accent(spinnerFrame(now));
    case 'retrying':
      return style.warn(GLYPH.retry);
    case 'discarded':
      return style.dim(GLYPH.discarded);
    case 'error':
      return style.bad(GLYPH.integrity);
    case 'done':
      switch (state.outcome) {
        case 'pass':
          return style.ok(GLYPH.pass);
        case 'partial':
          return style.warn(GLYPH.partial);
        case 'fail':
          return style.bad(GLYPH.fail);
        case 'api_error':
          return style.infra(GLYPH.apiError);
        case 'integrity':
          return style.paint(['red', 'bold'], GLYPH.integrity);
      }
  }
}

interface GridLayout {
  /** Glyphs of one cell are separated by a space when there is room. */
  spaced: boolean;
  /** Model groups side by side, or one under another. */
  sideBySide: boolean;
  labelWidth: number;
  columnWidth: number;
  short: Map<string, string>;
}

const GROUP_GAP = ' │ ';

/**
 * The roomiest layout that fits: glyphs spaced, then packed, then task
 * labels shortened, and only then models stacked one under another, which
 * costs height a terminal rarely has.
 */
function layoutGrid(state: LiveState, width: number): GridLayout {
  const short = abbreviations(state.strategyIds);
  const headerWidth = Math.max(...[...short.values()].map((s) => s.length));
  const longest = Math.min(24, Math.max(4, ...state.taskIds.map((id) => id.length)));
  const columnWidth = (spaced: boolean) =>
    Math.max(headerWidth, spaced ? state.repeats * 2 - 1 : state.repeats) + (spaced ? 2 : 1);
  const fits = (spaced: boolean, sideBySide: boolean, labelWidth: number) => {
    const groups = sideBySide ? state.models.length : 1;
    const used =
      1 + labelWidth + 2 + groups * columnWidth(spaced) * state.strategyIds.length + (groups - 1) * GROUP_GAP.length;
    return used <= width;
  };
  const candidates: [boolean, boolean, number][] = [
    [true, true, longest],
    [false, true, longest],
    [false, true, Math.min(longest, 14)],
    [true, false, longest],
    [false, false, longest],
  ];
  for (const [spaced, sideBySide, labelWidth] of candidates) {
    if (fits(spaced, sideBySide, labelWidth)) {
      return { spaced, sideBySide, labelWidth, columnWidth: columnWidth(spaced), short };
    }
  }
  return { spaced: false, sideBySide: false, labelWidth: Math.min(longest, 14), columnWidth: columnWidth(false), short };
}

interface GridRow {
  text: string;
  /** A cell of this row is running or waiting to retry. */
  active: boolean;
  /** For stacked models: the header row of the model this row belongs to. */
  group?: string;
  isGroupHeader?: boolean;
}

/** The grid's header lines and rows: one row per task, per model when models are stacked. */
function gridRows(state: LiveState, layout: GridLayout, now: number, style: Style): { header: string[]; rows: GridRow[] } {
  const cellText = (model: string, strategyId: string, taskId: string) => {
    const glyphs: string[] = [];
    let active = false;
    for (let repeat = 1; repeat <= state.repeats; repeat++) {
      const runId = runIdFor(state, model, strategyId, taskId, repeat);
      const cell = runId ? state.cells.get(runId) : undefined;
      if (cell?.kind === 'running' || cell?.kind === 'retrying') active = true;
      glyphs.push(cell ? cellGlyph(cell, now, style) : ' ');
    }
    return { text: padEnd(glyphs.join(layout.spaced ? ' ' : ''), layout.columnWidth), active };
  };
  const groupText = (model: string, taskId: string) => {
    let active = false;
    const text = state.strategyIds
      .map((strategyId) => {
        const cell = cellText(model, strategyId, taskId);
        active ||= cell.active;
        return cell.text;
      })
      .join('');
    return { text, active };
  };
  const strategyHeader = state.strategyIds
    .map((id) => padEnd(layout.short.get(id) ?? id, layout.columnWidth))
    .join('');
  const label = (text: string) => ` ${padEnd(truncate(text, layout.labelWidth), layout.labelWidth)}  `;
  const groupWidth = layout.columnWidth * state.strategyIds.length;
  const multi = state.models.length > 1;

  const header: string[] = [];
  const rows: GridRow[] = [];
  if (layout.sideBySide) {
    if (multi) {
      header.push(
        style.bold(
          ' '.repeat(1 + layout.labelWidth + 2) +
            state.models.map((model) => padEnd(truncate(shortModel(model), groupWidth), groupWidth)).join(GROUP_GAP),
        ),
      );
    }
    header.push(style.dim(label('TASK') + state.models.map(() => strategyHeader).join(GROUP_GAP)));
    for (const taskId of state.taskIds) {
      const groups = state.models.map((model) => groupText(model, taskId));
      rows.push({
        text: label(taskId) + groups.map((group) => group.text).join(style.dim(GROUP_GAP)),
        active: groups.some((group) => group.active),
      });
    }
  } else {
    header.push(style.dim(label('TASK') + strategyHeader));
    for (const model of state.models) {
      const groupHeader = style.bold(` ${shortModel(model)}`);
      if (multi) rows.push({ text: groupHeader, active: false, group: groupHeader, isGroupHeader: true });
      for (const taskId of state.taskIds) {
        const group = groupText(model, taskId);
        rows.push({ text: label(taskId) + group.text, active: group.active, ...(multi ? { group: groupHeader } : {}) });
      }
    }
  }
  return { header, rows };
}

const runIdIndexes = new WeakMap<LiveState, Map<string, string>>();

function runIdFor(state: LiveState, model: string, strategyId: string, taskId: string, repeat: number): string | undefined {
  let index = runIdIndexes.get(state);
  if (!index) {
    index = new Map();
    for (const [runId, cell] of state.coordinates) {
      index.set(JSON.stringify([cell.model, cell.strategyId, cell.taskId, cell.repeat]), runId);
    }
    runIdIndexes.set(state, index);
  }
  return index.get(JSON.stringify([model, strategyId, taskId, repeat]));
}

/**
 * The rows to show when the grid is taller than the room: a window that
 * starts just above the first active row. A row cut off from its model's
 * header gets that header pinned above it, so no row is ever ambiguous.
 */
export function windowRows(rows: readonly GridRow[], room: number): { shown: GridRow[]; above: number; below: number } {
  if (rows.length <= room) return { shown: [...rows], above: 0, below: 0 };
  const visible = Math.max(1, room - 2);
  const firstActive = rows.findIndex((row) => row.active);
  const anchor = firstActive === -1 ? 0 : Math.max(0, firstActive - 1);
  const start = Math.min(anchor, rows.length - visible);
  const shown = rows.slice(start, start + visible);
  const first = shown[0];
  if (first && first.group !== undefined && !first.isGroupHeader && shown.length > 1) {
    shown.splice(0, 1, { text: first.group, active: false, isGroupHeader: true });
    return { shown, above: start + 1, below: rows.length - start - visible };
  }
  return { shown, above: start, below: rows.length - start - visible };
}

export function renderLiveFrame(state: LiveState, options: FrameOptions): string[] {
  const style = options.style ?? PLAIN;
  const width = Math.max(40, options.width);
  const live = options.live !== false;
  const now = options.now;

  const elapsed = now - state.startedAt;
  const models = state.models.length === 1 ? (state.models[0] ?? '') : plural(state.models.length, 'model');
  const title =
    ` ${style.bold('ScaffoldBench')}  ${style.accent(state.runSetId)}  ` +
    style.dim(`${models} · effort ${state.effort} · ${plural(state.repeats, 'repeat')}`);

  const layout = layoutGrid(state, width);
  const { header, rows } = gridRows(state, layout, now, style);

  // Footer
  const footer: string[] = [style.dim(` ${'─'.repeat(width - 2)}`)];
  const fraction = state.total === 0 ? 1 : state.finished / state.total;
  const spent = spentSoFar(state);
  const rate = elapsed > 0 ? state.finished / elapsed : 0;
  const remaining = state.total - state.finished;
  // Below 100 columns the footer cannot hold every tally and still end with
  // the ETA: separators tighten and a tally that is zero is left out, so what
  // is shown is what has happened.
  const roomy = width >= 100;
  const gap = roomy ? '   ' : '  ';
  const eta =
    state.stage === 'running' && state.finished > 0 && remaining > 0 && rate > 0
      ? `${gap}ETA ${formatDuration(remaining / rate)}`
      : '';
  footer.push(
    ` ${renderBar(fraction, Math.max(6, Math.min(30, width - (roomy ? 75 : 72))), style)}  ` +
      `${state.finished}/${state.total}  ${Math.floor(fraction * 100)}%${gap}` +
      `${style.bold(formatUsd(spent))} ${style.dim(`of ${formatBudget(state.budgetUsd)}`)}${gap}` +
      `${state.inFlight.size} in flight${gap}${style.dim(formatDuration(elapsed))}${eta}`,
  );
  const counts = state.counts;
  const tallies: [number, string, (text: string) => string][] = [
    [counts.api_error, `${GLYPH.apiError} ${plural(counts.api_error, 'API error')}`, style.infra],
    [counts.integrity, `${GLYPH.integrity} ${counts.integrity} integrity`, style.bad],
    [state.retries, `${GLYPH.retry} ${plural(state.retries, 'retry', 'retries')}`, style.warn],
    [state.denied, `${state.denied} denied`, style.warn],
  ];
  footer.push(
    ' ' +
      [
        `${style.ok(GLYPH.pass)} ${counts.pass} pass`,
        `${style.warn(GLYPH.partial)} ${counts.partial} partial`,
        `${style.bad(GLYPH.fail)} ${counts.fail} fail`,
        ...tallies.filter(([count]) => roomy || count > 0).map(([count, text, tone]) => tally(count, text, tone, style)),
        ...(state.modelStops > 0 ? [style.warn(`${plural(state.modelStops, 'model stop')}`)] : []),
        ...(state.discarded > 0 ? [style.dim(`${GLYPH.discarded} ${state.discarded} discarded`)] : []),
      ].join(gap),
  );

  const flightLines = [...state.inFlight.entries()].map(([runId, flight]) => {
    const cell = state.cells.get(runId);
    const doing =
      cell?.kind === 'retrying' ? 'waiting to retry' : flight.phases.length > 0 ? flight.phases.join(', ') : 'starting';
    const glyph = cell ? cellGlyph(cell, now, style) : ' ';
    return (
      ` ${glyph} ${describeRun(state, runId)}   ${style.dim(doing)}   ` +
      `${formatDuration(now - flight.since)}${flight.costUsd > 0 ? `   ${formatUsd(flight.costUsd)}` : ''}`
    );
  });

  const notices = state.notices.map((text) => ` ${style.dim(text)}`);
  const legend = [style.dim(` ${abbreviationLegend(layout.short)}`)];
  const hints = live ? [style.dim(` ${hint(state)}`)] : [];

  // Fit the terminal. The grid gives way first, down to three rows; then the
  // optional lines (the blank line, the notices, the legend); then the
  // in-flight list, down to one line.
  const height = Math.max(4, options.height) - 1;
  let blank = 1;
  let shownNotices = notices;
  let shownLegend = legend;
  const fixed = () =>
    1 + blank + header.length + footer.length + shownNotices.length + shownLegend.length + hints.length;
  for (const drop of [() => (blank = 0), () => (shownNotices = []), () => (shownLegend = [])]) {
    if (height - fixed() - 1 >= 3) break;
    drop();
  }
  const flightRoom = Math.max(1, Math.min(flightLines.length, Math.floor((height - fixed()) / 3)));
  const flights =
    flightLines.length > flightRoom
      ? [...flightLines.slice(0, flightRoom - 1), style.dim(`   +${flightLines.length - flightRoom + 1} more in flight`)]
      : flightLines;
  const { shown, above, below } = windowRows(rows, Math.max(1, height - fixed() - flights.length));

  const lines = [title, ...(blank ? [''] : [])];
  lines.push(...header);
  if (above > 0) lines.push(style.dim(`   ↑ ${plural(above, 'more row')}`));
  lines.push(...shown.map((row) => row.text));
  if (below > 0) lines.push(style.dim(`   ↓ ${plural(below, 'more row')}`));
  lines.push(...footer, ...flights, ...shownNotices, ...shownLegend, ...hints);
  // A frame taller than the terminal scrolls, and cannot be redrawn in place.
  return lines.slice(0, height).map((line) => clipLine(line.trimEnd(), width));
}

function tally(count: number, text: string, tone: (text: string) => string, style: Style): string {
  return count > 0 ? tone(text) : style.dim(text);
}

function hint(state: LiveState): string {
  switch (state.stage) {
    case 'running':
      return 'Ctrl-C: start nothing new and let the runs in flight finish · twice: abort them';
    case 'draining':
      return `Stopping: waiting for ${plural(state.inFlight.size, 'run')} in flight · Ctrl-C again to abort ${state.inFlight.size === 1 ? 'it' : 'them'}`;
    case 'aborting':
      return 'Aborting the runs in flight; they are discarded and run again on --resume · Ctrl-C again to exit now';
    case 'finished':
      return '';
  }
}
