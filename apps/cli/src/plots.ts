/**
 * Terminal plots: a forest plot of intervals, a pairwise verdict grid, a
 * labelled scatter, and a progress bar.
 *
 * Each is a pure function from a small input to lines of text, with no idea
 * what a strategy or a run set is. That keeps them reusable for any metric,
 * and it means a richer analysis — paired, task-clustered contrasts — can be
 * drawn by mapping its results onto these inputs without touching the
 * drawing code.
 */

import { GLYPH, PLAIN, padEnd, truncate, visibleWidth } from './style';
import type { Style } from './style';

export interface Interval {
  low: number;
  high: number;
}

/** A point estimate and its interval; `ci` is null when the data cannot support one. */
export interface Estimate {
  value: number;
  ci: Interval | null;
}

/**
 * How a row compares with a column: `better` and `worse` are decided
 * differences, `equivalent` a difference shown to be inside a margin, and
 * `inconclusive` everything the data cannot settle.
 */
export type Verdict = 'better' | 'worse' | 'equivalent' | 'inconclusive';

// ---------------------------------------------------------------------------
// Axes
// ---------------------------------------------------------------------------

export interface Axis {
  low: number;
  high: number;
  ticks: number[];
  /** Distance between ticks. */
  step: number;
  /** Decimals that show every tick exactly: 2 for a 0.02 step, 3 for 0.025. */
  decimals: number;
}

/** Formats a tick value; `decimals` is what the axis step needs. */
export type TickFormat = (value: number, decimals: number) => string;

const plainTick: TickFormat = (value, decimals) => value.toFixed(decimals);

const STEP_MULTIPLIERS = [1, 2, 2.5, 5];

/**
 * A readable axis over `[min, max]`: bounds snapped to a round step, with
 * at most `maxTicks` ticks, clamped to `clamp` when given (scores never
 * leave 0..1, so the axis should not either).
 */
export function niceAxis(
  min: number,
  max: number,
  maxTicks: number,
  clamp?: Interval,
): Axis {
  let low = Math.min(min, max);
  let high = Math.max(min, max);
  if (!Number.isFinite(low) || !Number.isFinite(high)) {
    low = clamp?.low ?? 0;
    high = clamp?.high ?? 1;
  }
  if (high - low < 1e-9) {
    const pad = Math.abs(low) > 1e-9 ? Math.abs(low) * 0.05 : 0.05;
    low -= pad;
    high += pad;
  }
  if (clamp) {
    low = Math.max(clamp.low, low);
    high = Math.min(clamp.high, high);
  }

  const step = roundStep(low, high, Math.max(2, maxTicks));
  let axisLow = round(Math.floor(low / step + 1e-9) * step, 10);
  let axisHigh = round(Math.ceil(high / step - 1e-9) * step, 10);
  if (clamp) {
    axisLow = Math.max(clamp.low, axisLow);
    axisHigh = Math.min(clamp.high, axisHigh);
  }
  const count = Math.round((axisHigh - axisLow) / step) + 1;
  const ticks = Array.from({ length: count }, (_, i) => round(axisLow + i * step, 10));
  return { low: axisLow, high: axisHigh, ticks, step, decimals: decimalsOf(step) };
}

function decimalsOf(step: number): number {
  for (let decimals = 0; decimals < 10; decimals++) {
    if (Math.abs(round(step, decimals) - step) < 1e-12) return decimals;
  }
  return 10;
}

/**
 * The smallest round step (1, 2, 2.5 or 5 times a power of ten) whose
 * snapped-out axis over `[low, high]` needs no more than `maxTicks` ticks.
 */
function roundStep(low: number, high: number, maxTicks: number): number {
  const ticksAt = (step: number) =>
    Math.ceil(high / step - 1e-9) - Math.floor(low / step + 1e-9) + 1;
  const first = Math.floor(Math.log10((high - low) / maxTicks)) - 1;
  for (let exp = first; exp <= first + 3; exp++) {
    for (const multiplier of STEP_MULTIPLIERS) {
      const step = multiplier * 10 ** exp;
      if (ticksAt(step) <= maxTicks) return step;
    }
  }
  return high - low;
}

/** The column (0..width-1) at which `value` falls on `axis`. */
export function columnOf(value: number, axis: Axis, width: number): number {
  if (width <= 1 || axis.high === axis.low) return 0;
  const t = (value - axis.low) / (axis.high - axis.low);
  return Math.max(0, Math.min(width - 1, Math.round(t * (width - 1))));
}

