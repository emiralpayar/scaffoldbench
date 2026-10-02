/**
 * Fabricate a run set so the site can be developed and reviewed without
 * spending anything.
 *
 *   npm run demo:data                 # writes apps/web/demo-data/demo-synthetic
 *   ARENA_DEMO=1 npm run dev:web      # the site then reads it, bannered
 *
 * THE NUMBERS HERE ARE INVENTED. They exist so every chart and state of the
 * site can be built before a real run set exists: three models, all six
 * architectures, an expert tier, failed integrity checks, runs lost to the
 * API, and parallel phases with overlapping timestamps.
 *
 * Three things keep them from ever being mistaken for a measurement:
 *  - the manifest says `synthetic: true`, and the site renders an unmissable
 *    banner on every page because of it;
 *  - the output goes to `apps/web/demo-data/` (gitignored), never `results/`,
 *    and `results/latest.json` is never touched, so a published build cannot
 *    pick it up by accident;
 *  - the site reads it only under `ARENA_DEMO=1`, and the GitHub Pages build
 *    sets `ARENA_REQUIRE_REAL_DATA=1`, which refuses synthetic data outright.
 *
 * The record shapes follow the v1 contract (PLAN §1), which the site declares
 * in `apps/web/lib/records.ts` ahead of `@arena/core`.
 */

import { rm } from 'node:fs/promises';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { ensureDir, makeRng, writeJson } from '@arena/core';
import type { Penalty, ScoreItem, StrategyInfo } from '@arena/core';

import { ARCHITECTURES } from '../apps/web/lib/architectures';
import type {
  Catalog,
  Difficulty,
  Integrity,
  PhaseRecord,
  RunRecord,
  RunSetManifest,
  TaskInfo,
  TraceEvent,
} from '../apps/web/lib/records';

export const DEMO_RUN_SET_ID = 'demo-synthetic';
const REPEATS = 3;
const EFFORT = 'high' as const;
const STARTED = Date.UTC(2026, 8, 28, 9, 0, 0);

const DEFAULT_OUT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'apps',
  'web',
  'demo-data',
);

// ---------------------------------------------------------------------------
// The invented world
// ---------------------------------------------------------------------------

interface DemoModel {
  id: string;
  /** Baseline quality on an easy task. */
  ability: number;
  /** Cost of a `single` run relative to Sonnet. */
  costScale: number;
  latencyScale: number;
}

const MODELS: DemoModel[] = [
  { id: 'claude-haiku-4-5-20251001', ability: 0.8, costScale: 0.42, latencyScale: 0.7 },
  { id: 'claude-sonnet-5-5', ability: 0.9, costScale: 1, latencyScale: 1 },
  { id: 'claude-opus-5-5', ability: 0.95, costScale: 1.9, latencyScale: 1.25 },
];

interface DemoArchitecture {
  id: string;
  /** Score effect by model tier (haiku, sonnet, opus). */
  effect: [number, number, number];
  /** Extra effect on research tasks. */
  research: number;
  /** Extra effect on hard and expert tool-use tasks (policy traps). */
  traps: number;
  cost: number;
  latency: number;
  /** Probability that a fidelity check fails on a run. */
  degradeRate: number;
}

const ARCHS: DemoArchitecture[] = [
  { id: 'single', effect: [0, 0, 0], research: 0, traps: 0, cost: 1, latency: 1, degradeRate: 0.004 },
  { id: 'plan-execute', effect: [0.035, 0.015, 0], research: 0.01, traps: 0, cost: 1.35, latency: 1.25, degradeRate: 0.02 },
  { id: 'orchestrator-workers', effect: [-0.02, -0.025, -0.02], research: 0.1, traps: -0.02, cost: 2.7, latency: 0.85, degradeRate: 0.035 },
  { id: 'plan-execute-verify', effect: [0.11, 0.05, 0.015], research: 0.02, traps: 0.03, cost: 2.15, latency: 1.75, degradeRate: 0.025 },
  { id: 'propose-select', effect: [0.04, 0.02, 0.005], research: 0.03, traps: 0.01, cost: 3.4, latency: 1.45, degradeRate: 0.04 },
  { id: 'gated-execute', effect: [0.06, 0.035, 0.01], research: -0.01, traps: 0.09, cost: 1.65, latency: 1.6, degradeRate: 0.02 },
];

/**
 * A trap names the scorer item that registers it (contract 5): here, one
 * assertion per trap. `resistedBy` is the invented part, the architectures
 * this fake world lets avoid it more often.
 */
interface DemoTrap {
  id: string;
  description: string;
  assertion: { id: string; label: string };
  resistedBy: string[];
}

interface DemoTask {
  id: string;
  world: string;
  category: 'tool-use' | 'research';
  difficulty: Difficulty;
  title: string;
  hypothesis?: string;
  traps?: DemoTrap[];
}

const HARDNESS: Record<Difficulty, number> = { easy: 0.03, medium: 0.12, hard: 0.27, expert: 0.42 };

