import { SCHEMA_MIN_TURNS, parseLooseJson } from '@arena/core';
import type {
  FidelityInput,
  IntegrityCheck,
  QueryOutcome,
  RunContext,
  Strategy,
  StrategyOutcome,
} from '@arena/core';
import {
  checkFrom,
  cutShort,
  fail,
  metaNumber,
  metaString,
  pass,
  phase,
  phaseNamed,
  phasePrefix,
  toolSurfaceCheck,
  unjudged,
} from './fidelity';
import {
  ACTING_INSTRUCTIONS,
  REASONING_TURNS,
  createPhaseRunner,
  interrupted,
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
  'split gets wrong — an overlap, a dependency, a missing piece — shows up in the score. When ' +
  'the orchestrator judges that the task cannot honestly be split, one worker is given the ' +
  'whole task, so the architecture reduces to a single agent with an orchestrator around it.';

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
      minItems: 1,
    },
  },
  required: ['subtasks'],
  additionalProperties: false,
};

export interface Subtask {
  id: string;
  goal: string;
}

/** The single assignment when the work is not split: the task, whole. */
export const WHOLE_TASK: Subtask = {
  id: 'all',
  goal: 'Complete the task in full, from start to finish.',
};

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
    'Carry out your assignment.',
    ACTING_INSTRUCTIONS,
    // A worker answers the orchestrator, not the user: the one acting phase
    // that is not asked for a final answer.
    'Then report what you did, what you found, and anything that still needs attention. Your ' +
      'report is all the orchestrator will see.',
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

/** How the decomposition was read: through the schema, out of prose, or not at all. */
export type DecompositionSource = 'schema' | 'prose' | 'none';

export interface Decomposition {
  /** Usable subtasks, slugged, deduplicated and capped; empty when none could be read. */
  subtasks: Subtask[];
  source: DecompositionSource;
}

/**
 * The orchestrator's subtasks, as far as they can be read.
 *
 * One subtask is a decision, not a failure: the orchestrator was told to
 * return one when the task cannot honestly be split. None means it could not
 * be read at all.
 */
export function readDecomposition(outcome: Pick<QueryOutcome, 'structured' | 'text'>): Decomposition {
  const fromSchema = subtasksFrom(outcome.structured);
  if (fromSchema.length > 0) return { subtasks: fromSchema, source: 'schema' };
  const fromProse = subtasksFrom(parseLooseJson(outcome.text));
  if (fromProse.length > 0) return { subtasks: fromProse, source: 'prose' };
  return { subtasks: [], source: 'none' };
}

