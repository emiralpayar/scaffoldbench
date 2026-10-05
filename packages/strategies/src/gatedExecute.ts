import { parseLooseJson } from '@scaffoldbench/core';
import type {
  FidelityInput,
  IntegrityCheck,
  PendingToolCall,
  QueryOutcome,
  RunContext,
  Strategy,
  StrategyOutcome,
  ToolCallDecision,
} from '@scaffoldbench/core';
import { checkFrom, cutShort, metaString, phase, phasePrefix, toolSurfaceCheck } from './fidelity';
import { mainPrompt } from './single';
import {
  ACTING_INSTRUCTIONS,
  FINAL_ANSWER_INSTRUCTION,
  createPhaseRunner,
  interrupted,
  joinSections,
  numbered,
  tagged,
  taskBlock,
  mutatingTools,
  type StrategyDeps,
} from './helpers';

const DESCRIPTION =
  'One executor with the full toolset, but every call it makes that would change state is first ' +
  'put to a reviewer: a separate, read-only call that holds the domain policy, checks the current ' +
  'state and allows or denies the action. A denial comes back to the executor as the tool\'s ' +
  'result, with the reason, so it can adapt; reads pass straight through. It is review at the ' +
  'point of action rather than after the fact — it can stop a mistake before it lands instead of ' +
  'trying to undo it — and the measurement is whether that is worth a model call per action. On a ' +
  'task with nothing to change there is nothing to review, and it runs exactly as a single agent.';

/**
 * The most of what is available that the executor may reserve; the rest is
 * left for its reviews.
 *
 * The executor and its reviewers run at the same time — a review happens
 * while the executor waits on it — so they cannot both hold the whole run
 * budget. Reviews are short read-only calls, so half is ample for them;
 * the executor's own cap is correspondingly lower than `single`'s, which
 * is part of what this architecture costs.
 */
export const EXECUTOR_BUDGET_SHARE = 0.5;

/** The most of what is available that one review may reserve, so concurrent reviews cannot starve each other. */
const REVIEW_BUDGET_SHARE = 0.5;

/** Enough of an action's input for the reviewer, short enough to keep its prompt small. */
const MAX_INPUT_CHARS = 2_000;
/** Enough of an earlier review's reason to say why, without repeating it whole. */
const MAX_REASON_CHARS = 300;

export const REVIEW_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    decision: {
      type: 'string',
      enum: ['allow', 'deny'],
      description: '"allow" to let the action run, "deny" to stop it.',
    },
    reason: {
      type: 'string',
      description:
        'Why. For a denial: what is wrong with the action and what would be right, for the agent ' +
        'to act on.',
    },
  },
  required: ['decision', 'reason'],
  additionalProperties: false,
};

/** One review, as later reviewers are told about it. */
export interface ReviewNote {
  tool: string;
  input: unknown;
  allowed: boolean;
  reason: string;
}

/** How a review's decision was read: through the schema, out of prose, or not at all. */
export type DecisionSource = 'schema' | 'prose' | 'none';

export interface ReviewDecision {
  allow: boolean;
  reason: string;
  source: DecisionSource;
}

export function executorPrompt(ctx: RunContext): string {
  return joinSections(
    taskBlock(ctx),
    'Complete this task now. Every call you make that changes state is checked by a reviewer ' +
      'before it runs. If the reviewer denies a call, its reason comes back as that tool\'s ' +
      'result and nothing was changed: read it, adjust, and carry on.',
    ACTING_INSTRUCTIONS,
    FINAL_ANSWER_INSTRUCTION,
  );
}

