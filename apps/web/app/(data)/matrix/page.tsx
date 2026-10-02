import type { Metadata } from 'next';

import { EmptyState } from '../../../components/EmptyState';
import { MatrixView } from '../../../components/matrix/MatrixView';
import { defaultModel } from '../../../lib/derive';
import { pageMetadata } from '../../../lib/pageMetadata';
import { loadRunSet } from '../../../lib/server/runSet';

export const metadata: Metadata = pageMetadata({
  title: 'Where it breaks',
  description:
    'Every run of every architecture on every task, as one square per repeat, and which architectures fell into each declared trap.',
  path: '/matrix/',
});

export default async function MatrixPage() {
  const data = await loadRunSet();
  const model = data ? defaultModel(data.models) : undefined;
  if (!data || !model || data.records.length === 0) return <EmptyState />;
  return <MatrixView data={data} model={model} />;
}
