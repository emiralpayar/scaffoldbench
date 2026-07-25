/**
 * Fabricate a run set so the site can be developed and reviewed without
 * spending anything.
 *
 *   npm run demo:data          # writes results/demo-synthetic and points latest.json at it
 *   npm run demo:data -- --keep-latest
 *
 * THE NUMBERS HERE ARE INVENTED. The manifest carries `synthetic: true` and the
 * site renders a banner because of it. Nothing produced here may be quoted as a
 * result — the whole point of the project is that architecture claims should be
 * measured, and fabricated data would make it self-defeating.
 */

import { rm } from 'node:fs/promises';
import path from 'node:path';

import {
  RESULTS_DIR,
  catalogPath,
  ensureDir,
  latestPointerPath,
  makeRunId,
  manifestPath,
  runSetDir,
  runsDir,
  tracesDir,
  writeJson,
} from '@arena/core';
import type {
  RunRecord,
  RunSetManifest,
  StrategyInfo,
  TaskInfo,
  TraceEvent,
} from '@arena/core';
import { writeFile } from 'node:fs/promises';

const RUN_SET_ID = 'demo-synthetic';
const MODEL = 'claude-sonnet-5';
const REPEATS = 3;
const TRACED_TASKS = new Set(['airline-hard', 'research-medium']);

/** Deterministic PRNG so regenerating produces an identical directory. */
function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const strategies: (StrategyInfo & { baseScore: number; costMultiplier: number; subagents: number })[] = [
  {
    id: 'single',
    label: 'Single agent',
    description: 'One model call with the full toolset. The baseline every other row is measured against.',
    baseScore: 0.58,
    costMultiplier: 1,
    subagents: 0,
  },
  {
    id: 'plan-execute',
    label: 'Plan then execute',
    description: 'A tool-less planning call, then a separate execution call that follows the plan.',
    baseScore: 0.66,
    costMultiplier: 1.4,
    subagents: 0,
  },
  {
    id: 'orchestrator-workers',
    label: 'Orchestrator with parallel workers',
    description: 'Decompose into subtasks, run workers concurrently, synthesise their reports.',
    baseScore: 0.74,
    costMultiplier: 3.6,
    subagents: 3,
  },
  {
    id: 'plan-execute-verify',
    label: 'Plan, execute, verify, revise',
    description: 'Adds a read-only verification pass that can send the work back for revision.',
    baseScore: 0.79,
    costMultiplier: 2.5,
    subagents: 0,
  },
  {
    id: 'debate-select',
    label: 'Parallel proposals, select, execute',
    description: 'Three read-only proposers, a selector, then one executor applies the winner.',
    baseScore: 0.71,
    costMultiplier: 4.1,
    subagents: 3,
  },
];

const tasks: (TaskInfo & { hardness: number })[] = [
  taskInfo('airline-easy', 'airline', 'Add checked baggage and charge the correct fee', 'easy', 0.05),
  taskInfo('airline-medium', 'airline', 'Rebook a passenger after a cancellation', 'medium', 0.18),
  taskInfo('airline-hard', 'airline', 'Cancel with fare-class and insurance dependent refund', 'hard', 0.34),
  taskInfo('ecommerce-easy', 'ecommerce', 'Correct a shipping address on an unshipped order', 'easy', 0.04),
  taskInfo('ecommerce-medium', 'ecommerce', 'Cancel one line of a multi-line order', 'medium', 0.2),
  taskInfo('ecommerce-hard', 'ecommerce', 'Out-of-window partial return with mixed refund methods', 'hard', 0.38),
  taskInfo('support-easy', 'support', 'Triage and assign a new ticket', 'easy', 0.06),
  taskInfo('support-medium', 'support', 'Merge duplicate tickets preserving the earliest SLA', 'medium', 0.22),
  taskInfo('support-hard', 'support', 'Escalate by due-time on-call with a blocking linked ticket', 'hard', 0.4),
  researchInfo('research-easy', 'Compare two documented specifications', 'easy', 0.12),
  researchInfo('research-medium', 'Synthesise across three sources', 'medium', 0.26),
  researchInfo('research-hard', 'Surface a genuine disagreement between sources', 'hard', 0.42),
];

function taskInfo(
  id: string,
  world: string,
  title: string,
  difficulty: TaskInfo['difficulty'],
  hardness: number,
): TaskInfo & { hardness: number } {
  return {
    id,
    category: 'tool-use',
    world,
    title,
    prompt: `[synthetic] ${title}.`,
    policy: '[synthetic] Domain rules would appear here.',
    difficulty,
    tags: [world, difficulty],
    maxTurns: 14,
    hardness,
  };
}