const TASKS: DemoTask[] = [
  { id: 'airline-easy', world: 'airline', category: 'tool-use', difficulty: 'easy', title: 'Add checked bags and collect the right fee' },
  { id: 'airline-medium', world: 'airline', category: 'tool-use', difficulty: 'medium', title: 'Rebook onto the earliest available flight and settle the difference' },
  { id: 'airline-hard', world: 'airline', category: 'tool-use', difficulty: 'hard', title: 'Cancel a fare the customer wrongly believes is refundable to their card' },
  {
    id: 'airline-expert',
    world: 'airline',
    category: 'tool-use',
    difficulty: 'expert',
    title: 'Split a group booking across a cancelled connection',
    hypothesis: '[synthetic] A verifier should catch the stranded second leg that a single pass misses.',
    traps: [
      {
        id: 'stranded-leg',
        description: '[synthetic] Rebooks the first leg and leaves the cancelled connection unbooked.',
        assertion: { id: 'second-leg-rebooked', label: '[synthetic] Both legs of every passenger are rebooked' },
        resistedBy: ['plan-execute-verify', 'propose-select'],
      },
      {
        id: 'refund-to-card',
        description: '[synthetic] Refunds a credit-only fare to the card.',
        assertion: { id: 'credit-only-respected', label: '[synthetic] The credit-only fare was refunded as credit' },
        resistedBy: ['gated-execute'],
      },
    ],
  },
  { id: 'ecommerce-easy', world: 'ecommerce', category: 'tool-use', difficulty: 'easy', title: 'Redirect the order that has not shipped' },
  { id: 'ecommerce-medium', world: 'ecommerce', category: 'tool-use', difficulty: 'medium', title: 'Cancel one line of a multi-line order' },
  { id: 'ecommerce-hard', world: 'ecommerce', category: 'tool-use', difficulty: 'hard', title: 'Return an expired, partially shipped order' },
  {
    id: 'ecommerce-expert',
    world: 'ecommerce',
    category: 'tool-use',
    difficulty: 'expert',
    title: 'Reconcile a bundle return across two warehouses',
    hypothesis: '[synthetic] A gate on mutating calls should stop the double restock.',
    traps: [
      {
        id: 'double-restock',
        description: '[synthetic] Restocks the bundle in both warehouses and counts it twice.',
        assertion: { id: 'restocked-once', label: '[synthetic] The bundle was restocked exactly once' },
        resistedBy: ['gated-execute', 'plan-execute-verify'],
      },
      {
        id: 'partial-refund',
        description: '[synthetic] Refunds the full bundle when one item was kept.',
        assertion: { id: 'refund-matches-return', label: '[synthetic] The refund covers only the returned items' },
        resistedBy: ['plan-execute-verify'],
      },
    ],
  },
  { id: 'support-easy', world: 'support', category: 'tool-use', difficulty: 'easy', title: 'Triage a new service desk ticket' },
  { id: 'support-medium', world: 'support', category: 'tool-use', difficulty: 'medium', title: 'Consolidate duplicate CRM reports' },
  { id: 'support-hard', world: 'support', category: 'tool-use', difficulty: 'hard', title: 'Escalate a payroll outage the requester wants closed' },
  {
    id: 'support-expert',
    world: 'support',
    category: 'tool-use',
    difficulty: 'expert',
    title: 'Route a security incident hidden inside a billing complaint',
    hypothesis: '[synthetic] Parallel proposals should surface the second issue a single read skims past.',
    traps: [
      {
        id: 'buried-incident',
        description: '[synthetic] Routes the billing complaint and misses the incident in its third paragraph.',
        assertion: { id: 'incident-routed', label: '[synthetic] The security incident went to the security queue' },
        resistedBy: ['propose-select', 'orchestrator-workers'],
      },
    ],
  },
  { id: 'research-http-redirects', world: 'web', category: 'research', difficulty: 'medium', title: 'Explain how browsers treat each HTTP redirect status' },
  { id: 'research-script-loading', world: 'web', category: 'research', difficulty: 'hard', title: 'Compare async, defer and module script loading' },
  {
    id: 'research-password-hashing',
    world: 'web',
    category: 'research',
    difficulty: 'expert',
    title: 'Recommend password hashing parameters with sources',
    hypothesis: '[synthetic] Orchestrated breadth should win on a question with many primary sources.',
  },
];

/**
 * The fidelity invariants each architecture is checked against (contract 4),
 * by the ids `packages/strategies` declares them under. Every architecture
 * also has a tool-surface check; only the ones in `DEGRADED_REASON` are ever
 * made to fail here, because each failure has to leave its mark on a phase.
 */