/** Tick labels placed under their columns, never overlapping: a label that would collide is dropped. */
function tickLabelLine(axis: Axis, width: number, format: TickFormat): string {
  const cells = Array.from({ length: width }, () => ' ');
  let freeFrom = 0;
  axis.ticks.forEach((tick, index) => {
    const label = format(tick, axis.decimals);
    const center = columnOf(tick, axis, width);
    // First label starts at its tick, last ends at its tick, the rest centre on it.
    let start =
      index === 0
        ? center
        : index === axis.ticks.length - 1
          ? center - label.length + 1
          : center - Math.floor(label.length / 2);
    start = Math.max(start, 0);
    if (start < freeFrom || start + label.length > width) return;
    [...label].forEach((char, offset) => {
      cells[start + offset] = char;
    });
    freeFrom = start + label.length + 1;
  });
  return cells.join('').trimEnd();
}

// ---------------------------------------------------------------------------
// Forest plot
// ---------------------------------------------------------------------------

export interface ForestRow {
  label: string;
  estimate: Estimate;
  /** A one-column marker before the label, such as ★ for the Pareto frontier. */
  marker?: string;
}

export interface ForestOptions {
  /** Total width of every line. */
  width: number;
  style?: Style;
  /** Formats the estimates printed beside the plot. */
  format?: (value: number) => string;
  formatTick?: TickFormat;
  /** Keep the axis inside this range (0..1 for scores). */
  clamp?: Interval;
  /** Columns for the label; defaults to the longest label, capped at 24. */
  labelWidth?: number;
}

/**
 * A forest plot: one row per estimate, its interval drawn as `├──●──┤` on a
 * shared axis, the numbers repeated on the right so nothing is read off the
 * picture alone. A row without an interval shows only its point.
 */
export function renderForestPlot(rows: readonly ForestRow[], options: ForestOptions): string[] {
  const style = options.style ?? PLAIN;
  const format = options.format ?? ((v: number) => v.toFixed(2));
  if (rows.length === 0) return [];

  const labelWidth =
    options.labelWidth ?? Math.min(24, Math.max(...rows.map((row) => row.label.length)));
  const numbers = rows.map((row) => describeEstimate(row.estimate, format));
  const numbersWidth = Math.max(...numbers.map((text) => text.length));
  // marker + space + label + 2 + plot + 2 + numbers
  const plotWidth = Math.max(12, options.width - (2 + labelWidth + 2 + 2 + numbersWidth));

  const lows = rows.map((row) => row.estimate.ci?.low ?? row.estimate.value);
  const highs = rows.map((row) => row.estimate.ci?.high ?? row.estimate.value);
  const axis = niceAxis(
    Math.min(...lows),
    Math.max(...highs),
    Math.max(2, Math.min(6, Math.floor(plotWidth / 8))),
    options.clamp,
  );
  const tickColumns = new Set(axis.ticks.map((tick) => columnOf(tick, axis, plotWidth)));

  const indent = ' '.repeat(2 + labelWidth + 2);
  const lines = [indent + style.dim(tickLabelLine(axis, plotWidth, options.formatTick ?? plainTick))];

  rows.forEach((row, index) => {
    const cells: string[] = Array.from({ length: plotWidth }, (_, column) =>
      tickColumns.has(column) ? style.dim('┊') : ' ',
    );
    const { ci, value } = row.estimate;
    if (ci) {
      const from = columnOf(ci.low, axis, plotWidth);
      const to = columnOf(ci.high, axis, plotWidth);
      for (let column = from + 1; column < to; column++) cells[column] = style.accent('─');
      if (from !== to) {
        cells[from] = style.accent('├');
        cells[to] = style.accent('┤');
      }
    }
    cells[columnOf(value, axis, plotWidth)] = style.bold('●');

    const marker = row.marker ? style.warn(row.marker) : ' ';
    lines.push(
      `${marker} ${padEnd(truncate(row.label, labelWidth), labelWidth)}  ${cells.join('')}  ` +
        style.dim(numbers[index] ?? ''),
    );
  });
  return lines;
}

function describeEstimate(estimate: Estimate, format: (value: number) => string): string {
  const point = format(estimate.value);
  return estimate.ci ? `${point} [${format(estimate.ci.low)}, ${format(estimate.ci.high)}]` : point;
}

// ---------------------------------------------------------------------------
// Pairwise grid
// ---------------------------------------------------------------------------

export interface Pair {
  a: string;
  b: string;
  verdict: Verdict;
}

export interface PairwiseGridOptions {
  style?: Style;
  /** Column headers; defaults to the ids themselves. */
  headers?: ReadonlyMap<string, string>;
  /** Columns for the row labels; defaults to the longest id, capped at 24. */
  labelWidth?: number;
}