export function reviewPrompt(
  ctx: RunContext,
  call: Pick<PendingToolCall, 'toolName' | 'toolInput'>,
  earlier: readonly ReviewNote[],
): string {
  return joinSections(
    taskBlock(ctx),
    tagged('proposed_action', `tool: ${bareName(call.toolName)}\ninput: ${inputText(call.toolInput)}`),
    earlier.length === 0
      ? ''
      : tagged(
          'earlier_reviews',
          numbered(
            earlier.map(
              (note) =>
                `${note.allowed ? 'allowed' : 'denied'} ${bareName(note.tool)} ${inputText(note.input)}` +
                (note.allowed ? '' : ` — ${truncate(note.reason, MAX_REASON_CHARS)}`),
            ),
          ),
        ),
    // A call is shown only the tools it may use, so the reviewer never sees
    // the mutating tool it is judging. Told nothing, a reviewer took that
    // tool for one that does not exist and denied every action on that
    // ground (Haiku 4.5 at low effort, airline-easy).
    'You are the action reviewer. An agent working on the task above is about to make the call ' +
      'shown, and it would change state. The tool is the agent\'s: it is not among yours, and ' +
      'it does not need to be, because the agent makes the call and you decide whether it ' +
      'should. You hold the read-only tools and the domain policy: check the current state and ' +
      'the rules this action touches, and decide whether it should run.',
    'Allow it when it is correct, needed for the task and within the rules. Deny it when it is ' +
      'wrong, premature or against a rule, and give a reason the agent can act on: what is wrong, ' +
      'and what would be right. Judge the action itself — you will not see the agent\'s reasoning, ' +
      'and you cannot change anything.',
  );
}

/**
 * The reviewer's decision. Without one there is no review, and an action
 * nobody reviewed does not run: an unreadable decision is a denial.
 */
export function readDecision(outcome: Pick<QueryOutcome, 'structured' | 'text'>): ReviewDecision {
  const fromSchema = decisionFrom(outcome.structured);
  if (fromSchema) return { ...fromSchema, source: 'schema' };
  const fromProse = decisionFrom(parseLooseJson(outcome.text));
  if (fromProse) return { ...fromProse, source: 'prose' };
  return { allow: false, reason: '', source: 'none' };
}

function decisionFrom(value: unknown): { allow: boolean; reason: string } | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { decision, reason } = value as { decision?: unknown; reason?: unknown };
  if (decision !== 'allow' && decision !== 'deny') return undefined;
  return { allow: decision === 'allow', reason: typeof reason === 'string' ? reason.trim() : '' };
}

/**
 * No mutation ran unreviewed: every call to a tool that changes state that
 * reached the world had been allowed by a review. Counted per tool from the
 * journal — the world's own record of what ran — rather than from the
 * trace, so a call that never got as far as its tool is not mistaken for
 * one that slipped past.
 */
export function reviewedCheck(input: FidelityInput): IntegrityCheck {
  const mutating = new Set(mutatingTools(input.env).map(bareName));
  const ran = new Map<string, number>();
  for (const entry of input.env.journal) {
    if (mutating.has(entry.name)) ran.set(entry.name, (ran.get(entry.name) ?? 0) + 1);
  }
  const allowed = new Map<string, number>();
  for (const record of reviewPhases(input)) {
    const tool = metaString(record, 'tool');
    if (tool !== undefined && metaString(record, 'decision') === 'allow') {
      allowed.set(bareName(tool), (allowed.get(bareName(tool)) ?? 0) + 1);
    }
  }

  const failures = [...ran].flatMap(([tool, count]) => {
    const ok = allowed.get(tool) ?? 0;
    return count > ok ? [`${tool} ran ${count} time${count === 1 ? '' : 's'}, ${ok} allowed by a review`] : [];
  });
  const total = [...ran.values()].reduce((sum, count) => sum + count, 0);
  const reviews = reviewPhases(input).length;
  return checkFrom(
    'gated-execute.reviewed',
    failures,
    `${total} state change${total === 1 ? '' : 's'}, each allowed by a review (${reviews} review${reviews === 1 ? '' : 's'} in all)`,
  );
}

/** Every review that ran to its end gave a decision through the schema. */
export function decisionsCheck(input: FidelityInput): IntegrityCheck {
  const failures = reviewPhases(input)
    .filter((record) => !cutShort(record))
    .flatMap((record) =>
      metaString(record, 'source') === 'schema'
        ? []
        : [`${record.phase}: ${record.degraded ?? 'no decision was read'}`],
    );
  return checkFrom('gated-execute.decisions', failures);
}

export function gatedExecuteFidelityChecks(input: FidelityInput): IntegrityCheck[] {
  return [
    reviewedCheck(input),
    decisionsCheck(input),
    toolSurfaceCheck('gated-execute.tools', input, [
      { role: 'executor', matches: phase('execute'), tools: input.env.allowedTools },
      { role: 'reviewer', matches: phasePrefix('review-'), tools: input.env.readOnlyTools },
    ]),
  ];
}

