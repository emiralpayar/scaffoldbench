/**
 * Each architecture's design drawn as a timeline, for when no verified run
 * set has traces to replay.
 *
 * This is a diagram, not data: the calls are the ones each design is
 * described as making (`lib/architectures.ts`), in the order and parallelism
 * it makes them, on an invented clock. It carries no cost, score or
 * duration, and every place that draws it says it is a schematic. It exists
 * so the landing page can show what the designs do before a run set exists
 * that shows it for real; a verified run set with traces always replaces it.
 *
 * Pure: safe anywhere.
 */

import type { ArchitectureId } from './architectures';
import type { Timeline, TimelineCall } from './timeline';

interface Step {
  phase: string;
  label: string;
  depth?: 1;
  /** Invented seconds. */
  start: number;
  end: number;
  /** Tool calls, invented seconds; a tool-less step has none. */
  tools?: number[];
}

const STEPS: Record<ArchitectureId, Step[]> = {
  single: [{ phase: 'main', label: 'Agent', start: 0, end: 30, tools: [2, 5, 8, 12, 17, 21, 25] }],
  'plan-execute': [
    { phase: 'plan', label: 'Plan', start: 0, end: 6 },
    { phase: 'execute', label: 'Execute', start: 6, end: 34, tools: [8, 11, 14, 19, 24, 29] },
  ],
  'orchestrator-workers': [
    { phase: 'decompose', label: 'Decompose', start: 0, end: 5 },
    { phase: 'worker-1', label: 'Worker 1', depth: 1, start: 5, end: 21, tools: [7, 11, 15, 19] },
    { phase: 'worker-2', label: 'Worker 2', depth: 1, start: 5, end: 25, tools: [8, 13, 18, 23] },
    { phase: 'worker-3', label: 'Worker 3', depth: 1, start: 5, end: 17, tools: [7, 12, 15] },
    { phase: 'synthesize', label: 'Synthesize', start: 25, end: 30 },
  ],
  'plan-execute-verify': [
    { phase: 'plan', label: 'Plan', start: 0, end: 5 },
    { phase: 'execute', label: 'Execute', start: 5, end: 27, tools: [7, 10, 14, 18, 22, 25] },
    { phase: 'verify', label: 'Verify', start: 27, end: 37, tools: [29, 32, 35] },
  ],
  'propose-select': [
    { phase: 'propose-1', label: 'Proposal 1', depth: 1, start: 0, end: 14, tools: [3, 7, 11] },
    { phase: 'propose-2', label: 'Proposal 2', depth: 1, start: 0, end: 12, tools: [2, 6, 10] },
    { phase: 'propose-3', label: 'Proposal 3', depth: 1, start: 0, end: 16, tools: [4, 9, 13] },
    { phase: 'select', label: 'Select', start: 16, end: 20 },
    { phase: 'execute', label: 'Execute', start: 20, end: 36, tools: [22, 26, 30, 34] },
  ],
  'gated-execute': [
    { phase: 'execute', label: 'Execute', start: 0, end: 33, tools: [3, 6, 9, 14, 19, 24, 29] },
    { phase: 'review-1', label: 'Review 1', depth: 1, start: 9, end: 12, tools: [10] },
    { phase: 'review-2', label: 'Review 2', depth: 1, start: 19, end: 22, tools: [20] },
    { phase: 'review-3', label: 'Review 3', depth: 1, start: 29, end: 32, tools: [30] },
  ],
};

export function schematicTimeline(id: ArchitectureId): Timeline {
  const calls: TimelineCall[] = STEPS[id].map((step, index) => ({
    key: `${step.phase}#1`,
    phase: step.phase,
    label: step.label,
    depth: step.depth ?? 0,
    startMs: step.start * 1000,
    endMs: step.end * 1000,
    status: 'ok',
    costUsd: 0,
    toolCalls: step.tools?.length ?? 0,
    // A step drawn without tool calls is a reasoning step, shown no tools.
    toolsOffered: step.tools ? 1 : 0,
    ticks: (step.tools ?? []).map((t, i) => ({ seq: index * 100 + i, tMs: t * 1000, kind: 'tool', label: 'tool call' })),
    serversDown: [],
    foreignServers: [],
    firstSeq: index,
  }));
  return {
    source: 'schematic',
    durationMs: Math.max(...calls.map((call) => call.endMs)),
    calls,
    cost: [{ tMs: 0, usd: 0 }],
    totalCostUsd: 0,
  };
}
