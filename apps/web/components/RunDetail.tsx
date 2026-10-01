import type { Penalty, ScoreItem } from '@arena/core';

import type { PhaseRow } from '../lib/derive';
import { FULL_CREDIT, formatDuration, formatPercent, formatScore, formatUsd } from '../lib/format';
import type { RunRecord } from '../lib/records';
import { normalizeError } from '../lib/timeline';
import { MiniBar } from './MiniBar';
import { Tag, Verdict } from './Layout';

/** The graded assertions behind a score, each as a pass, a partial or a miss. */
export function ScoreBreakdown({ breakdown }: { breakdown: readonly ScoreItem[] }) {
  if (breakdown.length === 0) {
    return <p className="text-[13px] text-muted">This run recorded no score breakdown.</p>;
  }

  const totalWeight = breakdown.reduce((sum, item) => sum + item.weight, 0);

  return (
    <ul className="divide-y divide-rule">
      {breakdown.map((item) => {
        const passed = item.earned >= FULL_CREDIT;
        return (
          <li key={item.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2 first:pt-0">
            <Verdict state={passed ? 'pass' : item.earned > 0 ? 'partial' : 'fail'} />
            <span className="min-w-0 flex-1 text-[13px] text-ink">{item.label}</span>
            <MiniBar value={item.earned} tone={passed ? 'accent' : 'muted'} />
            <span className="num w-14 text-right text-[12px] text-ink-2">
              {item.earned.toFixed(2)}
            </span>
            <span className="num w-20 text-right text-[11px] text-muted">
              weight {totalWeight > 0 ? (item.weight / totalWeight).toFixed(2) : item.weight}
            </span>
            {item.detail ? (
              <p className="w-full text-[12px] text-muted">{item.detail}</p>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

/** Penalties multiply the raw score, so a multiplier of 0 is a hard fail. */
export function PenaltyList({ penalties }: { penalties: readonly Penalty[] }) {
  if (penalties.length === 0) {
    return <p className="text-[13px] text-muted">No penalties were applied.</p>;
  }

  return (
    <ul className="space-y-2">
      {penalties.map((penalty) => (
        <li key={penalty.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <Tag tone="bad">{penalty.kind.replace(/_/g, ' ')}</Tag>
          <span className="min-w-0 flex-1 text-[13px] text-ink">{penalty.label}</span>
          <span className="num text-[12px] text-bad">
            ×{penalty.multiplier}
            {penalty.multiplier === 0 ? ' · hard fail' : ''}
          </span>
          {penalty.detail ? <p className="w-full text-[12px] text-muted">{penalty.detail}</p> : null}
        </li>
      ))}
    </ul>
  );
}

export function PhaseTable({ rows }: { rows: readonly PhaseRow[] }) {
  if (rows.length === 0) {
    return <p className="text-[13px] text-muted">This run recorded no phases.</p>;
  }

  const derived = rows.some((row) => row.derived);

  return (
    <div>
      <div className="scroll-x">
        <table className="w-full min-w-[36rem] border-collapse text-[12.5px]">
          <thead>
            <tr className="border-b border-rule">
              <th scope="col" className="eyebrow px-2 py-1.5 text-left font-normal">
                Phase
              </th>
              <th scope="col" className="eyebrow px-2 py-1.5 text-right font-normal">
                Duration
              </th>
              <th scope="col" className="eyebrow px-2 py-1.5 text-right font-normal">
                Cost
              </th>
              <th scope="col" className="eyebrow px-2 py-1.5 text-right font-normal">
                Turns
              </th>
              <th scope="col" className="eyebrow px-2 py-1.5 text-right font-normal">
                Tools
              </th>
              <th scope="col" className="eyebrow px-2 py-1.5 text-left font-normal">
                Model
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={`${row.phase}-${index}`} className="border-b border-rule/70 last:border-0">
                <td className="px-2 py-1.5 text-ink" style={{ paddingLeft: 8 + row.depth * 14 }}>
                  {row.label}
                  {row.aborted ? <span className="ml-2 text-[11px] text-bad">aborted</span> : null}
                  {row.error ? (
                    <span className="ml-2 text-[11px] text-bad" title={row.error}>
                      {normalizeError(row.error)}
                    </span>
                  ) : null}
                  {row.degraded ? <span className="chip-warn ml-2">fell back · {row.degraded}</span> : null}
                </td>
                <td className="num px-2 py-1.5 text-right text-ink-2">
                  {formatDuration(row.durationMs)}
                </td>
                <td className="num px-2 py-1.5 text-right text-ink-2">{formatUsd(row.costUsd)}</td>
                <td className="num px-2 py-1.5 text-right text-ink-2">{row.turns}</td>
                <td className="num px-2 py-1.5 text-right text-ink-2">{row.toolCalls}</td>
                <td className="num px-2 py-1.5 text-[11px] text-muted">{row.model ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {derived ? (
        <p className="mt-2 text-[11px] text-muted">
          This strategy recorded no phase list, so the table above is reconstructed from the trace:
          duration spans the phase&apos;s first and last event and turns count assistant messages.
        </p>
      ) : null}
    </div>
  );
}

/** The metadata a scorer attached to the run, e.g. citation integrity. */
export function ScoreMetadata({ metadata }: { metadata: Record<string, unknown> }) {
  const entries = Object.entries(metadata);
  if (entries.length === 0) return null;

  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[12.5px]">
      {entries.map(([key, value]) => (
        <div key={key} className="contents">
          <dt className="text-muted">{key.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()}</dt>
          <dd className="num text-ink">
            {typeof value === 'number' && value >= 0 && value <= 1 && !Number.isInteger(value)
              ? `${value} (${formatPercent(value)})`
              : JSON.stringify(value)}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function RunHeadline({ record }: { record: RunRecord }) {
  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
      <div>
        <div className="eyebrow">Score</div>
        <div className="num mt-1 flex items-baseline gap-2 text-[26px] leading-none text-ink">
          {formatScore(record.score)}
          <Verdict state={record.passed ? 'pass' : 'fail'} />
        </div>
      </div>
      <div>
        <div className="eyebrow">Failure mode</div>
        <div className="mt-1 text-[15px] text-ink">
          {record.failureMode === 'none' ? (
            <span className="text-good">none</span>
          ) : (
            <span className="text-bad">{record.failureMode.replace(/_/g, ' ')}</span>
          )}
        </div>
      </div>
    </div>
  );
}
