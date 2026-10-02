
import type { CellSummary } from '@arena/core';

import type { RunRecord } from '../lib/records';

import {
  formatDuration,
  formatFailureMode,
  formatPercent,
  formatScore,
  formatUsd,
} from '../lib/format';
import Link from './Link';
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
    <>
      {/* On a phone, a card per strategy: seven columns do not fit across. */}
      <ul className="divide-y divide-rule md:hidden">
        {rows.map((row) => (
          <li key={row.strategyId} className="py-3.5 first:pt-0 last:pb-0">
            <div className="flex items-center justify-between gap-3">
              <span className="text-[0.9375rem] text-ink">{row.label}</span>
              <span className="flex items-center gap-2">
                <MiniBar value={row.cell.meanScore} />
                <span className="num text-ink">{formatScore(row.cell.meanScore)}</span>
              </span>
            </div>
            <p className="num mt-1.5 flex flex-wrap gap-x-4 gap-y-0.5 text-[0.75rem] text-ink-2">
              <span>{row.cell.runs} runs</span>
              <span>{formatPercent(row.cell.passRate)} pass</span>
              <span>{formatUsd(row.cell.meanCostUsd)} / run</span>
              <span>{formatDuration(row.cell.meanLatencyMs)}</span>
            </p>
            {Object.entries(row.cell.failureModes).some(([mode]) => mode !== 'none') ? (
              <p className="mt-1 text-[0.75rem] text-muted">
                {Object.entries(row.cell.failureModes)
                  .filter(([mode]) => mode !== 'none')
                  .map(([mode, count]) => `${formatFailureMode(mode)} ×${count}`)
                  .join(', ')}
              </p>
            ) : null}
          </li>
        ))}
      </ul>
      <div className="hidden md:block">
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
      </div>
    </>
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
