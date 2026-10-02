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
  fail,
  haltedBy,
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
  FINAL_ANSWER_INSTRUCTION,
  createPhaseRunner,
  hasMutatingTools,
  interrupted,
  joinSections,
  tagged,
  taskBlock,
  type LabeledSpec,
  type StrategyDeps,
} from './helpers';

const DESCRIPTION =
  'Three proposers investigate the task in parallel with read-only tools, each starting from a ' +
  'different angle — the rules, the current state, the outcome the user needs — and each returns ' +
  'a course of action; a selector picks the strongest and merges in what the others got right; a ' +
  'final call applies it with the full toolset. Nothing is changed until one approach has been ' +
  'chosen, which is the point: it spends three investigations to avoid committing to the first ' +
  'idea. The proposers never see one another, so this is selection among independent proposals, ' +
  'not a debate. On a task with nothing to mutate the selector\'s merged answer is the answer.';

/**
 * Where each proposer starts.
 *
 * The SDK exposes no sampling temperature, so three proposers given the same
 * prompt differ only by sampling noise and tend to propose the same thing.
 * A lens changes where the investigation begins, not what it must cover, so
 * the selector chooses between genuinely different routes to an answer.
 */
export const PROPOSER_LENSES: readonly { id: string; instruction: string }[] = [
  {
    id: 'policy-first',
    instruction:
      'Your lens is policy first: begin from the rules. Work out which rules — the domain policy ' +
      'and the conditions in the task itself — this request touches, then look up exactly the ' +
      'facts those rules depend on.',
  },
  {
    id: 'state-first',
    instruction:
      'Your lens is state first: begin from the facts. Before forming any view, look up what the ' +
      'request involves as it actually stands, then work out what the rules allow given what you ' +
      'found.',
  },
  {
    id: 'outcome-first',
    instruction:
      'Your lens is outcome first: begin from what the person asking needs. Work out the best ' +
      'result the rules permit for them, then confirm with the tools that it can be reached.',
  },
];

const PROPOSER_COUNT = PROPOSER_LENSES.length;

export const SELECT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    winnerIndex: {
      type: 'integer',
      minimum: 1,
      maximum: PROPOSER_COUNT,
      description: 'Number of the strongest proposal, as labelled above.',
    },
    rationale: {
      type: 'string',
      description: 'Two or three sentences on what decided it.',
    },
    mergedAnswer: {
      type: 'string',
      description:
        'The answer to the task: the winning proposal, corrected with anything the others got right.',
    },
  },
  required: ['winnerIndex', 'rationale', 'mergedAnswer'],
  additionalProperties: false,
};

/** How the selection was read: through the schema, out of prose, or not at all. */
export type SelectionSource = 'schema' | 'prose' | 'none';

export interface Selection {
  winnerIndex: number;
  rationale: string;
  mergedAnswer: string;
  source: SelectionSource;
  /** What was used instead of a valid choice from the schema reply, when something was. */
  fallback?: string;
}

export function proposePrompt(ctx: RunContext, index: number): string {
  const lens = PROPOSER_LENSES[index - 1];
  return joinSections(
    taskBlock(ctx),
    `You are proposer ${index} of ${PROPOSER_COUNT}, working independently and at the same time ` +
      'as the others. You hold the read-only tools: investigate as much as you need, but change ' +
      'nothing — another agent will act on whichever proposal wins.',
    lens
      ? `${lens.instruction} Each proposer starts from a different angle; yours is where you ` +
          'begin, not where you stop, so still cover everything the task needs.'
      : '',
    'Propose one course of action: what should be done, in what order, and why. Ground it in ' +
      'what you actually found, name the checks that led you there, and say plainly if the task ' +
      'should not be carried out as asked.',
  );
}

export function selectPrompt(ctx: RunContext, proposals: string): string {
  return joinSections(
    taskBlock(ctx),
    tagged('proposals', proposals),
    'You are the selector. You have no tools here, so judge the proposals on what they report.',
    `Compare them on correctness first, then on whether they respect the rules, then on how ` +
      'little they do beyond what was asked. Pick the strongest by its number, say briefly what ' +
      'decided it, and write the merged answer: the winning proposal as it should stand, ' +
      'corrected with anything the other proposals got right.',
  );
}

