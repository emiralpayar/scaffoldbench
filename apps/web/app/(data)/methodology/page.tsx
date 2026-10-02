import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import { PageHeader } from '../../../components/Layout';
import Link from '../../../components/Link';
import { RunSetBanner } from '../../../components/RunSetMeta';
import { ScrollRegion } from '../../../components/ScrollRegion';
import { VerdictDiagram } from '../../../components/methodology/VerdictDiagram';
import { analyzeForSite } from '../../../lib/analysis';
import { ARCHITECTURES } from '../../../lib/architectures';
import { formatInt } from '../../../lib/format';
import { modelShortName } from '../../../lib/models';
import { pageMetadata } from '../../../lib/pageMetadata';
import { analysisFor } from '../../../lib/server/analysis';
import { loadRunSet } from '../../../lib/server/runSet';
import { sourceUrl } from '../../../lib/site';

export const metadata: Metadata = pageMetadata({
  title: 'Methodology',
  description:
    'How ScaffoldBench scores a run, proves an architecture ran, turns runs into claims with paired, task-clustered statistics, and what the benchmark does not show.',
  path: '/methodology/',
});

const SECTIONS = [
  { id: 'design', label: 'What is compared' },
  { id: 'scoring', label: 'How a run is scored' },
  { id: 'fidelity', label: 'A run has to have run' },
  { id: 'statistics', label: 'How runs become claims' },
  { id: 'reading', label: 'Reading a result' },
  { id: 'prereg', label: 'Pre-registered' },
  { id: 'limits', label: 'What this does not show' },
  { id: 'reproduce', label: 'Reproduce it' },
];

