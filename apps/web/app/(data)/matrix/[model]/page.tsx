import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { EmptyState } from '../../../../components/EmptyState';
import { MatrixView } from '../../../../components/matrix/MatrixView';
import { modelLabel } from '../../../../lib/models';
import { EMPTY_PARAM, loadRunSet } from '../../../../lib/server/runSet';

interface Params {
  params: Promise<{ model: string }>;
}

export async function generateStaticParams(): Promise<{ model: string }[]> {
  const data = await loadRunSet();
  const models = (data?.models ?? []).map((model) => ({ model }));
  return models.length > 0 ? models : [{ model: EMPTY_PARAM }];
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { model } = await params;
  return {
    title: `Where it breaks on ${modelLabel(model)}`,
    description: `Every run on ${modelLabel(model)}, one square per repeat, and the traps each architecture fell into.`,
  };
}

export default async function ModelMatrixPage({ params }: Params) {
  const { model } = await params;
  const data = await loadRunSet();
  if (!data || data.records.length === 0) return <EmptyState />;
  if (!data.models.includes(model)) notFound();
  return <MatrixView data={data} model={model} />;
}
