import { architectureColor } from '../../lib/architectures';
import { formatPercent, formatUsd } from '../../lib/format';
import { modelShortName } from '../../lib/models';
import type { ModelStageCosts } from '../../lib/strategies';

const SHADES = [1, 0.62, 0.34];

/**
 * Where a run's money goes, stage by stage, one bar per model. Bars share a
 * scale, so a longer bar is a dearer run and the picture also shows how the
 * mix of stages shifts with the model. Each segment is named in the table
 * under the bars: shade alone does not carry which stage is which.
 */
export function StageCostBars({ strategyId, costs }: { strategyId: string; costs: readonly ModelStageCosts[] }) {
  const color = architectureColor(strategyId);
  const dearest = Math.max(...costs.map((cost) => cost.costUsd), 0.0001);
  // Every stage any model spent on, in the design's order (the first model's first).
  const stages = [
    ...new Map(costs.flatMap((cost) => cost.stages).map((stage) => [stage.stageId, stage] as const)).values(),
  ];
  const shade = (index: number, id: string) =>
    id === 'other'
      ? { background: 'repeating-linear-gradient(135deg, var(--ink-2) 0 2px, transparent 2px 5px)' }
      : { background: color, opacity: SHADES[Math.min(index, SHADES.length - 1)] ?? 0.34 };

  return (
    <figure>
      <div className="card px-5 py-5 sm:px-6">
        <ul className="space-y-5">
          {costs.map((cost) => (
            <li key={cost.model}>
              <div className="flex flex-wrap items-baseline justify-between gap-x-4">
                <span className="text-[0.9375rem] text-ink">{modelShortName(cost.model)}</span>
                <span className="num text-[0.8125rem] text-ink-2">
                  {formatUsd(cost.costUsd)} per run · {cost.runs} runs
                </span>
              </div>
              <div
                role="img"
                aria-label={`${modelShortName(cost.model)}: ${cost.stages
                  .map((stage) => `${stage.title} ${formatUsd(stage.costUsd)}`)
                  .join(', ')}`}
                className="mt-2 flex h-4 overflow-hidden rounded-[4px] bg-sunken"
                style={{ width: `${(cost.costUsd / dearest) * 100}%`, minWidth: '2rem' }}
              >
                {cost.stages.map((stage, index) => (
                  <span
                    key={stage.stageId}
                    className="h-full border-r border-surface last:border-r-0"
                    style={{ width: `${cost.costUsd === 0 ? 0 : (stage.costUsd / cost.costUsd) * 100}%`, ...shade(index, stage.stageId) }}
                  />
                ))}
              </div>
            </li>
          ))}
        </ul>

        <div className="scroll-x mt-6 border-t border-rule pt-4">
          <table className="w-full min-w-[26rem] border-collapse text-[0.8125rem]">
            <thead>
              <tr className="border-b border-rule">
                <th scope="col" className="eyebrow px-2 py-1.5 text-left font-normal !text-[0.6875rem]">
                  Stage
                </th>
                {costs.map((cost) => (
                  <th key={cost.model} scope="col" className="eyebrow px-2 py-1.5 text-right font-normal !text-[0.6875rem]">
                    {modelShortName(cost.model)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {stages.map((stage, index) => (
                <tr key={stage.stageId} className="border-b border-rule/70 last:border-0">
                  <th scope="row" className="px-2 py-2 text-left font-normal text-ink">
                    <span className="flex items-center gap-2">
                      <span aria-hidden className="block h-2.5 w-4 shrink-0 rounded-[2px]" style={shade(index, stage.stageId)} />
                      {stage.title}
                    </span>
                  </th>
                  {costs.map((cost) => {
                    const mine = cost.stages.find((s) => s.stageId === stage.stageId);
                    return (
                      <td key={cost.model} className="num px-2 py-2 text-right text-ink-2">
                        {mine ? (
                          <>
                            <span className="text-ink">{formatUsd(mine.costUsd)}</span>{' '}
                            <span className="text-muted">{formatPercent(cost.costUsd === 0 ? 0 : mine.costUsd / cost.costUsd)}</span>
                          </>
                        ) : (
                          '—'
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <figcaption className="mt-3 text-[0.8125rem] leading-relaxed text-muted">
        Mean cost of a ranked run, by the stage of the design that spent it. Judge calls are not counted.
      </figcaption>
    </figure>
  );
}
