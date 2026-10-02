import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { EmptyState } from '../../../../components/EmptyState';
import { ModelResults } from '../../../../components/leaderboard/ModelResults';
import { modelLabel } from '../../../../lib/models';
import { pageMetadata } from '../../../../lib/pageMetadata';
import { analysisFor } from '../../../../lib/server/analysis';
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
  return pageMetadata({
    title: `Results on ${modelLabel(model)}`,
    description: `Every harness architecture on ${modelLabel(model)}, ranked by paired comparison with intervals on score, pass rate, cost and latency.`,
    path: `/results/${model}/`,
  });
}

export default async function ModelResultsPage({ params }: Params) {
  const { model } = await params;
  const data = await loadRunSet();
  if (!data || data.records.length === 0) return <EmptyState />;
  if (!data.models.includes(model)) notFound();
  return <ModelResults data={data} analysis={analysisFor(data)} model={model} />;
}