export function executeSelectionPrompt(ctx: RunContext, selected: string): string {
  return joinSections(
    taskBlock(ctx),
    tagged('selected_plan', selected),
    'The investigation above was done with read-only tools, so nothing has been changed yet. ' +
      'Carry out the selected plan, confirming anything it assumes before you rely on it.',
    ACTING_INSTRUCTIONS,
    FINAL_ANSWER_INSTRUCTION,
  );
}

/**
 * The selector's choice.
 *
 * A valid choice is a whole number in range, read from the schema reply.
 * Anything else — a choice found only in prose, a number out of range, no
 * choice at all — still lets the run go on, with the nearest usable proposal
 * (or the first), but the selection says it is a fallback.
 */
export function readSelection(
  outcome: Pick<QueryOutcome, 'structured' | 'text'>,
  proposalCount: number,
): Selection {
  const fromSchema = selectionFrom(outcome.structured);
  const parsed = fromSchema ?? selectionFrom(parseLooseJson(outcome.text));
  const source: SelectionSource = fromSchema ? 'schema' : parsed ? 'prose' : 'none';

  const raw = parsed?.winnerIndex;
  const valid = typeof raw === 'number' && Number.isInteger(raw) && raw >= 1 && raw <= proposalCount;
  const winnerIndex = valid
    ? raw
    : typeof raw === 'number' && Number.isFinite(raw)
      ? Math.min(Math.max(Math.round(raw), 1), proposalCount)
      : 1;

  const fallback =
    source === 'none'
      ? 'the selection could not be read; proposal 1 was used by default'
      : !valid
        ? `the selector's choice (${JSON.stringify(raw ?? null)}) was not a proposal number; proposal ${winnerIndex} was used`
        : source === 'prose'
          ? 'the selection came back as JSON in prose, not through the schema'
          : undefined;

  return {
    winnerIndex,
    rationale: typeof parsed?.rationale === 'string' ? parsed.rationale.trim() : '',
    mergedAnswer: typeof parsed?.mergedAnswer === 'string' ? parsed.mergedAnswer.trim() : '',
    source,
    ...(fallback !== undefined ? { fallback } : {}),
  };
}

function selectionFrom(
  value: unknown,
): { winnerIndex?: unknown; rationale?: unknown; mergedAnswer?: unknown } | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
}

/**
 * All three proposers ran. They start together on equal shares of the
 * budget, so one skipped while another ran was starved, not stopped.
 */
export function proposalsCheck(input: FidelityInput): IntegrityCheck {
  const id = 'propose-select.proposals';
  const proposals = input.outcome.phases.filter((record) => record.phase.startsWith('propose-'));
  const halted = haltedBy(input);
  if (proposals.length === 0 && halted) {
    return pass(id, `the run was stopped (${halted}) before the proposers started`);
  }

  const failures: string[] = [];
  if (proposals.length !== PROPOSER_COUNT) {
    failures.push(`${proposals.length} of ${PROPOSER_COUNT} proposers ran`);
  }
  const skipped = proposals.filter((record) => record.subtype === 'skipped');
  if (skipped.length > 0 && skipped.length < proposals.length) {
    failures.push(`${skipped.map((record) => record.phase).join(', ')} never started while the others ran`);
  }
  const lenses = new Set(proposals.map((record) => metaString(record, 'lens')));
  if (lenses.size !== proposals.length) failures.push('the proposers did not each have their own lens');
  // Every proposer skipped is the run's budget giving out, not a starved one.
  const verified =
    skipped.length > 0 && skipped.length === proposals.length
      ? 'no proposer started: the run had too little budget left to start any'
      : `${proposals.length} proposers ran in parallel, one per lens`;
  return checkFrom(id, failures, verified);
}

/** The selector chose a proposal by a valid number, read from the schema reply. */
export function selectionCheck(input: FidelityInput): IntegrityCheck {
  const id = 'propose-select.selection';
  const select = phaseNamed(input, 'select');
  const excused = unjudged(id, input, select, 'the selection');
  if (excused || !select) return excused ?? fail(id, 'the selection never ran');

  const winner = metaNumber(select, 'winnerIndex');
  if (metaString(select, 'source') === 'schema' && select.degraded === undefined && winner !== undefined) {
    return pass(id, `proposal ${winner} chosen`);
  }
  return fail(id, select.degraded ?? 'the selection was not read from a schema reply');
}

