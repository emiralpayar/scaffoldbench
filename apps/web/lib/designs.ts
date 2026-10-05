/**
 * What each architecture is made of: the calls it makes, what each call is
 * shown, and the fidelity checks that prove the calls happened.
 *
 * This is the long form of `lib/architectures.ts`, written for the strategy
 * pages. It describes the strategies in `@scaffoldbench/strategies`; `test/designs.
 * test.ts` holds it to the glyph geometry (every stage names real glyph nodes,
 * every node belongs to a stage) so a drawing and its caption cannot drift.
 *
 * Stages are matched to a run's recorded phases by name, which is how a phase
 * cost breakdown is built from the records alone. The patterns accept the
 * names an older run set used as well as today's (`verify` before
 * `verify-1`, a lone `worker-all`), so the same page can describe both.
 *
 * Pure: safe anywhere.
 */

import type { ArchitectureId } from './architectures';
import { canonicalArchitectureId } from './architectures';

/** What a call is shown of the task's tools. */
export type ToolExposure = 'none' | 'read-only' | 'full';

export interface DesignStage {
  id: string;
  title: string;
  /** Ids of the glyph nodes (`lib/glyphs.ts`) this stage is drawn as. */
  nodes: readonly string[];
  /** Matches the recorded phase names that belong to this stage. */
  phase: RegExp;
  tools: ToolExposure;
  /** Runs at the same time as its siblings, in separate contexts. */
  parallel?: boolean;
  /** What the call does and what it hands on, in a sentence or two. */
  body: string;
}

export interface FidelityCheckInfo {
  /** The id a run record carries, e.g. `plan-execute.plan`. */
  id: string;
  title: string;
  /** What passing verifies, in a sentence. */
  means: string;
}

export interface DesignInfo {
  id: ArchitectureId;
  /** The question the design exists to answer. */
  question: string;
  /** Where it can go wrong in a way a score alone would not show. */
  risk: string;
  stages: readonly DesignStage[];
  checks: readonly FidelityCheckInfo[];
}

export const TOOL_EXPOSURE: Record<ToolExposure, { label: string; detail: string }> = {
  none: { label: 'no tools', detail: 'A reasoning call: it is shown no tool of the task.' },
  'read-only': { label: 'read-only tools', detail: 'It can look at the state of the world but not change it.' },
  full: { label: 'full toolset', detail: 'It holds every tool of the task, including the ones that change state.' },
};

const TOOLS_CHECK = (id: ArchitectureId, means: string): FidelityCheckInfo => ({
  id: `${id}.tools`,
  title: 'Each call was shown the right tools',
  means,
});

