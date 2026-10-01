/**
 * Geometry for the server-rendered chart kit: scales, round ticks and a
 * collision-free label placer. Pure functions, so every chart can be laid out
 * at build time and shipped as plain SVG with no client JavaScript.
 */

export interface Scale {
  (value: number): number;
  domain: [number, number];
  range: [number, number];
}

export function linearScale(domain: [number, number], range: [number, number]): Scale {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const span = d1 - d0 || 1;
  const scale = ((value: number) => r0 + ((value - d0) / span) * (r1 - r0)) as Scale;
  scale.domain = domain;
  scale.range = range;
  return scale;
}

/** Log scale for strictly positive data such as costs and cost multiples. */
export function logScale(domain: [number, number], range: [number, number]): Scale {
  const [d0, d1] = domain.map((v) => Math.log(Math.max(v, 1e-12))) as [number, number];
  const [r0, r1] = range;
  const span = d1 - d0 || 1;
  const scale = ((value: number) =>
    r0 + ((Math.log(Math.max(value, 1e-12)) - d0) / span) * (r1 - r0)) as Scale;
  scale.domain = domain;
  scale.range = range;
  return scale;
}

/** A round step (1, 2, 2.5 or 5 × 10ⁿ) that splits `span` into about `count` parts. */
export function niceStep(span: number, count: number): number {
  if (!(span > 0)) return 1;
  const raw = span / Math.max(1, count);
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const residual = raw / magnitude;
  const factor = residual <= 1 ? 1 : residual <= 2 ? 2 : residual <= 2.5 ? 2.5 : residual <= 5 ? 5 : 10;
  return factor * magnitude;
}

/** Expand [min, max] outward to round numbers, so the axis starts and ends on a tick. */
export function niceDomain(min: number, max: number, count = 5): [number, number] {
  if (min === max) {
    const pad = Math.abs(min) * 0.1 || 0.1;
    return niceDomain(min - pad, max + pad, count);
  }
  const step = niceStep(max - min, count);
  return [roundTo(Math.floor(min / step) * step), roundTo(Math.ceil(max / step) * step)];
}

export function linearTicks(domain: [number, number], count = 5): number[] {
  const [min, max] = domain;
  const step = niceStep(max - min, count);
  const ticks: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) {
    ticks.push(roundTo(v));
  }
  return ticks;
}

/**
 * Ticks for a log axis that read as plain numbers: 1, 1.5, 2, 3, 5 … within
 * each decade, thinned to at most `max` labels. A log axis labelled with
 * powers of ten alone would be useless across the 1×–4× span cost lives in.
 */
export function logTicks(domain: [number, number], max = 6): number[] {
  const [min, maxValue] = domain;
  const mantissas = [1, 1.5, 2, 3, 4, 5, 6, 8];
  const candidates: number[] = [];
  for (let exp = Math.floor(Math.log10(min)) - 1; exp <= Math.ceil(Math.log10(maxValue)); exp++) {
    for (const m of mantissas) {
      const value = roundTo(m * 10 ** exp);
      if (value >= min * (1 - 1e-9) && value <= maxValue * (1 + 1e-9)) candidates.push(value);
    }
  }
  if (candidates.length <= max) return candidates;
  // Keep a log-evenly spaced subset: target positions, nearest candidate each.
  const lo = Math.log(candidates[0] as number);
  const hi = Math.log(candidates[candidates.length - 1] as number);
  const picked = new Set<number>();
  for (let i = 0; i < max; i++) {
    const target = lo + ((hi - lo) * i) / (max - 1);
    let best = candidates[0] as number;
    for (const c of candidates) {
      if (Math.abs(Math.log(c) - target) < Math.abs(Math.log(best) - target)) best = c;
    }
    picked.add(best);
  }
  return [...picked].sort((a, b) => a - b);
}

/** Pad a positive [min, max] by a ratio on a log axis. */
export function logPad(min: number, max: number, ratio = 1.15): [number, number] {
  return [min / ratio, max * ratio];
}

function roundTo(value: number, digits = 10): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

// ---------------------------------------------------------------------------
// Text measurement and label placement
// ---------------------------------------------------------------------------

/**
 * Width of a label in Geist at `fontSize`, from per-glyph-class advance
 * widths. An estimate (the server has no layout engine), deliberately on the
 * generous side so placed labels never touch.
 */