/** The verdict of `row` against `column`, read from whichever orientation was compared. */
export function verdictBetween(
  pairs: readonly Pair[],
  row: string,
  column: string,
): Verdict | undefined {
  for (const pair of pairs) {
    if (pair.a === row && pair.b === column) return pair.verdict;
    if (pair.a === column && pair.b === row) return flipVerdict(pair.verdict);
  }
  return undefined;
}

export function flipVerdict(verdict: Verdict): Verdict {
  if (verdict === 'better') return 'worse';
  if (verdict === 'worse') return 'better';
  return verdict;
}

export function verdictGlyph(verdict: Verdict | undefined, style: Style): string {
  switch (verdict) {
    case 'better':
      return style.ok(GLYPH.better);
    case 'worse':
      return style.bad(GLYPH.worse);
    case 'equivalent':
      return style.accent(GLYPH.equivalent);
    case 'inconclusive':
      return style.dim(GLYPH.inconclusive);
    default:
      return ' ';
  }
}

/** Every row against every column: ▲ row better, ▼ row worse, ≈ equivalent, · inconclusive. */
export function renderPairwiseGrid(
  ids: readonly string[],
  pairs: readonly Pair[],
  options: PairwiseGridOptions = {},
): string[] {
  const style = options.style ?? PLAIN;
  if (ids.length < 2) return [];
  const header = (id: string) => options.headers?.get(id) ?? id;
  const labelWidth = options.labelWidth ?? Math.min(24, Math.max(...ids.map((id) => id.length)));
  const columnWidth = Math.max(...ids.map((id) => visibleWidth(header(id)))) + 2;

  const cell = (text: string) => padEnd(text, columnWidth);
  const lines = [
    `  ${' '.repeat(labelWidth)}  ${ids.map((id) => style.dim(cell(header(id)))).join('')}`.trimEnd(),
  ];
  for (const row of ids) {
    const cells = ids.map((column) =>
      cell(row === column ? style.dim(GLYPH.diagonal) : verdictGlyph(verdictBetween(pairs, row, column), style)),
    );
    lines.push(`  ${padEnd(truncate(row, labelWidth), labelWidth)}  ${cells.join('')}`.trimEnd());
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Scatter
// ---------------------------------------------------------------------------

export interface ScatterPoint {
  /** Short text drawn beside the point. */
  label: string;
  x: number;
  y: number;
  /** Drawn as ★ instead of ●. */
  highlight?: boolean;
}

export interface ScatterOptions {
  /** Columns of the plotting area. */
  width: number;
  /** Rows of the plotting area. */
  height: number;
  style?: Style;
  formatX?: TickFormat;
  formatY?: TickFormat;
  /** Start the x axis at zero, so distances read as proportions. */
  xFromZero?: boolean;
  clampY?: Interval;
}

/**
 * A labelled scatter on a character grid. Points that land on the same cell
 * share it and their labels are joined; a label with no room beside its
 * point is listed under the plot instead of being drawn over another.
 */
export function renderScatter(points: readonly ScatterPoint[], options: ScatterOptions): string[] {
  const style = options.style ?? PLAIN;
  const formatX = options.formatX ?? plainTick;
  const formatY = options.formatY ?? plainTick;
  if (points.length === 0) return [];

  const width = Math.max(16, options.width);
  const height = Math.max(4, options.height);
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const xAxis = niceAxis(
    options.xFromZero ? Math.min(0, ...xs) : Math.min(...xs),
    Math.max(...xs),
    Math.max(2, Math.min(5, Math.floor(width / 10))),
  );
  const yAxis = niceAxis(Math.min(...ys), Math.max(...ys), Math.min(5, height), options.clampY);

  // Merge points that land on the same cell.
  interface Placed {
    row: number;
    column: number;
    labels: string[];
    highlight: boolean;
  }
  const placed: Placed[] = [];
  for (const point of points) {
    const column = columnOf(point.x, xAxis, width);
    const row = height - 1 - columnOf(point.y, yAxis, height);
    const same = placed.find((p) => p.row === row && p.column === column);
    if (same) {
      same.labels.push(point.label);
      same.highlight ||= point.highlight === true;
    } else {
      placed.push({ row, column, labels: [point.label], highlight: point.highlight === true });
    }
  }

  const grid: string[][] = Array.from({ length: height }, () => Array.from({ length: width }, () => ' '));
  const taken: boolean[][] = Array.from({ length: height }, () => Array.from({ length: width }, () => false));
  for (const p of placed) {
    const gridRow = grid[p.row];
    const takenRow = taken[p.row];
    if (!gridRow || !takenRow) continue;
    gridRow[p.column] = p.highlight ? style.warn(GLYPH.frontier) : style.accent(GLYPH.pass);
    takenRow[p.column] = true;
  }

  const unplaced: string[] = [];
  // Highest points first, so a crowded top row keeps its most readable labels.
  for (const p of [...placed].sort((a, b) => a.row - b.row || a.column - b.column)) {
    const label = p.labels.join(',');
    const takenRow = taken[p.row];
    const gridRow = grid[p.row];
    if (!takenRow || !gridRow) continue;
    // Beside the point, right if there is room and left otherwise, keeping
    // one free column between this label and anything else on the row.
    const free = (from: number, to: number) => {
      for (let column = Math.max(0, from); column < Math.min(width, to); column++) {
        if (takenRow[column]) return false;
      }
      return true;
    };
    const right = p.column + 1;
    const left = p.column - label.length;
    const start =
      right + label.length <= width && free(right, right + label.length + 1)
        ? right
        : left >= 0 && free(left - 1, left + label.length)
          ? left
          : undefined;
    if (start === undefined) {
      unplaced.push(label);
      continue;
    }
    [...label].forEach((char, offset) => {
      gridRow[start + offset] = p.highlight ? style.bold(char) : char;
      takenRow[start + offset] = true;
    });
  }

  const yLabels = new Map<number, string>();
  for (const tick of yAxis.ticks) {
    yLabels.set(height - 1 - columnOf(tick, yAxis, height), formatY(tick, yAxis.decimals));
  }
  const yLabelWidth = Math.max(...[...yLabels.values()].map((label) => label.length));

  const lines: string[] = grid.map((cells, row) => {
    const label = yLabels.get(row);
    const prefix = label !== undefined ? `${label.padStart(yLabelWidth)} ┤` : `${' '.repeat(yLabelWidth)} │`;
    return `${style.dim(prefix)}${cells.join('')}`.trimEnd();
  });

  const tickColumns = new Set(xAxis.ticks.map((tick) => columnOf(tick, xAxis, width)));
  const axisLine = Array.from({ length: width }, (_, column) => (tickColumns.has(column) ? '┬' : '─')).join('');
  lines.push(style.dim(`${' '.repeat(yLabelWidth)} └${axisLine}`));
  lines.push(style.dim(`${' '.repeat(yLabelWidth + 2)}${tickLabelLine(xAxis, width, formatX)}`));
  if (unplaced.length > 0) {
    lines.push(style.dim(`${' '.repeat(yLabelWidth + 2)}not labelled for lack of room: ${unplaced.join(', ')}`));
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Progress bar
// ---------------------------------------------------------------------------

const PARTIAL_BLOCKS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉'];

/** A bar `width` columns wide, filled to `fraction` with eighth-block precision. */
export function renderBar(fraction: number, width: number, style: Style = PLAIN): string {
  const clamped = Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0));
  const eighths = Math.round(clamped * width * 8);
  const full = Math.floor(eighths / 8);
  const partial = PARTIAL_BLOCKS[eighths % 8] ?? '';
  const filled = '█'.repeat(full) + partial;
  const empty = '░'.repeat(Math.max(0, width - full - (partial ? 1 : 0)));
  return style.ok(filled) + style.dim(empty);
}

// ---------------------------------------------------------------------------
// Short names
// ---------------------------------------------------------------------------

/**
 * Short, unique column headers for ids: the initials of their dash-separated
 * parts (`plan-execute-verify` → `PEV`), numbered when two collide.
 */
export function abbreviations(ids: readonly string[]): Map<string, string> {
  const initials = (id: string) =>
    id
      .split(/[-_\s]+/)
      .filter((part) => part !== '')
      .map((part) => part[0]?.toUpperCase() ?? '')
      .join('') || id.slice(0, 2).toUpperCase();

  const result = new Map<string, string>();
  const used = new Map<string, number>();
  for (const id of ids) {
    const base = initials(id);
    const seen = used.get(base) ?? 0;
    used.set(base, seen + 1);
    result.set(id, seen === 0 ? base : `${base}${seen + 1}`);
  }
  // The first holder of a colliding abbreviation gets a number too, so none is ambiguous.
  for (const [base, count] of used) {
    if (count < 2) continue;
    const first = ids.find((id) => result.get(id) === base);
    if (first) result.set(first, `${base}1`);
  }
  return result;
}

/** `S single · PE plan-execute · …`: the key to `abbreviations`. */
export function abbreviationLegend(map: ReadonlyMap<string, string>): string {
  return [...map].map(([id, short]) => `${short} ${id}`).join(' · ');
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
