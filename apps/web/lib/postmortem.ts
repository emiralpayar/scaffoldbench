/**
 * Act 1: what each architecture was designed to do against what it did, read
 * off the committed run records of the first published run set.
 *
 * Every receipt is a count over `runs/*.json` — phase errors, worker counts,
 * tool calls per proposer, revision phases — so the claim on the page is
 * re-derived on every build from files anyone can open, not typed into copy.
 * What a record cannot show — the plan an executor was handed, the tools and
 * servers a session started with — comes from the run set's committed traces
 * through `deriveTraceFacts` below.
 */

import { compareArchitectures } from './architectures';
import { joinList } from './format';
import type { RunRecord, TraceEvent } from './records';
import { normalizeError } from './timeline';

export interface Receipt {
  /** What went wrong, as a sentence fragment that reads after the count. */
  label: string;
  count: number;
  of: number;
  /** What `count` and `of` count: runs, or individual phases. */
  unit: 'runs' | 'proposals';
}

export interface PostmortemRow {
  strategyId: string;
  runs: number;
  /** What the leaderboard said: the plain mean score over these runs. */
  meanScore: number;
  /** True when no receipt below fired in any run. */
  ranAsDesigned: boolean;
  /** Glyph node ids that never did their job (see `lib/glyphs.ts`). */
  deadNodes: string[];
  receipts: Receipt[];
  /** Runs recorded with no failure mode: the record said nothing went wrong. */
  withoutFailure: number;
  /** Mean cost of a run, and the part of it spent on phases that failed or ran blind. */
  costUsdPerRun: number;
  wastedUsdPerRun: number;
}

export interface Postmortem {
  runSetId: string;
  runs: number;
  models: string[];
  rows: PostmortemRow[];
  /** Architectures with at least one receipt. */
  degraded: number;
  /** Runs in which the sandbox guard denied a tool call. */
  runsWithDenials: number;
  totals: PostmortemTotals;
}

/** Everything the run records say about the set as a whole. */
export interface PostmortemTotals {
  phases: number;
  /** Phases that were asked for a structured reply: a plan, a decomposition or a selection. */
  structuredPhases: number;
  /** Of those, the ones that ended in an error. */
  structuredFailed: number;
  proposals: number;
  /** Proposals made without a single tool call. */
  blindProposals: number;
  /** Phases that errored or ran blind: their output was thrown away or guessed. */
  wastedPhases: number;
  wastedCostUsd: number;
  costUsd: number;
  /** Tool calls the sandbox guard denied, over the whole set. */
  deniedToolCalls: number;
  /** Runs recorded with no failure mode at all. */
  runsWithoutFailure: number;
  /** Runs of a design with a verifier, and how many of them it sent back for revision. */
  verifiedRuns: number;
  revisedRuns: number;
}

const STRUCTURED_PHASE = /^(plan|decompose|select)$/;
const PROPOSER_PHASE = /^propose-\d+$/;

/** A phase whose output was lost to an error, or guessed because the proposer had no tools. */
function wasted(phase: RunRecord['phases'][number]): boolean {
  return !!phase.error || (PROPOSER_PHASE.test(phase.phase) && phase.toolCalls === 0);
}

