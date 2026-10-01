/**
 * Geometry for the architecture glyphs: each design drawn as a tiny topology
 * diagram on a 40×24 grid.
 *
 * The geometry is data, not markup, so the same shapes render in the page
 * (`ArchitectureGlyph`), in the generated social card and in the "as it ran"
 * diagrams of Act 1, where individual nodes are marked dead by id.
 */

import type { ArchitectureId } from './architectures';

export const GLYPH_WIDTH = 40;
export const GLYPH_HEIGHT = 24;

export type GlyphNodeKind =
  /** An agent that acts with tools. */
  | 'agent'
  /** A smaller agent in a parallel pool. */
  | 'worker'
  /** A tool-less reasoning step (planning). */
  | 'plan'
  /** A decision point: verifying or selecting. */
  | 'decide'
  /** A gate every action has to pass. */
  | 'gate'
  /** A read-only reviewer standing beside a gate. */
  | 'reviewer';

export interface GlyphNode {
  id: string;
  kind: GlyphNodeKind;
  x: number;
  y: number;
  /** Plain-language role, for accessible names and the Act 1 receipts. */
  role: string;
}

export interface GlyphEdge {
  from: string;
  to: string;
  /** `loop` is drawn as an arc back; `review` as a dashed side link. */
  kind: 'flow' | 'loop' | 'review';
}

export interface GlyphGeometry {
  nodes: GlyphNode[];
  edges: GlyphEdge[];
}

const MID = GLYPH_HEIGHT / 2;

export const GLYPHS: Record<ArchitectureId, GlyphGeometry> = {
  single: {
    nodes: [{ id: 'agent', kind: 'agent', x: 20, y: MID, role: 'agent' }],
    edges: [],
  },
  'plan-execute': {
    nodes: [
      { id: 'plan', kind: 'plan', x: 9, y: MID, role: 'planner' },
      { id: 'execute', kind: 'agent', x: 31, y: MID, role: 'executor' },
    ],
    edges: [{ from: 'plan', to: 'execute', kind: 'flow' }],
  },
  'orchestrator-workers': {
    nodes: [
      { id: 'orchestrate', kind: 'agent', x: 5, y: MID, role: 'orchestrator' },
      { id: 'w1', kind: 'worker', x: 20, y: 4.5, role: 'worker 1' },
      { id: 'w2', kind: 'worker', x: 20, y: MID, role: 'worker 2' },
      { id: 'w3', kind: 'worker', x: 20, y: 19.5, role: 'worker 3' },
      { id: 'synthesize', kind: 'agent', x: 35, y: MID, role: 'synthesis' },
    ],
    edges: [
      { from: 'orchestrate', to: 'w1', kind: 'flow' },
      { from: 'orchestrate', to: 'w2', kind: 'flow' },
      { from: 'orchestrate', to: 'w3', kind: 'flow' },
      { from: 'w1', to: 'synthesize', kind: 'flow' },
      { from: 'w2', to: 'synthesize', kind: 'flow' },
      { from: 'w3', to: 'synthesize', kind: 'flow' },
    ],
  },
  'plan-execute-verify': {
    nodes: [
      { id: 'plan', kind: 'plan', x: 5, y: 15, role: 'planner' },
      { id: 'execute', kind: 'agent', x: 20, y: 15, role: 'executor' },
      { id: 'verify', kind: 'decide', x: 35, y: 15, role: 'verifier' },
    ],
    edges: [
      { from: 'plan', to: 'execute', kind: 'flow' },
      { from: 'execute', to: 'verify', kind: 'flow' },
      { from: 'verify', to: 'execute', kind: 'loop' },
    ],
  },
  'propose-select': {
    nodes: [
      { id: 'p1', kind: 'worker', x: 5, y: 4.5, role: 'proposer 1' },
      { id: 'p2', kind: 'worker', x: 5, y: MID, role: 'proposer 2' },
      { id: 'p3', kind: 'worker', x: 5, y: 19.5, role: 'proposer 3' },
      { id: 'select', kind: 'decide', x: 20, y: MID, role: 'selector' },
      { id: 'execute', kind: 'agent', x: 35, y: MID, role: 'executor' },
    ],
    edges: [
      { from: 'p1', to: 'select', kind: 'flow' },
      { from: 'p2', to: 'select', kind: 'flow' },
      { from: 'p3', to: 'select', kind: 'flow' },
      { from: 'select', to: 'execute', kind: 'flow' },
    ],
  },
  'gated-execute': {
    nodes: [
      { id: 'agent', kind: 'agent', x: 5, y: 15, role: 'agent' },
      { id: 'gate', kind: 'gate', x: 20, y: 15, role: 'gate' },
      { id: 'reviewer', kind: 'reviewer', x: 20, y: 3.5, role: 'reviewer' },
      { id: 'effect', kind: 'worker', x: 35, y: 15, role: 'state change' },
    ],
    edges: [
      { from: 'agent', to: 'gate', kind: 'flow' },
      { from: 'gate', to: 'effect', kind: 'flow' },
      { from: 'reviewer', to: 'gate', kind: 'review' },
    ],
  },
};

export function glyphFor(strategyId: string): GlyphGeometry | undefined {
  return (GLYPHS as Record<string, GlyphGeometry | undefined>)[strategyId];
}
