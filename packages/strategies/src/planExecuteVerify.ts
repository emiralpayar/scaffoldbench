import { parseLooseJson } from '@arena/core';
import type {
  FidelityInput,
  IntegrityCheck,
  QueryOutcome,
  RunContext,
  Strategy,
  StrategyOutcome,
} from '@arena/core';
import { checkFrom, cutShort, metaString, phase, phasePrefix, toolSurfaceCheck } from './fidelity';
import {
  ACTING_INSTRUCTIONS,
  FINAL_ANSWER_INSTRUCTION,
  createPhaseRunner,
  interrupted,
  joinSections,
  numbered,
  stringList,
  tagged,
  taskBlock,
  type PhaseRunner,
  type StrategyDeps,
} from './helpers';
import { executePlanPrompt, planCheck, runPlanPhase } from './planExecute';

const DESCRIPTION =
  'Plan, execute, then hand the work to a verifier that holds only the read-only tools and has ' +
  'to check the real state rather than the executor\'s account of it. A rejection with a ' +
  'blocking issue goes back for revision, at most twice; one with only minor issues ends the ' +
  'review, since a full revision over a detail risks more than it fixes. It is the most ' +
  'expensive way to buy a second opinion, and the measurement is whether catching the ' +
  'executor\'s mistakes is worth what the review costs.';

/** Revisions after the first execution. The last revision is final: nothing reviews it. */
export const MAX_REVISIONS = 2;
const MAX_ISSUES = 8;

export type Severity = 'none' | 'minor' | 'blocking';

/** What the loop does with a verdict. */
export type VerdictDecision = 'approve' | 'accept-minor' | 'revise';

export interface Verdict {
  approved: boolean;
  issues: string[];
  severity: Severity;
  decision: VerdictDecision;
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
      description:
        'Worst severity among the issues: "blocking" when the outcome is wrong or a rule was ' +
        'broken, "minor" when the outcome is right but something small remains, "none" when ' +
        'there is nothing to fix.',
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
      'per defect, naming what is wrong and what would put it right, and rate the worst of them: ' +
      'blocking when the outcome is wrong or a rule was broken, minor when the outcome is right ' +
      'but something small remains. Approve only when nothing remains to be fixed; do not ' +
      'withhold approval over wording or style.',
  );
}

