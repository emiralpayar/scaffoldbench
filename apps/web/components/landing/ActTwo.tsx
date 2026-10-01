import Link from 'next/link';

import type { SiteAnalysis } from '../../lib/analysis';
import { payoffData, payoffHeadline, scaffoldScaleGroups, scaleHeadline } from '../../lib/chartData';
import { PayoffSmallMultiples } from '../charts/PayoffChart';
import { ScaffoldScaleChart } from '../charts/ScatterCharts';

/**
 * Act 2: the answer, once there is one to give. With no verified run set the
 * section says so and plots nothing; a chart of numbers that do not exist
 * yet would be the opposite of the point.
 */
export function ActTwo({ analysis, synthetic }: { analysis: SiteAnalysis | null; synthetic: boolean }) {
  return (
    <section id="act-2" aria-labelledby="act-2-title" className="section border-t border-rule bg-surface/50">
      <div className="container-page">
        <div className="max-w-[46rem]">
          <p className="eyebrow">Act 2 · Scaffold or scale?</p>
          <h2 id="act-2-title" className="h1 mt-4 text-ink">
            Does the extra structure pay for itself<span className="kern-q">?</span>
          </h2>
          <p className="lede mt-6">
            Every architecture against a plain single agent on the same model, the same tasks and the
            same repeats. Up the page is score gained; across it, what that cost. An interval wholly
            above the grey band is structure that bought real score.
          </p>
        </div>

        {synthetic ? (
          <div role="note" className="banner banner-warn mt-8">
            <p className="banner-title">Synthetic data — not a measurement</p>
            <p className="banner-body">
              The charts below are drawn from numbers fabricated by{' '}
              <code className="code-inline">scripts/generate-demo-data.ts</code> to build the site. They
              show what the charts will look like, not what any architecture does.
            </p>
          </div>
        ) : null}

        {analysis ? <Charts analysis={analysis} /> : <Pending />}
      </div>
    </section>
  );
}

function Charts({ analysis }: { analysis: SiteAnalysis }) {
  const payoff = payoffData(analysis);
  const groups = scaffoldScaleGroups(analysis);
  const scale = scaleHeadline(analysis);

  return (
    <>
      <p className="mt-10 max-w-[46rem] font-serif text-[1.375rem] leading-snug text-ink">
        {payoffHeadline(analysis)}
      </p>
      <div className="card mt-8 p-5 sm:p-7">
        <PayoffSmallMultiples data={payoff} method={analysis.method} />
      </div>

      {analysis.models.length > 1 ? (
        <div className="mt-20 grid gap-10 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
          <div>
            <h3 className="h2 text-ink">
              Or buy a bigger model<span className="kern-q">?</span>
            </h3>
            <p className="prose-serif mt-4">
              Adding structure is one way to spend more per task. Moving a plain agent up a model
              tier is the other. Each ring is a single agent, labelled by model; spokes reach that
              model&apos;s architectures, and the dashed arrows are the upgrade to the next model.
            </p>
            {scale ? <p className="mt-5 text-[0.9375rem] leading-relaxed text-ink">{scale}</p> : null}
            <p className="mt-5 text-[0.9375rem]">
              <Link href="/results/" className="link">
                Every architecture, model by model →
              </Link>
            </p>
          </div>
          <div className="card min-w-0 p-5 sm:p-7">
            <ScaffoldScaleChart groups={groups} />
          </div>
        </div>
      ) : null}
    </>
  );
}

function Pending() {
  return (
    <div className="mt-10 grid gap-8 rounded-[14px] border border-dashed border-rule-strong p-6 sm:p-10 md:grid-cols-[minmax(0,1fr)_minmax(0,18rem)] md:items-center">
      <div>
        <p className="h3 text-ink">No Act 2 results are published yet.</p>
        <p className="prose-serif mt-3 max-w-[36rem]">
          This chart is drawn only from a run set whose every record carries its fidelity checks, so
          nothing appears here until one exists. When it does, each architecture will sit at its
          cost relative to a single agent, against the score difference, with an interval on both,
          for every model in the run.
        </p>
      </div>
      <svg viewBox="0 0 280 180" className="w-full max-w-[18rem] justify-self-center" aria-hidden>
        <rect x={30} y={70} width={240} height={36} fill="var(--sunken)" />
        <line x1={30} x2={270} y1={88} y2={88} stroke="var(--ink-2)" strokeWidth={1} />
        <line x1={80} x2={80} y1={10} y2={160} stroke="var(--rule-strong)" strokeWidth={1} />
        <line x1={30} x2={270} y1={160} y2={160} stroke="var(--axis)" strokeWidth={1} />
        <line x1={30} x2={30} y1={10} y2={160} stroke="var(--axis)" strokeWidth={1} />
        <circle cx={80} cy={88} r={6} fill="var(--plane)" stroke="var(--arch-single)" strokeWidth={2} />
        <text x={88} y={82} fontSize={11} fill="var(--muted)">
          single
        </text>
        <text x={150} y={176} fontSize={10.5} fill="var(--muted)" textAnchor="middle">
          cost relative to single
        </text>
        <text x={12} y={88} fontSize={10.5} fill="var(--muted)" textAnchor="middle" transform="rotate(-90 12 88)">
          score vs single
        </text>
      </svg>
    </div>
  );
}
