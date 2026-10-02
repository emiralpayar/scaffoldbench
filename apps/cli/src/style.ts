/**
 * Colour, glyphs and ANSI-aware text layout for the terminal.
 *
 * `util.styleText` is the only colour primitive: no dependency, and the
 * escape codes are Node's own. Whether to colour at all is decided once per
 * stream, the way Node decides it (`FORCE_COLOR`, then a TTY that reports
 * colour support, which already honours `NO_COLOR`, `NODE_DISABLE_COLORS`
 * and `TERM=dumb`), and the decision travels as a `Style` value. Renderers
 * take a `Style` instead of asking the environment, so every one of them is
 * a pure function that a test can call with `PLAIN` and compare as text.
 */

import { stripVTControlCharacters, styleText } from 'node:util';

/** One `util.inspect.colors` name, such as 'green' or 'bold'. */
export type Format = Exclude<Parameters<typeof styleText>[0], readonly unknown[]>;

export interface Style {
  readonly color: boolean;
  /** Apply one or more `util.inspect.colors` formats, or return `text` unchanged when colour is off. */
  paint(format: Format | readonly Format[], text: string): string;
  bold(text: string): string;
  dim(text: string): string;
  /** Good news: a pass, a check that held. */
  ok(text: string): string;
  /** Worth a look: partial credit, an unverified run, a retry. */
  warn(text: string): string;
  /** Bad news: a failure, a check that did not hold. */
  bad(text: string): string;
  /** Not the architecture's fault: API and infrastructure failures. */
  infra(text: string): string;
  /** Live activity and identifiers worth finding again. */
  accent(text: string): string;
}

export function createStyle(color: boolean): Style {
  const paint = (format: Format | readonly Format[], text: string): string => {
    if (!color || text === '') return text;
    const formats: readonly Format[] = typeof format === 'string' ? [format] : format;
    // Applied one at a time: arrays of formats are newer than Node 22.0.
    return formats.reduce((styled, one) => styleText(one, styled, { validateStream: false }), text);
  };
  return {
    color,
    paint,
    bold: (text) => paint('bold', text),
    dim: (text) => paint('dim', text),
    ok: (text) => paint('green', text),
    warn: (text) => paint('yellow', text),
    bad: (text) => paint('red', text),
    infra: (text) => paint('magenta', text),
    accent: (text) => paint('cyan', text),
  };
}

/** No colour at all: what tests, pipes and `NO_COLOR` get. */
export const PLAIN: Style = createStyle(false);

interface ColorStream {
  isTTY?: boolean;
  hasColors?: () => boolean;
}

/**
 * Should output to `stream` be coloured? Mirrors Node's own rule for
 * `util.styleText`: a `FORCE_COLOR` of '', 1, 2, 3 or true forces colour on
 * any stream and any other value forces it off; otherwise only a TTY that
 * reports colour support gets it, and that report already says no under
 * `NO_COLOR`, `NODE_DISABLE_COLORS` and `TERM=dumb`.
 */
export function shouldColor(stream: ColorStream, env: NodeJS.ProcessEnv = process.env): boolean {
  const force = env.FORCE_COLOR;
  if (force !== undefined) return ['', '1', '2', '3', 'true'].includes(force);
  if (stream.isTTY !== true) return false;
  return typeof stream.hasColors === 'function' ? stream.hasColors() : true;
}

export function styleFor(stream: ColorStream, env: NodeJS.ProcessEnv = process.env): Style {
  return createStyle(shouldColor(stream, env));
}

// ---------------------------------------------------------------------------
// Glyphs
// ---------------------------------------------------------------------------

/**
 * Every glyph is a single terminal column wide, so a grid of them lines up.
 * (No emoji: those are two columns in most terminals and one in some.)
 */
export const GLYPH = {
  pass: '●',
  partial: '◑',
  fail: '✗',
  apiError: '!',
  integrity: '⊘',
  queued: '·',
  retry: '↻',
  discarded: '○',
  ok: '✓',
  warn: '⚠',
  info: '·',
  frontier: '★',
  better: '▲',
  worse: '▼',
  equivalent: '≈',
  inconclusive: '·',
  diagonal: '—',
} as const;

/** Braille spinner frames; `spinnerFrame(now)` advances one every 80 ms. */
export const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;

export function spinnerFrame(nowMs: number): string {
  return SPINNER[Math.floor(nowMs / 80) % SPINNER.length] ?? SPINNER[0];
}

// ---------------------------------------------------------------------------
// ANSI-aware text layout
// ---------------------------------------------------------------------------

/** Columns `text` occupies on screen: escape codes take none, every code point one. */
export function visibleWidth(text: string): number {
  return [...stripVTControlCharacters(text)].length;
}

export function padEnd(text: string, width: number): string {
  const gap = width - visibleWidth(text);
  return gap > 0 ? text + ' '.repeat(gap) : text;
}

export function padStart(text: string, width: number): string {
  const gap = width - visibleWidth(text);
  return gap > 0 ? ' '.repeat(gap) + text : text;
}

/** Shorten unstyled `text` to `width` columns, marking the cut with an ellipsis. */
export function truncate(text: string, width: number): string {
  const chars = [...text];
  if (chars.length <= width) return text;
  if (width <= 0) return '';
  if (width === 1) return '…';
  return `${chars.slice(0, width - 1).join('')}…`;
}

/**
 * Cut a styled line to `width` visible columns, keeping its escape codes and
 * closing any style left open, so a long line never wraps and breaks a
 * redrawn frame.
 */
export function clipLine(line: string, width: number): string {
  if (visibleWidth(line) <= width) return line;
  let out = '';
  let shown = 0;
  const pattern = /\u001b\[[0-9;]*m|[\s\S]/gu;
  for (const match of line.matchAll(pattern)) {
    const token = match[0];
    if (token.startsWith('\u001b[')) {
      out += token;
      continue;
    }
    if (shown >= width) continue;
    out += token;
    shown += 1;
  }
  return line.includes('\u001b[') ? `${out}\u001b[0m` : out;
}

/** Greedy word wrap of unstyled text. */
export function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let current = '';
  for (const word of text.split(/\s+/)) {
    if (word === '') continue;
    if (current === '') current = word;
    else if (current.length + 1 + word.length <= width) current = `${current} ${word}`;
    else {
      lines.push(current);
      current = word;
    }
  }
  if (current !== '') lines.push(current);
  return lines;
}

export type Align = 'left' | 'right';

export interface Column {
  header: string;
  align?: Align;
}

/**
 * A plain fixed-width table. Cells may carry colour; widths are measured on
 * what is visible. Headers are dimmed so the numbers carry the weight.
 */
export function renderTable(
  columns: readonly Column[],
  rows: readonly (readonly string[])[],
  style: Style = PLAIN,
  indent = '',
): string {
  const widths = columns.map((column, index) => {
    let width = visibleWidth(column.header);
    for (const row of rows) width = Math.max(width, visibleWidth(row[index] ?? ''));
    return width;
  });

  const line = (cells: readonly string[]): string =>
    indent +
    columns
      .map((column, index) => {
        const cell = cells[index] ?? '';
        const width = widths[index] ?? 0;
        return column.align === 'right' ? padStart(cell, width) : padEnd(cell, width);
      })
      .join('  ')
      .trimEnd();

  return [line(columns.map((column) => style.dim(column.header))), ...rows.map(line)].join('\n');
}

/** A section heading: bold title, then an optional dimmed subtitle on the same line. */
export function heading(title: string, subtitle: string | undefined, style: Style): string {
  return subtitle ? `${style.bold(title)}  ${style.dim(subtitle)}` : style.bold(title);
}