const FIDELITY_CHECKS: Record<string, string[]> = {
  single: ['single.tools'],
  'plan-execute': ['plan-execute.plan', 'plan-execute.tools'],
  'orchestrator-workers': [
    'orchestrator-workers.decomposition',
    'orchestrator-workers.fan-out',
    'orchestrator-workers.synthesis',
    'orchestrator-workers.tools',
  ],
  'plan-execute-verify': [
    'plan-execute-verify.plan',
    'plan-execute-verify.verdicts',
    'plan-execute-verify.loop',
    'plan-execute-verify.tools',
  ],
  'propose-select': ['propose-select.proposals', 'propose-select.selection', 'propose-select.tools'],
  'gated-execute': ['gated-execute.reviewed', 'gated-execute.decisions', 'gated-execute.tools'],
};

/** The runner's own checks, by the ids `packages/core/src/integrity.ts` uses. */
const HARNESS_CHECKS = [
  'harness.run-completed',
  'harness.api',
  'harness.calls-ended',
  'harness.harness-tools',
  'harness.mcp-connected',
  'harness.mcp-hermetic',
  'harness.structured-output',
  'harness.not-degraded',
];

const DEGRADED_REASON: Record<string, { phase: string; degraded: string; detail: string }> = {
  'plan-execute.plan': { phase: 'plan', degraded: 'empty-plan', detail: '[synthetic] the planner returned no steps; the executor ran without a plan' },
  'orchestrator-workers.decomposition': { phase: 'decompose', degraded: 'single-worker-fallback', detail: '[synthetic] the decomposition did not parse; fell back to one worker' },
  'orchestrator-workers.fan-out': { phase: 'decompose', degraded: 'single-worker-fallback', detail: '[synthetic] only one subtask was produced' },
  'plan-execute-verify.plan': { phase: 'plan', degraded: 'empty-plan', detail: '[synthetic] the planner returned no steps; the executor ran without a plan' },
  'plan-execute-verify.verdicts': { phase: 'verify-1', degraded: 'verdict-unreadable', detail: '[synthetic] verify-1: the verifier gave no readable verdict' },
  'propose-select.tools': { phase: 'propose-2', degraded: 'proposer-without-tools', detail: '[synthetic] the proposer (propose-2) was not shown get_reservation, get_flight and 4 more' },
  'propose-select.selection': { phase: 'select', degraded: 'default-winner', detail: '[synthetic] the selection did not parse; proposal 1 was used by default' },
  'gated-execute.reviewed': { phase: 'execute', degraded: 'ungated-action', detail: '[synthetic] issue_refund ran 1 time, 0 allowed by a review' },
  'harness.mcp-connected': { phase: 'main', degraded: 'mcp-failed', detail: '[synthetic] a call started without its tool server' },
};

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

export interface DemoRunSet {
  manifest: RunSetManifest & Record<string, unknown>;
  catalog: Catalog;
  records: RunRecord[];
  traces: Map<string, TraceEvent[]>;
}

/** Deterministic: the same call always produces the same run set. */
export function buildDemoRunSet(): DemoRunSet {
  const rng = makeRng(20260928);
  const records: RunRecord[] = [];
  const traces = new Map<string, TraceEvent[]>();
  let clock = STARTED;

  for (let repeat = 1; repeat <= REPEATS; repeat++) {
    for (const task of TASKS) {
      for (const [tier, model] of MODELS.entries()) {
        for (const arch of ARCHS) {
          const record = buildRecord({ rng, repeat, task, tier, model, arch, startMs: clock });
          clock += 1_500 + Math.floor(rng() * 4_000);
          records.push(record);
          if (isTraced(task.id, model.id, repeat)) {
            record.traceFile = `traces/${record.runId}.jsonl`;
            traces.set(record.runId, buildTrace(record));
          }
        }
      }
    }
  }

  const totalCostUsd = round(records.reduce((sum, r) => sum + r.costUsd, 0), 6);
  const totalJudgeCostUsd = round(records.reduce((sum, r) => sum + r.judgeCostUsd, 0), 6);

  const manifest: DemoRunSet['manifest'] = {
    runSetId: DEMO_RUN_SET_ID,
    createdAt: new Date(STARTED).toISOString(),
    finishedAt: new Date(clock).toISOString(),
    status: 'complete',
    gitSha: null,
    gitDirty: false,
    models: MODELS.map((m) => m.id),
    effort: EFFORT,
    repeats: REPEATS,
    fixtureMode: 'replay',
    strategyIds: ARCHS.map((a) => a.id),
    taskIds: TASKS.map((t) => t.id),
    totalRuns: records.length,
    completedRuns: records.length,
    totalCostUsd,
    totalJudgeCostUsd,
    durationMs: clock - STARTED,
    maxCostUsdPerRun: 1,
    concurrency: 4,
    judge: { model: 'claude-sonnet-5-5', samples: 3, effort: 'high' },
    synthetic: true,
    notes:
      'SYNTHETIC DEMO DATA generated by scripts/generate-demo-data.ts. These numbers are ' +
      'invented for interface development and must never be quoted as benchmark results.',
  };

  const strategies: StrategyInfo[] = ARCHITECTURES.map((info) => ({
    id: info.id,
    label: info.name,
    description: info.summary,
  }));

  const tasks: TaskInfo[] = TASKS.map((task) => ({
    id: task.id,
    category: task.category,
    world: task.world,
    title: task.title,
    prompt: `[synthetic] ${task.title}. The real prompt for this task would appear here.`,
    ...(task.category === 'tool-use'
      ? { policy: '[synthetic] The domain rules for this world would appear here.' }
      : {}),
    difficulty: task.difficulty,
    tags: [task.world, task.difficulty],
    maxTurns: task.category === 'research' ? 24 : 16,
    ...(task.hypothesis ? { hypothesis: task.hypothesis } : {}),
    ...(task.traps
      ? {
          traps: task.traps.map((trap) => ({
            id: trap.id,
            description: trap.description,
            caughtBy: [trap.assertion.id],
          })),
        }
      : {}),
  }));

  return { manifest, catalog: { strategies, tasks }, records, traces };
}

