import type { Metadata } from 'next';

import { STRATEGIES } from '@arena/strategies';
import { ALL_TASKS } from '@arena/tasks';

import { ArchitectureGlyph } from '../../components/ArchitectureGlyph';
import { LiveRunner, type LiveOption } from '../../components/LiveRunner';
import { architectureName, compareArchitectures } from '../../lib/architectures';
import { formatModelPrice } from '../../lib/models';
import {
  LIVE_DEFAULT_MODEL,
  LIVE_MAX_COST_USD,
  LIVE_MAX_WALL_CLOCK_MS,
  LIVE_MODELS,
} from '../../lib/server/live';
import { LIVE_ENABLED } from '../../lib/site';

export const metadata: Metadata = {
  title: 'Run it yourself',
  description:
    'Re-run any cell of the benchmark on your own machine, or run one task live on your own API key when the site is served in server mode.',
};

const STEPS = [
  { label: 'Install', command: 'npm ci' },
  {
    label: 'Run two architectures on one task, once each',
    command: 'npm run arena -- run --strategies single,plan-execute --tasks airline-hard --repeats 1',
  },
  { label: 'Open the site on your results', command: 'npm run dev:web' },
];

export default function LivePage() {
  return (
    <div className="container-page pb-20 pt-10 sm:pt-14">
      <header className="mb-12 max-w-3xl border-b border-rule pb-8">
        <p className="eyebrow">Run it yourself</p>
        <h1 className="h1 mt-3 text-ink">Every number here comes from a command you can run.</h1>
        <p className="lede mt-5">
          The leaderboard is an average over many runs. Running one yourself is the quickest way to
          see what those numbers are made of: the tool calls, the subagents, anything the sandbox
          guard blocks, and the deterministic score at the end.
        </p>
      </header>

      <section aria-labelledby="local-title" className="grid grid-cols-[minmax(0,1fr)] gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
        <div>
          <h2 id="local-title" className="h3 text-ink">
            On your machine
          </h2>
          <p className="prose-serif mt-3 max-w-2xl">
            Runs use whatever Claude credentials your shell has. Results land in{' '}
            <code className="code-inline">results/</code> and the site renders them.
          </p>
          <ol className="mt-6 space-y-4">
            {STEPS.map((step, index) => (
              <li key={step.command} className="card overflow-hidden">
                <p className="flex items-baseline gap-3 border-b border-rule px-4 py-2.5 text-[0.875rem] text-ink-2">
                  <span className="num text-muted">{String(index + 1).padStart(2, '0')}</span>
                  {step.label}
                </p>
                <pre className="scroll-x bg-sunken px-4 py-3 font-mono text-[0.8125rem] leading-relaxed text-ink">
                  <code>{step.command}</code>
                </pre>
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
            <code className="code-inline">NEXT_PUBLIC_ARENA_LIVE=1 npm run dev:web</code>; runs there
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
