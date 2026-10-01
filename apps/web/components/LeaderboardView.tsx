'use client';

import { useState } from 'react';

import type { CategoryFilter, LeaderboardViewModel } from '../lib/derive';
import { ScoreBar } from './ScoreBar';

const COLUMNS = [
  { key: 'rank', label: '#', align: 'text-right' },
  { key: 'strategy', label: 'Strategy', align: 'text-left' },
  { key: 'n', label: 'n', align: 'text-right' },
  { key: 'score', label: 'Mean score · 95% CI', align: 'text-left' },
  { key: 'pass', label: 'Pass', align: 'text-right' },
  { key: 'cost', label: 'Cost / run', align: 'text-right' },
  { key: 'latency', label: 'Latency', align: 'text-right' },
  { key: 'value', label: 'Score / $', align: 'text-right' },
] as const;

export function LeaderboardView({ views }: { views: LeaderboardViewModel[] }) {
  const [active, setActive] = useState<CategoryFilter>('all');
  const view = views.find((candidate) => candidate.id === active) ?? views[0];
  if (!view) return null;

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div
          role="tablist"
          aria-label="Task category"
          className="inline-flex rounded-[2px] border border-rule bg-surface p-0.5"
        >
          {views.map((candidate) => {
            const selected = candidate.id === view.id;
            return (
              <button
                key={candidate.id}
                type="button"
                role="tab"
                aria-selected={selected}
                disabled={candidate.rows.length === 0}
                onClick={() => setActive(candidate.id)}
                className={`rounded-[2px] px-2.5 py-1 text-[12px] transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                  selected ? 'bg-accent/12 text-accent' : 'text-ink-2 hover:text-ink'
                }`}
              >
                {candidate.label}
              </button>
            );
          })}
        </div>
        <p className="num text-[12px] text-muted">
          {view.runs} runs · {view.taskCount} tasks · {view.rows.length} strategies
        </p>
      </div>

      <div className="scroll-x rounded-[3px] border border-rule bg-surface">
        <table className="w-full min-w-[60rem] border-collapse text-[13px]">
          <thead>
            <tr className="border-b border-rule">
              {COLUMNS.map((column) => (
                <th
                  key={column.key}
                  scope="col"
                  className={`eyebrow whitespace-nowrap px-3 py-2 font-normal ${column.align}`}
                >
                  {column.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {view.rows.map((row) => (
              <tr
                key={row.strategyId}
                className="border-b border-rule/70 align-top last:border-0 hover:bg-sunken/60"
              >
                <td className="num px-3 py-3 text-right text-muted">{row.rank}</td>

                <td className="px-3 py-3">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-ink">{row.label}</span>
                    {row.onFrontier ? (
                      <span
                        title="On the score-versus-cost Pareto frontier"
                        className="inline-flex items-center gap-1 rounded-[2px] border border-accent/40 px-1 py-px font-mono text-[9px] uppercase tracking-[0.08em] text-accent"
                      >
                        <span aria-hidden>◆</span> frontier
                      </span>
                    ) : null}
                  </div>
                  {row.description ? (
                    <p className="mt-1 max-w-[34rem] text-[12px] leading-snug text-muted">
                      {row.description}
                    </p>
                  ) : null}
                </td>

                <td className="num px-3 py-3 text-right text-ink-2">{row.runs}</td>

                <td className="px-3 py-3">
                  <div className="flex items-center gap-2.5">
                    <ScoreBar
                      mean={row.score.mean}
                      ciLow={row.score.ciLow}
                      ciHigh={row.score.ciHigh}
                    />
                    <span className="num text-ink">{row.scoreText}</span>
                    <span className="num text-[11px] text-muted">{row.ciText}</span>
                  </div>
                </td>

                <td className="num px-3 py-3 text-right text-ink-2">{row.passRateText}</td>
                <td className="num px-3 py-3 text-right text-ink-2">{row.costText}</td>
                <td className="num px-3 py-3 text-right text-ink-2">{row.latencyText}</td>
                <td className="num px-3 py-3 text-right text-ink">{row.valueText}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="mt-2 text-[11px] text-muted">
        The bar is the mean; the whisker is the 95% bootstrap confidence interval over runs. Rows
        whose whiskers overlap are not separated by this data.
      </p>

      <section className="mt-7 max-w-3xl border-t border-rule pt-5">
        <h2 className="eyebrow">What the numbers say</h2>
        <p className="prose-serif mt-2">{view.prose}</p>
      </section>
    </div>
  );
}
