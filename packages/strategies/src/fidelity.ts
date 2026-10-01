import { tracedCalls } from '@arena/core';
import type { FidelityInput, IntegrityCheck, PhaseRecord } from '@arena/core';
import { interrupted } from './helpers';

/**
 * Building blocks for the strategies' fidelity checks.
 *
 * A fidelity check asks whether the architecture ran as designed: the plan
 * was a plan, the fan-out fanned out, the selector chose. It judges only what
 * the architecture could have done. A phase the run's cost or time limit cut
 * short, or that never started because the run had already stopped, is the
 * run's failure and passes; a phase that ran to its end and still produced
 * nothing usable does not.
 */

export function pass(id: string, detail?: string): IntegrityCheck {
  return detail === undefined ? { id, ok: true } : { id, ok: true, detail };
}

export function fail(id: string, detail: string): IntegrityCheck {
  return { id, ok: false, detail };
}

/** One check from a list of failures: ok when there are none. */
export function checkFrom(id: string, failures: readonly string[], verified?: string): IntegrityCheck {
  if (failures.length === 0) return pass(id, verified);
  const shown = failures.slice(0, 3);
  const more = failures.length - shown.length;
  return fail(id, more > 0 ? `${shown.join('; ')}; and ${more} more` : shown.join('; '));
}

/** The first phase record with this name. */
export function phaseNamed(input: FidelityInput, name: string): PhaseRecord | undefined {
  return input.outcome.phases.find((phase) => phase.phase === name);
}

/** True when the phase was stopped from outside before it could finish; see `interrupted`. */
export function cutShort(phase: PhaseRecord): boolean {
  return interrupted({
    aborted: phase.aborted,
    subtype: phase.subtype ?? '',
    ...(phase.apiError ? { apiError: phase.apiError } : {}),
  });
}

/**
 * The verdict on a phase the architecture needed, when it is missing or was
 * cut short — or `undefined` when it ran and has to be judged on its output.
 *
 * Missing is excused only when the run was stopped: an architecture that
 * skips its own phase with budget and time to spare did not run as designed.
 */
export function unjudged(
  id: string,
  input: FidelityInput,
  phase: PhaseRecord | undefined,
  name: string,
): IntegrityCheck | undefined {
  if (!phase) {
    return input.stoppedBy
      ? pass(id, `${name} never ran: the run was stopped (${input.stoppedBy})`)
      : fail(id, `${name} never ran`);
  }
  if (cutShort(phase)) return pass(id, `${name} was cut short (${phase.subtype}), so it is not judged`);
  return undefined;
}

/** Which phases an expectation covers, and what they should have been shown. */
export interface ToolExpectation {
  /** What to call the phase in a failure, e.g. `proposer`. */
  role: string;
  matches(phase: string): boolean;
  /** The task tools the phase should hold: `[]` for none. */
  tools: readonly string[];
}

/**
 * Every phase was shown exactly the task tools the architecture gives it.
 *
 * Read from the tools each session listed when it started, not from what the
 * strategy asked for: the first published run set asked for the right tools
 * and two of every three proposers were shown none. A call that never
 * started has nothing to judge and passes here; whether it should have
 * started is the business of the check that needed it.
 */
export function toolSurfaceCheck(
  id: string,
  input: FidelityInput,
  expectations: readonly ToolExpectation[],
): IntegrityCheck {
  const taskTools = new Set(input.env.allowedTools);
  const failures: string[] = [];
  let judged = 0;

  for (const call of tracedCalls(input.trace)) {
    const expectation = expectations.find((candidate) => candidate.matches(call.phase));
    if (!expectation || !call.init) continue;
    judged += 1;
    const shown = new Set(call.init.tools.filter((tool) => taskTools.has(tool)));
    const wanted = new Set(expectation.tools);
    const missing = [...wanted].filter((tool) => !shown.has(tool));
    const extra = [...shown].filter((tool) => !wanted.has(tool));
    if (missing.length > 0) {
      failures.push(`the ${expectation.role} (${call.phase}) was not shown ${listOf(missing)}`);
    }
    if (extra.length > 0) {
      failures.push(`the ${expectation.role} (${call.phase}) was also shown ${listOf(extra)}`);
    }
  }
  return checkFrom(id, failures, `${judged} phase${judged === 1 ? '' : 's'} had the tools designed for them`);
}

function listOf(tools: readonly string[]): string {
  // `mcp__airline__get_reservation` reads better as `get_reservation`.
  const bare = tools.map((tool) => (tool.startsWith('mcp__') ? tool.split('__').slice(2).join('__') : tool));
  return bare.length > 4 ? `${bare.slice(0, 4).join(', ')} and ${bare.length - 4} more` : bare.join(', ');
}

/** Exactly `name`. */
export const phase = (name: string) => (candidate: string) => candidate === name;

/** `prefix` followed by anything, e.g. every `worker-*`. */
export const phasePrefix = (prefix: string) => (candidate: string) => candidate.startsWith(prefix);

/** A number from a phase's `meta`, when it is one. */
export function metaNumber(record: PhaseRecord | undefined, key: string): number | undefined {
  const value = record?.meta?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** A string from a phase's `meta`, when it is one. */
export function metaString(record: PhaseRecord | undefined, key: string): string | undefined {
  const value = record?.meta?.[key];
  return typeof value === 'string' ? value : undefined;
}