export function proposeSelectFidelityChecks(input: FidelityInput): IntegrityCheck[] {
  return [
    proposalsCheck(input),
    selectionCheck(input),
    toolSurfaceCheck('propose-select.tools', input, [
      { role: 'proposer', matches: phasePrefix('propose-'), tools: input.env.readOnlyTools },
      { role: 'selector', matches: phase('select'), tools: [] },
      { role: 'executor', matches: phase('execute'), tools: input.env.allowedTools },
    ]),
  ];
}

export function createProposeSelectStrategy(deps: Partial<StrategyDeps> = {}): Strategy {
  return {
    id: 'propose-select',
    label: 'Parallel proposals, select, execute',
    description: DESCRIPTION,
    fidelityChecks: proposeSelectFidelityChecks,

    async run(ctx: RunContext): Promise<StrategyOutcome> {
      const runner = createPhaseRunner(ctx, deps);
      if (!runner.canContinue()) return runner.finish();

      const specs: LabeledSpec[] = PROPOSER_LENSES.map((lens, i) => {
        const index = i + 1;
        return {
          phase: `propose-${index}`,
          label: `Proposal ${index} (${lens.id})`,
          prompt: proposePrompt(ctx, index),
          // Read-only: three agents exploring the same world at once must not
          // each act on it, or they would be undoing one another's work.
          allowedTools: [...ctx.env.readOnlyTools],
          depth: 1,
          agentLabel: `proposer-${index}`,
        };
      });

      const proposals = await runner.runAll(specs);
      proposals.forEach((proposal, i) => runner.annotate(proposal, { meta: { lens: PROPOSER_LENSES[i]?.id } }));
      const subagentCount = PROPOSER_COUNT;

      if (!runner.canContinue()) return runner.finish({ subagentCount });

      const rendered = proposals
        .map((proposal, i) => {
          const text = proposal.text.trim();
          return tagged(
            `proposal_${i + 1}`,
            text === '' ? '(this proposer returned nothing)' : text,
          );
        })
        .join('\n\n');

      const select = await runner.run({
        phase: 'select',
        label: 'Select',
        prompt: selectPrompt(ctx, rendered),
        allowedTools: [],
        outputSchema: SELECT_SCHEMA,
        maxTurns: SCHEMA_MIN_TURNS,
      });
      const selection = readSelection(select, PROPOSER_COUNT);
      const winner = proposals[selection.winnerIndex - 1]?.text.trim() ?? '';
      const mutating = hasMutatingTools(ctx);

      // On a task with nothing to mutate the merged answer is the answer, so
      // a selector that wrote none has left the winning proposal standing in.
      const fallbacks = [
        selection.fallback,
        !mutating && selection.source !== 'none' && selection.mergedAnswer === ''
          ? 'the selector wrote no merged answer; the winning proposal stands as the answer'
          : undefined,
      ].filter((reason): reason is string => reason !== undefined);
      runner.annotate(select, {
        meta: {
          winnerIndex: selection.winnerIndex,
          source: selection.source,
          mergedAnswer: selection.mergedAnswer !== '',
        },
        ...(fallbacks.length > 0 && !interrupted(select) ? { degraded: fallbacks.join('; ') } : {}),
      });

      if (!mutating) {
        return runner.finish({
          finalText: selection.mergedAnswer !== '' ? selection.mergedAnswer : winner,
          subagentCount,
        });
      }

      if (!runner.canContinue()) return runner.finish({ subagentCount });

      const plan = joinSections(
        tagged('winning_proposal', winner),
        selection.mergedAnswer === '' ? '' : tagged('merged_answer', selection.mergedAnswer),
      );
      const execute = await runner.run({
        phase: 'execute',
        label: 'Execute',
        prompt: executeSelectionPrompt(ctx, plan),
        answers: true,
      });

      return runner.finish({ finalText: execute.text, subagentCount });
    },
  };
}

export const proposeSelectStrategy = createProposeSelectStrategy();