export const DESIGNS: Record<ArchitectureId, DesignInfo> = {
  single: {
    id: 'single',
    question: 'Is any structure worth its price at all?',
    risk: 'Nothing to skip: the control cannot degrade in a way that makes it look like something else.',
    stages: [
      {
        id: 'agent',
        title: 'The agent',
        nodes: ['agent'],
        phase: /^(main|single)$/,
        tools: 'full',
        body: 'Reads the task, calls tools as it sees fit and answers in one session. Every other design adds calls around this one, so its score and cost are what each of them has to beat.',
      },
    ],
    checks: [TOOLS_CHECK('single', 'The agent was shown exactly the task’s tools, none missing and none extra.')],
  },

  'plan-execute': {
    id: 'plan-execute',
    question: 'Does committing to a sequence up front beat deciding one action at a time?',
    risk: 'An empty plan leaves a single agent with a wasted call in front of it, and the score cannot tell.',
    stages: [
      {
        id: 'plan',
        title: 'The planner',
        nodes: ['plan'],
        phase: /^plan$/,
        tools: 'none',
        body: 'Sees the task and the domain policy but no tool, and returns an ordered list of steps through a structured reply. It cannot look anything up, so the plan is only as good as the statement of the task.',
      },
      {
        id: 'execute',
        title: 'The executor',
        nodes: ['execute'],
        phase: /^execute$/,
        tools: 'full',
        body: 'Receives the plan with the task and carries it out with the full toolset, adapting where the world differs from what the plan assumed.',
      },
    ],
    checks: [
      {
        id: 'plan-execute.plan',
        title: 'The plan was a plan',
        means: 'The planner’s reply was read through its schema and held at least one step.',
      },
      TOOLS_CHECK('plan-execute', 'The planner was shown no tools and the executor the task’s full toolset.'),
    ],
  },

  'orchestrator-workers': {
    id: 'orchestrator-workers',
    question: 'Does splitting a task across parallel contexts pay for the coordination?',
    risk: 'If the split never happens the design is one worker with an orchestrator around it, and the score looks like a single agent’s.',
    stages: [
      {
        id: 'decompose',
        title: 'The orchestrator',
        nodes: ['orchestrate'],
        phase: /^decompose$/,
        tools: 'none',
        body: 'Splits the task into two to four independent subtasks through a structured reply, or one worker with the whole task when it judges the task cannot honestly be split.',
      },
      {
        id: 'workers',
        title: 'The workers',
        nodes: ['w1', 'w2', 'w3'],
        phase: /^worker(-.+)?$/,
        tools: 'full',
        parallel: true,
        body: 'One worker per subtask, started together in separate contexts with the full toolset. They cannot see each other, so an overlap or a dependency the split missed shows up in the score.',
      },
      {
        id: 'synthesize',
        title: 'The synthesis',
        nodes: ['synthesize'],
        phase: /^synthesi[sz]e$/,
        tools: 'none',
        body: 'Writes the final answer from the workers’ reports. It holds no tools, so it can only merge what the workers found.',
      },
    ],
    checks: [
      {
        id: 'orchestrator-workers.decomposition',
        title: 'The task was decomposed',
        means: 'The orchestrator’s reply was read through its schema and held at least one subtask.',
      },
      {
        id: 'orchestrator-workers.fan-out',
        title: 'The fan-out happened',
        means: 'Every subtask got a worker, every worker ran, and the recorded subagent count matches.',
      },
      {
        id: 'orchestrator-workers.synthesis',
        title: 'The synthesis wrote the answer',
        means: 'The final answer came from the synthesis call, not from a worker’s report standing in for it.',
      },
      TOOLS_CHECK(
        'orchestrator-workers',
        'The orchestrator and the synthesis were shown no tools and every worker the task’s full toolset.',
      ),
    ],
  },

  'plan-execute-verify': {
    id: 'plan-execute-verify',
    question: 'Is a second opinion on the finished state worth the cost of asking for it?',
    risk: 'A verifier whose verdict cannot be read, or that approves by default, never sends anything back: the loop is dead code and the cost is overhead.',
    stages: [
      {
        id: 'plan',
        title: 'The planner',
        nodes: ['plan'],
        phase: /^plan$/,
        tools: 'none',
        body: 'The same tool-less planner as in plan-execute: an ordered list of steps through a structured reply.',
      },
      {
        id: 'execute',
        title: 'The executor',
        nodes: ['execute'],
        phase: /^(execute|revise(-\d+)?)$/,
        tools: 'full',
        body: 'Carries out the plan with the full toolset. When the verifier sends the work back, a revision call, with the full toolset again, acts on its issues, at most twice.',
      },
      {
        id: 'verify',
        title: 'The verifier',
        nodes: ['verify'],
        phase: /^verify(-\d+)?(-retry)?$/,
        tools: 'read-only',
        body: 'Holds only the read-only tools and has to check the real state of the world rather than the executor’s account of it. It returns a verdict with a severity: a blocking issue sends the work back, a minor one ends the review.',
      },
    ],
    checks: [
      {
        id: 'plan-execute-verify.plan',
        title: 'The plan was a plan',
        means: 'The planner’s reply was read through its schema and held at least one step.',
      },
      {
        id: 'plan-execute-verify.verdicts',
        title: 'Every verdict was read',
        means: 'Every review round ended with a verdict read from the schema reply, not a default.',
      },
      {
        id: 'plan-execute-verify.loop',
        title: 'The loop did what its verdicts said',
        means: 'Every verdict that called for a revision got one, and nothing was revised without such a verdict.',
      },
      TOOLS_CHECK(
        'plan-execute-verify',
        'The planner was shown no tools, the verifier the read-only ones, and the executor and reviser the full toolset.',
      ),
    ],
  },

  'propose-select': {
    id: 'propose-select',
    question: 'Does choosing among independent proposals beat committing to the first idea?',
    risk: 'A proposer that starts without its tools can only guess, and a selector that falls back to proposal 1 turns three investigations into one.',
    stages: [
      {
        id: 'propose',
        title: 'The proposers',
        nodes: ['p1', 'p2', 'p3'],
        phase: /^propose(-\d+)?$/,
        tools: 'read-only',
        parallel: true,
        body: 'Three proposers investigate at the same time with read-only tools, each starting from a different angle: the rules, the current state, or the outcome the person needs. Nothing is changed, and they never see one another.',
      },
      {
        id: 'select',
        title: 'The selector',
        nodes: ['select'],
        phase: /^select$/,
        tools: 'none',
        body: 'Reads the three proposals, picks the strongest and merges in what the others got right, through a structured reply. It holds no tools, so it chooses on the proposals alone.',
      },
      {
        id: 'execute',
        title: 'The executor',
        nodes: ['execute'],
        phase: /^execute$/,
        tools: 'full',
        body: 'Applies the chosen course of action with the full toolset. Until this call nothing in the world has changed.',
      },
    ],
    checks: [
      {
        id: 'propose-select.proposals',
        title: 'All three proposers ran',
        means: 'Three proposers ran in parallel, each from its own angle, and none was starved while another ran.',
      },
      {
        id: 'propose-select.selection',
        title: 'The selector chose',
        means: 'The selector picked a proposal by a valid number, read from its schema reply and not a default.',
      },
      TOOLS_CHECK(
        'propose-select',
        'Each proposer was shown the read-only tools, the selector none, and the executor the full toolset.',
      ),
    ],
  },

  'gated-execute': {
    id: 'gated-execute',
    question: 'Is review at the point of action worth a model call per action?',
    risk: 'If a state-changing call can run without a review the gate is decoration, and an unreadable decision must count as a denial.',
    stages: [
      {
        id: 'execute',
        title: 'The executor',
        nodes: ['agent', 'effect'],
        phase: /^execute$/,
        tools: 'full',
        body: 'One agent with the full toolset. Reads pass straight through; every call that would change state is held until a reviewer has ruled on it.',
      },
      {
        id: 'review',
        title: 'The reviewer',
        nodes: ['gate', 'reviewer'],
        phase: /^review(-\d+)?$/,
        tools: 'read-only',
        body: 'A separate call per state-changing action. It holds the domain policy and the read-only tools, checks the current state and allows or denies. A denial returns to the executor as the tool’s result, with the reason, so it can adapt.',
      },
    ],
    checks: [
      {
        id: 'gated-execute.reviewed',
        title: 'Every state change was reviewed',
        means: 'Every call that changed the world had been allowed by a review before it ran, counted from the world’s own journal.',
      },
      {
        id: 'gated-execute.decisions',
        title: 'Every decision was read',
        means: 'Every review that ran to its end gave its decision through the schema; an unreadable one is a denial.',
      },
      TOOLS_CHECK(
        'gated-execute',
        'The executor was shown the task’s full toolset and each reviewer the read-only tools.',
      ),
    ],
  },
};

export function designFor(strategyId: string): DesignInfo | undefined {
  return (DESIGNS as Record<string, DesignInfo | undefined>)[canonicalArchitectureId(strategyId)];
}

/** The stage a recorded phase belongs to, or `undefined` for a phase the design does not know. */
export function stageOfPhase(strategyId: string, phase: string): DesignStage | undefined {
  return designFor(strategyId)?.stages.find((stage) => stage.phase.test(phase));
}

/** The words for a fidelity check id declared by any architecture. */
export function fidelityCheckInfo(checkId: string): FidelityCheckInfo | undefined {
  for (const design of Object.values(DESIGNS)) {
    const found = design.checks.find((check) => check.id === checkId);
    if (found) return found;
  }
  return undefined;
}
