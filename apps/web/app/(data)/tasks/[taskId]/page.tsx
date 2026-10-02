import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { EmptyState } from '../../../../components/EmptyState';
import { TaskView } from '../../../../components/tasks/TaskView';
import { defaultModel, findTask } from '../../../../lib/derive';
import { EMPTY_PARAM, loadRunSet } from '../../../../lib/server/runSet';
import { taskMetadata } from '../../../../lib/server/taskMetadata';

interface Params {
  params: Promise<{ taskId: string }>;
}

export async function generateStaticParams(): Promise<{ taskId: string }[]> {
  const data = await loadRunSet();
  const ids = (data?.catalog.tasks ?? []).map((task) => ({ taskId: task.id }));
  // A static export rejects an empty list, and an empty results/ is a state
  // the site must build in. The placeholder renders the empty state.
  return ids.length > 0 ? ids : [{ taskId: EMPTY_PARAM }];
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { taskId } = await params;
  return taskMetadata(taskId);
}

/** The default model's view of a task; every model has its own under /tasks/<id>/. */
export default async function TaskPage({ params }: Params) {
  const { taskId } = await params;
  const data = await loadRunSet();
  const model = data ? defaultModel(data.models) : undefined;
  if (!data || !model || data.records.length === 0) return <EmptyState />;
  if (!findTask(data.catalog, taskId)) notFound();
  return <TaskView data={data} taskId={taskId} model={model} />;
}