export function derivePostmortem(runSetId: string, records: readonly RunRecord[]): Postmortem {
  const strategies = [...new Set(records.map((record) => record.strategyId))].sort(
    compareArchitectures,
  );

  const rows = strategies.map((strategyId) => {
    const runs = records.filter((record) => record.strategyId === strategyId);
    const { receipts, deadNodes } = inspect(strategyId, runs);
    const phases = runs.flatMap((run) => run.phases);
    return {
      strategyId,
      runs: runs.length,
      meanScore: runs.reduce((sum, record) => sum + record.score, 0) / Math.max(1, runs.length),
      ranAsDesigned: receipts.every((receipt) => receipt.count === 0),
      deadNodes,
      receipts: receipts.filter((receipt) => receipt.count > 0),
      withoutFailure: runs.filter((run) => run.failureMode === 'none').length,
      costUsdPerRun: sum(runs.map((run) => run.costUsd)) / Math.max(1, runs.length),
      wastedUsdPerRun:
        sum(phases.filter(wasted).map((phase) => phase.costUsd)) / Math.max(1, runs.length),
    };
  });

  const phases = records.flatMap((record) => record.phases);
  const structured = phases.filter((phase) => STRUCTURED_PHASE.test(phase.phase));
  const proposals = phases.filter((phase) => PROPOSER_PHASE.test(phase.phase));
  const reviewed = records.filter((record) => record.phases.some((phase) => phase.phase.startsWith('verify')));

  return {
    runSetId,
    runs: records.length,
    models: [...new Set(records.map((record) => record.model))],
    rows,
    degraded: rows.filter((row) => !row.ranAsDesigned).length,
    runsWithDenials: records.filter((record) => record.deniedToolCalls > 0).length,
    totals: {
      phases: phases.length,
      structuredPhases: structured.length,
      structuredFailed: structured.filter((phase) => !!phase.error).length,
      proposals: proposals.length,
      blindProposals: proposals.filter((phase) => phase.toolCalls === 0).length,
      wastedPhases: phases.filter(wasted).length,
      wastedCostUsd: sum(phases.filter(wasted).map((phase) => phase.costUsd)),
      costUsd: sum(records.map((record) => record.costUsd)),
      deniedToolCalls: sum(records.map((record) => record.deniedToolCalls)),
      runsWithoutFailure: records.filter((record) => record.failureMode === 'none').length,
      verifiedRuns: reviewed.length,
      revisedRuns: reviewed.filter((record) => record.phases.some((phase) => phase.phase.startsWith('revise'))).length,
    },
  };
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function inspect(
  strategyId: string,
  runs: readonly RunRecord[],
): { receipts: Receipt[]; deadNodes: string[] } {
  const n = runs.length;
  const receipts: Receipt[] = [];
  const dead = new Set<string>();
  const all = (count: number) => n > 0 && count === n;

  const phaseErrored = (name: string) =>
    runs.filter((run) => run.phases.some((phase) => phase.phase === name && !!phase.error)).length;

  switch (strategyId) {
    case 'plan-execute':
    case 'plan-execute-verify': {
      const planFailed = phaseErrored('plan');
      receipts.push({
        label: 'the planning phase ended in an error',
        count: planFailed,
        of: n,
        unit: 'runs',
      });
      if (all(planFailed)) dead.add('plan');

      if (strategyId === 'plan-execute-verify') {
        const revised = runs.filter((run) =>
          run.phases.some((phase) => phase.phase.startsWith('revise')),
        ).length;
        const imperfect = runs.filter((run) => run.score < 1).length;
        if (revised === 0 && imperfect > 0) {
          receipts.push({
            label: `the verifier sent nothing back for revision, including the ${imperfect} that scored below 1.0`,
            count: n,
            of: n,
            unit: 'runs',
          });
          dead.add('verify');
        }
      }
      break;
    }

    case 'orchestrator-workers': {
      const decomposeFailed = phaseErrored('decompose');
      receipts.push({
        label: 'the decomposition phase ended in an error',
        count: decomposeFailed,
        of: n,
        unit: 'runs',
      });
      if (all(decomposeFailed)) dead.add('orchestrate');

      const singleWorker = runs.filter(
        (run) => run.phases.filter((phase) => phase.phase.startsWith('worker')).length <= 1,
      ).length;
      receipts.push({
        label: 'the task went to a single worker',
        count: singleWorker,
        of: n,
        unit: 'runs',
      });
      if (all(singleWorker)) {
        dead.add('w1');
        dead.add('w3');
      }
      break;
    }

    case 'propose-select': {
      const proposers = runs.flatMap((run) =>
        run.phases.filter((phase) => /^propose-\d+$/.test(phase.phase)),
      );
      const idle = proposers.filter((phase) => phase.toolCalls === 0);
      receipts.push({
        label: 'made without a single tool call',
        count: idle.length,
        of: proposers.length,
        unit: 'proposals',
      });
      for (const id of ['1', '2', '3']) {
        const these = proposers.filter((phase) => phase.phase === `propose-${id}`);
        if (these.length > 0 && these.every((phase) => phase.toolCalls === 0)) dead.add(`p${id}`);
      }

      const selectFailed = phaseErrored('select');
      receipts.push({
        label: 'the selection phase ended in an error',
        count: selectFailed,
        of: n,
        unit: 'runs',
      });
      if (all(selectFailed)) dead.add('select');
      break;
    }

    default: {
      const failed = runs.filter((run) => run.phases.some((phase) => !!phase.error)).length;
      receipts.push({ label: 'a phase ended in an error', count: failed, of: n, unit: 'runs' });
    }
  }

  return { receipts, deadNodes: [...dead] };
}

/**
 * What one legacy run's own records show went wrong, in sentences. For runs
 * recorded before integrity checks existed, this is the only fidelity signal
 * there is: errored phases, guard denials, idle proposers, a fan-out that
 * never happened.
 */
export function runReceipts(record: RunRecord): string[] {
  const out: string[] = [];
  for (const phase of record.phases) {
    if (phase.error) out.push(`${phase.label} ended in an error: ${normalizeError(phase.error).toLowerCase()}.`);
  }
  if (record.deniedToolCalls > 0) {
    out.push(
      `The sandbox guard denied ${record.deniedToolCalls} tool call${record.deniedToolCalls === 1 ? '' : 's'} the harness itself needed.`,
    );
  }
  if (record.strategyId === 'propose-select') {
    const idle = record.phases.filter((phase) => /^propose-\d+$/.test(phase.phase) && phase.toolCalls === 0);
    if (idle.length > 0) {
      out.push(`${joinList(idle.map((phase) => phase.label))} made no tool call.`);
    }
  }
  if (record.strategyId === 'orchestrator-workers') {
    const workers = record.phases.filter((phase) => phase.phase.startsWith('worker'));
    if (workers.length <= 1) out.push('The task went to a single worker: the fan-out never happened.');
  }
  if (record.strategyId === 'plan-execute-verify' && record.score < 1) {
    const revised = record.phases.some((phase) => phase.phase.startsWith('revise'));
    if (!revised) out.push('The run scored below 1.0, and the verifier sent nothing back for revision.');
  }
  return out;
}

// ---------------------------------------------------------------------------
// What only the traces show
// ---------------------------------------------------------------------------

/**
 * The counts that cannot be read off a run record, because the record keeps
 * a phase's cost and error but not what the phase was shown: the plan the
 * executor received, the tools each session started with, the servers it
 * connected to. They come from the run set's traces, committed under
 * `results/<runSetId>/traces/`; `ACT_ONE` states them, and
 * `test/postmortem.test.ts` re-derives them from those traces on every run.
 */
export interface TraceFacts {
  /** Executor calls that were handed a plan, and the ones whose plan was empty. */
  plans: number;
  emptyPlans: number;
  /** What the non-empty plans said, in full. */
  otherPlans: string[];
  /** Sessions started, and those that listed a claude.ai connector among their tool servers. */
  sessions: number;
  sessionsWithConnectors: number;
  /** Sessions of a second or later proposer, and those that were shown none of the task's tools. */
  laterProposers: number;
  laterProposersWithoutTools: number;
  /** Calls to the SDK's structured-output tool the sandbox guard refused. */
  structuredOutputDenials: number;
}

export function deriveTraceFacts(traces: readonly (readonly TraceEvent[])[]): TraceFacts {
  const facts: TraceFacts = {
    plans: 0,
    emptyPlans: 0,
    otherPlans: [],
    sessions: 0,
    sessionsWithConnectors: 0,
    laterProposers: 0,
    laterProposersWithoutTools: 0,
    structuredOutputDenials: 0,
  };

  for (const trace of traces) {
    for (const event of trace) {
      if (event.kind === 'tool_denied' && event.toolName === 'StructuredOutput') {
        facts.structuredOutputDenials += 1;
      }
      if (event.kind === 'user' && event.phase === 'execute') {
        const plan = /<plan>([\s\S]*?)<\/plan>/.exec(event.text ?? '')?.[1];
        if (plan !== undefined) {
          facts.plans += 1;
          if (plan.trim() === '') facts.emptyPlans += 1;
          else facts.otherPlans.push(plan.trim());
        }
      }
      if (event.kind !== 'system_init') continue;

      facts.sessions += 1;
      const servers = event.meta?.mcpServers;
      if (Array.isArray(servers) && servers.some((server) => String(server?.name).startsWith('claude.ai'))) {
        facts.sessionsWithConnectors += 1;
      }
      const proposer = /^propose-(\d+)$/.exec(event.phase);
      if (proposer && Number(proposer[1]) >= 2) {
        facts.laterProposers += 1;
        const tools = Array.isArray(event.meta?.tools) ? (event.meta.tools as string[]) : [];
        if (!tools.some((tool) => tool.startsWith('mcp__') && !tool.startsWith('mcp__claude_ai'))) {
          facts.laterProposersWithoutTools += 1;
        }
      }
    }
  }
  return facts;
}

/**
 * The first run set, in numbers, as the post-mortem page states them. Fixed
 * on purpose: the set is closed evidence, and a sentence that says "72 of 72"
 * should not move because a page's code changed. `test/postmortem.test.ts`
 * re-derives every one from the committed run records and traces, so a
 * number here that the evidence does not support fails the build.
 */
export const ACT_ONE = {
  runs: 90,
  phases: 252,
  /** Plan, decompose and select phases that ended in an error. */
  structuredPhases: 72,
  structuredFailed: 72,
  /** Executor calls handed an empty plan, of those handed one. */
  emptyPlans: 35,
  plans: 36,
  /** Orchestrator runs that fanned out to more than one worker. */
  fannedOut: 0,
  orchestratorRuns: 18,
  /** Proposer sessions after the first, and those shown none of the task's tools. */
  laterProposers: 36,
  laterProposersWithoutTools: 36,
  /** Verifier runs that sent work back for revision. */
  revisions: 0,
  verifiedRuns: 18,
  deniedToolCalls: 70,
  sessions: 252,
  sessionsWithConnectors: 70,
  wastedPhases: 108,
  /** Dollars, to the cent. */
  wastedUsd: 2.43,
  totalUsd: 9.11,
  /** Tests passing at the commit the run set records. */
  tests: 437,
} as const;
