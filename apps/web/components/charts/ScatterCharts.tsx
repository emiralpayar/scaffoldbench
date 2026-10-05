import type { IntervalPoint, ScaffoldScaleGroup } from '../../lib/chartData';
import type { Rect } from '../../lib/charts';
import {
  linearScale,
  linearTicks,
  logPad,
  logScale,
  logTicks,
  niceDomain,
  placeLabels,
} from '../../lib/charts';
import { boundsOf, formatRange, formatUsd } from '../../lib/format';
import { ChartSvg, DataTable, FONT, Labels, LegendItem, Marker, Responsive, Whisker } from './parts';

interface Frame {
  width: number;
  height: number;
  plot: Rect;
}

function frame(width: number, height: number): Frame {
  const narrow = width < 500;
  const m = { top: 30, right: narrow ? 10 : 18, bottom: 46, left: narrow ? 44 : 54 };
  return {
    width,
    height,
    plot: { x: m.left, y: m.top, width: width - m.left - m.right, height: height - m.top - m.bottom },
  };
}

function extentOf(points: readonly IntervalPoint[]): { x: [number, number]; y: [number, number] } {
  const xs = points.flatMap((p) => [...boundsOf(p.x), p.x.mean]).filter((v) => v > 0);
  const ys = points.flatMap((p) => [...boundsOf(p.y), p.y.mean]);
  const [x0, x1] = logPad(Math.min(...xs), Math.max(...xs), 1.2);
  const [y0, y1] = niceDomain(Math.min(...ys), Math.max(...ys), 5);
  return { x: [x0, x1], y: [Math.max(0, y0), Math.min(1, y1)] };
}

function Axes({
  f,
  sx,
  sy,
  xTicks,
  yTicks,
  xTitle,
  yTitle,
}: {
  f: Frame;
  sx: (v: number) => number;
  sy: (v: number) => number;
  xTicks: number[];
  yTicks: number[];
  xTitle: string;
  yTitle: string;
}) {
  const { plot } = f;
  return (
    <g>
      {yTicks.map((tick) => (
        <g key={`y${tick}`}>
          <line x1={plot.x} x2={plot.x + plot.width} y1={sy(tick)} y2={sy(tick)} stroke="var(--grid)" strokeWidth={1} />
          <text x={plot.x - 8} y={sy(tick) + 3.5} textAnchor="end" className="tick">
            {tick.toFixed(2)}
          </text>
        </g>
      ))}
      {xTicks.map((tick) => (
        <g key={`x${tick}`}>
          <line x1={sx(tick)} x2={sx(tick)} y1={plot.y} y2={plot.y + plot.height} stroke="var(--grid)" strokeWidth={1} />
          <text x={sx(tick)} y={plot.y + plot.height + 16} textAnchor="middle" className="tick">
            {formatUsd(tick)}
          </text>
        </g>
      ))}
      <line x1={plot.x} x2={plot.x + plot.width} y1={plot.y + plot.height} y2={plot.y + plot.height} stroke="var(--axis)" strokeWidth={1} />
      <text x={plot.x + plot.width / 2} y={f.height - 8} textAnchor="middle" fontSize={FONT.tick} fill="var(--muted)">
        {xTitle}
      </text>
      <text x={plot.x - 8} y={plot.y - 12} textAnchor="end" fontSize={FONT.tick} fill="var(--muted)">
        {yTitle}
      </text>
    </g>
  );
}

function IntervalMark({
  point,
  sx,
  sy,
}: {
  point: IntervalPoint;
  sx: (v: number) => number;
  sy: (v: number) => number;
}) {
  const cx = sx(point.x.mean);
  const cy = sy(point.y.mean);
  return (
    <g>
      <title>{point.note}</title>
      {point.x.ci ? (
        <Whisker x1={sx(point.x.ci.low)} y1={cy} x2={sx(point.x.ci.high)} y2={cy} color={point.color} opacity={0.5} cap={5} />
      ) : null}
      {point.y.ci ? <Whisker x1={cx} y1={sy(point.y.ci.low)} x2={cx} y2={sy(point.y.ci.high)} color={point.color} /> : null}
      <Marker x={cx} y={cy} color={point.color} hollow={point.hollow ?? false} />
    </g>
  );
}

function whiskerObstacles(points: readonly IntervalPoint[], sx: (v: number) => number, sy: (v: number) => number): Rect[] {
  return points.flatMap((point) => {
    const rects: Rect[] = [];
    // A point with no interval has no whisker for a label to keep off.
    const { x, y } = point;
    if (y.ci) rects.push({ x: sx(x.mean) - 1.5, y: sy(y.ci.high), width: 3, height: sy(y.ci.low) - sy(y.ci.high) });
    if (x.ci) rects.push({ x: sx(x.ci.low), y: sy(y.mean) - 1.5, width: sx(x.ci.high) - sx(x.ci.low), height: 3 });
    return rects;
  });
}

