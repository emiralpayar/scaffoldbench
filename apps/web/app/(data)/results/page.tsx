import type { Metadata } from 'next';
import Link from 'next/link';

import { ArchitectureGlyph } from '../../../components/ArchitectureGlyph';
import { EmptyState } from '../../../components/EmptyState';
import { PageHeader, Stat } from '../../../components/Layout';
import { RunSetBanner } from '../../../components/RunSetMeta';
import { ForestPlot, forestDomain } from '../../../components/charts/ForestPlot';
import { analyzeForSite } from '../../../lib/analysis';
import { describeModel, describeUnverifiedModel, forestRows, modelTableRows } from '../../../lib/chartData';
import { formatInt, formatUsd } from '../../../lib/format';
import { modelLabel, modelShortName } from '../../../lib/models';
import { loadRunSet } from '../../../lib/server/runSet';

export const metadata: Metadata = {
  title: 'Results',
  description:
    'Mean score, pass rate, cost and latency for every harness architecture on every model, each against the single-agent control, with task-clustered intervals.',
};

const VERDICT_LABEL = {
  better: { text: 'better', className: 'text-good' },
  worse: { text: 'worse', className: 'text-bad' },
  equivalent: { text: 'equivalent', className: 'text-ink-2' },
  inconclusive: { text: 'not separable', className: 'text-muted' },
  control: { text: 'control', className: 'text-ink-2' },
  '—': { text: '—', className: 'text-muted' },
  unverified: { text: 'no verdict', className: 'text-muted' },
} as const;

export default async function ResultsPage() {
  const data = await loadRunSet();
  if (!data || data.records.length === 0) return <EmptyState />;

  const analysis = analyzeForSite(data.records);
  const { health } = analysis;
  const allRows = analysis.models.flatMap((model) => forestRows(model));
  const domain = allRows.length > 0 ? forestDomain(allRows) : undefined;
  const spent = data.records.reduce((sum, record) => sum + record.costUsd, 0);
  // Without fidelity checks a row may not be the design it is named after.
  const verified = data.verification !== 'unverified';

  return (
    <>
      <RunSetBanner data={data} />

      <PageHeader
        eyebrow="Results"
        title="Every architecture against a single agent, model by model"
        lede="Each architecture is compared with the single-agent control on the same tasks and repeats. Intervals are bootstrapped over tasks, so a lucky task cannot pass for a better design."
        aside={
          <div className="flex flex-wrap gap-x-8 gap-y-4">
            <Stat label={verified ? 'Ranked runs' : 'Runs'} value={formatInt(health.rankable)} />
            <Stat label="Models" value={data.models.length} />
            <Stat label="Spent" value={formatUsd(spent)} />
          </div>
        }
      />

      {health.integrityFailed + health.apiErrors > 0 ? (
        <p className="mb-10 max-w-3xl text-[0.9375rem] leading-relaxed text-ink-2">
          <strong className="font-medium text-ink">
            {health.integrityFailed + health.apiErrors} of {formatInt(health.total)} runs are excluded
          </strong>{' '}
          from every number below: {health.integrityFailed} failed a fidelity check (the architecture
          did not run as designed) and {health.apiErrors} were lost to API errors after retries.
        </p>
      ) : null}

      {analysis.models.map((model) => {
        const rows = modelTableRows(model, analysis.baselineId);
        const baseline = model.architectures.find((a) => a.strategyId === analysis.baselineId);
        return (
          <section key={model.model} aria-labelledby={`model-${model.model}`} className="mb-16">
            <div className="mb-5 flex flex-wrap items-baseline justify-between gap-3">
              <h2 id={`model-${model.model}`} className="h2 text-ink">
                {modelShortName(model.model)}
              </h2>
              <span className="num text-[0.8125rem] text-muted">{modelLabel(model.model)} · {model.model}</span>
            </div>
            <p className="prose-serif mb-6 max-w-3xl">
              {verified ? describeModel(model) : describeUnverifiedModel(model)}
            </p>

            <div className="card p-5 sm:p-6">
              <ForestPlot
                rows={forestRows(model)}
                title={modelShortName(model.model)}
                {...(domain ? { domain } : {})}
                {...(baseline ? { reference: { value: baseline.score.mean, label: 'single' } } : {})}
              />
            </div>

            <div className="scroll-x mt-4 rounded-[14px] border border-rule bg-surface">
              <table className="w-full min-w-[52rem] border-collapse text-[0.875rem]">
                <thead>
                  <tr className="border-b border-rule text-left">
                    {['Architecture', 'Runs', 'Score', 'Interval', 'Pass', 'Cost / run', 'Latency', 'Δ vs single', 'Interval', 'Cost ×', 'Verdict'].map((head, index) => (
                      <th
                        key={index}
                        scope="col"
                        className={`eyebrow whitespace-nowrap px-3 py-2.5 font-normal ${index === 0 ? 'sticky left-0 z-[1] bg-surface' : 'text-right'}`}
                      >
                        {head}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => {
                    const verdict =
                      verified || row.verdict === 'control' || row.verdict === '—'
                        ? VERDICT_LABEL[row.verdict]
                        : VERDICT_LABEL.unverified;
                    return (
                      <tr key={row.strategyId} className="border-b border-rule last:border-0">
                        {/* Pinned, so a phone scrolling to the deltas still sees whose they are. */}
                        <th scope="row" className="sticky left-0 z-[1] bg-surface px-3 py-2.5 text-left font-normal">
                          <span className="flex items-center gap-2.5">
                            <span className="hidden sm:contents">
                              <ArchitectureGlyph id={row.strategyId} width={30} />
                            </span>
                            <span className="whitespace-nowrap text-ink">{row.label}</span>
                            {row.onFrontier ? (
                              <span className="chip !px-1.5 !py-0 !text-[0.625rem]" title="On the mean score-against-cost frontier for this model">
                                frontier
                              </span>
                            ) : null}
                          </span>
                        </th>
                        <td className="num whitespace-nowrap px-3 py-2.5 text-right text-ink-2">{row.runs}</td>
                        <td className="num whitespace-nowrap px-3 py-2.5 text-right text-ink">{row.score}</td>
                        <td className="num whitespace-nowrap px-3 py-2.5 text-right text-muted">{row.scoreInterval}</td>
                        <td className="num whitespace-nowrap px-3 py-2.5 text-right text-ink-2">{row.passRate}</td>
                        <td className="num whitespace-nowrap px-3 py-2.5 text-right text-ink-2">{row.cost}</td>
                        <td className="num whitespace-nowrap px-3 py-2.5 text-right text-ink-2">{row.latency}</td>
                        <td className="num whitespace-nowrap px-3 py-2.5 text-right text-ink">{row.delta}</td>
                        <td className="num whitespace-nowrap px-3 py-2.5 text-right text-muted">{row.deltaInterval}</td>
                        <td className="num whitespace-nowrap px-3 py-2.5 text-right text-ink-2">{row.costMultiple}</td>
                        <td className={`whitespace-nowrap px-3 py-2.5 text-right ${verdict.className}`}>{verdict.text}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        );
      })}

      <p className="max-w-3xl text-[0.8125rem] leading-relaxed text-muted">{analysis.method}</p>

      <nav className="mt-10 flex flex-wrap gap-x-6 gap-y-2 border-t border-rule pt-5 text-[0.9375rem]">
        <Link href="/pareto/" className="link">
          Score against cost →
        </Link>
        <Link href="/matrix/" className="link">
          Every run, task by task →
        </Link>
      </nav>
    </>
  );
}
