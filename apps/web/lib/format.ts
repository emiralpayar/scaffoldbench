/**
 * Pure formatting helpers.
 *
 * Nothing here touches `node:fs` or any server-only module, so client
 * components import these directly instead of re-implementing them with
 * subtly different rounding (which is how a site ends up printing `$0.0500`
 * on one page and `$0.050` on the next).
 */

/** An assertion earning less than this is credit, not a pass. */
export const FULL_CREDIT = 0.999;

export function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

export function formatScore(value: number): string {
  return value.toFixed(3);
}

/** A signed score difference, with a true minus sign so columns align. */
export function formatDelta(value: number, digits = 3): string {
  const rounded = Number(value.toFixed(digits));
  if (rounded === 0) return (0).toFixed(digits);
  const body = Math.abs(rounded).toFixed(digits);
  return rounded > 0 ? `+${body}` : `−${body}`;
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

/** A cost multiple such as `2.4×`; one decimal is all a ratio of means can carry. */
export function formatMultiple(value: number): string {
  if (!Number.isFinite(value)) return '—';
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)}×`;
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) {
    const minutes = Math.floor(ms / 60_000);
    const seconds = Math.round((ms % 60_000) / 1000);
    return `${minutes}m ${seconds}s`;
  }
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.round((ms % 3_600_000) / 60_000);
  return `${hours}h ${minutes}m`;
}

export function formatInt(value: number): string {
  return Number.isFinite(value) ? Math.round(value).toLocaleString('en-US') : '—';
}

export function formatFailureMode(mode: string): string {
  return mode.replace(/_/g, ' ');
}

export function plural(count: number, noun: string, pluralNoun = `${noun}s`): string {
  return `${count} ${count === 1 ? noun : pluralNoun}`;
}

/** "a", "a and b", "a, b and c" — for prose built from data. */
export function joinList(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

// ---------------------------------------------------------------------------
// Intervals
// ---------------------------------------------------------------------------

/** What the page prints where core withheld an interval. */
export const NO_INTERVAL = 'no interval';

/**
 * `0.612–0.847`, or "no interval" where the data cannot support one. An
 * interval is never faked from the point estimate: a zero-width range reads
 * as certainty.
 */
export function formatRange(
  estimate: { ci: { low: number; high: number } | null },
  format: (value: number) => string,
  separator = '–',
): string {
  return estimate.ci ? `${format(estimate.ci.low)}${separator}${format(estimate.ci.high)}` : NO_INTERVAL;
}

/** `[0.612, 0.847]` with a comma, or "no interval": the form a sentence or tooltip quotes. */
export function formatBracket(
  estimate: { ci: { low: number; high: number } | null },
  format: (value: number) => string,
): string {
  return estimate.ci ? `[${format(estimate.ci.low)}, ${format(estimate.ci.high)}]` : NO_INTERVAL;
}

/** The lower and upper end of an interval for drawing, or the point itself when there is none. */
export function boundsOf(estimate: { mean: number; ci: { low: number; high: number } | null }): [number, number] {
  return estimate.ci ? [estimate.ci.low, estimate.ci.high] : [estimate.mean, estimate.mean];
}

/** Why a verdict was withheld or limited, in a phrase for a caption or tooltip. */
export function caveatText(caveat: 'too-few-tasks' | 'no-variation' | 'few-informative-tasks'): string {
  switch (caveat) {
    case 'too-few-tasks':
      return 'too few tasks for a verdict';
    case 'no-variation':
      return 'every task moved by the same amount, so there is no interval';
    case 'few-informative-tasks':
      return 'too few tasks carry the spread to show equivalence';
  }
}

/** The same, in two or three words for a table cell; `caveatText` goes in the tooltip. */
export function caveatShort(caveat: 'too-few-tasks' | 'no-variation' | 'few-informative-tasks'): string {
  switch (caveat) {
    case 'too-few-tasks':
      return 'too few tasks';
    case 'no-variation':
      return 'no variation';
    case 'few-informative-tasks':
      return 'few informative tasks';
  }
}
