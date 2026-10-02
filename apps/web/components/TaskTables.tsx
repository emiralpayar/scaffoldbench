import Link from 'next/link';

import type { CellSummary } from '@arena/core';

import type { RunRecord } from '../lib/records';

import type { AssertionStat } from '../lib/derive';
import {
  formatDuration,
  formatFailureMode,
  formatPercent,
  formatScore,
  formatUsd,
} from '../lib/format';
import { MiniBar } from './MiniBar';
import { Verdict } from './Layout';
import { ScrollRegion } from './ScrollRegion';

export interface StrategyCellRow {
  strategyId: string;
  label: string;
  cell: CellSummary;
}

export function TaskStrategyTable({ rows }: { rows: readonly StrategyCellRow[] }) {
  if (rows.length === 0) {
    return <p className="text-[13px] text-muted">No strategy has been run on this task.</p>;
  }

  return (
    <ScrollRegion label="Results of each strategy on this task">
      <table className="w-full min-w-[42rem] border-collapse text-[13px]">
        <thead>
          <tr className="border-b border-rule">
            <th scope="col" className="eyebrow px-2 py-1.5 text-left font-normal">
              Strategy
            </th>
            <th scope="col" className="eyebrow px-2 py-1.5 text-right font-normal">
              n
            </th>
            <th scope="col" className="eyebrow px-2 py-1.5 text-left font-normal">
              Mean score
            </th>
            <th scope="col" className="eyebrow px-2 py-1.5 text-right font-normal">
              Pass
            </th>
            <th scope="col" className="eyebrow px-2 py-1.5 text-right font-normal">
              Cost / run
            </th>
            <th scope="col" className="eyebrow px-2 py-1.5 text-right font-normal">
              Latency
            </th>
            <th scope="col" className="eyebrow px-2 py-1.5 text-left font-normal">
              Failure modes
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.strategyId} className="border-b border-rule/70 last:border-0">
              <td className="px-2 py-2 text-ink">{row.label}</td>
              <td className="num px-2 py-2 text-right text-ink-2">{row.cell.runs}</td>
              <td className="px-2 py-2">
                <span className="flex items-center gap-2">
                  <MiniBar value={row.cell.meanScore} />
                  <span className="num text-ink">{formatScore(row.cell.meanScore)}</span>
                </span>
              </td>
              <td className="num px-2 py-2 text-right text-ink-2">
                {formatPercent(row.cell.passRate)}
              </td>
              <td className="num px-2 py-2 text-right text-ink-2">
                {formatUsd(row.cell.meanCostUsd)}
              </td>
              <td className="num px-2 py-2 text-right text-ink-2">
                {formatDuration(row.cell.meanLatencyMs)}
              </td>
              <td className="px-2 py-2 text-[11.5px] text-muted">
                {Object.entries(row.cell.failureModes)
                  .filter(([mode]) => mode !== 'none')
                  .map(([mode, count]) => `${formatFailureMode(mode)} ×${count}`)
                  .join(', ') || '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </ScrollRegion>
  );
}

/**
 * How often each graded assertion held, across every strategy and repeat.
 *
 * This is the column that says *which part* of the task the architectures keep
 * getting wrong — the thing a mean score cannot tell you.
 */
export function AssertionTable({ stats }: { stats: readonly AssertionStat[] }) {
  if (stats.length === 0) {
    return (
      <p className="text-[13px] text-muted">
        This task is graded by a judge rather than by assertions, so there is no assertion list.
      </p>
    );
  }

  return (
    <ScrollRegion label="Graded assertions of this task">
      <table className="w-full min-w-[40rem] border-collapse text-[13px]">
        <thead>
          <tr className="border-b border-rule">
            <th scope="col" className="eyebrow px-2 py-1.5 text-left font-normal">
              Assertion
            </th>
            <th scope="col" className="eyebrow px-2 py-1.5 text-right font-normal">
              Weight
            </th>
            <th scope="col" className="eyebrow px-2 py-1.5 text-left font-normal">
              Passed
            </th>
            <th scope="col" className="eyebrow px-2 py-1.5 text-right font-normal">
              Partial
            </th>
            <th scope="col" className="eyebrow px-2 py-1.5 text-right font-normal">
              Mean credit
            </th>
          </tr>
        </thead>
        <tbody>
          {stats.map((stat) => (
            <tr key={stat.id} className="border-b border-rule/70 last:border-0">
              <td className="px-2 py-2">
                <span className="text-ink">{stat.label}</span>
                <span className="num ml-2 text-[11px] text-muted">{stat.id}</span>
              </td>
              <td className="num px-2 py-2 text-right text-ink-2">{stat.weight}</td>
              <td className="px-2 py-2">
                <span className="flex items-center gap-2">
                  <MiniBar value={stat.passRate} />
                  <span className="num text-ink">
                    {stat.passed}/{stat.runs}
                  </span>
                  <span className="num text-[11px] text-muted">
                    {formatPercent(stat.passRate)}
                  </span>
                </span>
              </td>
              <td className="num px-2 py-2 text-right text-ink-2">{stat.partial}</td>
              <td className="num px-2 py-2 text-right text-ink-2">
                {stat.meanEarned.toFixed(2)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </ScrollRegion>
  );
}

export function RunsTable({
  records,
  labels,
}: {
  records: readonly RunRecord[];
  labels: Record<string, string>;
}) {
  if (records.length === 0) return null;

  return (
    <ScrollRegion label="Every run of this task">
      <table className="w-full min-w-[44rem] border-collapse text-[12.5px]">
        <thead>
          <tr className="border-b border-rule">
            <th scope="col" className="eyebrow px-2 py-1.5 text-left font-normal">
              Run
            </th>
            <th scope="col" className="eyebrow px-2 py-1.5 text-left font-normal">
              Strategy
            </th>
            <th scope="col" className="eyebrow px-2 py-1.5 text-right font-normal">
              Repeat
            </th>
            <th scope="col" className="eyebrow px-2 py-1.5 text-right font-normal">
              Score
            </th>
            <th scope="col" className="eyebrow px-2 py-1.5 text-left font-normal">
              Result
            </th>
            <th scope="col" className="eyebrow px-2 py-1.5 text-right font-normal">
              Cost
            </th>
            <th scope="col" className="eyebrow px-2 py-1.5 text-right font-normal">
              Latency
            </th>
          </tr>
        </thead>
        <tbody>
          {records.map((record) => (
            <tr key={record.runId} className="border-b border-rule/70 last:border-0">
              <td className="px-2 py-1.5">
                <Link
                  href={`/runs/${record.runId}`}
                  className="num text-accent underline-offset-2 hover:underline"
                >
                  {record.runId}
                </Link>
              </td>
              <td className="px-2 py-1.5 text-ink-2">
                {labels[record.strategyId] ?? record.strategyId}
              </td>
              <td className="num px-2 py-1.5 text-right text-ink-2">{record.repeat}</td>
              <td className="num px-2 py-1.5 text-right text-ink">{formatScore(record.score)}</td>
              <td className="px-2 py-1.5">
                <Verdict state={record.passed ? 'pass' : 'fail'}>
                  {record.passed ? 'pass' : formatFailureMode(record.failureMode)}
                </Verdict>
              </td>
              <td className="num px-2 py-1.5 text-right text-ink-2">
                {formatUsd(record.costUsd)}
              </td>
              <td className="num px-2 py-1.5 text-right text-ink-2">
                {formatDuration(record.latencyMs)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </ScrollRegion>
  );
}
