import type { Metadata } from 'next';

import { findTask } from '../derive';
import { loadRunSet } from './runSet';

/** Title and description for a task page, from the published catalog. */
export async function taskMetadata(taskId: string): Promise<Metadata> {
  const data = await loadRunSet();
  const task = data ? findTask(data.catalog, taskId) : undefined;
  return {
    title: task ? `${task.title} (${task.id})` : taskId,
    description: task
      ? `${task.prompt || `Results for task ${taskId}`} Every architecture on every model, the traps it sets and where each design lost it.`.slice(0, 300)
      : `Results for task ${taskId}.`,
  };
}
