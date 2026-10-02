import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { EmptyState } from '../../../../../components/EmptyState';
import { TaskView } from '../../../../../components/tasks/TaskView';
import { findTask } from '../../../../../lib/derive';
import { EMPTY_PARAM, loadRunSet } from '../../../../../lib/server/runSet';
import { taskMetadata } from '../../../../../lib/server/taskMetadata';

interface Params {
  params: Promise<{ taskId: string; model: string }>;
}

export async function generateStaticParams(): Promise<{ taskId: string; model: string }[]> {
  const data = await loadRunSet();
  const pairs = (data?.catalog.tasks ?? []).flatMap((task) =>
    (data?.models ?? []).map((model) => ({ taskId: task.id, model })),
  );
  return pairs.length > 0 ? pairs : [{ taskId: EMPTY_PARAM, model: EMPTY_PARAM }];
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { taskId } = await params;
  return taskMetadata(taskId);
}

export default async function TaskModelPage({ params }: Params) {
  const { taskId, model } = await params;
  const data = await loadRunSet();
  if (!data || data.records.length === 0) return <EmptyState />;
  if (!findTask(data.catalog, taskId) || !data.models.includes(model)) notFound();
  return <TaskView data={data} taskId={taskId} model={model} />;
}
