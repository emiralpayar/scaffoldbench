import type { Metadata } from 'next';

import { LiveRunner, type LiveOption } from '../../components/LiveRunner';
import { STRATEGIES } from '@arena/strategies';
import { ALL_TASKS } from '@arena/tasks';

export const metadata: Metadata = {
  title: 'Run one live — Agent Arena',
  description: 'Run a single task through one architecture on your own API key and watch the trace.',
};

export default function LivePage() {
  const tasks: LiveOption[] = ALL_TASKS.map((task) => ({
    id: task.id,
    label: `${task.id} — ${task.title}`,
  }));

  const strategies: LiveOption[] = STRATEGIES.map((strategy) => ({
    id: strategy.id,
    label: strategy.label,
  }));

  return (
    <div className="mx-auto w-full max-w-[62rem] px-5 py-10 sm:px-8">
      <header className="mb-8">
        <h1 className="font-serif text-[28px] leading-tight text-ink">Run one live</h1>
        <p className="mt-3 max-w-[46rem] font-serif text-[15px] leading-relaxed text-ink-2">
          The leaderboard is an average over many runs. This is the opposite: one task, one
          architecture, one run, with the trace streaming as it happens — the tool calls, the
          subagents, anything the sandbox guard blocks, and the deterministic score at the end.
          It is the quickest way to see what the numbers elsewhere are actually made of.
        </p>
        <p className="mt-3 max-w-[46rem] text-[13px] leading-relaxed text-muted">
          Nothing here is recorded. The run is not written to <code>results/</code> and never
          reaches the leaderboard — published numbers come only from a full benchmark run.
        </p>
      </header>

      <LiveRunner tasks={tasks} strategies={strategies} />
    </div>
  );
}