export function estimateTextWidth(text: string, fontSize: number): number {
  let em = 0;
  for (const ch of text) {
    if ('ilI.,:;|!\'`'.includes(ch)) em += 0.3;
    else if ('fjrt()[] '.includes(ch)) em += 0.38;
    else if ('mwMW'.includes(ch)) em += 0.86;
    else if (/[A-Z]/.test(ch)) em += 0.68;
    else if (/[0-9]/.test(ch)) em += 0.6;
    else if ('−–—×'.includes(ch)) em += 0.62;
    else em += 0.56;
  }
  return em * fontSize;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LabelRequest {
  id: string;
  text: string;
  /** The point the label belongs to. */
  x: number;
  y: number;
  /** Radius of the point's mark, kept clear. */
  r: number;
  fontSize: number;
}

export interface PlacedLabel {
  id: string;
  text: string;
  /** Text anchor position (SVG `x`, baseline-adjusted `y`). */
  x: number;
  y: number;
  anchor: 'start' | 'middle' | 'end';
  box: Rect;
  /** A connector from the mark to the label, when the label had to move away. */
  leader?: { x1: number; y1: number; x2: number; y2: number };
}

type Direction = [dx: number, dy: number];

const DIRECTIONS: Direction[] = [
  [1, 0],
  [-1, 0],
  [0, -1],
  [0, 1],
  [1, -1],
  [1, 1],
  [-1, -1],
  [-1, 1],
];

const RINGS = [5, 12, 22, 34, 48];

function intersects(a: Rect, b: Rect, pad = 2): boolean {
  return (
    a.x < b.x + b.width + pad &&
    b.x < a.x + a.width + pad &&
    a.y < b.y + b.height + pad &&
    b.y < a.y + a.height + pad
  );
}

function inside(a: Rect, bounds: Rect): boolean {
  return (
    a.x >= bounds.x &&
    a.y >= bounds.y &&
    a.x + a.width <= bounds.x + bounds.width &&
    a.y + a.height <= bounds.y + bounds.height
  );
}

function overlapArea(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/**
 * Greedy placement: each label, in the order given, takes the first position
 * — trying the eight compass directions at increasing distance — that hits no
 * placed label, no point mark and stays inside `bounds`. A label that had to
 * move beyond the first ring gets a leader line back to its point. If nothing
 * is free, it takes the position with the least overlap rather than vanishing.
 */
export function placeLabels(
  requests: readonly LabelRequest[],
  bounds: Rect,
  extraObstacles: readonly Rect[] = [],
): PlacedLabel[] {
  const marks: Rect[] = requests.map((r) => ({
    x: r.x - r.r,
    y: r.y - r.r,
    width: r.r * 2,
    height: r.r * 2,
  }));
  const placed: PlacedLabel[] = [];

  for (const request of requests) {
    const width = estimateTextWidth(request.text, request.fontSize);
    const height = request.fontSize * 1.15;
    const obstacles = [...marks, ...extraObstacles, ...placed.map((p) => p.box)];

    let best: { label: PlacedLabel; cost: number } | null = null;

    for (const ring of RINGS) {
      for (const [dx, dy] of DIRECTIONS) {
        const label = candidate(request, dx, dy, request.r + ring, width, height);
        if (!inside(label.box, bounds)) continue;
        const cost = obstacles.reduce((sum, o) => sum + overlapArea(label.box, o), 0);
        const clear = obstacles.every((o) => !intersects(label.box, o));
        if (clear) {
          best = { label, cost: -1 };
          break;
        }
        if (!best || cost < best.cost) best = { label, cost };
      }
      if (best?.cost === -1) break;
    }

    const chosen = best?.label ?? candidate(request, 1, 0, request.r + RINGS[0]!, width, height);
    const distance = Math.hypot(
      chosen.box.x + chosen.box.width / 2 - request.x,
      chosen.box.y + chosen.box.height / 2 - request.y,
    );
    if (distance > request.r + width / 2 + 16) {
      chosen.leader = leaderTo(request, chosen.box);
    }
    placed.push(chosen);
  }
  return placed;
}

function candidate(
  request: LabelRequest,
  dx: number,
  dy: number,
  distance: number,
  width: number,
  height: number,
): PlacedLabel {
  const cx = request.x + dx * distance;
  const cy = request.y + dy * distance;
  const anchor: PlacedLabel['anchor'] = dx > 0 ? 'start' : dx < 0 ? 'end' : 'middle';
  const left = anchor === 'start' ? cx : anchor === 'end' ? cx - width : cx - width / 2;
  const top = dy < 0 ? cy - height : dy > 0 ? cy : cy - height / 2;
  return {
    id: request.id,
    text: request.text,
    x: anchor === 'start' ? left : anchor === 'end' ? left + width : left + width / 2,
    // Baseline sits ~22% above the box bottom for this cap height.
    y: top + height * 0.8,
    anchor,
    box: { x: left, y: top, width, height },
  };
}

function leaderTo(request: LabelRequest, box: Rect): PlacedLabel['leader'] {
  const tx = Math.min(Math.max(request.x, box.x), box.x + box.width);
  const ty = Math.min(Math.max(request.y, box.y), box.y + box.height);
  const dx = tx - request.x;
  const dy = ty - request.y;
  const length = Math.hypot(dx, dy) || 1;
  return {
    x1: request.x + (dx / length) * (request.r + 2),
    y1: request.y + (dy / length) * (request.r + 2),
    x2: tx - (dx / length) * 2,
    y2: ty - (dy / length) * 2,
  };
}
