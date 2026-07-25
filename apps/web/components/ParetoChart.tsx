'use client';

import {
  CartesianGrid,
  ComposedChart,
  LabelList,
  Line,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { TooltipProps } from 'recharts';

import type { ParetoModel, ParetoPoint } from '../lib/data';

/**
 * Score against cost, with the non-dominated set joined by a line.
 *
 * Position carries the whole message; colour only separates "on the frontier"
 * from "dominated", and every point is directly labelled, so nothing depends on
 * hue. Both axes start at zero — a truncated score axis would exaggerate gaps
 * the confidence intervals cannot support.
 */
export function ParetoChart({ model }: { model: ParetoModel }) {
  const maxCost = Math.max(...model.points.map((p) => p.cost), 0.01);
  const xMax = Number((maxCost * 1.18).toPrecision(2));
  const frontier = model.points.filter((p) => p.onFrontier);
  const dominated = model.points.filter((p) => !p.onFrontier);

  return (
    <div>
      <div className="h-[470px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart margin={{ top: 26, right: 44, bottom: 44, left: 8 }}>
            <CartesianGrid stroke="var(--rule)" strokeDasharray="0" vertical horizontal />

            <XAxis
              type="number"
              dataKey="cost"
              domain={[0, xMax]}
              tickFormatter={(value: number) => `$${value < 1 ? value.toFixed(2) : value.toFixed(1)}`}
              stroke="var(--axis)"
              tickLine={false}
              label={{
                value: 'Mean cost per run (USD)',
                position: 'insideBottom',
                offset: -22,
                fill: 'var(--ink-2)',
                fontSize: 12,
              }}
            />
            <YAxis
              type="number"
              dataKey="score"
              domain={[0, 1]}
              ticks={[0, 0.25, 0.5, 0.75, 1]}
              tickFormatter={(value: number) => value.toFixed(2)}
              stroke="var(--axis)"
              tickLine={false}
              width={52}
              label={{
                value: 'Mean score',
                angle: -90,
                position: 'insideLeft',
                offset: 14,
                fill: 'var(--ink-2)',
                fontSize: 12,
              }}
            />

            <ReferenceArea
              x1={0}
              x2={model.medianCost}
              y1={model.medianScore}
              y2={1}
              fill="transparent"
              stroke="none"
              label={{
                value: 'cheaper · higher score',
                position: 'insideTopLeft',
                fill: 'var(--muted)',
                fontSize: 10,
              }}
            />
            <ReferenceArea
              x1={model.medianCost}
              x2={xMax}
              y1={model.medianScore}
              y2={1}
              fill="transparent"
              stroke="none"
              label={{
                value: 'higher score · you pay for it',
                position: 'insideTopRight',
                fill: 'var(--muted)',
                fontSize: 10,
              }}
            />
            <ReferenceArea
              x1={0}
              x2={model.medianCost}
              y1={0}
              y2={model.medianScore}
              fill="transparent"
              stroke="none"
              label={{
                value: 'cheap · weak',
                position: 'insideBottomLeft',
                fill: 'var(--muted)',
                fontSize: 10,
              }}
            />
            <ReferenceArea
              x1={model.medianCost}
              x2={xMax}
              y1={0}
              y2={model.medianScore}
              fill="transparent"
              stroke="none"
              label={{
                value: 'costs more · scores less',
                position: 'insideBottomRight',
                fill: 'var(--muted)',
                fontSize: 10,
              }}
            />

            <ReferenceLine x={model.medianCost} stroke="var(--axis)" strokeDasharray="3 3" />
            <ReferenceLine y={model.medianScore} stroke="var(--axis)" strokeDasharray="3 3" />

            <Line
              data={model.frontier}
              dataKey="score"
              type="linear"
              stroke="var(--accent)"
              strokeWidth={2}
              dot={false}
              activeDot={false}
              isAnimationActive={false}
              legendType="none"
            />

            <Scatter
              data={dominated}
              dataKey="score"
              fill="var(--muted)"
              stroke="var(--surface)"
              strokeWidth={2}
              isAnimationActive={false}
            >
              <LabelList
                dataKey="label"
                position="top"
                offset={10}
                fill="var(--muted)"
                fontSize={11}
              />
            </Scatter>

            <Scatter
              data={frontier}
              dataKey="score"
              fill="var(--accent)"
              stroke="var(--surface)"
              strokeWidth={2}
              isAnimationActive={false}
            >
              <LabelList
                dataKey="label"
                position="top"
                offset={10}
                fill="var(--ink)"
                fontSize={11}
              />
            </Scatter>

            <Tooltip
              cursor={{ stroke: 'var(--axis)', strokeDasharray: '3 3' }}
              content={<ParetoTooltip />}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-1 text-[11px] text-muted">
        <span className="inline-flex items-center gap-1.5">
          <span
            aria-hidden
            className="inline-block h-2.5 w-2.5 rounded-full bg-accent"
          />
          on the frontier — nothing scores as well for less
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden className="inline-block h-2.5 w-2.5 rounded-full bg-muted" />
          dominated
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden className="inline-block h-px w-5 bg-accent" />
          frontier path
        </span>
        <span>dashed lines mark the median cost and median score</span>
      </div>
    </div>
  );
}

function ParetoTooltip({ active, payload }: TooltipProps<number, string>) {
  if (!active || !payload || payload.length === 0) return null;
  const point = payload[0]?.payload as ParetoPoint | undefined;
  if (!point) return null;

  return (
    <div className="rounded-[3px] border border-rule bg-surface px-3 py-2 shadow-sm">
      <p className="text-[12px] font-medium text-ink">{point.label}</p>
      <dl className="num mt-1.5 grid grid-cols-[auto_auto] gap-x-3 gap-y-0.5 text-[11px]">
        <dt className="text-muted">score</dt>
        <dd className="text-ink">
          {point.scoreText} <span className="text-muted">({point.ciText})</span>
        </dd>
        <dt className="text-muted">cost / run</dt>
        <dd className="text-ink">{point.costText}</dd>
        <dt className="text-muted">score / $</dt>
        <dd className="text-ink">{point.valueText}</dd>
        <dt className="text-muted">runs</dt>
        <dd className="text-ink">{point.runs}</dd>
      </dl>
    </div>
  );
}
