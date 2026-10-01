import type { Metadata } from 'next';
import Link from 'next/link';

import { EmptyState } from '../../../../components/EmptyState';
import { PageHeader } from '../../../../components/Layout';
import { RunSetBanner } from '../../../../components/RunSetMeta';
import { ScaffoldScaleChart } from '../../../../components/charts/ScatterCharts';
import { ModelSwitcher } from '../../../../components/leaderboard/ModelSwitcher';
import { resultsSwitcher } from '../../../../components/leaderboard/ModelResults';
import { ScaleTable } from '../../../../components/leaderboard/ScaleTable';
import { scaffoldScaleGroups, scaleHeadline } from '../../../../lib/chartData';
import { modelShortName } from '../../../../lib/models';
import { analysisFor } from '../../../../lib/server/analysis';
import { loadRunSet } from '../../../../lib/server/runSet';

export const metadata: Metadata = {
  title: 'Scaffold or scale?',
  description:
    'Is a scaffold on a smaller model worth more than a plain agent on the next model up? Every architecture on every model on one score-against-cost plane, with the paired contrasts.',
};

export default async function ScalePage() {
  const data = await loadRunSet();
  if (!data || data.records.length === 0) return <EmptyState />;
  const analysis = analysisFor(data);
  const verified = data.verification !== 'unverified';
  const headline = scaleHeadline(analysis);

  return (
    <>
      <RunSetBanner data={data} />
      <PageHeader
        eyebrow="Results · every model"
        title={
          <>
            Scaffold or scale<span className="kern-q">?</span>
          </>
        }
        lede="There are two ways to spend more on a task: wrap the model in structure, or move a plain agent up a model tier. Each scaffold on one model is compared, task by task, with a single agent on the next model up."
      />
      <div className="-mt-4 mb-10">
        <ModelSwitcher items={resultsSwitcher(data.models, 'scale')} />
      </div>

      {data.models.length < 2 ? (
        <p className="prose-serif max-w-2xl">
          This run set covers one model ({data.models.map(modelShortName).join(', ')}), so there is no next model up
          to compare with. The view fills in once a run set spans more than one.
        </p>
      ) : (
        <>
          {headline && verified ? (
            <p className="mb-8 max-w-[46rem] font-serif text-[1.375rem] leading-snug text-ink">{headline}</p>
          ) : null}
          <div className="card mb-12 p-5 sm:p-7">
            <ScaffoldScaleChart groups={scaffoldScaleGroups(analysis)} />
          </div>
          <section aria-labelledby="contrasts-title" className="mb-12">
            <h2 id="contrasts-title" className="h2 mb-6 text-ink">
              Each scaffold against the next model up
            </h2>
            <ScaleTable analysis={analysis} verified={verified} />
          </section>
          <p className="max-w-3xl text-[0.8125rem] leading-relaxed text-muted">{analysis.method}</p>
        </>
      )}

      <nav aria-label="More results" className="mt-10 flex flex-wrap gap-x-6 gap-y-2 border-t border-rule pt-5 text-[0.9375rem]">
        <Link href="/results/" className="link">
          One model at a time →
        </Link>
        <Link href="/methodology/" className="link">
          How the contrasts are computed →
        </Link>
      </nav>
    </>
  );
}