function subtasksFrom(value: unknown): Subtask[] {
  if (typeof value !== 'object' || value === null) return [];
  const raw = (value as { subtasks?: unknown }).subtasks;
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

const workerPhase = (subtask: Subtask) => `worker-${subtask.id}`;

/** The decomposition was read through the schema. */
export function decompositionCheck(input: FidelityInput): IntegrityCheck {
  const id = 'orchestrator-workers.decomposition';
  const decompose = phaseNamed(input, 'decompose');
  const excused = unjudged(id, input, decompose, 'the decomposition');
  if (excused || !decompose) return excused ?? fail(id, 'the decomposition never ran');

  const subtasks = metaNumber(decompose, 'subtasks') ?? 0;
  if (metaString(decompose, 'source') === 'schema' && subtasks > 0) {
    return pass(id, `${subtasks} subtask${subtasks === 1 ? '' : 's'}, read from the schema reply`);
  }
  return fail(id, decompose.degraded ?? 'the decomposition was not read from a schema reply');
}

/**
 * When the orchestrator split the work, every subtask got a worker and every
 * worker ran. Workers are started together on equal shares of the budget, so
 * one of them skipped while another ran was starved, not stopped.
 */
export function fanOutCheck(input: FidelityInput): IntegrityCheck {
  const id = 'orchestrator-workers.fan-out';
  const decompose = phaseNamed(input, 'decompose');
  const planned = metaNumber(decompose, 'workers');
  const workers = input.outcome.phases.filter((record) => record.phase.startsWith('worker-'));

  if (planned === undefined) {
    return input.stoppedBy || (decompose && cutShort(decompose))
      ? pass(id, 'the run stopped before the fan-out')
      : fail(id, 'no fan-out was recorded');
  }
  if (workers.length === 0 && input.stoppedBy) {
    return pass(id, `the run was stopped (${input.stoppedBy}) before the workers started`);
  }

  const failures: string[] = [];
  if (workers.length !== planned) failures.push(`${planned} workers planned, ${workers.length} ran`);
  const skipped = workers.filter((worker) => worker.subtype === 'skipped');
  if (skipped.length > 0 && skipped.length < workers.length) {
    failures.push(`${skipped.map((worker) => worker.phase).join(', ')} never started while the others ran`);
  }
  if (input.outcome.subagentCount !== planned) {
    failures.push(`subagentCount is ${input.outcome.subagentCount}, not ${planned}`);
  }
  return checkFrom(
    id,
    failures,
    planned === 1 ? 'one worker on the whole task, as the orchestrator chose' : `${planned} workers ran in parallel`,
  );
}

/** The synthesis wrote the answer, rather than a worker's report standing in for it. */
export function synthesisCheck(input: FidelityInput): IntegrityCheck {
  const id = 'orchestrator-workers.synthesis';
  const synthesize = phaseNamed(input, 'synthesize');
  const excused = unjudged(id, input, synthesize, 'the synthesis');
  if (excused || !synthesize) return excused ?? fail(id, 'the synthesis never ran');
  return synthesize.degraded === undefined ? pass(id) : fail(id, synthesize.degraded);
}

export function orchestratorWorkersFidelityChecks(input: FidelityInput): IntegrityCheck[] {
  return [
    decompositionCheck(input),
    fanOutCheck(input),
    synthesisCheck(input),
    toolSurfaceCheck('orchestrator-workers.tools', input, [
      { role: 'orchestrator', matches: phase('decompose'), tools: [] },
      { role: 'worker', matches: phasePrefix('worker-'), tools: input.env.allowedTools },
      { role: 'orchestrator', matches: phase('synthesize'), tools: [] },
    ]),
  ];
}

export function createOrchestratorWorkersStrategy(deps: Partial<StrategyDeps> = {}): Strategy {
  return {
    id: 'orchestrator-workers',
    label: 'Orchestrator with parallel workers',
    description: DESCRIPTION,
    fidelityChecks: orchestratorWorkersFidelityChecks,

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

      const decomposition = readDecomposition(decompose);
      // A lone subtask covers the whole task by the orchestrator's own
      // instructions, so its worker is given the task itself rather than the
      // orchestrator's restatement of it — which is often a plan, and would
      // turn this arm into plan-execute.
      const subtasks = decomposition.subtasks.length >= 2 ? decomposition.subtasks : [WHOLE_TASK];
      runner.annotate(decompose, {
        meta: {
          subtasks: decomposition.subtasks.length,
          workers: subtasks.length,
          source: decomposition.source,
        },
        ...(decomposition.source !== 'schema' && !interrupted(decompose)
          ? {
              degraded:
                decomposition.source === 'prose'
                  ? 'the subtasks came back as JSON in prose, not through the schema'
                  : 'the decomposition could not be read; one worker was given the whole task',
            }
          : {}),
      });

      if (!runner.canContinue()) return runner.finish();

      // The harness owns the fan-out rather than delegating to the SDK's
      // `agents` option: parallel subagents are the architecture under test, so
      // their count, tools and cost have to be observable here.
      const specs: LabeledSpec[] = subtasks.map((subtask, index) => ({
        phase: workerPhase(subtask),
        label: `Worker ${index + 1}: ${subtask.id}`,
        prompt: workerPrompt(ctx, subtask, subtasks.length),
        depth: 1,
        agentLabel: workerPhase(subtask),
        answers: true,
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
        answers: true,
      });
      if (synthesis.text.trim() === '' && !interrupted(synthesis)) {
        runner.annotate(synthesis, {
          degraded: 'the synthesis came back empty; the last worker report stands as the answer',
        });
      }

      return runner.finish({ finalText: synthesis.text, subagentCount });
    },
  };
}

export const orchestratorWorkersStrategy = createOrchestratorWorkersStrategy();
