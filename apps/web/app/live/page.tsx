import type { Metadata } from 'next';

import { STRATEGIES } from '@scaffoldbench/strategies';
import { ALL_TASKS } from '@scaffoldbench/tasks';

import { ArchitectureGlyph } from '../../components/ArchitectureGlyph';
import Link from '../../components/Link';
import { LiveRunner, type LiveOption } from '../../components/LiveRunner';
import { ScrollRegion } from '../../components/ScrollRegion';
import type { ReplayEntry } from '../../components/timeline/ReplayGallery';
import { ReplayGallery } from '../../components/timeline/ReplayGallery';
import { architectureName, compareArchitectures } from '../../lib/architectures';
import { modelShortName, formatModelPrice } from '../../lib/models';
import { pageMetadata } from '../../lib/pageMetadata';
import {
  LIVE_DEFAULT_MODEL,
  LIVE_MAX_COST_USD,
  LIVE_MAX_WALL_CLOCK_MS,
  LIVE_MODELS,
} from '../../lib/server/live';
import { loadReplays, toReplayEntries } from '../../lib/server/replays';
import { LIVE_ENABLED } from '../../lib/site';

export const metadata: Metadata = pageMetadata({
  title: 'Replay a run',
  description:
    'Watch recorded benchmark runs play back call by call: parallel subagents, tool calls and the sandbox guard, at real speed or eight times faster. Then re-run any cell yourself.',
  path: '/live/',
});

const STEPS = [
  { label: 'Install', command: 'npm ci' },
  {
    label: 'Run two architectures on one task, once each',
    command: 'npm run bench -- run --strategies single,plan-execute --tasks airline-hard --repeats 1 --update-latest',
  },
  { label: 'Open the site on your results', command: 'npm run dev:web' },
];