/**
 * Which runs get a trace: the first repeat of one hard task on every model
 * (enough to race every architecture on the same task), and the first repeat
 * on Sonnet of a research task and the expert tasks with traps.
 */
function isTraced(taskId: string, modelId: string, repeat: number): boolean {
  if (repeat !== 1) return false;
  if (taskId === 'airline-hard') return true;
  return (
    modelId === 'claude-sonnet-5-5' &&
    ['research-script-loading', 'airline-expert', 'support-expert'].includes(taskId)
  );
}

interface RecordInput {
  rng: () => number;
  repeat: number;
  task: DemoTask;
  tier: number;
  model: DemoModel;
  arch: DemoArchitecture;
  startMs: number;
}

function buildRecord({ rng, repeat, task, tier, model, arch, startMs }: RecordInput): RunRecord {
  const runId = `${arch.id}__${task.id}__${model.id}__r${repeat}`;
  const hardness = HARDNESS[task.difficulty];
  const trapBonus = task.category === 'tool-use' && hardness >= HARDNESS.hard ? arch.traps : 0;
  const researchBonus = task.category === 'research' ? arch.research : 0;
  const quality = clamp01(
    model.ability -
      hardness +
      (arch.effect[tier] ?? 0) +
      trapBonus +
      researchBonus +
      (rng() - 0.5) * 0.16,
  );

  const apiError = rng() < 0.012;
  const degradedCheck = !apiError && rng() < arch.degradeRate ? pickCheck(arch.id, rng) : null;

  const breakdown = buildBreakdown(task, arch.id, quality, rng);
  let score = scoreFrom(task, breakdown);
  const penalties: Penalty[] = [];
  if (!apiError && task.category === 'tool-use' && score < 1 && rng() < 0.15) {
    penalties.push({
      id: 'policy',
      label: '[synthetic] Acted before checking the policy',
      kind: 'policy_violation',
      multiplier: 0,
    });
    score = 0;
  }
  if (apiError) score = 0;

  const passed = !apiError && score >= 0.999;
  const latencyMs = Math.round(
    (14_000 + hardness * 70_000) * arch.latency * model.latencyScale * (0.8 + rng() * 0.45),
  );
  const costUsd = round(
    (apiError ? 0.25 : 1) *
      (0.02 + hardness * 0.1) *
      arch.cost *
      model.costScale *
      (task.category === 'research' ? 2.2 : 1) *
      (0.85 + rng() * 0.3),
    6,
  );
  const judgeCostUsd = task.category === 'research' && !apiError ? round(0.01 + rng() * 0.006, 6) : 0;
  const setupMs = Math.round(180 + rng() * 420);
  const gradingMs = task.category === 'research' ? Math.round(6_000 + rng() * 5_000) : Math.round(4 + rng() * 30);

  const phases = buildPhases(arch.id, startMs + setupMs, latencyMs, costUsd, model.id, rng, {
    imperfect: score < 1,
    degradedCheck,
  });
  const failureMode: RunRecord['failureMode'] = apiError
    ? 'api_error'
    : passed
      ? 'none'
      : penalties.length > 0
        ? 'policy_violation'
        : pickFailure(rng);

  const turns = phases.reduce((sum, phase) => sum + phase.turns, 0);
  const toolCalls = phases.reduce((sum, phase) => sum + phase.toolCalls, 0);

  return {
    runId,
    runSetId: DEMO_RUN_SET_ID,
    taskId: task.id,
    taskTitle: task.title,
    taskCategory: task.category,
    taskWorld: task.world,
    taskDifficulty: task.difficulty,
    strategyId: arch.id,
    model: model.id,
    effort: EFFORT,
    repeat,
    startedAt: new Date(startMs).toISOString(),
    finishedAt: new Date(startMs + setupMs + latencyMs + gradingMs).toISOString(),
    latencyMs,
    setupMs,
    gradingMs,
    attempts: apiError ? 3 : rng() < 0.03 ? 2 : 1,
    score: round(score, 4),
    passed,
    breakdown,
    penalties,
    failureMode,
    scoreMetadata:
      task.category === 'research'
        ? { citationIntegrity: round(0.6 + rng() * 0.4, 3), citedSources: 3 + Math.floor(rng() * 5) }
        : { toolCalls, failedToolCalls: Math.floor(rng() * 2) },
    costUsd,
    judgeCostUsd,
    usage: {
      inputTokens: Math.round(1_200 * arch.cost),
      outputTokens: Math.round(2_600 * arch.cost * (0.8 + rng() * 0.4)),
      cacheReadInputTokens: Math.round(38_000 * arch.cost),
      cacheCreationInputTokens: Math.round(6_000 + rng() * 3_000),
    },
    turns,
    toolCalls,
    deniedToolCalls: 0,
    subagentCount: phases.filter((phase) => /^(worker|propose|review)-/.test(phase.phase)).length,
    phases,
    integrity: buildIntegrity(arch.id, degradedCheck),
    finalText: apiError
      ? ''
      : `[synthetic] ${arch.id} on ${model.id}: the answer to "${task.title}" would appear here.`,
    ...(apiError
      ? { error: '[synthetic] API overloaded (HTTP 529) on every attempt; not the architecture’s fault.' }
      : {}),
  };
}

