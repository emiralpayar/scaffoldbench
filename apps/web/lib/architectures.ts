/**
 * Display metadata for the harness architectures: names, one-line summaries,
 * reading order and the colour each one wears on every chart.
 *
 * This is presentation, not the benchmark's source of truth. The strategies
 * themselves live in `@scaffoldbench/strategies`; the run set's `catalog.json` carries
 * the long description that was current when it ran. What belongs here is what
 * has to be identical across the whole site so a reader can learn it once:
 * the glyph, the colour and the short name.
 *
 * Colours are CSS custom properties (`--arch-<id>` in globals.css) so both
 * themes re-skin every chart from one place. The palette was chosen with the
 * data-viz validator (OKLab ΔE under protanopia/deuteranopia simulation) and
 * `test/palette.test.ts` re-checks it, so the claim stays true when a hex is
 * edited. `single` is deliberately a neutral: it is the control condition.
 */

export type ArchitectureId =
  | 'single'
  | 'plan-execute'
  | 'orchestrator-workers'
  | 'plan-execute-verify'
  | 'propose-select'
  | 'gated-execute';

export interface ArchitectureInfo {
  id: ArchitectureId;
  /** Short display name, used everywhere a label fits. Mirrors the id on purpose. */
  name: string;
  /** One sentence describing the design, for tables, cards and tooltips. */
  summary: string;
  /** The shape of the design in words, used as the glyph's accessible name. */
  shape: string;
  /** Ids this architecture was published under before a rename. */
  legacyIds: readonly string[];
}

/**
 * Reading order: the control first, then increasing structure. Every list,
 * legend and chart on the site uses this order, so colour and position never
 * have to be re-learned between pages.
 */
export const ARCHITECTURES: readonly ArchitectureInfo[] = [
  {
    id: 'single',
    name: 'Single',
    summary:
      'One agent, one context, the full toolset. The control condition every other architecture has to beat.',
    shape: 'one agent',
    legacyIds: [],
  },
  {
    id: 'plan-execute',
    name: 'Plan-execute',
    summary:
      'A tool-less planner writes the steps; a second call carries them out with the full toolset.',
    shape: 'a planner, then an executor',
    legacyIds: [],
  },
  {
    id: 'orchestrator-workers',
    name: 'Orchestrator-workers',
    summary:
      'An orchestrator splits the task, workers run the parts in parallel contexts, and a final call merges their reports.',
    shape: 'an orchestrator fanning out to parallel workers, then a synthesis',
    legacyIds: [],
  },
  {
    id: 'plan-execute-verify',
    name: 'Plan-execute-verify',
    summary:
      'Plan and execute, then a verifier with read-only tools checks the real state and can send the work back.',
    shape: 'a planner, an executor and a verifier that can loop back',
    legacyIds: [],
  },
  {
    id: 'propose-select',
    name: 'Propose-select',
    summary:
      'Three proposers investigate in parallel with read-only tools, a selector picks one plan, and an executor applies it.',
    shape: 'three parallel proposers, a selector, then an executor',
    legacyIds: ['debate-select'],
  },
  {
    id: 'gated-execute',
    name: 'Gated-execute',
    summary:
      'One agent acts, but every state-changing tool call must pass a read-only reviewer before it runs.',
    shape: 'an agent whose actions pass through a reviewer gate',
    legacyIds: [],
  },
];

export const BASELINE_ID: ArchitectureId = 'single';

const BY_ID = new Map<string, ArchitectureInfo>();
for (const info of ARCHITECTURES) {
  BY_ID.set(info.id, info);
  for (const legacy of info.legacyIds) BY_ID.set(legacy, info);
}

/**
 * Map a strategy id as recorded to the architecture it is today.
 *
 * `debate-select` was renamed `propose-select` because it never had debate
 * rounds. Run sets recorded before the rename keep their original ids on disk
 * (run ids, file names); everything the site draws uses the current one.
 */
export function canonicalArchitectureId(strategyId: string): string {
  return BY_ID.get(strategyId)?.id ?? strategyId;
}

export function architectureInfo(strategyId: string): ArchitectureInfo | undefined {
  return BY_ID.get(strategyId);
}

export function isKnownArchitecture(strategyId: string): boolean {
  return BY_ID.has(strategyId);
}

/** Display name for any strategy id, falling back to the id for unknown ones. */
export function architectureName(strategyId: string): string {
  return BY_ID.get(strategyId)?.name ?? strategyId;
}

/** CSS colour for a strategy; unknown strategies get the neutral axis ink. */
export function architectureColor(strategyId: string): string {
  const info = BY_ID.get(strategyId);
  return info ? `var(--arch-${info.id})` : 'var(--ink-2)';
}

/** Sort key: registry order, unknown strategies after, alphabetically. */
export function architectureOrder(strategyId: string): number {
  const info = BY_ID.get(strategyId);
  if (!info) return ARCHITECTURES.length;
  return ARCHITECTURES.indexOf(info);
}

export function compareArchitectures(a: string, b: string): number {
  return architectureOrder(a) - architectureOrder(b) || a.localeCompare(b);
}
