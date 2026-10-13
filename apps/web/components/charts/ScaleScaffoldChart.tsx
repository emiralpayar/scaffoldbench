import type { SiteAnalysis } from '../../lib/analysis';
import { architectureColor, architectureName } from '../../lib/architectures';
import { formatBracket, formatScore, formatUsd } from '../../lib/format';
import { modelShortName } from '../../lib/models';
import type { Headline } from '../../lib/scorecard';
import { signed, times } from '../../lib/scorecard';
import { ChartSvg, DataTable, LegendItem, Marker, Responsive, Whisker } from './parts';

interface Point {
  strategyId: string;
  score: number;
  low: number | null;
  high: number | null;
  cost: number;
}

interface Column {
  model: string;
  baselineCost: number;
  points: Point[];
}

/**
 * The result in one picture: every architecture's mean score, model by
 * model. Within a column the five scaffolds scatter around the plain agent's
 * line (the scaffold move); across columns the plain agent climbs (the scale
 * move). Two annotations price both moves on the smallest model.
 */
export function ScaleScaffoldChart({ analysis, headline }: { analysis: SiteAnalysis; headline: Headline }) {
  const columns: Column[] = analysis.models.map((model) => {
    const baseline = model.architectures.find((a) => a.strategyId === analysis.baselineId);
    return {
      model: model.model,
      baselineCost: baseline?.costUsd.mean ?? Number.NaN,
      points: model.architectures.map((a) => ({
        strategyId: a.strategyId,
        score: a.score.mean,
        low: a.score.ci?.low ?? null,
        high: a.score.ci?.high ?? null,
        cost: a.costUsd.mean,
      })),
    };
  });
  const archIds = columns[0]?.points.map((p) => p.strategyId) ?? [];

  const rows = analysis.models.flatMap((model) =>
    model.architectures.map((a) => {
      const contrast = model.contrasts.find((c) => c.strategyId === a.strategyId);
      return [
        modelShortName(model.model),
        architectureName(a.strategyId),
        formatScore(a.score.mean),
        formatBracket(a.score, (v) => formatScore(v)),
        formatUsd(a.costUsd.mean),
        contrast ? `${signed(contrast.scoreDelta.mean)} · ${contrast.verdict}` : 'control',
      ];
    }),
  );

  return (
    <figure>
      <div className="mb-5 flex flex-wrap gap-x-5 gap-y-2 text-[0.8125rem] text-ink-2">
        {archIds.map((id) => (
          <LegendItem key={id} color={architectureColor(id)} label={architectureName(id)} hollow={id === analysis.baselineId} />
        ))}
      </div>
      <Responsive
        wide={<Plot columns={columns} baselineId={analysis.baselineId} headline={headline} width={1040} height={500} />}
        narrow={<Plot columns={columns} baselineId={analysis.baselineId} headline={headline} width={360} height={460} compact />}
      />
      <figcaption className="mt-4 max-w-[52rem] text-[0.8125rem] leading-relaxed text-muted">
        Dots: mean score over 25 tasks (2 repeats each, 50 runs per dot); whiskers: 95% task-clustered
        bootstrap interval. The ring is the plain single agent; the dashed line carries its score across the
        column, so a dot above it is a scaffold that scored higher on average, though none did by a margin the
        paired tests could separate.
      </figcaption>
      <DataTable head={['Model', 'Architecture', 'Score', '95% CI', 'Cost / run', 'vs single (Holm)']} rows={rows} />
    </figure>
  );
}

