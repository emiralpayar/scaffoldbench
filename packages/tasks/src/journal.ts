import type { ToolCall } from '@arena/core';

/**
 * Queries over the tool journal, shared by every world's scorer.
 *
 * The journal is the record of what the agent actually did, in order, so it is
 * where process rules ("read the policy before refunding") and irreversible
 * actions ("paged the wrong engineer, then corrected it") are scored. The final
 * world cannot answer either question: consulting a rule leaves no trace in
 * state, and a corrected page still woke somebody up.
 */

/** Exact values for some of a call's arguments, or a predicate over all of them. */
export type ArgsFilter =
  | Readonly<Record<string, unknown>>
  | ((args: Record<string, unknown>) => boolean);

export interface CallFilter {
  /** One tool name, or several that count as the same kind of act. */
  name: string | readonly string[];
  args?: ArgsFilter;
  /**
   * Count calls the tool rejected as well. Off by default: a rejected call
   * changed nothing, so for most rules only successful calls matter. Turn it on
   * for rules about attempts, such as probing a booking API by trial and error.
   */
  includeFailed?: boolean;
}

export function callMatches(entry: ToolCall, filter: CallFilter): boolean {
  if (!filter.includeFailed && !entry.ok) return false;
  const names = typeof filter.name === 'string' ? [filter.name] : filter.name;
  if (!names.includes(entry.name)) return false;
  const args = filter.args;
  if (args === undefined) return true;
  if (typeof args === 'function') return args(entry.args);
  return Object.entries(args).every(([key, value]) => sameValue(entry.args[key], value));
}

export function findCalls(journal: readonly ToolCall[], filter: CallFilter): ToolCall[] {
  return journal.filter((entry) => callMatches(entry, filter));
}

export function hasCall(journal: readonly ToolCall[], filter: CallFilter): boolean {
  return journal.some((entry) => callMatches(entry, filter));
}

export function countCalls(journal: readonly ToolCall[], filter: CallFilter): number {
  return findCalls(journal, filter).length;
}

/** Position of the first matching call, or -1. */
export function firstCallIndex(journal: readonly ToolCall[], filter: CallFilter): number {
  return journal.findIndex((entry) => callMatches(entry, filter));
}

/** Position of the last matching call, or -1. */
export function lastCallIndex(journal: readonly ToolCall[], filter: CallFilter): number {
  for (let index = journal.length - 1; index >= 0; index--) {
    const entry = journal[index];
    if (entry && callMatches(entry, filter)) return index;
  }
  return -1;
}

/**
 * True when `action` happened before any `prerequisite` had succeeded, or with
 * no prerequisite at all. False when the action never happened: a rule about
 * acting cannot be broken by not acting.
 */
export function actedBeforeConsulting(
  journal: readonly ToolCall[],
  action: CallFilter,
  prerequisite: CallFilter,
): boolean {
  const acted = firstCallIndex(journal, action);
  if (acted === -1) return false;
  const consulted = firstCallIndex(journal, prerequisite);
  return consulted === -1 || consulted > acted;
}

/** Match an argument against several accepted values, e.g. any of a set of ids. */
export function argIn(
  key: string,
  values: readonly unknown[],
): (args: Record<string, unknown>) => boolean {
  return (args) => values.some((value) => sameValue(args[key], value));
}

/** Text of a string argument, or '' when it is missing or not a string. */
export function textArg(entry: ToolCall, key: string): string {
  const value = entry.args[key];
  return typeof value === 'string' ? value : '';
}

function sameValue(actual: unknown, expected: unknown): boolean {
  if (Object.is(actual, expected)) return true;
  if (typeof actual !== 'object' || typeof expected !== 'object') return false;
  if (actual === null || expected === null) return false;
  return JSON.stringify(actual) === JSON.stringify(expected);
}