function reviewPhases(input: FidelityInput) {
  return input.outcome.phases.filter((record) => record.phase.startsWith('review-'));
}

/** `mcp__airline__issue_refund` → `issue_refund`, the name the journal and the model use. */
function bareName(tool: string): string {
  return tool.startsWith('mcp__') ? tool.split('__').slice(2).join('__') : tool;
}

function inputText(input: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(input ?? {});
  } catch {
    text = String(input);
  }
  return truncate(text, MAX_INPUT_CHARS);
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function createGatedExecuteStrategy(deps: Partial<StrategyDeps> = {}): Strategy {
  return {
    id: 'gated-execute',
    label: 'Execute with action review',
    description: DESCRIPTION,
    fidelityChecks: gatedExecuteFidelityChecks,

    async run(ctx: RunContext): Promise<StrategyOutcome> {
      const runner = createPhaseRunner(ctx, deps);
      if (!runner.canContinue()) return runner.finish();

      const mutating = new Set(mutatingTools(ctx.env));
      const notes: ReviewNote[] = [];
      let reviews = 0;
      let opened = 0;

      const review = async (
        call: PendingToolCall,
        { signal }: { signal: AbortSignal },
      ): Promise<ToolCallDecision> => {
        // Reads pass straight through: only a change of state is gated.
        if (!mutating.has(call.toolName)) return { allow: true };

        reviews += 1;
        const earlier = [...notes];
        const outcome = await runner.run(
          {
            phase: `review-${reviews}`,
            label: `Review ${reviews}: ${bareName(call.toolName)}`,
            prompt: reviewPrompt(ctx, call, earlier),
            allowedTools: [...ctx.env.readOnlyTools],
            outputSchema: REVIEW_SCHEMA,
            maxBudgetUsd: ctx.budget.availableUsd * REVIEW_BUDGET_SHARE,
            depth: 1,
            agentLabel: 'reviewer',
          },
          { signal },
        );
        if (outcome.subtype !== 'skipped') opened += 1;

        const decision = readDecision(outcome);
        const cut = interrupted(outcome);
        runner.annotate(outcome, {
          meta: {
            tool: call.toolName,
            toolUseId: call.toolUseId,
            decision: decision.allow ? 'allow' : 'deny',
            source: decision.source,
            reason: truncate(decision.reason, MAX_REASON_CHARS),
          },
          ...(decision.source !== 'schema' && !cut
            ? {
                degraded:
                  decision.source === 'prose'
                    ? 'the decision came back as JSON in prose, not through the schema'
                    : 'no decision could be read; the action was denied unreviewed',
              }
            : {}),
        });

        if (decision.allow) {
          notes.push({ tool: call.toolName, input: call.toolInput, allowed: true, reason: decision.reason });
          return { allow: true };
        }
        // An action nobody could review does not run either.
        const reason =
          decision.source !== 'none'
            ? decision.reason || 'The reviewer gave no reason.'
            : cut
              ? 'The review was cut short (the run ran out of budget or time, or the review ' +
                'failed at the API), so this call could not be reviewed.'
              : 'The reviewer gave no readable decision.';
        notes.push({ tool: call.toolName, input: call.toolInput, allowed: false, reason });
        return {
          allow: false,
          reason: `Denied by the action reviewer: ${reason} Nothing was changed.`,
        };
      };

      // With nothing that changes state there is nothing to gate, and the
      // executor keeps the whole budget, exactly as `single` would.
      const gated = mutating.size > 0;
      const execute = await runner.run({
        phase: 'execute',
        label: 'Execute',
        prompt: gated ? executorPrompt(ctx) : mainPrompt(ctx),
        ...(gated
          ? { maxBudgetUsd: ctx.budget.availableUsd * EXECUTOR_BUDGET_SHARE, reviewToolCall: review }
          : {}),
        answers: true,
      });

      return runner.finish({ finalText: execute.text, subagentCount: opened });
    },
  };
}

export const gatedExecuteStrategy = createGatedExecuteStrategy();
