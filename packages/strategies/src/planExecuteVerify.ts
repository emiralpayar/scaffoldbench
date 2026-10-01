import { readStructured } from '@arena/core';
import type {
  FidelityInput,
  IntegrityCheck,
  QueryOutcome,
  RunContext,
  Strategy,
  StrategyOutcome,
} from '@arena/core';
import { phase, phasePrefix, toolSurfaceCheck } from './fidelity';
import {
  ACTING_INSTRUCTIONS,
  FINAL_ANSWER_INSTRUCTION,
  createPhaseRunner,
  joinSections,
  numbered,
  stringList,
  tagged,
  taskBlock,
  type StrategyDeps,
} from './helpers';
import { executePlanPrompt, planCheck, runPlanPhase } from './planExecute';

const DESCRIPTION =
  'Plan, execute, then hand the work to a verifier that holds only the read-only tools and has ' +
  'to check the real state rather than the executor\'s account of it. Anything it rejects goes ' +
  'back for revision, at most twice. It is the most expensive way to buy a second opinion, and ' +
  'the measurement is whether catching the executor\'s mistakes is worth what the review costs.';

const MAX_REVISIONS = 2;
const MAX_ISSUES = 8;

export type Severity = 'none' | 'minor' | 'blocking';

export interface Verdict {
  approved: boolean;
  issues: string[];
  severity: Severity;
}

export const VERIFY_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    approved: {
      type: 'boolean',
      description: 'True only when nothing remains to be fixed.',
    },
    issues: {
      type: 'array',
      description: 'One entry per defect: what is wrong, and what would put it right.',
      items: { type: 'string' },
    },
    severity: {
      type: 'string',
      enum: ['none', 'minor', 'blocking'],
      description: 'Worst severity among the issues.',
    },
  },
  required: ['approved', 'issues', 'severity'],
  additionalProperties: false,
};

export function verifyPrompt(ctx: RunContext, answer: string): string {
  return joinSections(
    taskBlock(ctx),
    tagged('executor_report', answer === '' ? '(the executor returned no report)' : answer),
    'You are the verifier. You hold the read-only tools: use them to check what the state ' +
      'actually is instead of trusting the report above.',
    'Decide whether the task has been completed correctly and within the rules. Report one issue ' +
      'per defect, naming what is wrong and what would put it right. Approve only when nothing ' +
      'remains to be fixed; do not withhold approval over wording or style.',
  );
}

export function revisePrompt(ctx: RunContext, answer: string, issues: string[]): string {
  return joinSections(
    taskBlock(ctx),
    tagged('your_previous_attempt', answer === '' ? '(nothing was reported)' : answer),
    tagged('issues_found', numbered(issues)),
    'A verifier checked the real state against the task and reported the issues above. Fix them, ' +
      'changing only what the issues call for. If an issue is mistaken, leave the work alone and ' +
      'say why.',
    ACTING_INSTRUCTIONS,
    FINAL_ANSWER_INSTRUCTION,
  );
}

/**
 * The verifier's verdict, defaulting to approval.
 *
 * A verdict that cannot be read is not evidence of a defect, and revising
 * against an empty issue list would spend a full tool-enabled phase on
 * speculation — so an unreadable reply ends the loop rather than extending it.
 */
export function readVerdict(outcome: QueryOutcome): Verdict {
  const parsed = readStructured<{ approved?: unknown; issues?: unknown; severity?: unknown }>(
    outcome,
  );
  if (parsed === undefined) return { approved: true, issues: [], severity: 'none' };

  const approved = typeof parsed.approved === 'boolean' ? parsed.approved : true;
  const severity =
    parsed.severity === 'minor' || parsed.severity === 'blocking' || parsed.severity === 'none'
      ? parsed.severity
      : 'none';
  const issues = stringList(parsed.issues, MAX_ISSUES);

  // A rejection with no itemised issue still carries its reasoning in prose.
  if (!approved && issues.length === 0) {
    const prose = outcome.text.trim();
    return {
      approved,
      issues: prose === '' ? ['The verifier rejected the work without saying why.'] : [prose],
      severity,
    };
  }

  return { approved, issues, severity };
}

export function planExecuteVerifyFidelityChecks(input: FidelityInput): IntegrityCheck[] {
  return [
    planCheck('plan-execute-verify.plan', input),
    toolSurfaceCheck('plan-execute-verify.tools', input, [
      { role: 'planner', matches: phase('plan'), tools: [] },
      { role: 'executor', matches: phase('execute'), tools: input.env.allowedTools },
      { role: 'verifier', matches: phase('verify'), tools: input.env.readOnlyTools },
      { role: 'reviser', matches: phasePrefix('revise-'), tools: input.env.allowedTools },
    ]),
  ];
}

export function createPlanExecuteVerifyStrategy(deps: Partial<StrategyDeps> = {}): Strategy {
  return {
    id: 'plan-execute-verify',
    label: 'Plan, execute, verify, revise',
    description: DESCRIPTION,
    fidelityChecks: planExecuteVerifyFidelityChecks,

    async run(ctx: RunContext): Promise<StrategyOutcome> {
      const runner = createPhaseRunner(ctx, deps);
      if (!runner.canContinue()) return runner.finish();

      const plan = await runPlanPhase(runner, ctx);
      if (!runner.canContinue()) return runner.finish();

      const execute = await runner.run({
        phase: 'execute',
        label: 'Execute',
        prompt: executePlanPrompt(ctx, plan),
        answers: true,
      });

      // The answer is whatever the last acting phase said, never the verifier's
      // critique of it.
      let answer = execute.text;

      for (let round = 0; round <= MAX_REVISIONS; round++) {
        if (!runner.canContinue()) break;

        const verdict = readVerdict(
          await runner.run({
            phase: 'verify',
            label: round === 0 ? 'Verify' : `Verify after revision ${round}`,
            prompt: verifyPrompt(ctx, answer.trim()),
            allowedTools: [...ctx.env.readOnlyTools],
          }),
        );

        if (verdict.approved || round === MAX_REVISIONS) break;
        if (!runner.canContinue()) break;

        const revision = await runner.run({
          phase: `revise-${round + 1}`,
          label: `Revise (round ${round + 1})`,
          prompt: revisePrompt(ctx, answer.trim(), verdict.issues),
          answers: true,
        });
        if (revision.text.trim() !== '') answer = revision.text;
      }

      return runner.finish({ finalText: answer });
    },
  };
}

export const planExecuteVerifyStrategy = createPlanExecuteVerifyStrategy();
