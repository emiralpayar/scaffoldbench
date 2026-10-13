import { architectureName } from '../../lib/architectures';
import { formatDuration, formatScore, formatUsd } from '../../lib/format';
import { modelShortName } from '../../lib/models';
import type { FeaturedEntry } from '../../lib/server/featured';
import { ArchitectureGlyph } from '../ArchitectureGlyph';
import Link from '../Link';

/**
 * A few runs worth reading call by call, each with what to look for. Only
 * runs whose trace is committed are listed, so every card opens a replay.
 */
export function FeaturedTraces({ runs, traced, total }: { runs: FeaturedEntry[]; traced: number; total: number }) {
  if (runs.length === 0) return null;
  return (
    <section aria-labelledby="traces-title" className="section border-t border-rule">
      <div className="container-page">
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)] lg:items-end lg:gap-16">
          <div className="max-w-[46rem]">
            <p className="eyebrow">Read the traces</p>
            <h2 id="traces-title" className="h1 mt-4 text-ink">
              The averages hide the runs. Here are a few, call by call.
            </h2>
          </div>
          <p className="text-[0.9375rem] leading-relaxed text-ink-2 lg:pb-1.5">
            Every prompt, tool call, review and verdict is recorded. The repository keeps {traced} of the {total}{' '}
            traces, chosen to show a design at work; every run&apos;s score, phases and final answer are on its page.
          </p>
        </div>

        <ul className="mt-12 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {runs.slice(0, 3).map((entry) => (
            <li key={entry.runId}>
              <Link
                href={`/runs/${entry.runId}/`}
                className="card group flex h-full flex-col p-6 transition-colors hover:border-rule-strong"
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="flex items-center gap-3">
                    <ArchitectureGlyph id={entry.record.strategyId} width={44} decorative />
                    <span className="text-[0.875rem] text-ink-2">
                      {architectureName(entry.record.strategyId)} · {modelShortName(entry.record.model)}
                    </span>
                  </span>
                  <span
                    className={`num text-[0.9375rem] ${entry.record.passed ? 'text-good' : entry.record.score > 0 ? 'text-warn' : 'text-bad'}`}
                  >
                    {formatScore(entry.record.score)}
                  </span>
                </div>
                <h3 className="mt-5 font-serif text-[1.375rem] leading-snug text-ink">{entry.title}</h3>
                <p className="mt-2 flex-1 text-[0.9375rem] leading-relaxed text-ink-2">{entry.caption}</p>
                <p className="mt-5 flex items-center justify-between border-t border-rule pt-4 text-[0.8125rem] text-muted">
                  <span className="num">
                    {formatUsd(entry.record.costUsd)} · {formatDuration(entry.record.latencyMs)} · {entry.record.taskId}
                  </span>
                  <span className="text-ink transition-transform group-hover:translate-x-0.5" aria-hidden>
                    →
                  </span>
                </p>
              </Link>
            </li>
          ))}
        </ul>
        <p className="mt-8 flex flex-wrap gap-x-8 gap-y-3 text-[0.9375rem]">
          <Link href="/live/" className="link">
            Replay the six-way race above, call by call →
          </Link>
          {runs.slice(3).map((entry) => (
            <Link key={entry.runId} href={`/runs/${entry.runId}/`} className="link">
              {entry.title} →
            </Link>
          ))}
        </p>
      </div>
    </section>
  );
}