function pickCheck(archId: string, rng: () => number): string {
  const fidelity = (FIDELITY_CHECKS[archId] ?? []).filter((id) => id in DEGRADED_REASON);
  // Most fidelity failures are the architecture's own invariants; a few are
  // harness health (an MCP server that did not connect for one phase).
  if (fidelity.length === 0 || rng() < 0.2) return 'harness.mcp-connected';
  return fidelity[Math.floor(rng() * fidelity.length)] as string;
}

function buildIntegrity(archId: string, failed: string | null): Integrity {
  const ids = [...HARNESS_CHECKS, ...(FIDELITY_CHECKS[archId] ?? [])];
  // A strategy's fidelity failure is a degraded phase, which the runner's own
  // not-degraded check reports as well.
  const alsoFailed = failed && !failed.startsWith('harness.') ? 'harness.not-degraded' : null;
  const checks = ids.map((id) =>
    id === failed
      ? { id, ok: false, detail: DEGRADED_REASON[id]?.detail ?? '[synthetic] check failed' }
      : id === alsoFailed
        ? { id, ok: false, detail: `[synthetic] ${DEGRADED_REASON[failed as string]?.phase ?? 'a phase'} fell back on a default` }
        : { id, ok: true },
  );
  return { ok: checks.every((check) => check.ok), checks };
}

const ASSERTIONS = [
  { id: 'final-state', label: '[synthetic] Final state matches the expected records', weight: 3 },
  { id: 'policy', label: '[synthetic] Every policy rule was respected', weight: 2 },
  { id: 'side-effects', label: '[synthetic] No unintended changes to other records', weight: 2 },
  { id: 'reply', label: '[synthetic] The reply states what was done', weight: 1 },
];

function buildBreakdown(task: DemoTask, archId: string, quality: number, rng: () => number): ScoreItem[] {
  if (task.category === 'research') {
    return [
      { id: 'rubric', label: '[synthetic] Judged rubric', weight: 3, earned: round(clamp01(quality + (rng() - 0.5) * 0.1), 3) },
      { id: 'citations', label: '[synthetic] Citations resolve and support the claims', weight: 1, earned: round(clamp01(quality + 0.05), 3) },
    ];
  }
  // Tool-use scoring is a deterministic assertion grid, so outcomes are
  // discrete and a fully correct run lands exactly on 1.0.
  const grid = ASSERTIONS.map((assertion) => ({
    ...assertion,
    earned: rng() < quality ** 0.6 ? 1 : rng() < 0.3 ? 0.5 : 0,
  }));
  // Each trap is one assertion; an architecture this world says resists the
  // trap avoids it more often.
  const traps = (task.traps ?? []).map((trap) => ({
    id: trap.assertion.id,
    label: trap.assertion.label,
    weight: 2,
    earned: rng() < Math.min(0.97, quality ** 0.8 + (trap.resistedBy.includes(archId) ? 0.3 : 0)) ? 1 : 0,
  }));
  return [...grid, ...traps];
}

function scoreFrom(task: DemoTask, breakdown: ScoreItem[]): number {
  const total = breakdown.reduce((sum, item) => sum + item.weight, 0);
  const earned = breakdown.reduce((sum, item) => sum + item.weight * item.earned, 0);
  const raw = total === 0 ? 0 : earned / total;
  return task.category === 'research' ? raw : Math.round(raw * 1000) / 1000;
}

function pickFailure(rng: () => number): RunRecord['failureMode'] {
  const roll = rng();
  if (roll < 0.1) return 'max_turns';
  if (roll < 0.16) return 'timeout';
  if (roll < 0.2) return 'budget_exceeded';
  return 'wrong_answer';
}

interface PhaseContext {
  imperfect: boolean;
  degradedCheck: string | null;
}