function researchInfo(
  id: string,
  title: string,
  difficulty: TaskInfo['difficulty'],
  hardness: number,
): TaskInfo & { hardness: number } {
  return {
    id,
    category: 'research',
    world: 'web',
    title,
    prompt: `[synthetic] ${title}.`,
    difficulty,
    tags: ['web', difficulty],
    maxTurns: 18,
    hardness,
  };
}

function buildTrace(strategyId: string, subagents: number): TraceEvent[] {
  const events: TraceEvent[] = [];
  let seq = 0;
  let tMs = 0;
  const push = (event: Omit<TraceEvent, 'seq' | 'tMs'>) => {
    tMs += 400;
    events.push({ ...event, seq: seq++, tMs });
  };

  push({ phase: 'main', depth: 0, kind: 'phase_start', text: 'main' });
  push({ phase: 'main', depth: 0, kind: 'user', text: '[synthetic] task prompt' });
  push({
    phase: 'main',
    depth: 0,
    kind: 'assistant_text',
    text: '[synthetic] Reading the record before changing anything.',
  });
  push({
    phase: 'main',
    depth: 0,
    kind: 'tool_call',
    toolName: 'get_record',
    toolUseId: 'tu_1',
    toolInput: { id: 'R1' },
  });
  push({ phase: 'main', depth: 0, kind: 'tool_result', toolUseId: 'tu_1', text: '[synthetic] record body' });

  for (let i = 1; i <= subagents; i++) {
    push({
      phase: `worker-${i}`,
      depth: 1,
      agent: `worker-${i}`,
      kind: 'assistant_text',
      text: `[synthetic] worker ${i} report`,
    });
  }

  push({ phase: 'main', depth: 0, kind: 'result', costUsd: 0.04, meta: { subtype: 'success' } });
  push({ phase: 'main', depth: 0, kind: 'phase_end', meta: { subtype: 'success' } });
  void strategyId;
  return events;
}

