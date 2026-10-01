import type { PayoffData, PayoffPanel } from '../../lib/chartData';
import { payoffDomains } from '../../lib/chartData';
import { linearScale, linearTicks, logScale, logTicks, niceDomain, placeLabels } from '../../lib/charts';
import { formatDelta, formatMultiple } from '../../lib/format';
import { ChartSvg, DataTable, FONT, Labels, LegendItem, Marker, Whisker } from './parts';

const WIDTH = 380;
const HEIGHT = 336;
const M = { top: 46, right: 14, bottom: 46, left: 50 };

/**
 * "Does the extra structure pay for itself?" — the project's thesis as one
 * picture. Each architecture sits at its cost as a multiple of `single` (log
 * scale, so 2× and ½× are the same distance from 1×) against its paired score
 * difference from `single`, with intervals on both. The grey band is the
 * equivalence margin: an interval inside it means "no practical difference",
 * one wholly above it means the structure bought real score, at the cost the
 * x axis states. One panel per model on shared axes.
 */
export function PayoffSmallMultiples({ data, method }: { data: PayoffData; method: string }) {
  if (data.panels.length === 0) return null;
  const domains = payoffDomains(data);
  const x: [number, number] = [domains.x[0] / 1.18, domains.x[1] * 1.18];
  const y = niceDomain(domains.y[0], domains.y[1], 5);

  const first = data.panels[0];
  const legend = first?.points ?? [];

  return (
    <figure>
      <div className="mb-5 flex flex-wrap gap-x-5 gap-y-2 text-[0.8125rem] text-ink-2">
        <LegendItem color="var(--arch-single)" label="single, the control (1×, 0)" hollow />
        <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
          <span aria-hidden className="block h-3 w-5 rounded-[2px] bg-[var(--band)] ring-1 ring-rule" />
          equivalent to single (±{data.margin.toFixed(2)})
        </span>
        {legend.map((point) => (
          <LegendItem key={point.id} color={point.color} label={point.label} />
        ))}
      </div>

      <div className="grid gap-x-6 gap-y-8 md:grid-cols-2 xl:grid-cols-3">
        {data.panels.map((panel) => (
          <PayoffPanelChart
            key={panel.model}
            panel={panel}
            xDomain={x}
            yDomain={y}
            margin={data.margin}
          />
        ))}
      </div>

      <figcaption className="mt-5 max-w-3xl text-[0.8125rem] leading-relaxed text-muted">
        Vertical whiskers: interval on the score difference. Horizontal whiskers: interval on the
        cost multiple. Grey band: ±{data.margin.toFixed(2)}, the equivalence margin. {method}
      </figcaption>

      <DataTable
        head={['Model', 'Architecture', 'Δ score', 'interval', 'Cost ×', 'interval', 'Verdict']}
        rows={data.panels.flatMap((panel) =>
          panel.points.map((point) => [
            panel.title,
            point.label,
            formatDelta(point.y.mean),
            `${formatDelta(point.y.low)} to ${formatDelta(point.y.high)}`,
            formatMultiple(point.x.mean),
            `${formatMultiple(point.x.low)}–${formatMultiple(point.x.high)}`,
            point.verdict ?? '—',
          ]),
        )}
      />
    </figure>
  );
}

