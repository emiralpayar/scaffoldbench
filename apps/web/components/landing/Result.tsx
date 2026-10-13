import type { SiteAnalysis } from '../../lib/analysis';
import { formatScore } from '../../lib/format';
import { modelShortName } from '../../lib/models';
import type { Headline } from '../../lib/scorecard';
import { ScaleScaffoldChart } from '../charts/ScaleScaffoldChart';
import Link from '../Link';

/**
 * The result in one chart, with the caveats a reader should have before
 * quoting it. Sits straight under the hero.
 */
export function Result({
  analysis,
  headline,
  ceiling,
}: {
  analysis: SiteAnalysis;
  headline: Headline;
  /** Tasks on which every architecture scored at least 0.99 on the top model, of `tasks`. */
  ceiling: { count: number; tasks: number };
}) {
  const small = analysis.models[0];
  const top = analysis.models[analysis.models.length - 1];
  const below = small?.contrasts.filter((c) => c.scoreDelta.mean < 0).length ?? 0;
  const topSingle = top?.architectures.find((a) => a.strategyId === analysis.baselineId)?.score.mean;
  const words = ['none', 'one', 'two', 'three', 'four', 'five', 'six'];
  return (
    <section id="result" aria-labelledby="result-title" className="section">
      <div className="container-page">
        <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,20rem)] lg:items-end lg:gap-16">
          <div className="max-w-[46rem]">
            <p className="eyebrow">The result · scaffold-or-scale-v1</p>
            <h2 id="result-title" className="h1 mt-4 text-ink">
              Within a model, the scaffolds scatter around the plain agent. Across models, the plain agent climbs.
            </h2>
          </div>
          <p className="prose-serif lg:pb-1.5">
            {cap(words[headline.scaffoldContrasts / analysis.models.length] ?? '')} scaffolds against a single agent on{' '}
            {words[analysis.models.length]} Claude models: {headline.scaffoldContrasts} paired comparisons,{' '}
            {headline.scaffoldsBetter === 0 ? 'none' : headline.scaffoldsBetter} separated in the scaffold&apos;s
            favour.{small ? ` On ${modelShortName(small.model)}, ${words[below] ?? below} of the ${words[small.contrasts.length] ?? small.contrasts.length} scored below the agent they wrap.` : ''}
          </p>
        </div>

        <div className="card mt-10 p-5 sm:p-8">
          <ScaleScaffoldChart analysis={analysis} headline={headline} />
        </div>

        <div className="mt-12 grid gap-10 md:grid-cols-[minmax(0,16rem)_minmax(0,1fr)]">
          <h3 className="h3 text-ink">Read this before quoting it</h3>
          <ul className="grid gap-x-10 gap-y-4 text-[0.9375rem] leading-relaxed text-ink-2 sm:grid-cols-2">
            <li>
              <strong className="font-medium text-ink">
                {ceiling.tasks} tasks are {ceiling.tasks} clusters.
              </strong>{' '}
              Power is set by the task count, not the number of runs, so most contrasts are <em>inconclusive</em> rather than shown equivalent: “no scaffold
              won” is not “every scaffold is useless”.
            </li>
            <li>
              <strong className="font-medium text-ink">{top ? modelShortName(top.model) : 'The top model'} had little headroom.</strong>{' '}
              Its single agent already scored {topSingle !== undefined ? formatScore(topSingle) : 'near the ceiling'}, and{' '}
              on {ceiling.count} of the {ceiling.tasks} tasks every architecture scored 0.99 or more, leaving no room to show a gain.
            </li>
            <li>
              <strong className="font-medium text-ink">We wrote the pre-registration.</strong> It was committed and tagged
              before the runs, and the single pilot and what it changed are disclosed in it.
            </li>
            <li>
              <strong className="font-medium text-ink">Our first leaderboard was wrong.</strong> Four of five designs never
              ran as designed; every run now has to prove it did.{' '}
              <Link href="/postmortem/" className="link">
                Read the post-mortem
              </Link>
              .
            </li>
          </ul>
        </div>
      </div>
    </section>
  );
}

function cap(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