/**
 * Phase records with real overlap: workers and proposers start together and
 * finish at different times, which is exactly what a sequential timeline hid.
 */
function buildPhases(
  archId: string,
  t0: number,
  latencyMs: number,
  costUsd: number,
  model: string,
  rng: () => number,
  context: PhaseContext,
): PhaseRecord[] {
  const phases: PhaseRecord[] = [];
  const add = (phase: string, label: string, start: number, duration: number, share: number, tools: number) => {
    phases.push({
      phase,
      label,
      startedAtMs: Math.round(t0 + start),
      durationMs: Math.max(200, Math.round(duration)),
      costUsd: round(costUsd * share, 6),
      turns: Math.max(1, tools + (tools > 0 ? 1 : 0)),
      toolCalls: tools,
      model,
      aborted: false,
      subtype: 'success',
    });
  };
  const tools = (min: number, spread: number) => min + Math.floor(rng() * spread);
  const L = latencyMs;

  switch (archId) {
    case 'plan-execute':
      add('plan', 'Plan', 0, L * 0.2, 0.15, 0);
      add('execute', 'Execute', L * 0.2, L * 0.8, 0.85, tools(4, 6));
      break;
    case 'orchestrator-workers': {
      add('decompose', 'Decompose', 0, L * 0.15, 0.08, 0);
      const durations = [0.55, 0.7, 0.62].map((f) => L * f * (0.8 + rng() * 0.3));
      durations.forEach((d, i) => add(`worker-${i + 1}`, `Worker ${i + 1}`, L * 0.15 + rng() * 300, d, 0.25, tools(2, 4)));
      const end = L * 0.15 + Math.max(...durations);
      add('synthesize', 'Synthesize', end, Math.max(400, L - end), 0.17, 0);
      break;
    }
    case 'plan-execute-verify': {
      add('plan', 'Plan', 0, L * 0.12, 0.08, 0);
      const revise = context.imperfect && rng() < 0.35;
      add('execute', 'Execute', L * 0.12, L * (revise ? 0.4 : 0.55), 0.45, tools(4, 5));
      add('verify-1', 'Verify', L * (revise ? 0.52 : 0.67), L * (revise ? 0.16 : 0.33), 0.22, tools(2, 3));
      if (revise) {
        add('revise-1', 'Revise', L * 0.68, L * 0.18, 0.15, tools(1, 3));
        add('verify-2', 'Verify again', L * 0.86, L * 0.14, 0.1, tools(1, 2));
      }
      break;
    }
    case 'propose-select': {
      const durations = [0.45, 0.4, 0.5].map((f) => L * f * (0.8 + rng() * 0.3));
      durations.forEach((d, i) => add(`propose-${i + 1}`, `Proposal ${i + 1}`, rng() * 250, d, 0.2, tools(2, 3)));
      const end = Math.max(...durations);
      add('select', 'Select', end, L * 0.12, 0.1, 0);
      add('execute', 'Execute', end + L * 0.12, Math.max(500, L - end - L * 0.12), 0.3, tools(3, 4));
      break;
    }
    case 'gated-execute': {
      add('execute', 'Execute', 0, L, 0.7, tools(4, 5));
      const reviews = 1 + Math.floor(rng() * 3);
      for (let i = 0; i < reviews; i++) {
        add(`review-${i + 1}`, `Review ${i + 1}`, L * (0.3 + 0.2 * i), L * 0.08, 0.3 / reviews, tools(1, 2));
      }
      break;
    }
    default:
      add('main', 'Main', 0, L, 1, tools(4, 7));
  }

  if (context.degradedCheck) {
    const reason = DEGRADED_REASON[context.degradedCheck];
    const target =
      phases.find((phase) => phase.phase === reason?.phase) ??
      phases.find((phase) => !TOOLLESS_PHASES.test(phase.phase)) ??
      phases[0];
    if (target && reason) {
      // A tool server that never connected is the harness failing, not the
      // strategy falling back, so it is not a degraded phase; the trace shows it.
      if (context.degradedCheck !== 'harness.mcp-connected') target.degraded = reason.degraded;
      if (reason.degraded === 'proposer-without-tools' || reason.degraded === 'mcp-failed') target.toolCalls = 0;
    }
  }
  return phases;
}

const WORLD_TOOLS: Record<string, { read: string[]; write: string[] }> = {
  airline: {
    read: ['get_reservation', 'get_passenger', 'get_fare_rules', 'get_refund_policy', 'get_ledger'],
    write: ['cancel_reservation', 'issue_refund', 'record_non_refundable', 'charge_fee'],
  },
  ecommerce: {
    read: ['get_order', 'get_customer', 'get_return_policy', 'get_inventory'],
    write: ['refund_order', 'restock_item', 'apply_store_credit'],
  },
  support: {
    read: ['get_ticket', 'list_tickets', 'search_kb', 'get_account'],
    write: ['update_ticket', 'escalate_ticket', 'add_note'],
  },
  web: { read: ['web_search', 'fetch_page'], write: [] },
};