function PayoffPanelChart({
  panel,
  xDomain,
  yDomain,
  margin,
}: {
  panel: PayoffPanel;
  xDomain: [number, number];
  yDomain: [number, number];
  margin: number;
}) {
  const plot = { x: M.left, y: M.top, width: WIDTH - M.left - M.right, height: HEIGHT - M.top - M.bottom };
  const sx = logScale(xDomain, [plot.x, plot.x + plot.width]);
  const sy = linearScale(yDomain, [plot.y + plot.height, plot.y]);
  const xTicks = logTicks(xDomain, 5);
  const yTicks = linearTicks(yDomain, 5);

  const baseline = { x: sx(1), y: sy(0) };
  const labels = placeLabels(
    [
      { id: 'single', text: 'single', x: baseline.x, y: baseline.y, r: 7, fontSize: FONT.label },
      ...panel.points.map((point) => ({
        id: point.id,
        text: point.label,
        x: sx(point.x.mean),
        y: sy(point.y.mean),
        r: 8,
        fontSize: FONT.label,
      })),
    ],
    { x: plot.x + 2, y: plot.y + 2, width: plot.width - 4, height: plot.height - 4 },
    // Labels keep off the whiskers too, not just the dots.
    panel.points.flatMap((point) => [
      { x: sx(point.x.mean) - 1.5, y: sy(point.y.high), width: 3, height: sy(point.y.low) - sy(point.y.high) },
      { x: sx(point.x.low), y: sy(point.y.mean) - 1.5, width: sx(point.x.high) - sx(point.x.low), height: 3 },
    ]),
  );

  return (
    <div>
      <ChartSvg
        width={WIDTH}
        height={HEIGHT}
        label={`${panel.title}: score difference from single against cost multiple for ${panel.points.length} architectures.`}
      >
        <text x={M.left} y={18} fontSize={FONT.title} fill="var(--ink)" style={{ fontFamily: 'var(--font-serif)' }} fontWeight={500}>
          {panel.title}
        </text>
        <text x={WIDTH - M.right} y={18} fontSize={FONT.tick} fill="var(--muted)" textAnchor="end" className="num">
          {panel.pairs}
        </text>

        {/* equivalence band */}
        <rect
          x={plot.x}
          y={sy(margin)}
          width={plot.width}
          height={Math.max(0, sy(-margin) - sy(margin))}
          fill="var(--band)"
        />

        {/* grid */}
        {yTicks.map((tick) => (
          <g key={`y${tick}`}>
            <line x1={plot.x} x2={plot.x + plot.width} y1={sy(tick)} y2={sy(tick)} stroke="var(--grid)" strokeWidth={1} />
            <text x={plot.x - 8} y={sy(tick) + 3.5} textAnchor="end" className="tick">
              {tick === 0 ? '0' : formatDelta(tick, 2)}
            </text>
          </g>
        ))}
        {xTicks.map((tick) => (
          <g key={`x${tick}`}>
            <line x1={sx(tick)} x2={sx(tick)} y1={plot.y} y2={plot.y + plot.height} stroke="var(--grid)" strokeWidth={1} />
            <text x={sx(tick)} y={plot.y + plot.height + 16} textAnchor="middle" className="tick">
              {`${tick}×`}
            </text>
          </g>
        ))}

        {/* reference lines: same score, same cost */}
        <line x1={plot.x} x2={plot.x + plot.width} y1={baseline.y} y2={baseline.y} stroke="var(--ink-2)" strokeWidth={1} />
        <line x1={baseline.x} x2={baseline.x} y1={plot.y} y2={plot.y + plot.height} stroke="var(--rule-strong)" strokeWidth={1} />

        {/* axis titles */}
        <text x={plot.x + plot.width / 2} y={HEIGHT - 8} textAnchor="middle" fontSize={FONT.tick} fill="var(--muted)">
          cost relative to single (log scale)
        </text>
        <text x={plot.x - 8} y={plot.y - 10} textAnchor="end" fontSize={FONT.tick} fill="var(--muted)">
          Δ score
        </text>

        {/* the control */}
        <Marker x={baseline.x} y={baseline.y} color="var(--arch-single)" hollow r={5.5} />

        {panel.points.map((point) => {
          const cx = sx(point.x.mean);
          const cy = sy(point.y.mean);
          return (
            <g key={point.id}>
              <title>{point.note}</title>
              <Whisker x1={sx(point.x.low)} y1={cy} x2={sx(point.x.high)} y2={cy} color={point.color} opacity={0.45} cap={5} />
              <Whisker x1={cx} y1={sy(point.y.low)} x2={cx} y2={sy(point.y.high)} color={point.color} opacity={0.95} />
              <Marker x={cx} y={cy} color={point.color} />
            </g>
          );
        })}

        <Labels labels={labels} />
      </ChartSvg>
    </div>
  );
}