// ---------------------------------------------------------------------------
// Pareto: score against cost for one model
// ---------------------------------------------------------------------------

/**
 * Score against cost with intervals on both axes and the frontier drawn as a
 * step (a straight segment would imply in-between points exist). The frontier
 * is the paired verdicts' reading, not the means': a point is a ring only when
 * another architecture is shown to beat it on one axis and match it on the
 * other, so a point that trails on means but cannot be separated stays on it.
 */
export function ParetoPlot({
  points,
  model,
  basis = 'evidence',
}: {
  points: IntervalPoint[];
  model: string;
  /** `means`: a run set without fidelity checks, whose frontier is read off the means alone. */
  basis?: 'evidence' | 'means';
}) {
  if (points.length === 0) return null;
  return (
    <figure>
      <div className="mb-4 flex flex-wrap gap-x-5 gap-y-2 text-[0.8125rem] text-ink-2">
        <LegendItem color="var(--ink-2)" label={basis === 'means' ? 'on the mean frontier' : 'on the frontier: not shown to be beaten'} />
        <LegendItem
          color="var(--ink-2)"
          label={basis === 'means' ? 'dominated on means' : 'beaten on one axis, matched on the other'}
          hollow
        />
      </div>
      <Responsive
        wide={<ParetoSvg points={points} model={model} width={680} height={420} />}
        narrow={<ParetoSvg points={points} model={model} width={340} height={360} />}
      />
      <DataTable
        head={['Architecture', 'Score', 'interval', 'Cost / run', 'interval', 'Frontier']}
        rows={points.map((p) => [
          p.label,
          p.y.mean.toFixed(3),
          formatRange(p.y, (v) => v.toFixed(3)),
          formatUsd(p.x.mean),
          formatRange(p.x, formatUsd),
          p.hollow ? (basis === 'means' ? 'dominated' : 'beaten') : 'frontier',
        ])}
      />
    </figure>
  );
}

function ParetoSvg({
  points,
  model,
  width,
  height,
}: {
  points: IntervalPoint[];
  model: string;
  width: number;
  height: number;
}) {
  const f = frame(width, height);
  const extent = extentOf(points);
  const sx = logScale(extent.x, [f.plot.x, f.plot.x + f.plot.width]);
  const sy = linearScale(extent.y, [f.plot.y + f.plot.height, f.plot.y]);
  const xTicks = logTicks(extent.x, width < 500 ? 4 : 6);
  const yTicks = linearTicks(extent.y, 5);

  const frontier = points.filter((p) => !p.hollow).sort((a, b) => a.x.mean - b.x.mean);
  let step = '';
  frontier.forEach((p, i) => {
    const x = sx(p.x.mean);
    const y = sy(p.y.mean);
    if (i === 0) step = `M ${x} ${y}`;
    else step += ` H ${x} V ${y}`;
  });

  const labels = placeLabels(
    points.map((p) => ({ id: p.id, text: p.label, x: sx(p.x.mean), y: sy(p.y.mean), r: 8, fontSize: FONT.label })),
    { x: f.plot.x + 2, y: f.plot.y + 2, width: f.plot.width - 4, height: f.plot.height - 4 },
    whiskerObstacles(points, sx, sy),
  );

  return (
    <ChartSvg width={width} height={height} label={`Mean score against mean cost per run on ${model}, with intervals on both axes.`}>
      <Axes f={f} sx={sx} sy={sy} xTicks={xTicks} yTicks={yTicks} xTitle="mean cost per run (USD, log scale)" yTitle="score" />
      {step ? <path d={step} fill="none" stroke="var(--ink-2)" strokeWidth={1.5} strokeLinejoin="round" opacity={0.7} /> : null}
      {points.map((point) => (
        <IntervalMark key={point.id} point={point} sx={sx} sy={sy} />
      ))}
      <Labels labels={labels} />
    </ChartSvg>
  );
}

// ---------------------------------------------------------------------------
// Scaffold or scale: all models on one plane
// ---------------------------------------------------------------------------

/**
 * Every model's architectures on one score-against-cost plane. Each model's
 * plain `single` agent is a ring labelled with the model; thin spokes join it
 * to that model's scaffolded variants (the "scaffold" moves), and a heavier
 * arrow joins one model's `single` to the next model's (the "scale" move).
 * Both moves cost money; the picture asks which buys more score per step.
 */
