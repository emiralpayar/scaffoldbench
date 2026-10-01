import type { Task, TaskCategory } from '@arena/core';

import { researchTasks } from './research';
import { airlineExpertTasks, airlineTasks } from './worlds/airline';
import { ecommerceExpertTasks, ecommerceTasks } from './worlds/ecommerce';
import { supportExpertTasks, supportTasks } from './worlds/support';

/**
 * The task set, in the order everything renders in.
 *
 * Selection never reorders: a run of `--tasks support,airline` and a run of
 * `--tasks airline,support` produce the same matrix, so two reports of the same
 * set are comparable line by line however the flags were typed.
 */
export const ALL_TASKS: Task[] = [
  ...airlineTasks,
  ...airlineExpertTasks,
  ...ecommerceTasks,
  ...ecommerceExpertTasks,
  ...supportTasks,
  ...supportExpertTasks,
  ...researchTasks,
];

export const TASK_CATEGORIES: readonly TaskCategory[] = ['tool-use', 'research'];

/** Every world present in `ALL_TASKS`, in declaration order. */
export const TASK_WORLDS: readonly string[] = [...new Set(ALL_TASKS.map((task) => task.world))];

export function taskById(id: string): Task | undefined {
  return ALL_TASKS.find((task) => task.id === id);
}

/**
 * Resolve one selector: `all`, a category, a world, an exact id, or a glob.
 * Returns an empty array when nothing matches, which the caller treats as an
 * error rather than as an empty selection.
 */
function matchSelector(selector: string): Task[] {
  if (selector === 'all') return [...ALL_TASKS];

  if ((TASK_CATEGORIES as readonly string[]).includes(selector)) {
    return ALL_TASKS.filter((task) => task.category === selector);
  }

  const byWorld = ALL_TASKS.filter((task) => task.world === selector);
  if (byWorld.length > 0) return byWorld;

  const exact = ALL_TASKS.filter((task) => task.id === selector);
  if (exact.length > 0) return exact;

  if (selector.includes('*')) {
    const pattern = globToRegExp(selector);
    return ALL_TASKS.filter((task) => pattern.test(task.id));
  }

  return [];
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

/**
 * Select tasks by any mix of selectors. Overlapping selectors are fine — the
 * result is de-duplicated and returned in declaration order.
 */
export function getTasks(selectors?: string[]): Task[] {
  const cleaned = (selectors ?? []).map((selector) => selector.trim()).filter((s) => s !== '');
  if (cleaned.length === 0 || cleaned.includes('all')) return [...ALL_TASKS];

  const wanted = new Set<string>();
  const unknown: string[] = [];

  for (const selector of cleaned) {
    const matched = matchSelector(selector);
    if (matched.length === 0) {
      unknown.push(selector);
      continue;
    }
    for (const task of matched) wanted.add(task.id);
  }

  if (unknown.length > 0) {
    throw new Error(
      `Unknown task selector(s): ${unknown.join(', ')}.\n` +
        `Valid task ids: ${ALL_TASKS.map((task) => task.id).join(', ')}.\n` +
        `Also accepted: all, categories (${TASK_CATEGORIES.join(', ')}), ` +
        `worlds (${TASK_WORLDS.join(', ')}), and globs such as airline-*.`,
    );
  }

  return ALL_TASKS.filter((task) => wanted.has(task.id));
}