async function main(): Promise<void> {
  const keepLatest = process.argv.includes('--keep-latest');
  const rng = makeRng(20260725);
  const root = RESULTS_DIR;

  await rm(runSetDir(RUN_SET_ID, root), { recursive: true, force: true });
  await ensureDir(runsDir(RUN_SET_ID, root));
  await ensureDir(tracesDir(RUN_SET_ID, root));

  const records: RunRecord[] = [];
  let totalCostUsd = 0;
  let totalJudgeCostUsd = 0;

  for (let repeat = 1; repeat <= REPEATS; repeat++) {
    for (const task of tasks) {
      for (const strategy of strategies) {
        // Tool-use scores come off a weighted assertion grid in reality, so
        // they are discrete and a fully-correct run lands exactly on 1.0.
        // Modelling that here is what gives the demo a believable pass rate and
        // exercises the pass/fail rendering.
        const quality = clamp01(strategy.baseScore - task.hardness + (rng() - 0.5) * 0.22);
        const score =
          task.category === 'tool-use' ? quantizeToAssertions(quality, rng) : round(quality, 3);
        const passed = score >= 0.999;
        const costUsd = round(
          (0.018 + task.hardness * 0.05) * strategy.costMultiplier * (0.85 + rng() * 0.3),
          6,
        );
        const judgeCostUsd = task.category === 'research' ? round(0.003 + rng() * 0.002, 6) : 0;
        const latencyMs = Math.round(
          (9_000 + task.hardness * 22_000) * (strategy.subagents > 0 ? 0.7 : 1) * (0.8 + rng() * 0.5),
        );

        totalCostUsd += costUsd;
        totalJudgeCostUsd += judgeCostUsd;

        const runId = makeRunId({ strategyId: strategy.id, taskId: task.id, repeat });
        const failureMode = pickFailureMode(score, rng);

        const record: RunRecord = {
          runId,
          runSetId: RUN_SET_ID,
          taskId: task.id,
          taskTitle: task.title,
          taskCategory: task.category,
          taskWorld: task.world,
          taskDifficulty: task.difficulty,
          strategyId: strategy.id,
          model: MODEL,
          effort: 'high',
          repeat,
          startedAt: new Date(Date.UTC(2026, 6, 25, 12, repeat, 0)).toISOString(),
          finishedAt: new Date(Date.UTC(2026, 6, 25, 12, repeat, 30)).toISOString(),
          latencyMs,
          score: round(score, 4),
          passed,
          breakdown: [
            { id: 'state', label: '[synthetic] Final state is correct', weight: 2, earned: score },
            { id: 'side-effects', label: '[synthetic] No unintended changes', weight: 1, earned: score > 0.5 ? 1 : 0 },
          ],
          penalties:
            failureMode === 'policy_violation'
              ? [
                  {
                    id: 'policy',
                    label: '[synthetic] Acted before consulting the policy',
                    kind: 'policy_violation',
                    multiplier: 0,
                  },
                ]
              : [],
          failureMode,
          scoreMetadata:
            task.category === 'research'
              ? { citationIntegrity: round(0.6 + rng() * 0.4, 3), citedCount: 4 }
              : { toolCalls: 5 + Math.floor(rng() * 7) },
          costUsd,
          judgeCostUsd,
          usage: {
            inputTokens: Math.round(18_000 * strategy.costMultiplier),
            outputTokens: Math.round(1_400 * strategy.costMultiplier),
            cacheReadInputTokens: Math.round(42_000 * strategy.costMultiplier),
            cacheCreationInputTokens: 3_200,
          },
          turns: 4 + Math.floor(rng() * 9),
          toolCalls: 5 + Math.floor(rng() * 9),
          deniedToolCalls: rng() > 0.93 ? 1 : 0,
          subagentCount: strategy.subagents,
          phases: [],
          finalText: `[synthetic] ${strategy.label} answer for ${task.id}.`,
          ...(repeat === 1 && TRACED_TASKS.has(task.id)
            ? { traceFile: `traces/${runId}.jsonl` }
            : {}),
        };

        records.push(record);
        await writeJson(path.join(runsDir(RUN_SET_ID, root), `${runId}.json`), record);

        // Only a representative slice gets a trace. Every strategy is covered
        // on one tool-use and one research task, which is enough to exercise
        // the viewer; the rest exercise its "trace not committed" fallback,
        // which is what a real repository looks like.
        if (repeat === 1 && TRACED_TASKS.has(task.id)) {
          const events = buildTrace(strategy.id, strategy.subagents);
          await writeFile(
            path.join(tracesDir(RUN_SET_ID, root), `${runId}.jsonl`),
            `${events.map((e) => JSON.stringify(e)).join('\n')}\n`,
            'utf8',
          );
        }
      }
    }
  }

  const manifest: RunSetManifest = {
    runSetId: RUN_SET_ID,
    createdAt: '2026-07-25T12:00:00.000Z',
    finishedAt: '2026-07-25T12:41:00.000Z',
    gitSha: null,
    model: MODEL,
    effort: 'high',
    repeats: REPEATS,
    fixtureMode: 'replay',
    strategyIds: strategies.map((s) => s.id),
    taskIds: tasks.map((t) => t.id),
    totalRuns: records.length,
    completedRuns: records.length,
    totalCostUsd: round(totalCostUsd, 6),
    totalJudgeCostUsd: round(totalJudgeCostUsd, 6),
    durationMs: 2_460_000,
    maxCostUsdPerRun: 1,
    synthetic: true,
    notes:
      'SYNTHETIC DEMO DATA generated by scripts/generate-demo-data.ts. These numbers are ' +
      'invented for interface development and must never be quoted as benchmark results.',
  };

  await writeJson(manifestPath(RUN_SET_ID, root), manifest);
  await writeJson(catalogPath(RUN_SET_ID, root), {
    strategies: strategies.map(({ id, label, description }) => ({ id, label, description })),
    tasks: tasks.map(({ hardness, ...rest }) => {
      void hardness;
      return rest;
    }),
  });

  if (!keepLatest) {
    await writeJson(latestPointerPath(root), { runSetId: RUN_SET_ID });
  }

  console.log(`Wrote ${records.length} synthetic runs to results/${RUN_SET_ID}`);
  console.log('These numbers are invented. The site shows a banner; do not quote them.');
  if (!keepLatest) console.log('results/latest.json now points at the synthetic set.');
}

/**
 * Snap a continuous quality signal onto a three-assertion grid (0, 1/3, 2/3, 1),
 * biased by the signal, so the distribution looks like deterministic scoring
 * rather than a smear.
 */
function quantizeToAssertions(quality: number, rng: () => number): number {
  const assertions = 3;
  let earned = 0;
  for (let i = 0; i < assertions; i++) {
    if (rng() < quality) earned += 1;
  }
  return round(earned / assertions, 4);
}

function pickFailureMode(score: number, rng: () => number): RunRecord['failureMode'] {
  if (score >= 0.999) return 'none';
  const roll = rng();
  if (roll < 0.18) return 'policy_violation';
  if (roll < 0.26) return 'timeout';
  if (roll < 0.32) return 'max_turns';
  if (roll < 0.36) return 'budget_exceeded';
  return 'wrong_answer';
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
