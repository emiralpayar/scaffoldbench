import type { Metadata } from 'next';

import { findTask } from '../derive';
import { pageMetadata } from '../pageMetadata';
import { loadRunSet } from './runSet';

/** A description longer than this is cut by search results and link previews. */
const MAX_DESCRIPTION = 200;

/** The text up to `max` characters, cut at a word and marked as cut. */
function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max - 1);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), 1)).replace(/[\s,;:.-]+$/, '')}…`;
}

/**
 * Title and description for a task page, from the published catalog. The
 * model-less route is the default model's view of the same task, so the
 * model only changes the canonical address.
 */
export async function taskMetadata(taskId: string, model?: string): Promise<Metadata> {
  const data = await loadRunSet();
  const task = data ? findTask(data.catalog, taskId) : undefined;
  const path = model ? `/tasks/${taskId}/${model}/` : `/tasks/${taskId}/`;
  if (!task) return pageMetadata({ title: taskId, description: `Results for task ${taskId}.`, path });
  return pageMetadata({
    title: `${task.title} (${task.id})`,
    description: `${clip(task.prompt || `Results for task ${taskId}.`, MAX_DESCRIPTION)} Every architecture on every model, and where each design lost it.`,
    path,
  });
}