/** Phases that ask for structured output and are given no task tools. */
const STRUCTURED_PHASES = /^(plan|decompose|select)$/;
const TOOLLESS_PHASES = /^(plan|decompose|select|synthesize)$/;
const READ_ONLY_PHASES = /^(propose|verify|review)/;
const PARALLEL_PHASES = /^(worker|propose|review)-/;

/**
 * A structurally honest trace in the v1 shape: every event carries its call
 * id, sessions report the tools and servers they were given, structured
 * phases answer through the harness's `StructuredOutput` tool, parallel calls
 * interleave on one clock, and a degraded phase shows how it degraded. The
 * words are invented and say so.
 */
function buildTrace(record: RunRecord): TraceEvent[] {
  const rng = makeRng(hash(record.runId));
  const t0 = Date.parse(record.startedAt) + (record.setupMs ?? 0);
  const world = WORLD_TOOLS[record.taskWorld] ?? (WORLD_TOOLS.web as { read: string[]; write: string[] });
  const qualify = (name: string) => `mcp__${record.taskWorld}__${name}`;
  const raw: Omit<TraceEvent, 'seq'>[] = [];
  const last = record.phases.length - 1;
  const mcpFailed = record.integrity?.checks.some((check) => check.id === 'harness.mcp-connected' && !check.ok) ?? false;
  const firstToolPhase = record.phases.findIndex((phase) => !TOOLLESS_PHASES.test(phase.phase));

  record.phases.forEach((phase, index) => {
    const callId = `call-${index + 1}`;
    const depth = PARALLEL_PHASES.test(phase.phase) ? 1 : 0;
    const base = { phase: phase.phase, depth, callId, ...(depth > 0 ? { agent: phase.phase } : {}) };
    const start = phase.startedAtMs - t0;
    const at = (fraction: number) => Math.round(start + phase.durationMs * fraction);
    const toolless = TOOLLESS_PHASES.test(phase.phase);
    const structured = STRUCTURED_PHASES.test(phase.phase);
    const serverDown =
      phase.degraded === 'proposer-without-tools' || (mcpFailed && index === firstToolPhase);
    const structuredMissing = structured && phase.degraded !== undefined;
    const apiFailure = record.failureMode === 'api_error' && index === last;
    const names = READ_ONLY_PHASES.test(phase.phase) ? world.read : [...world.read, ...world.write];
    const offered = toolless ? (structured ? ['StructuredOutput'] : []) : serverDown ? [] : names.map(qualify);
    const expected = toolless ? [] : [record.taskWorld];

    raw.push({ ...base, tMs: at(0), kind: 'phase_start', text: phase.label });
    raw.push({ ...base, tMs: at(0) + 2, kind: 'user', text: promptFor(record, phase.label) });
    raw.push({
      ...base,
      tMs: at(0) + 650 + Math.round(rng() * 250),
      kind: 'system_init',
      meta: {
        model: record.model,
        tools: offered,
        mcpServers: expected.map((name) => ({ name, status: serverDown ? 'failed' : 'connected' })),
        permissionMode: 'dontAsk',
      },
    });

    const calls = serverDown || toolless ? 0 : phase.toolCalls;
    for (let i = 0; i < calls; i++) {
      // Reads first, then the changes they justify.
      const writes = READ_ONLY_PHASES.test(phase.phase) ? 0 : Math.min(world.write.length, Math.floor(calls / 3));
      const pool = i >= calls - writes ? world.write : world.read;
      const name = pool[i % pool.length] as string;
      const id = `toolu_${record.runId.length}${index}${i}`;
      const t = at(0.12 + (0.7 * (i + 0.5)) / calls);
      const failedCall = rng() < 0.06;
      raw.push({ ...base, tMs: t, kind: 'tool_call', toolName: qualify(name), toolUseId: id, toolInput: inputFor(name, i) });
      raw.push({
        ...base,
        tMs: t + 40 + Math.round(rng() * 260),
        kind: 'tool_result',
        toolUseId: id,
        isError: failedCall,
        text: failedCall ? `[synthetic] ${name} failed: record not found` : `[synthetic] ${name}: record ${100 + i} as of the start of the run`,
      });
    }

    if (structured && !structuredMissing) {
      const id = `toolu_so_${index}`;
      raw.push({ ...base, tMs: at(0.86), kind: 'tool_call', toolName: 'StructuredOutput', toolUseId: id, toolInput: structuredFor(phase.phase) });
      raw.push({ ...base, tMs: at(0.86) + 6, kind: 'tool_result', toolUseId: id, text: 'Structured output provided successfully' });
    }

    const text = replyFor(phase.phase, phase.label, structuredMissing);
    if (!structured || structuredMissing) raw.push({ ...base, tMs: at(0.93), kind: 'assistant_text', text });
    const subtype = apiFailure ? 'error_during_execution' : (phase.subtype ?? 'success');
    if (apiFailure) {
      raw.push({ ...base, tMs: at(0.97), kind: 'error', isError: true, text: '[synthetic] API overloaded (HTTP 529); retried and gave up' });
    } else {
      raw.push({
        ...base,
        tMs: at(0.97),
        kind: 'result',
        ...(!structured || structuredMissing ? { text } : {}),
        costUsd: phase.costUsd,
        meta: { subtype, numTurns: phase.turns },
      });
    }
    raw.push({
      ...base,
      tMs: at(1),
      kind: 'phase_end',
      costUsd: phase.costUsd,
      meta: {
        subtype,
        turns: phase.turns,
        toolCalls: calls + (structured && !structuredMissing ? 1 : 0),
        durationMs: phase.durationMs,
        mcpServersExpected: expected,
        ...(structuredMissing ? { structuredMissing: true } : {}),
        ...(phase.degraded ? { degraded: phase.degraded } : {}),
        ...(apiFailure ? { apiError: { kind: 'overloaded', retryable: true, status: 529, message: '[synthetic] Overloaded' } } : {}),
      },
    });
  });

  return raw
    .map((event, index) => ({ event, index }))
    .sort((a, b) => a.event.tMs - b.event.tMs || a.index - b.index)
    .map(({ event }, seq) => ({ ...event, seq }));
}