export function ScaffoldScaleChart({ groups }: { groups: ScaffoldScaleGroup[] }) {
  const usable = groups.filter((g) => g.baseline);
  if (usable.length === 0) return null;
  const legend = usable[0]?.points ?? [];
  return (
    <figure>
      <div className="mb-4 flex flex-wrap gap-x-5 gap-y-2 text-[0.8125rem] text-ink-2">
        <LegendItem color="var(--arch-single)" label="single, labelled by model" hollow />
        {legend.map((point) => (
          <LegendItem key={point.label} color={point.color} label={point.label} />
        ))}
      </div>
      <Responsive
        wide={<ScaffoldScaleSvg groups={usable} width={760} height={480} />}
        narrow={<ScaffoldScaleSvg groups={usable} width={340} height={420} />}
      />
      <DataTable
        head={['Model', 'Architecture', 'Score', 'interval', 'Cost / run']}
        rows={usable.flatMap((group) =>
          [group.baseline, ...group.points]
            .filter((p): p is IntervalPoint => !!p)
            .map((p) => [group.title, p.label, p.y.mean.toFixed(3), formatRange(p.y, (v) => v.toFixed(3)), formatUsd(p.x.mean)]),
        )}
      />
    </figure>
  );
}

function ScaffoldScaleSvg({
  groups,
  width,
  height,
}: {
  groups: ScaffoldScaleGroup[];
  width: number;
  height: number;
}) {
  const f = frame(width, height);
  const all = groups.flatMap((g) => [...(g.baseline ? [g.baseline] : []), ...g.points]);
  const extent = extentOf(all);
  const sx = logScale(extent.x, [f.plot.x, f.plot.x + f.plot.width]);
  const sy = linearScale(extent.y, [f.plot.y + f.plot.height, f.plot.y]);
  const xTicks = logTicks(extent.x, width < 500 ? 4 : 6);
  const yTicks = linearTicks(extent.y, 5);

  const baselines = groups.map((g) => g.baseline).filter((p): p is IntervalPoint => !!p);
  const labels = placeLabels(
    groups
      .filter((g) => g.baseline)
      .map((g) => ({
        id: g.model,
        text: g.title,
        x: sx(g.baseline!.x.mean),
        y: sy(g.baseline!.y.mean),
        r: 9,
        fontSize: 12.5,
      })),
    { x: f.plot.x + 2, y: f.plot.y + 2, width: f.plot.width - 4, height: f.plot.height - 4 },
    [
      ...all.map((p) => ({ x: sx(p.x.mean) - 7, y: sy(p.y.mean) - 7, width: 14, height: 14 })),
      ...whiskerObstacles(all, sx, sy),
    ],
  );

  return (
    <ChartSvg width={width} height={height} label="Mean score against mean cost for every architecture on every model.">
      <defs>
        <marker id={`scale-arrow-${width}`} viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M 0 1 L 9 5 L 0 9 z" fill="var(--ink-2)" />
        </marker>
      </defs>
      <Axes f={f} sx={sx} sy={sy} xTicks={xTicks} yTicks={yTicks} xTitle="mean cost per run (USD, log scale)" yTitle="score" />

      {/* scaffold spokes */}
      {groups.map((g) =>
        g.baseline
          ? g.points.map((p) => (
              <line
                key={`spoke-${p.id}`}
                x1={sx(g.baseline!.x.mean)}
                y1={sy(g.baseline!.y.mean)}
                x2={sx(p.x.mean)}
                y2={sy(p.y.mean)}
                stroke={p.color}
                strokeWidth={1.25}
                opacity={0.45}
              />
            ))
          : null,
      )}

      {/* scale arrows */}
      {baselines.slice(1).map((next, i) => {
        const prev = baselines[i] as IntervalPoint;
        const x1 = sx(prev.x.mean);
        const y1 = sy(prev.y.mean);
        const x2 = sx(next.x.mean);
        const y2 = sy(next.y.mean);
        const length = Math.hypot(x2 - x1, y2 - y1) || 1;
        const trim = 11;
        return (
          <line
            key={`scale-${next.id}`}
            x1={x1 + ((x2 - x1) / length) * trim}
            y1={y1 + ((y2 - y1) / length) * trim}
            x2={x2 - ((x2 - x1) / length) * trim}
            y2={y2 - ((y2 - y1) / length) * trim}
            stroke="var(--ink-2)"
            strokeWidth={1.75}
            strokeDasharray="5 4"
            markerEnd={`url(#scale-arrow-${width})`}
          />
        );
      })}

      {/* Architectures stay quiet (score interval only); the rings carry the story. */}
      {groups.flatMap((g) => g.points).map((point) => {
        const cx = sx(point.x.mean);
        return (
          <g key={point.id}>
            <title>{point.note}</title>
            {point.y.ci ? (
              <Whisker x1={cx} y1={sy(point.y.ci.low)} x2={cx} y2={sy(point.y.ci.high)} color={point.color} opacity={0.35} cap={5} />
            ) : null}
            <Marker x={cx} y={sy(point.y.mean)} color={point.color} r={4.5} />
          </g>
        );
      })}
      {baselines.map((point) => (
        <IntervalMark key={point.id} point={point} sx={sx} sy={sy} />
      ))}
      <Labels labels={labels} fontSize={12.5} />
    </ChartSvg>
  );
}
