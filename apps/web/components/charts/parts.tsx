import type { ReactNode } from 'react';

import type { PlacedLabel } from '../../lib/charts';

/**
 * Shared pieces of the SVG chart kit. Everything renders on the server: the
 * charts are plain markup in the exported HTML, readable without JavaScript
 * and by link unfurlers, and themed by CSS variables.
 *
 * Mark specs follow the data-viz rules the site uses everywhere: 2px lines,
 * markers of at least 8px with a 2px ring in the surface colour, hairline
 * solid grids, text in text tokens (never in the series colour).
 */

export const FONT = { tick: 11, label: 11.5, title: 15 } as const;

/**
 * Render a chart twice, at a wide and a narrow layout, and let CSS show the
 * one that fits. Each layout is computed for its own width, so labels are
 * placed for the size they are read at instead of being scaled down.
 */
export function Responsive({
  wide,
  narrow,
}: {
  wide: ReactNode;
  narrow: ReactNode;
}) {
  return (
    <>
      <div className="chart-wide">{wide}</div>
      <div className="chart-narrow">{narrow}</div>
    </>
  );
}

/** The <svg> root: scales down with its container, never up past its design width. */
export function ChartSvg({
  width,
  height,
  label,
  children,
}: {
  width: number;
  height: number;
  label: string;
  children: ReactNode;
}) {
  return (
    <svg
      className="chart mx-auto block h-auto w-full"
      viewBox={`0 0 ${width} ${height}`}
      style={{ maxWidth: width }}
      role="img"
      aria-label={label}
      overflow="visible"
    >
      {children}
    </svg>
  );
}

/** A point estimate's interval: a 2px line with short caps. */
export function Whisker({
  x1,
  y1,
  x2,
  y2,
  color,
  opacity = 0.9,
  cap = 7,
}: {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color: string;
  opacity?: number;
  cap?: number;
}) {
  const vertical = Math.abs(x2 - x1) < Math.abs(y2 - y1);
  const h = cap / 2;
  return (
    <g stroke={color} strokeWidth={2} strokeLinecap="round" opacity={opacity}>
      <line x1={x1} y1={y1} x2={x2} y2={y2} />
      {vertical ? (
        <>
          <line x1={x1 - h} y1={y1} x2={x1 + h} y2={y1} />
          <line x1={x2 - h} y1={y2} x2={x2 + h} y2={y2} />
        </>
      ) : (
        <>
          <line x1={x1} y1={y1 - h} x2={x1} y2={y1 + h} />
          <line x1={x2} y1={y2 - h} x2={x2} y2={y2 + h} />
        </>
      )}
    </g>
  );
}

/** A point mark with the 2px surface ring that keeps it legible over lines. */
export function Marker({
  x,
  y,
  color,
  r = 5.5,
  hollow = false,
  ring = 'var(--surface)',
}: {
  x: number;
  y: number;
  color: string;
  r?: number;
  hollow?: boolean;
  ring?: string;
}) {
  return (
    <g>
      <circle cx={x} cy={y} r={r + 2} fill={ring} />
      {hollow ? (
        <circle cx={x} cy={y} r={r - 1} fill={ring} stroke={color} strokeWidth={2.2} />
      ) : (
        <circle cx={x} cy={y} r={r} fill={color} />
      )}
    </g>
  );
}

/** Direct labels from `placeLabels`, with their leader lines. */
export function Labels({ labels, fontSize = FONT.label }: { labels: PlacedLabel[]; fontSize?: number }) {
  return (
    <g>
      {labels.map((label) => (
        <g key={label.id}>
          {label.leader ? (
            <line
              x1={label.leader.x1}
              y1={label.leader.y1}
              x2={label.leader.x2}
              y2={label.leader.y2}
              stroke="var(--axis)"
              strokeWidth={1}
            />
          ) : null}
          <text
            x={label.x}
            y={label.y}
            textAnchor={label.anchor}
            fontSize={fontSize}
            fill="var(--ink-2)"
            style={{ paintOrder: 'stroke' }}
            stroke="var(--surface)"
            strokeWidth={3}
            strokeLinejoin="round"
          >
            {label.text}
          </text>
        </g>
      ))}
    </g>
  );
}

/** A legend entry: the mark beside the name, so identity never rests on colour alone. */
export function LegendItem({
  color,
  label,
  hollow = false,
}: {
  color: string;
  label: ReactNode;
  hollow?: boolean;
}) {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <svg viewBox="0 0 12 12" width={12} height={12} aria-hidden>
        {hollow ? (
          <circle cx={6} cy={6} r={4.2} fill="none" stroke={color} strokeWidth={2} />
        ) : (
          <circle cx={6} cy={6} r={5} fill={color} />
        )}
      </svg>
      {label}
    </span>
  );
}

/** "Show the numbers": the table twin every chart carries for screen readers and checking. */
export function DataTable({
  summary = 'Show the numbers',
  head,
  rows,
}: {
  summary?: string;
  head: string[];
  rows: (string | number)[][];
}) {
  return (
    <details className="mt-4 text-[0.875rem]">
      <summary className="inline-flex items-center text-ink-2 hover:text-ink">{summary}</summary>
      <div className="scroll-x mt-3 rounded-[10px] border border-rule">
        <table className="w-full border-collapse text-left">
          <thead>
            <tr className="border-b border-rule">
              {head.map((cell, index) => (
                <th key={index} scope="col" className="eyebrow whitespace-nowrap px-3 py-2 font-normal">
                  {cell}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={index} className="border-b border-rule last:border-0">
                {row.map((cell, cellIndex) => (
                  <td
                    key={cellIndex}
                    className={`whitespace-nowrap px-3 py-1.5 ${cellIndex === 0 ? 'text-ink' : 'num text-ink-2'}`}
                  >
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