function promptFor(record: RunRecord, label: string): string {
  return `[synthetic] <task>\n${record.taskTitle}.\n</task>\n\nThis is the ${label.toLowerCase()} call. The real prompt for this phase would appear here.`;
}

function inputFor(name: string, i: number): Record<string, unknown> {
  if (name === 'web_search') return { query: `[synthetic] query ${i + 1}` };
  if (name === 'fetch_page') return { url: `https://example.com/synthetic/${i + 1}` };
  return { id: `R-${100 + i}` };
}

function structuredFor(phase: string): Record<string, unknown> {
  if (phase === 'plan') {
    return { steps: ['[synthetic] Read the record and the rules', '[synthetic] Decide what the rules allow', '[synthetic] Act and confirm'], rationale: '[synthetic] Read before acting.' };
  }
  if (phase === 'decompose') {
    return { subtasks: [1, 2, 3].map((n) => ({ id: `part-${n}`, goal: `[synthetic] Part ${n} of the task` })) };
  }
  return { winnerIndex: 1, rationale: '[synthetic] The most grounded proposal.', mergedAnswer: '[synthetic] Proposal 1, with the check from proposal 3.' };
}

function replyFor(phase: string, label: string, structuredMissing: boolean): string {
  if (structuredMissing) {
    return `[synthetic] ${label}: I would start by reading the record, but I could not produce the structured reply this phase asked for.`;
  }
  if (phase.startsWith('propose')) {
    return `### [synthetic] ${label}\n1. Read the record and the rules that apply to it.\n2. Change only what the rules allow, in that order.\n\n> Grounded in what the read-only tools returned.`;
  }
  if (phase.startsWith('verify')) {
    return '**[synthetic] Verdict:** approved. The final state matches the task and every rule checked holds.';
  }
  if (phase.startsWith('review')) return '[synthetic] Approved: the call is within the policy.';
  if (phase === 'synthesize') {
    return '## [synthetic] Summary\n| Worker | Outcome |\n|---|---|\n| 1 | done |\n| 2 | done |\n| 3 | done |';
  }
  return '## [synthetic] Done\n- Read `R-100` before changing it\n- Applied the change the policy allows\n\n**Result:** the request is resolved.';
}

/** FNV-1a, for a per-run seed that does not disturb the record generator's stream. */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const outFlag = process.argv.indexOf('--out');
  const outRoot = outFlag >= 0 && process.argv[outFlag + 1] ? path.resolve(process.argv[outFlag + 1] as string) : DEFAULT_OUT;
  const dir = path.join(outRoot, DEMO_RUN_SET_ID);

  const { manifest, catalog, records, traces } = buildDemoRunSet();

  await rm(dir, { recursive: true, force: true });
  await ensureDir(path.join(dir, 'runs'));
  await ensureDir(path.join(dir, 'traces'));

  for (const record of records) {
    await writeJson(path.join(dir, 'runs', `${record.runId}.json`), record);
  }
  for (const [runId, events] of traces) {
    await writeFile(
      path.join(dir, 'traces', `${runId}.jsonl`),
      `${events.map((event) => JSON.stringify(event)).join('\n')}\n`,
      'utf8',
    );
  }
  await writeJson(path.join(dir, 'manifest.json'), manifest);
  await writeJson(path.join(dir, 'catalog.json'), catalog);

  console.log(`Wrote ${records.length} synthetic runs to ${path.relative(process.cwd(), dir)}`);
  console.log('These numbers are invented. View them with: ARENA_DEMO=1 npm run dev:web');
  console.log('results/ and results/latest.json were not touched.');
}

const invokedDirectly =
  typeof process.argv[1] === 'string' && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