/** The verifier asked again, with what its first attempt left behind. */
export function verifyRetryPrompt(ctx: RunContext, answer: string, notes: string): string {
  return joinSections(
    verifyPrompt(ctx, answer),
    tagged('your_earlier_notes', notes === '' ? '(none)' : notes),
    'You checked this work once already, but your verdict could not be read. Your notes from ' +
      'that attempt are above: check whatever you still need, then give the verdict.',
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
 * The verifier's verdict from its schema reply, or `undefined` when there is
 * none to read. A verdict is never assumed: a reply that cannot be read is
 * asked for again, and if it still cannot be read the loop ends on record as
 * having no verdict.
 */
export function readVerdict(outcome: Pick<QueryOutcome, 'structured' | 'text'>): Verdict | undefined {
  return verdictFrom(outcome.structured, outcome.text);
}

function verdictFrom(value: unknown, prose: string): Verdict | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const parsed = value as { approved?: unknown; issues?: unknown; severity?: unknown };
  if (typeof parsed.approved !== 'boolean') return undefined;

  const approved = parsed.approved;
  const severity: Severity =
    parsed.severity === 'minor' || parsed.severity === 'blocking' || parsed.severity === 'none'
      ? parsed.severity
      : 'none';
  let issues = stringList(parsed.issues, MAX_ISSUES);

  // A rejection with no itemised issue still carries its reasoning in prose.
  if (!approved && issues.length === 0) {
    const text = prose.trim();
    issues = [text === '' ? 'The verifier rejected the work without saying why.' : text];
  }

  return { approved, issues, severity, decision: decide(approved, severity) };
}

/**
 * Approval ends the loop; so does a rejection whose worst issue is minor,
 * because a full tool-enabled revision on a world that is already right
 * risks more than a detail is worth. Any other rejection — blocking, or one
 * that names no severity — is revised.
 */
function decide(approved: boolean, severity: Severity): VerdictDecision {
  if (approved) return 'approve';
  return severity === 'minor' ? 'accept-minor' : 'revise';
}

/**
 * One review round: verify, and if the verdict cannot be read, ask once more.
 * Returns the verdict, or `undefined` when there is still none — recorded on
 * the phase as degraded unless the run's own limits are why.
 */
async function verifyRound(
  runner: PhaseRunner,
  ctx: RunContext,
  round: number,
  answer: string,
): Promise<Verdict | undefined> {
  const name = `verify-${round}`;
  const label = round === 1 ? 'Verify' : `Verify revision ${round - 1}`;
  const spec = {
    allowedTools: [...ctx.env.readOnlyTools],
    outputSchema: VERIFY_SCHEMA,
  };

  const first = await runner.run({ ...spec, phase: name, label, prompt: verifyPrompt(ctx, answer) });
  const verdict = readVerdict(first);
  if (verdict) {
    runner.annotate(first, { meta: verdictMeta(verdict, 'schema') });
    return verdict;
  }
  if (interrupted(first)) return undefined;
  if (!runner.canContinue()) {
    runner.annotate(first, {
      meta: { decision: 'unreadable' },
      degraded: 'no verdict could be read, and the run had stopped before it could ask again',
    });
    return undefined;
  }

  const retryName = `${name}-retry`;
  runner.annotate(first, { retriedBy: retryName, meta: { decision: 'unreadable' } });
  const retry = await runner.run({
    ...spec,
    phase: retryName,
    label: `${label} (asked again)`,
    prompt: verifyRetryPrompt(ctx, answer, first.text.trim()),
  });
  const second = readVerdict(retry);
  if (second) {
    runner.annotate(retry, { meta: verdictMeta(second, 'schema') });
    return second;
  }
  if (interrupted(retry)) return undefined;

  // Still nothing through the schema. JSON in either reply's prose is the
  // last thing to try; without it the loop has no verdict to act on.
  const fromProse =
    verdictFrom(parseLooseJson(retry.text), retry.text) ?? verdictFrom(parseLooseJson(first.text), first.text);
  runner.annotate(retry, {
    meta: fromProse ? verdictMeta(fromProse, 'prose') : { decision: 'unreadable' },
    degraded: fromProse
      ? 'the verdict was read from prose after the schema reply failed twice'
      : 'no verdict could be read, even when asked again; the review ended without one',
  });
  return fromProse;
}

function verdictMeta(verdict: Verdict, source: 'schema' | 'prose'): Record<string, unknown> {
  return {
    approved: verdict.approved,
    severity: verdict.severity,
    issues: verdict.issues.length,
    decision: verdict.decision,
    source,
  };
}

/** The phases that hold a round's verdict: the retry when there was one. */
function verdictPhases(input: FidelityInput) {
  return input.outcome.phases.filter(
    (record) => /^verify-\d+(-retry)?$/.test(record.phase) && record.retriedBy === undefined,
  );
}

/** Every review round ended with a verdict read from the schema. */
export function verdictsCheck(input: FidelityInput): IntegrityCheck {
  const failures = verdictPhases(input)
    .filter((record) => !cutShort(record))
    .flatMap((record) =>
      metaString(record, 'source') === 'schema'
        ? []
        : [`${record.phase}: ${record.degraded ?? 'no verdict was read'}`],
    );
  const rounds = verdictPhases(input).length;
  return checkFrom(
    'plan-execute-verify.verdicts',
    failures,
    `${rounds} verdict${rounds === 1 ? '' : 's'}, each read from the schema reply`,
  );
}

/**
 * The loop did what its verdicts said: every verdict that called for a
 * revision got one, unless it was the last round or the run had stopped, and
 * nothing was revised without such a verdict.
 */
export function loopCheck(input: FidelityInput): IntegrityCheck {
  const phases = input.outcome.phases.map((record) => record.phase);
  const failures: string[] = [];
  for (const record of verdictPhases(input)) {
    const round = Number(/^verify-(\d+)/.exec(record.phase)?.[1]);
    const revised = phases.includes(`revise-${round}`);
    const wanted = metaString(record, 'decision') === 'revise';
    if (wanted && !revised && !input.stoppedBy) {
      failures.push(`${record.phase} called for a revision that never ran`);
    }
    if (revised && !wanted) failures.push(`revise-${round} ran without a verdict calling for it`);
  }
  const revisions = phases.filter((name) => name.startsWith('revise-')).length;
  return checkFrom(
    'plan-execute-verify.loop',
    failures,
    `${revisions} revision${revisions === 1 ? '' : 's'}, each called for by a verdict`,
  );
}

export function planExecuteVerifyFidelityChecks(input: FidelityInput): IntegrityCheck[] {
  return [
    planCheck('plan-execute-verify.plan', input),
    verdictsCheck(input),
    loopCheck(input),
    toolSurfaceCheck('plan-execute-verify.tools', input, [
      { role: 'planner', matches: phase('plan'), tools: [] },
      { role: 'executor', matches: phase('execute'), tools: input.env.allowedTools },
      { role: 'verifier', matches: phasePrefix('verify-'), tools: input.env.readOnlyTools },
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
      let answer = execute.text.trim();

      for (let round = 1; round <= MAX_REVISIONS; round++) {
        if (!runner.canContinue()) break;

        const verdict = await verifyRound(runner, ctx, round, answer);
        if (verdict?.decision !== 'revise' || !runner.canContinue()) break;

        const revision = await runner.run({
          phase: `revise-${round}`,
          label: `Revise (round ${round})`,
          prompt: revisePrompt(ctx, answer, verdict.issues),
          answers: true,
        });
        // A revision that says nothing leaves the previous answer standing;
        // on a tool-use task the world it left behind is what is scored.
        if (revision.text.trim() !== '') answer = revision.text.trim();
      }

      return runner.finish({ finalText: answer });
    },
  };
}

export const planExecuteVerifyStrategy = createPlanExecuteVerifyStrategy();
