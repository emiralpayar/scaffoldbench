import type { CSSProperties } from 'react';

import { architectureColor, architectureInfo } from '../lib/architectures';
import type { GlyphEdge, GlyphGeometry, GlyphNode } from '../lib/glyphs';
import { GLYPH_HEIGHT, GLYPH_WIDTH, glyphFor } from '../lib/glyphs';

const RADIUS: Record<GlyphNode['kind'], number> = {
  agent: 3.6,
  worker: 2.6,
  plan: 3.2,
  decide: 3.9,
  gate: 5,
  reviewer: 2.3,
};

/**
 * An architecture drawn as its topology: who runs, in what order, in
 * parallel or not. The same picture on every page, in the social card and in
 * the favicon is what lets a reader recognise a design without its name.
 *
 * `dead` greys out nodes that never did their job and strikes them through;
 * Act 1 uses it to draw an architecture as it actually ran. `animated` draws
 * the edges in once (and does nothing under reduced motion).
 */
export function ArchitectureGlyph({
  id,
  width = 40,
  dead = [],
  animated = false,
  delayMs = 0,
  title,
  decorative = false,
  className,
}: {
  id: string;
  width?: number;
  dead?: readonly string[];
  animated?: boolean;
  delayMs?: number;
  /** Accessible name; defaults to the architecture's shape in words. */
  title?: string;
  /** Hidden from assistive technology, for a glyph drawn beside the name it stands for. */
  decorative?: boolean;
  className?: string;
}) {
  const geometry = glyphFor(id);
  if (!geometry) return null;

  const info = architectureInfo(id);
  const label = title ?? `${info?.name ?? id}: ${info?.shape ?? 'architecture'}`;
  const color = architectureColor(id);
  const deadSet = new Set(dead);
  const height = (width * GLYPH_HEIGHT) / GLYPH_WIDTH;

  return (
    <svg
      viewBox={`0 0 ${GLYPH_WIDTH} ${GLYPH_HEIGHT}`}
      width={width}
      height={height}
      {...(decorative ? { 'aria-hidden': true } : { role: 'img', 'aria-label': label })}
      className={`${animated ? 'glyph-animated' : ''} ${className ?? ''}`}
      style={{ '--glyph-delay': `${delayMs}ms`, overflow: 'visible' } as CSSProperties}
    >
      <GlyphBody geometry={geometry} color={color} dead={deadSet} />
    </svg>
  );
}

/** The glyph's shapes without the outer <svg>, for embedding in charts. */
export function GlyphBody({
  geometry,
  color,
  dead,
}: {
  geometry: GlyphGeometry;
  color: string;
  dead: ReadonlySet<string>;
}) {
  const byId = new Map(geometry.nodes.map((node) => [node.id, node]));

  return (
    <g>
      {geometry.edges.map((edge, index) => {
        const from = byId.get(edge.from);
        const to = byId.get(edge.to);
        if (!from || !to) return null;
        const broken = dead.has(edge.from) || dead.has(edge.to);
        return (
          <Edge
            key={`${edge.from}-${edge.to}`}
            edge={edge}
            from={from}
            to={to}
            color={broken ? 'var(--muted)' : color}
            broken={broken}
            index={index}
          />
        );
      })}
      {geometry.nodes.map((node, index) => (
        <Node
          key={node.id}
          node={node}
          color={dead.has(node.id) ? 'var(--muted)' : color}
          dead={dead.has(node.id)}
          index={index}
        />
      ))}
    </g>
  );
}

function Edge({
  edge,
  from,
  to,
  color,
  broken,
  index,
}: {
  edge: GlyphEdge;
  from: GlyphNode;
  to: GlyphNode;
  color: string;
  broken: boolean;
  index: number;
}) {
  const style = { '--edge-index': index } as CSSProperties;
  const common = {
    className: 'glyph-edge',
    stroke: color,
    strokeWidth: 1.15,
    strokeLinecap: 'round' as const,
    fill: 'none',
    opacity: broken ? 0.5 : 0.62,
    pathLength: 1,
    style,
    ...(broken || edge.kind === 'review' ? { strokeDasharray: broken ? '0.06 0.05' : '0.08 0.06' } : {}),
  };

  if (edge.kind === 'loop') {
    // An arc from the later node back over the top to the earlier one.
    const r1 = RADIUS[from.kind];
    const r2 = RADIUS[to.kind];
    const lift = 11;
    const d = `M ${from.x - r1 * 0.7} ${from.y - r1 * 0.7} Q ${(from.x + to.x) / 2} ${from.y - lift} ${to.x + r2 * 0.7} ${to.y - r2 * 0.7}`;
    return <path d={d} {...common} />;
  }

  const [x1, y1, x2, y2] = trim(from, to);
  return <line x1={x1} y1={y1} x2={x2} y2={y2} {...common} />;
}

/** Shorten an edge so it starts and ends at the node outlines, not their centres. */
function trim(from: GlyphNode, to: GlyphNode): [number, number, number, number] {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy) || 1;
  const gap = 1.1;
  const a = from.kind === 'gate' ? 1.8 : RADIUS[from.kind] + gap;
  const b = to.kind === 'gate' ? 1.8 : RADIUS[to.kind] + gap;
  return [
    from.x + (dx / length) * a,
    from.y + (dy / length) * a,
    to.x - (dx / length) * b,
    to.y - (dy / length) * b,
  ];
}

function Node({
  node,
  color,
  dead,
  index,
}: {
  node: GlyphNode;
  color: string;
  dead: boolean;
  index: number;
}) {
  const r = RADIUS[node.kind];
  const style = { '--node-index': index } as CSSProperties;
  const opacity = dead ? 0.55 : 1;

  let shape;
  switch (node.kind) {
    case 'plan':
    case 'reviewer':
      shape = (
        <circle cx={node.x} cy={node.y} r={r} fill="none" stroke={color} strokeWidth={1.4} />
      );
      break;
    case 'decide':
      shape = (
        <rect
          x={node.x - r * 0.72}
          y={node.y - r * 0.72}
          width={r * 1.44}
          height={r * 1.44}
          rx={0.6}
          transform={`rotate(45 ${node.x} ${node.y})`}
          fill={color}
        />
      );
      break;
    case 'gate':
      shape = (
        <g stroke={color} strokeWidth={1.5} strokeLinecap="round">
          <line x1={node.x - 1.4} y1={node.y - r} x2={node.x - 1.4} y2={node.y + r} />
          <line x1={node.x + 1.4} y1={node.y - r} x2={node.x + 1.4} y2={node.y + r} />
        </g>
      );
      break;
    default:
      shape = <circle cx={node.x} cy={node.y} r={r} fill={color} />;
  }

  const s = Math.min(r, 3.4) + 0.9;
  return (
    <g className="glyph-node" style={style}>
      <g opacity={opacity}>{shape}</g>
      {dead ? (
        <g stroke="var(--bad)" strokeWidth={1.25} strokeLinecap="round">
          <line x1={node.x - s} y1={node.y - s} x2={node.x + s} y2={node.y + s} />
          <line x1={node.x - s} y1={node.y + s} x2={node.x + s} y2={node.y - s} />
        </g>
      ) : null}
    </g>
  );
}
