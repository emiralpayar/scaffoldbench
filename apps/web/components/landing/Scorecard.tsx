import type { Badge, Headline, Hypothesis } from '../../lib/scorecard';
import { BADGE_LABEL, interval, signed, times } from '../../lib/scorecard';
import { architectureName } from '../../lib/architectures';
import { modelShortName } from '../../lib/models';
import { sourceUrl } from '../../lib/site';

const BADGE_STYLE: Record<Badge, { glyph: string; className: string }> = {
  supported: { glyph: '✓', className: 'text-good border-good/50 bg-good/10' },
  consistent: { glyph: '≈', className: 'text-focus border-focus/50 bg-focus/10' },
  partial: { glyph: '◐', className: 'text-warn border-warn/50 bg-warn/10' },
  'not-supported': { glyph: '✗', className: 'text-bad border-bad/50 bg-bad/10' },
};

const KIND_LABEL: Record<Hypothesis['kind'], string> = {
  confirmatory: 'Confirmatory',
  secondary: 'Secondary',
  descriptive: 'Descriptive only',
};

/**
 * H1–H6 as registered before the first run, each with the verdict this run
 * set gave it. The predictions that failed are shown at the same size as the
 * ones that held.
 */
export function Scorecard({ hypotheses, runSetId }: { hypotheses: Hypothesis[]; runSetId: string }) {
  const prereg = sourceUrl('docs/PREREGISTRATION.md');
  const report = sourceUrl(`results/${runSetId}/REPORT.md`);
  const tally = (badge: Badge) => hypotheses.filter((h) => h.badge === badge).length;

  return (
    <section id="scorecard" aria-labelledby="scorecard-title" className="section scroll-mt-16 border-t border-rule">
      <div className="container-page">
        <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)] lg:items-end">
          <div className="max-w-[46rem]">
            <p className="eyebrow">Pre-registration scorecard</p>
            <h2 id="scorecard-title" className="h1 mt-4 text-ink">
              We wrote down {hypotheses.length === 6 ? 'six' : hypotheses.length} predictions before the first run.{' '}
              {tally('not-supported') * 2 === hypotheses.length
                ? 'Half of them failed.'
                : `${tally('not-supported')} of them failed.`}
            </h2>
            <p className="lede mt-6">
              The hypotheses, the analysis and its settings were committed and tagged{' '}
              <code className="code-inline">prereg-v1</code> before any of the 900 runs. Each verdict below is
              recomputed from the run records by the same code, with Holm adjustment within each family.
            </p>
          </div>
          <ul className="flex flex-wrap gap-2 lg:justify-end">
            {(['supported', 'consistent', 'partial', 'not-supported'] as Badge[]).map((badge) =>
              tally(badge) > 0 ? (
                <li key={badge} className={`rounded-full border px-3 py-1 font-mono text-[0.75rem] ${BADGE_STYLE[badge].className}`}>
                  {BADGE_STYLE[badge].glyph} {tally(badge)} {BADGE_LABEL[badge].toLowerCase()}
                </li>
              ) : null,
            )}
          </ul>
        </div>

        <ol className="mt-12 grid gap-px overflow-hidden rounded-[16px] border border-rule bg-rule md:grid-cols-2 lg:grid-cols-3">
          {hypotheses.map((h) => (
            <li key={h.id} className="flex min-w-0 flex-col bg-surface p-6 sm:p-7">
              <div className="flex items-start justify-between gap-4">
                <span className="font-serif text-[2.75rem] leading-none tracking-[-0.02em] text-ink">{h.id}</span>
                <span
                  className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 font-mono text-[0.75rem] uppercase tracking-[0.06em] ${BADGE_STYLE[h.badge].className}`}
                >
                  <span aria-hidden>{BADGE_STYLE[h.badge].glyph}</span>
                  {BADGE_LABEL[h.badge]}
                </span>
              </div>
              <p className="eyebrow mt-5">{KIND_LABEL[h.kind]}</p>
              <h3 className="mt-1.5 text-[1.125rem] font-medium leading-snug text-ink">{h.name}</h3>
              <p className="mt-2 text-[0.9375rem] leading-relaxed text-muted">
                <span className="text-ink-2">Predicted:</span> {h.claim}
              </p>
              <p className="mt-4 border-t border-rule pt-4 text-[0.9375rem] leading-relaxed text-ink-2">{h.result}</p>
            </li>
          ))}
        </ol>

        <p className="mt-6 max-w-[52rem] text-[0.875rem] leading-relaxed text-muted">
          H1–H3 are confirmatory (the baseline family); H4 and H5 are secondary, each its own family; H6 has three
          tasks, fewer than the five a verdict needs, so it is described rather than tested.{' '}
          {prereg ? (
            <a href={prereg} className="link">
              The pre-registration
            </a>
          ) : (
            'The pre-registration (docs/PREREGISTRATION.md)'
          )}{' '}
          also discloses the pilot and the two changes it led to.
          {report ? (
            <>
              {' '}
              Every number:{' '}
              <a href={report} className="link">
                <code className="code-inline">REPORT.md</code>
              </a>
              .
            </>
          ) : null}
        </p>
      </div>
    </section>
  );
}

/**
 * The exploratory observation: a scaffold on a mid model shown equivalent to
 * the plain agent one model up, for less. Labelled as exploratory wherever it
 * appears; it was computed by the pre-registered analysis but not predicted.
 */
export function Observation({ match, margin }: { match: NonNullable<Headline['match']>; margin: number }) {
  return (
    <section aria-labelledby="observation-title" className="section border-t border-rule bg-surface/50">
      <div className="container-page">
        <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:items-center lg:gap-16">
          <div>
            <p className="flex flex-wrap items-center gap-3">
              <span className="eyebrow">One thing worth a second look</span>
              <span className="chip-warn">Exploratory · not pre-registered</span>
            </p>
            <h2 id="observation-title" className="h2 mt-4 text-ink">
              {architectureName(match.strategyId)} on {modelShortName(match.model)} matched a single agent on{' '}
              {modelShortName(match.nextModel)}, at {times(match.costRatio)} the cost.
            </h2>
            <p className="prose-serif mt-5">
              {match.own ? (
                <>
                  The planner did not separably beat {modelShortName(match.model)}&apos;s own single agent (
                  <span className="num">{signed(match.own.scoreDelta.mean)}</span>, {verdictPhrase(match.own.verdict)}).
                  What it did was close enough of the gap to {modelShortName(match.nextModel)} for the equivalence test to
                  pass: within ±{margin.toFixed(2)} of {modelShortName(match.nextModel)} working alone, on the same tasks
                  and repeats.
                </>
              ) : (
                <>
                  It scored within ±{margin.toFixed(2)} of {modelShortName(match.nextModel)} working alone, on the same
                  tasks and repeats.
                </>
              )}
              {match.plain ? (
                <>
                  {' '}
                  {modelShortName(match.model)}&apos;s single agent is cheaper still (
                  <span className="num">{times(match.plain.costRatio)}</span>) but scored{' '}
                  <span className="num">{signed(match.plain.scoreDelta.mean)}</span> against it, {verdictPhrase(match.plain.verdict)}.
                </>
              ) : null}{' '}
              The comparison comes from the analysis&apos;s scale family, computed but not predicted, so read it as a lead
              for the next run set rather than a finding of this one.
            </p>
          </div>
          <dl className="card grid grid-cols-2 gap-px overflow-hidden bg-rule p-0">
            <Cell
              label="Score difference"
              value={signed(match.scoreDelta.mean)}
              detail={`95% CI ${interval(match.scoreDelta)}`}
            />
            <Cell label="Verdict" value={match.verdict} detail={`within ±${margin.toFixed(2)}, two one-sided tests`} />
            <Cell label="Cost ratio" value={times(match.costRatio)} detail="paired, geometric mean per cell" />
            <Cell label="Pairs" value={String(match.pairs)} detail={`${match.tasks} tasks, paired by task and repeat`} />
          </dl>
        </div>
      </div>
    </section>
  );
}

function verdictPhrase(verdict: string): string {
  return verdict === 'inconclusive' ? 'not separable' : verdict === 'equivalent' ? 'shown equivalent' : `shown ${verdict}`;
}

function Cell({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="bg-surface p-5 sm:p-6">
      <dt className="eyebrow">{label}</dt>
      <dd className="num mt-2 text-[1.75rem] leading-none tracking-[-0.02em] text-ink">{value}</dd>
      <dd className="mt-2 text-[0.8125rem] leading-snug text-muted">{detail}</dd>
    </div>
  );
}