function Plot({
  columns,
  baselineId,
  headline,
  width,
  height,
  compact = false,
}: {
  columns: Column[];
  baselineId: string;
  headline: Headline;
  width: number;
  height: number;
  compact?: boolean;
}) {
  const m = compact ? { l: 40, r: 8, t: 30, b: 64 } : { l: 56, r: 16, t: 36, b: 72 };
  const lows = columns.flatMap((c) => c.points.map((p) => p.low ?? p.score));
  const yMin = Math.floor((Math.min(...lows) - 0.02) * 20) / 20;
  const yMax = 1;
  const plotH = height - m.t - m.b;
  const y = (v: number) => m.t + ((yMax - v) / (yMax - yMin)) * plotH;
  const colW = (width - m.l - m.r) / columns.length;
  const pad = compact ? 10 : 34;
  const xOf = (col: number, i: number, n: number) => m.l + col * colW + pad + (i * (colW - 2 * pad)) / Math.max(1, n - 1);

  const ticks: number[] = [];
  for (let v = Math.ceil(yMin * 20) / 20; v <= yMax + 1e-9; v += 0.05) ticks.push(Math.round(v * 100) / 100);

  const singles = columns.map((c, ci) => {
    const i = c.points.findIndex((p) => p.strategyId === baselineId);
    const p = c.points[i];
    return p ? { x: xOf(ci, i, c.points.length), y: y(p.score), score: p.score } : null;
  });

  const small = columns[0];
  const best = headline.bestSmall && small ? small.points.findIndex((p) => p.strategyId === headline.bestSmall?.strategyId) : -1;
  const second = singles[1];

  return (
    <ChartSvg
      width={width}
      height={height}
      label="Mean score of six agent architectures on Haiku 4.5, Sonnet 5.5 and Opus 5.5. The single agent rises with each model; the scaffolds scatter around it within each model."
    >
      {/* grid and y axis */}
      {ticks.map((t) => (
        <g key={t}>
          <line x1={m.l} x2={width - m.r} y1={y(t)} y2={y(t)} stroke="var(--grid)" strokeWidth={1} />
          <text x={m.l - 10} y={y(t) + 4} textAnchor="end" className="tick">
            {t.toFixed(2)}
          </text>
        </g>
      ))}
      <text x={m.l - (compact ? 34 : 46)} y={m.t - 18} className="tick" textAnchor="start">
        score
      </text>

      {/* column separators and headers */}
      {columns.map((c, ci) => (
        <g key={c.model}>
          {ci > 0 ? (
            <line x1={m.l + ci * colW} x2={m.l + ci * colW} y1={m.t} y2={height - m.b + 8} stroke="var(--rule)" strokeWidth={1} />
          ) : null}
          <text
            x={m.l + ci * colW + colW / 2}
            y={height - m.b + (compact ? 26 : 30)}
            textAnchor="middle"
            fontSize={compact ? 13 : 15}
            fill="var(--ink)"
            fontWeight={500}
          >
            {modelShortName(c.model)}
          </text>
          <text
            x={m.l + ci * colW + colW / 2}
            y={height - m.b + (compact ? 44 : 52)}
            textAnchor="middle"
            className="tick"
            fontSize={compact ? 10.5 : 12}
          >
            {compact ? formatUsd(c.baselineCost) : `single agent ${formatUsd(c.baselineCost)} / run`}
          </text>
        </g>
      ))}

      {/* each model's single-agent line across its column */}
      {columns.map((c, ci) => {
        const s = singles[ci];
        if (!s) return null;
        return (
          <line
            key={`ref-${c.model}`}
            x1={m.l + ci * colW + 6}
            x2={m.l + (ci + 1) * colW - 6}
            y1={s.y}
            y2={s.y}
            stroke="var(--arch-single)"
            strokeWidth={1.25}
            strokeDasharray="4 4"
            opacity={0.7}
          />
        );
      })}

      {/* the scale move: single agent, model to model */}
      <polyline
        points={singles
          .filter((s): s is NonNullable<typeof s> => s !== null)
          .map((s) => `${s.x},${s.y}`)
          .join(' ')}
        fill="none"
        stroke="var(--ink)"
        strokeWidth={2}
        strokeLinejoin="round"
        opacity={0.85}
      />

      {/* points */}
      {columns.map((c, ci) =>
        c.points.map((p, i) => {
          const x = xOf(ci, i, c.points.length);
          const color = architectureColor(p.strategyId);
          const isBase = p.strategyId === baselineId;
          return (
            <g key={`${c.model}-${p.strategyId}`}>
              <title>{`${architectureName(p.strategyId)} on ${modelShortName(c.model)}: ${formatScore(p.score)}${
                p.low !== null && p.high !== null ? ` [${formatScore(p.low)}, ${formatScore(p.high)}]` : ''
              }, ${formatUsd(p.cost)} per run`}</title>
              {p.low !== null && p.high !== null ? (
                <Whisker x1={x} x2={x} y1={y(p.low)} y2={y(p.high)} color={color} opacity={0.55} cap={compact ? 4 : 6} />
              ) : null}
              <Marker x={x} y={y(p.score)} color={color} r={isBase ? (compact ? 5.5 : 7) : compact ? 4 : 5.5} hollow={isBase} ring="var(--surface)" />
            </g>
          );
        }),
      )}

      {/* annotations */}
      {!compact && second && headline.step ? (
        <Callout
          x={second.x + 14}
          y={second.y + 46}
          lines={[`One model up: ${signed(headline.step.scoreGain)}`, `at ${times(headline.step.costRatio)} the cost`]}
          strong
          leader={{ x1: second.x + 4, y1: second.y + 9, x2: second.x + 12, y2: second.y + 30 }}
        />
      ) : null}
      {!compact && small && best >= 0 && headline.bestSmall ? (
        <Callout
          x={m.l + 16}
          y={y(0.985)}
          lines={[
            `Best ${modelShortName(small.model)} scaffold: ${signed(headline.bestSmall.scoreGain)}`,
            `at ${times(headline.bestSmall.costRatio)} the cost, not separable`,
          ]}
          strong
          leader={{
            x1: xOf(0, best, small.points.length),
            y1: y(0.985) + 26,
            x2: xOf(0, best, small.points.length),
            y2: y(small.points[best]?.high ?? 0.9) - 8,
          }}
        />
      ) : null}
    </ChartSvg>
  );
}

function Callout({
  x,
  y,
  lines,
  anchor = 'start',
  strong = false,
  leader,
}: {
  x: number;
  y: number;
  lines: string[];
  anchor?: 'start' | 'middle' | 'end';
  strong?: boolean;
  leader?: { x1: number; y1: number; x2: number; y2: number };
}) {
  return (
    <g>
      {leader ? (
        <line x1={leader.x1} x2={leader.x2} y1={leader.y1} y2={leader.y2} stroke="var(--axis)" strokeWidth={1} />
      ) : null}
      {lines.map((line, i) => (
        <text
          key={line}
          x={x}
          y={y + i * 17}
          textAnchor={anchor}
          fontSize={i === 0 ? 14 : 12.5}
          fontWeight={i === 0 && strong ? 600 : i === 0 ? 500 : 400}
          fill={i === 0 ? 'var(--ink)' : 'var(--ink-2)'}
          style={{ paintOrder: 'stroke' }}
          stroke="var(--surface)"
          strokeWidth={4}
          strokeLinejoin="round"
        >
          {line}
        </text>
      ))}
    </g>
  );
}
