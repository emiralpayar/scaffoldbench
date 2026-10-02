import type { Metadata } from 'next';

import { EmptyState } from '../../../components/EmptyState';
import { ModelResults } from '../../../components/leaderboard/ModelResults';
import { defaultModel } from '../../../lib/derive';
import { pageMetadata } from '../../../lib/pageMetadata';
import { analysisFor } from '../../../lib/server/analysis';
import { loadRunSet } from '../../../lib/server/runSet';

export const metadata: Metadata = pageMetadata({
  title: 'Results',
  description:
    'Every harness architecture ranked by paired comparison, model by model, with intervals on score, pass rate, cost and latency, and ties shown as ties.',
  path: '/results/',
});

/** The default model's results; every model has its own page under /results/. */
export default async function ResultsPage() {
  const data = await loadRunSet();
  const model = data ? defaultModel(data.models) : undefined;
  if (!data || !model || data.records.length === 0) return <EmptyState />;
  return <ModelResults data={data} analysis={analysisFor(data)} model={model} />;
}
