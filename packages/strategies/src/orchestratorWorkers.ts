import { SCHEMA_MIN_TURNS, readStructured } from '@arena/core';
import type { QueryOutcome, RunContext, Strategy, StrategyOutcome } from '@arena/core';
import {
  REASONING_TURNS,
  createPhaseRunner,
  joinSections,
  tagged,
  taskBlock,
  type LabeledSpec,
  type StrategyDeps,
} from './helpers';

const DESCRIPTION =
  'An orchestrator splits the task into independent subtasks, fans them out to workers that run ' +
  'at the same time in separate contexts, then writes the answer from their reports. It trades ' +
  'wall-clock time for coordination risk: the workers cannot see each other, so anything the ' +
  'split gets wrong — an overlap, a dependency, a missing piece — shows up in the score.';

/** Beyond four the workers start colliding and the synthesis gets thin. */
const MAX_WORKERS = 4;

export const DECOMPOSE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    subtasks: {
      type: 'array',
      description: 'Independent pieces of work, each safe to carry out at the same time.',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Short lowercase hyphenated name, e.g. "refund".' },
          goal: {
            type: 'string',
            description: 'Self-contained instruction for one worker, understandable on its own.',
          },
        },
        required: ['id', 'goal'],
        additionalProperties: false,
      },
    },
  },
  required: ['subtasks'],
  additionalProperties: false,
};

export interface Subtask {
  id: string;
  goal: string;
}

export function decomposePrompt(ctx: RunContext): string {
  return joinSections(
    taskBlock(ctx),
    'You are the orchestrator. You have no tools here: split the work only.',
    `Divide the task into between 2 and ${MAX_WORKERS} subtasks that separate workers can carry ` +
      'out at the same time. Each worker gets the same tools, starts from the task statement ' +
      'alone and never sees the others, so a subtask must not depend on another subtask\'s ' +
      'result and two subtasks must not touch the same thing. State each goal as a complete ' +
      'instruction. If the task cannot honestly be split this way, return a single subtask ' +
      'covering all of it.',
  );
}

export function workerPrompt(ctx: RunContext, subtask: Subtask, total: number): string {
  const solo =
    'You are carrying out this task on your own; the assignment below covers all of it.';
  const parallel =
    `You are one of ${total} workers running at the same time on this task. The others are ` +
    'handling the rest of it, so do your assignment and nothing beyond it.';

  return joinSections(
    taskBlock(ctx),
    tagged('your_assignment', subtask.goal),
    total === 1 ? solo : parallel,
    'Use the tools to carry out your assignment, checking state before you change it. Then ' +
      'report what you did, what you found, and anything that still needs attention. Your report ' +
      'is all the orchestrator will see.',
  );
}

export function synthesizePrompt(ctx: RunContext, reports: string): string {
  return joinSections(
    taskBlock(ctx),
    tagged('worker_reports', reports),
    'You are the orchestrator. You have no tools here, so the reports above are your only ' +
      'evidence.',
    'Write the final answer to the task from those reports. Do not claim anything no worker ' +
      'reported; if the reports conflict or leave something unfinished, say so plainly.',
  );
}

/**
 * Subtasks the orchestrator can actually fan out.
 *
 * A single subtask is not a decomposition — it is the whole task with an extra
 * call in front of it — so callers treat anything under two as a fallback.
 */
export function readSubtasks(outcome: QueryOutcome): Subtask[] {
  const parsed = readStructured<{ subtasks?: unknown }>(outcome);
  const raw = parsed?.subtasks;
  if (!Array.isArray(raw)) return [];

  const subtasks: Subtask[] = [];
  const used = new Set<string>();

  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const record = item as Record<string, unknown>;
    const goal = typeof record.goal === 'string' ? record.goal.trim() : '';
    if (goal === '') continue;

    const rawId = typeof record.id === 'string' ? record.id : '';
    // Ids become phase names, so they have to be slug-safe and unique.
    const base =
      rawId
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 24) || `${subtasks.length + 1}`;
    let id = base;
    for (let suffix = 2; used.has(id); suffix++) id = `${base}-${suffix}`;
    used.add(id);

    subtasks.push({ id, goal });
    if (subtasks.length >= MAX_WORKERS) break;
  }

  return subtasks;
}

export function createOrchestratorWorkersStrategy(deps: Partial<StrategyDeps> = {}): Strategy {
  return {
    id: 'orchestrator-workers',
    label: 'Orchestrator with parallel workers',
    description: DESCRIPTION,

    async run(ctx: RunContext): Promise<StrategyOutcome> {
      const runner = createPhaseRunner(ctx, deps);
      if (!runner.canContinue()) return runner.finish();

      const decompose = await runner.run({
        phase: 'decompose',
        label: 'Decompose',
        prompt: decomposePrompt(ctx),
        allowedTools: [],
        outputSchema: DECOMPOSE_SCHEMA,
        maxTurns: SCHEMA_MIN_TURNS,
      });

      const proposed = readSubtasks(decompose);
      const subtasks: Subtask[] =
        proposed.length >= 2
          ? proposed
          : [{ id: 'all', goal: 'Complete the task in full, from start to finish.' }];

      if (!runner.canContinue()) return runner.finish();

      // The harness owns the fan-out rather than delegating to the SDK's
      // `agents` option: parallel subagents are the architecture under test, so
      // their count, tools and cost have to be observable here.
      const specs: LabeledSpec[] = subtasks.map((subtask, index) => ({
        phase: `worker-${subtask.id}`,
        label: `Worker ${index + 1}: ${subtask.id}`,
        prompt: workerPrompt(ctx, subtask, subtasks.length),
        depth: 1,
        agentLabel: `worker-${subtask.id}`,
      }));

      const workers = await runner.runAll(specs);
      const subagentCount = subtasks.length;

      if (!runner.canContinue()) return runner.finish({ subagentCount });

      const reports = subtasks
        .map((subtask, index) => {
          const text = workers[index]?.text.trim();
          return tagged(
            'report',
            `worker: ${subtask.id}\nassignment: ${subtask.goal}\n\n${
              text === undefined || text === '' ? '(no report: this worker returned nothing)' : text
            }`,
          );
        })
        .join('\n\n');

      const synthesis = await runner.run({
        phase: 'synthesize',
        label: 'Synthesize',
        prompt: synthesizePrompt(ctx, reports),
        allowedTools: [],
        maxTurns: REASONING_TURNS,
      });

      return runner.finish({ finalText: synthesis.text, subagentCount });
    },
  };
}

export const orchestratorWorkersStrategy = createOrchestratorWorkersStrategy();