export default async function LivePage() {
  const race = await loadReplays();
  const entries: ReplayEntry[] = race ? await toReplayEntries(race) : [];
  // Open on the design with the most going on: the one that fans out.
  const initial =
    entries.find((entry) => entry.strategyId === 'propose-select') ??
    entries.find((entry) => entry.strategyId !== 'single') ??
    entries[0];
  const verification = race?.data.verification;

  return (
    <div className="container-page pb-20 pt-8 sm:pt-12">
      {/* Short on purpose: the player is what this page is for and should be on the first screen. */}
      <header className="mb-8 max-w-3xl">
        <p className="eyebrow">Replay</p>
        <h1 className="h1 mt-3 text-ink">Watch a run, call by call.</h1>
        <p className="lede mt-4">
          A score is the end of a story. The replay is the story: which model calls ran, in
          parallel or not, which tools they called, what the sandbox guard refused, and what the run
          had spent at every moment.
        </p>
      </header>

      {race && initial ? (
        <section aria-labelledby="replay-title" className="mb-20">
          <div className="mb-4 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
            <h2 id="replay-title" className="h3 text-ink">
              {race.taskTitle}
            </h2>
            <p className="num text-[0.8125rem] text-muted">
              The same task for {race.runs.length} architectures · {modelShortName(race.model)} · repeat {race.repeat} · run set{' '}
              {race.data.runSetId}
            </p>
          </div>
          {verification === 'synthetic' ? (
            <div role="note" className="banner banner-warn mb-4">
              <p className="banner-title">Synthetic trace — not a recording</p>
              <p className="banner-body">
                These runs were fabricated by <code className="code-inline">scripts/generate-demo-data.ts</code> to
                build the site. The shapes are what a replay looks like; nothing here happened.
              </p>
            </div>
          ) : verification === 'unverified' ? (
            <div role="note" className="banner banner-bad mb-4">
              <p className="banner-title">From the retracted first run set</p>
              <p className="banner-body">
                These are recordings of runs whose architectures mostly did not run as designed. Watch for the
                proposers with no tools and the selector the guard stopped.{' '}
                <Link href="/postmortem/" className="link">
                  What went wrong
                </Link>
                .
              </p>
            </div>
          ) : null}
          <ReplayGallery entries={entries} initial={initial.runId} />
        </section>
      ) : (
        <section aria-labelledby="replay-title" className="mb-20 rounded-[14px] border border-dashed border-rule-strong p-6 sm:p-8">
          <h2 id="replay-title" className="h3 text-ink">
            No recorded trace is in this build.
          </h2>
          <p className="prose-serif mt-3 max-w-2xl">
            Replays are drawn from the traces committed under{' '}
            <code className="code-inline">results/&lt;run set&gt;/traces/</code>. None are, so there is nothing to
            play back here; every run page still shows its phases and score. Run a cell below and the replay
            appears for it.
          </p>
        </section>
      )}

      <section aria-labelledby="local-title" className="grid grid-cols-[minmax(0,1fr)] gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
        <div>
          <h2 id="local-title" className="h3 text-ink">
            Run it yourself
          </h2>
          <p className="prose-serif mt-3 max-w-2xl">
            Runs use whatever Claude credentials your shell has, so they spend tokens on that account.
            Results land in <code className="code-inline">results/</code>, and{' '}
            <code className="code-inline">--update-latest</code> makes the site render them.
          </p>
          <ol className="mt-6 space-y-4">
            {STEPS.map((step, index) => (
              <li key={step.command} className="card overflow-hidden">
                <p className="flex items-baseline gap-3 border-b border-rule px-4 py-2.5 text-[0.875rem] text-ink-2">
                  <span className="num text-muted">{String(index + 1).padStart(2, '0')}</span>
                  {step.label}
                </p>
                <ScrollRegion label={`Command: ${step.label}`}>
                  <pre className="w-max min-w-full bg-sunken px-4 py-3 font-mono text-[0.8125rem] leading-relaxed text-ink">
                    <code>{step.command}</code>
                  </pre>
                </ScrollRegion>
              </li>
            ))}
          </ol>
        </div>

        <aside className="card self-start p-6">
          <p className="eyebrow">Architecture ids</p>
          <p className="mt-1.5 text-[0.8125rem] text-muted">
            Pass any of these to <code className="font-mono">--strategies</code>.
          </p>
          <ul className="mt-4 space-y-3">
            {[...STRATEGIES]
              .sort((a, b) => compareArchitectures(a.id, b.id))
              .map((strategy) => (
                <li key={strategy.id} className="flex items-center gap-3">
                  <ArchitectureGlyph id={strategy.id} width={40} />
                  <span className="min-w-0">
                    <span className="block text-[0.9375rem] text-ink">{architectureName(strategy.id)}</span>
                    <code className="font-mono text-[0.75rem] text-muted">{strategy.id}</code>
                  </span>
                </li>
              ))}
          </ul>
        </aside>
      </section>

      <section aria-labelledby="live-title" className="mt-16 border-t border-rule pt-12">
        <h2 id="live-title" className="h3 text-ink">
          Live, in the browser
        </h2>
        {LIVE_ENABLED ? (
          <>
            <p className="prose-serif mt-3 max-w-2xl">
              This server runs one tool-use task through one architecture on your own Anthropic API
              key and streams the trace as it happens. Nothing here is recorded, and nothing reaches
              the published results.
            </p>
            <div className="mt-8">
              <LiveRunner
                tasks={liveTasks()}
                strategies={liveStrategies()}
                models={LIVE_MODELS.map((m) => ({ id: m.id, label: `${m.short} (${formatModelPrice(m)})` }))}
                defaultModel={LIVE_DEFAULT_MODEL}
                limits={`Each run is capped at $${LIVE_MAX_COST_USD.toFixed(2)} and ${LIVE_MAX_WALL_CLOCK_MS / 60_000} minutes.`}
              />
            </div>
          </>
        ) : (
          <p className="prose-serif mt-3 max-w-2xl">
            This copy of the site is static, so it cannot run a model and will never ask for an API
            key. To try the streaming demo, serve the site in server mode on your machine with{' '}
            <code className="code-inline">NEXT_PUBLIC_SCAFFOLDBENCH_LIVE=1 npm run dev:web</code>; runs there
            are billed to the key you paste and to no other credentials.
          </p>
        )}
      </section>
    </div>
  );
}

/**
 * Only tool-use tasks: they are scored deterministically and call no judge,
 * so a visitor's run cannot spend anything on the operator's credentials.
 */
function liveTasks(): LiveOption[] {
  return ALL_TASKS.filter((task) => task.category === 'tool-use').map((task) => ({
    id: task.id,
    label: task.title,
    hint: `${task.world} · ${task.difficulty}`,
  }));
}

function liveStrategies(): LiveOption[] {
  return [...STRATEGIES]
    .sort((a, b) => compareArchitectures(a.id, b.id))
    .map((strategy) => ({ id: strategy.id, label: architectureName(strategy.id) }));
}
