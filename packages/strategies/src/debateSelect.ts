import { SCHEMA_MIN_TURNS, readStructured } from '@arena/core';
import type { QueryOutcome, RunContext, Strategy, StrategyOutcome } from '@arena/core';
import {
  ACTING_INSTRUCTIONS,
  FINAL_ANSWER_INSTRUCTION,
  createPhaseRunner,
  hasMutatingTools,
  joinSections,
  tagged,
  taskBlock,
  type LabeledSpec,
  type StrategyDeps,
} from './helpers';

const DESCRIPTION =
  'Three proposers investigate the task in parallel with read-only tools and each returns a ' +
  'course of action; a selector picks the strongest and merges in what the others got right; a ' +
  'final call applies it with the full toolset. Nothing is changed until one approach has been ' +
  'chosen, which is the point — it spends three investigations to avoid committing to the first ' +
  'idea. On a task with nothing to mutate the selector\'s merged answer is the answer.';

const PROPOSER_COUNT = 3;

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

export interface Selection {
  winnerIndex: number;
  rationale: string;
  mergedAnswer: string;
}

export function proposePrompt(ctx: RunContext, index: number): string {
  return joinSections(
    taskBlock(ctx),
    `You are proposer ${index} of ${PROPOSER_COUNT}, working independently and at the same time ` +
      'as the others. You hold the read-only tools: investigate as much as you need, but change ' +
      'nothing — another agent will act on whichever proposal wins.',
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
 * The selector's choice, clamped into range.
 *
 * `winnerIndex` is presentation-level: it refers to labels the selector was
 * shown, so an out-of-range or non-numeric answer is a formatting slip, not a
 * reason to discard three investigations.
 */
export function readSelection(outcome: QueryOutcome, proposalCount: number): Selection {
  const parsed = readStructured<{
    winnerIndex?: unknown;
    rationale?: unknown;
    mergedAnswer?: unknown;
  }>(outcome);

  const raw = typeof parsed?.winnerIndex === 'number' ? Math.round(parsed.winnerIndex) : 1;
  const winnerIndex = Number.isFinite(raw) ? Math.min(Math.max(raw, 1), proposalCount) : 1;

  return {
    winnerIndex,
    rationale: typeof parsed?.rationale === 'string' ? parsed.rationale.trim() : '',
    mergedAnswer: typeof parsed?.mergedAnswer === 'string' ? parsed.mergedAnswer.trim() : '',
  };
}

export function createDebateSelectStrategy(deps: Partial<StrategyDeps> = {}): Strategy {
  return {
    id: 'debate-select',
    label: 'Parallel proposals, select, execute',
    description: DESCRIPTION,

    async run(ctx: RunContext): Promise<StrategyOutcome> {
      const runner = createPhaseRunner(ctx, deps);
      if (!runner.canContinue()) return runner.finish();

      const specs: LabeledSpec[] = Array.from({ length: PROPOSER_COUNT }, (_, i) => {
        const index = i + 1;
        return {
          phase: `propose-${index}`,
          label: `Proposal ${index}`,
          prompt: proposePrompt(ctx, index),
          // Read-only: three agents exploring the same world at once must not
          // each act on it, or they would be undoing one another's work.
          allowedTools: [...ctx.env.readOnlyTools],
          depth: 1,
          agentLabel: `proposer-${index}`,
        };
      });

      const proposals = await runner.runAll(specs);
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

      const selection = readSelection(
        await runner.run({
          phase: 'select',
          label: 'Select',
          prompt: selectPrompt(ctx, rendered),
          allowedTools: [],
          outputSchema: SELECT_SCHEMA,
          maxTurns: SCHEMA_MIN_TURNS,
        }),
        PROPOSER_COUNT,
      );

      const winner = proposals[selection.winnerIndex - 1]?.text.trim() ?? '';
      const plan = joinSections(
        tagged('winning_proposal', winner),
        selection.mergedAnswer === '' ? '' : tagged('merged_answer', selection.mergedAnswer),
      );

      // Nothing to apply on a read-only task: the merged answer is the answer,
      // and an execution phase would only add cost.
      if (!hasMutatingTools(ctx)) {
        return runner.finish({
          finalText: selection.mergedAnswer !== '' ? selection.mergedAnswer : winner,
          subagentCount,
        });
      }

      if (!runner.canContinue()) return runner.finish({ subagentCount });

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

export const debateSelectStrategy = createDebateSelectStrategy();