export default async function MethodologyPage() {
  const data = await loadRunSet();
  // The method is a property of the code, not of the data, so the page reads
  // the same on a site with nothing benchmarked yet.
  const analysis = data && data.records.length > 0 ? analysisFor(data) : analyzeForSite([]);
  const manifest = data?.manifest ?? null;
  const tasks = data ? new Set(data.records.map((record) => record.taskId)).size : 0;
  const architectures = data ? new Set(data.records.map((record) => record.strategyId)).size : ARCHITECTURES.length;
  const grid =
    data && data.records.length > 0 && data.verification !== 'unverified'
      ? `${data.models.length} model${data.models.length === 1 ? '' : 's'} (${data.models.map(modelShortName).join(', ')}) × ${architectures} architectures × ${tasks} tasks × ${manifest?.repeats ?? 'several'} repeats`
      : null;
  const doc = (path: string, label: string): ReactNode => {
    const url = sourceUrl(path);
    return url ? (
      <a href={url} className="link">
        <code className="code-inline">{label}</code>
      </a>
    ) : (
      <code className="code-inline">{label}</code>
    );
  };

  return (
    <>
      {data && data.records.length > 0 ? <RunSetBanner data={data} /> : null}

      <PageHeader
        eyebrow="Methodology"
        title="How the numbers are made."
        lede="What is held fixed, how a run is scored, how a run proves its architecture ran, how runs become claims, and what none of it can show. Every step names the file that does it."
      />

      <div className="grid gap-x-16 lg:grid-cols-[13rem_minmax(0,1fr)]">
        <nav aria-label="On this page" className="mb-10 lg:sticky lg:top-24 lg:mb-0 lg:self-start">
          <p className="eyebrow mb-3">On this page</p>
          <ol className="flex flex-wrap gap-x-5 gap-y-1.5 text-[0.875rem] lg:block lg:space-y-1.5">
            {SECTIONS.map((section, index) => (
              <li key={section.id}>
                <a href={`#${section.id}`} className="text-ink-2 hover:text-ink hover:underline">
                  <span className="num mr-2 text-[0.75rem] text-muted">{index + 1}</span>
                  {section.label}
                </a>
              </li>
            ))}
          </ol>
        </nav>

        <div className="min-w-0 max-w-[44rem] space-y-20">
          <Section id="design" title="What is compared">
            <p>
              ScaffoldBench is a grid of model, architecture, task and repeat.
              {grid ? (
                <>
                  {' '}
                  The run set published here is {grid}: <span className="num text-ink">{formatInt(data?.records.length ?? 0)}</span>{' '}
                  runs.
                </>
              ) : null}{' '}
              In every cell the only thing that changes is the harness around the model. The model, the tools the task
              offers, the task prompt, the domain policy appended to the system prompt, the reasoning effort and the cap
              on cost and wall-clock time per run are the same for every architecture.
            </p>
            <p>
              The six architectures are on the{' '}
              <Link href="/strategies/" className="link">
                designs
              </Link>{' '}
              page, each drawn as the calls it makes. The first of them, <code className="code-inline">single</code>, is the
              control: one agent with the full toolset. Every other architecture is measured as a difference from it, because
              the question is never whether an architecture works but whether its extra calls earn their cost.
            </p>
          </Section>

          <Section id="scoring" title="How a run is scored">
            <p>
              <strong className="font-medium text-ink">Tool-use tasks are graded by code.</strong> A task lists weighted
              assertions about the final state of its simulated world and about the journal of tool calls the agent made,
              such as whether it read the refund policy before it moved money. Rules add penalties that multiply the score,
              so a broken hard rule zeroes a run however well the rest went. A run passes at a score of 0.999 or more. No
              model decides who won.
            </p>
            <p>
              <strong className="font-medium text-ink">Research tasks are graded by a judge model</strong> against a rubric.
              Each item is scored several times and the median taken, so one unlucky grading cannot move a score. The score
              adds the coverage of the sources a thorough answer should have consulted, and an audit of the citations: an
              answer that cites a page the agent never fetched is penalised. The judge’s cost is tracked apart from the run’s, so a
              scoring model never flatters or penalises an architecture. In replay mode, research tasks read a recorded
              corpus of pages rather than the live web, so a run can be repeated.
            </p>
            <p>
              A task may also carry a <em>difficulty</em>, a <em>hypothesis</em> written before it was run (which
              architecture should do best, and why) and its <em>traps</em>: the specific ways a run can go wrong, each tied
              to the assertions that register it. The{' '}
              <Link href="/matrix/" className="link">
                matrix
              </Link>{' '}
              and the task pages show them.
            </p>
          </Section>

          <Section id="fidelity" title="A run has to have run">
            <p>
              The first run set tied five architectures because four of them never ran as designed, and nothing checked.{' '}
              <Link href="/postmortem/" className="link">
                The post-mortem
              </Link>{' '}
              tells it. Now every run carries a list of checks. The runner’s own say the harness did its job: no API failure,
              no harness tool denied, every tool server connected and no foreign one, no silent fallback on a default, every
              structured reply received. Each architecture adds checks that say what running as designed means for it: a plan
              with at least one step, a fan-out that happened, a verdict that was read, a selector that chose.
            </p>
            <p>
              A run that fails a check is <em>excluded</em> from every ranking and counted, never scored. A run lost to the
              API after the runner’s retries is excluded too, because an outage is not an architecture’s failure. Exclusions
              are not hidden: they are counted at the top of every results page, and every excluded run and the check that
              failed is listed on the{' '}
              <Link href="/health/" className="link">
                harness health
              </Link>{' '}
              page. A run set recorded without checks is shown but ranked nowhere.
            </p>
            <p>
              The runner’s checks are in {doc('packages/core/src/integrity.ts', 'packages/core/src/integrity.ts')}; each
              architecture’s are beside its strategy in <code className="code-inline">packages/strategies/src</code>.
            </p>
          </Section>

          <Section id="statistics" title="How runs become claims">
            <p>
              A benchmark this size overstates differences far more often than it misses them, so every choice below is
              there to keep a ranking honest. When the data cannot separate two architectures, the site says so.
            </p>
            <ul className="list-disc space-y-3 pl-5 marker:text-muted">
              <li>
                <strong className="font-medium text-ink">The task is the unit.</strong> The repeats of one task resemble
                each other much more than they resemble another task, so they are not independent evidence. Every interval
                resamples whole tasks, keeping each task’s repeats together.
              </li>
              <li>
                <strong className="font-medium text-ink">Comparisons are paired.</strong> Two architectures are compared on
                the same task and the same repeat, which removes the large variance between tasks. A pass rate carries a
                Wilson score interval; cost and latency are compared as ratios.
              </li>
              <li>
                <strong className="font-medium text-ink">Four verdicts, not two.</strong> A comparison ends{' '}
                <em>better</em>, <em>worse</em>, <em>equivalent</em> within a margin, or <em>not separable</em>. “Not
                separable” is a finding about the data, not a hidden tie.
              </li>
              <li>
                <strong className="font-medium text-ink">Many comparisons are paid for.</strong> Each family of verdicts is
                adjusted for the comparisons it makes at once, so the chance of any false call stays at 5% and the
                intervals are wider than they would be alone.
              </li>
              <li>
                <strong className="font-medium text-ink">The margin is fixed in advance.</strong> “Equivalent” means the
                whole interval sits within ±{analysis.margin.toFixed(2)} of score, a difference chosen before the data was
                seen.
              </li>
            </ul>
            <div className="rounded-[14px] border border-rule bg-surface px-5 py-4">
              <p className="eyebrow">What this site ran</p>
              <p className="mt-2 text-[0.9375rem] leading-relaxed text-ink-2">{analysis.method}</p>
            </div>
            <p>
              The derivation of each step, and how the intervals behave in simulation, is in{' '}
              {doc('docs/STATISTICS.md', 'docs/STATISTICS.md')}.
            </p>
          </Section>

          <Section id="reading" title="Reading a result">
            <VerdictDiagram margin={analysis.margin} />
            <p>
              <strong className="font-medium text-ink">Ties are shown as ties.</strong> Two architectures share a rank when
              neither is reliably above anything the other is not. The leaderboard writes <span className="num">=1</span> and
              groups them, rather than ordering them by a difference the data does not support.
            </p>
            <p>
              <strong className="font-medium text-ink">Scaffold or scale?</strong> To ask whether structure beats a bigger
              model, an architecture on one model is compared, task by task, with a plain single agent on the next model up.
              A scaffold that scores reliably higher at a lower cost has bought more than the upgrade would, for less.{' '}
              <Link href="/results/scale/" className="link">
                The comparison
              </Link>{' '}
              is drawn for every architecture, not only the best one, because picking the winner from the same data and
              then testing it flatters it.
            </p>
          </Section>

          <Section id="prereg" title="Pre-registered">
            <p>
              Before the flagship run starts, its hypotheses, metrics, margins and decision rules are committed to{' '}
              {doc('docs/PREREGISTRATION.md', 'docs/PREREGISTRATION.md')}. The run set’s manifest records the commit it ran
              at, so anyone can check that the commitment came first. Each task’s own hypothesis, the architecture it
              expects to do best and why, is written when the task is, and is shown on its page beside what happened.
            </p>
            <p>
              A hypothesis that the data contradicts is reported as contradicted. That is the point of writing it down.
            </p>
          </Section>

          <Section id="limits" title="What this does not show">
            <ul className="list-disc space-y-3 pl-5 marker:text-muted">
              <li>
                <strong className="font-medium text-ink">Tasks like these, not agents in general.</strong> The tasks are
                hand-written, in a few simulated worlds and a research set, by one author. Their difficulty labels are the
                author’s, checked by pilot runs. The intervals say how sure the data is about <em>these kinds of task</em>.
              </li>
              <li>
                <strong className="font-medium text-ink">One model family, one SDK.</strong> Every model is a Claude model
                run through the Claude Agent SDK. Another family, or another harness runtime, may rank the designs
                differently.
              </li>
              <li>
                <strong className="font-medium text-ink">Prompts are a confound.</strong> We wrote each architecture’s
                prompts. Every design gets the same task prompt and domain policy, which narrows the gap, but a better
                prompt for one design could move its standing.
              </li>
              <li>
                <strong className="font-medium text-ink">Structure and tokens are not separated.</strong> A design that
                makes more calls spends more tokens, and there is no compute-matched control yet. Read a gain beside its cost
                ratio, never alone.
              </li>
              <li>
                <strong className="font-medium text-ink">Cost is what the SDK reported, not an invoice.</strong> Prompt
                caching varies from run to run, and latency is wall-clock time with other runs in flight.
              </li>
              <li>
                <strong className="font-medium text-ink">Few repeats.</strong> With a handful of repeats per task, small
                differences stay <em>not separable</em>. That is the site refusing to guess, not an absence of effect.
              </li>
              <li>
                <strong className="font-medium text-ink">The judge can be wrong.</strong> Research scores rest on a model’s
                grading. Taking the median of several samples reduces its noise; it does not remove its bias.
              </li>
              <li>
                <strong className="font-medium text-ink">A fidelity check proves structure, not quality.</strong> It shows
                that a plan existed and a verdict was read. It does not show that the plan was good.
              </li>
              <li>
                <strong className="font-medium text-ink">Models change.</strong> A result is dated to the run set’s models
                and commit, both recorded in its manifest.
              </li>
            </ul>
          </Section>

          <Section id="reproduce" title="Reproduce it">
            <p>
              Everything on this site is read from <code className="code-inline">results/</code> at build time, and the
              records are plain JSON. To run a cell yourself, from the repository root:
            </p>
            <ScrollRegion label="Commands to run a cell yourself" className="rounded-[12px] border border-rule bg-sunken">
              <pre className="w-max p-4 font-mono text-[0.75rem] leading-relaxed text-ink-2">{`npm ci
npm run arena -- run --strategies single,plan-execute --tasks airline-hard --repeats 1
npm run dev:web`}</pre>
            </ScrollRegion>
            <p>
              Adding a task is described in {doc('docs/ADDING-A-TASK.md', 'docs/ADDING-A-TASK.md')}, and the shape of the
              code in {doc('docs/ARCHITECTURE.md', 'docs/ARCHITECTURE.md')}.
            </p>
          </Section>
        </div>
      </div>
    </>
  );
}

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`} className="h2 text-ink">
        {title}
      </h2>
      <div className="prose-serif mt-5 space-y-5">{children}</div>
    </section>
  );
}
