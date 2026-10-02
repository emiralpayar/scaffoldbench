/**
 * Formatting shared by the report, the run plan and the live view: scores,
 * money, durations and paths.
 *
 * Each value is rounded to the unit it is displayed in before it is split
 * into parts, so a carry can never produce `1m60s` or `1000ms`.
 */

import path from 'node:path';

export const MISSING = '-';

export function formatScore(value: number): string {
  return Number.isFinite(value) ? value.toFixed(3) : MISSING;
}

export function formatPercent(fraction: number): string {
  return Number.isFinite(fraction) ? `${(fraction * 100).toFixed(1)}%` : MISSING;
}

const usd = (digits: number) =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
const USD_2 = usd(2);
const USD_3 = usd(3);

/**
 * Dollars at the precision the amount deserves: three decimals below a
 * dollar, where per-run costs live (`$0.051`), two from there on (`$9.11`,
 * `$1,234.50`), and `<$0.001` for a cost too small to show rather than a
 * misleading `$0.000`.
 */
export function formatUsd(value: number): string {
  if (!Number.isFinite(value)) return MISSING;
  if (value === 0) return '$0.00';
  const magnitude = Math.abs(value);
  if (magnitude < 0.0005) return value < 0 ? '-<$0.001' : '<$0.001';
  // Decided on the rounded value, so $0.9996 reads $1.00, not $1.000.
  return Math.round(magnitude * 1000) / 1000 < 1 ? USD_3.format(value) : USD_2.format(value);
}

/**
 * A limit someone typed, such as a cap or a budget: in dollars and cents
 * (`$0.75`, `$25.00`), with more decimals only when the amount has them.
 */
export function formatBudget(value: number): string {
  if (!Number.isFinite(value)) return MISSING;
  return Math.abs(value * 100 - Math.round(value * 100)) < 1e-9 ? USD_2.format(value) : formatUsd(value);
}

/** `850ms`, `22.4s`, `3m07s`, `2h05m`. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return MISSING;
  const wholeMs = Math.round(ms);
  if (wholeMs < 1_000) return `${wholeMs}ms`;

  const tenths = Math.round(ms / 100);
  if (tenths < 600) return `${(tenths / 10).toFixed(1)}s`;

  const seconds = Math.round(ms / 1_000);
  if (seconds < 3_600) {
    return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}s`;
  }
  const minutes = Math.round(ms / 60_000);
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`;
}

/** `+0.031` / `-0.120`: a signed difference in score. */
export function formatDelta(value: number, digits = 3): string {
  if (!Number.isFinite(value)) return MISSING;
  const fixed = value.toFixed(digits);
  // -0.000 is a rounding artefact, not a direction.
  if (Number(fixed) === 0) return (0).toFixed(digits);
  return value > 0 ? `+${fixed}` : fixed;
}

/** `claude-haiku-4-5-20251001` → `haiku-4-5`: short enough for a column header. */
export function shortModel(model: string): string {
  return model.replace(/^claude-/, '').replace(/-\d{8}$/, '');
}

/** `1 run`, `3 runs`. */
export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

/** `results/<id>` from inside the repository; the absolute path from anywhere else. */
export function displayPath(cwd: string, target: string): string {
  const rel = path.relative(cwd, target);
  if (rel === '') return '.';
  return rel.startsWith('..') || path.isAbsolute(rel) ? target : rel;
}
