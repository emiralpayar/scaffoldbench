/**
 * The integrity checks a run records, in words a reader can follow, and the
 * rates at which they held.
 *
 * The `harness.*` ids are the runner's own checks (`packages/core/src/
 * integrity.ts`); the descriptions here paraphrase the comments there. Every
 * other id belongs to an architecture's own fidelity checks, which the
 * strategies declare; those are shown by a readable form of their id until
 * the site is given their descriptions too.
 *
 * Pure: no filesystem, safe anywhere.
 */

import { architectureName, isKnownArchitecture } from './architectures';
import type { RunRecord } from './records';

export interface CheckWords {
  title: string;
  /** What passing the check verifies, in a sentence. */
  means: string;
}

const HARNESS_CHECKS: Record<string, CheckWords> = {
  'harness.run-completed': {
    title: 'Run completed',
    means: 'The environment was built, the architecture returned and grading finished, none of them throwing.',
  },
  'harness.api': {
    title: 'No API failures',
    means: 'No model call failed at the API.',
  },
  'harness.calls-ended': {
    title: 'Every call ended',
    means: "Every call ended with a result, or was stopped by the run's own limits.",
  },
  'harness.harness-tools': {
    title: 'No harness tool denied',
    means: 'The sandbox guard never denied a harness tool, nor a tool the session itself offered.',
  },
  'harness.mcp-connected': {
    title: 'Tool servers connected',
    means: 'Every tool server the harness gave a call was connected when the session started.',
  },
  'harness.mcp-hermetic': {
    title: 'No foreign tool servers',
    means: 'No call loaded a tool server the harness did not give it.',
  },
  'harness.structured-output': {
    title: 'Structured replies arrived',
    means: 'Every call that asked for structured output and ran to the end got it.',
  },
  'harness.not-degraded': {
    title: 'No silent fallbacks',
    means: 'No phase fell back on a default (an empty plan, a default winner) instead of its output.',
  },
  'harness.judge': {
    title: 'Judge answered',
    means: 'At least one grading call returned a usable verdict.',
  },
};

export function isHarnessCheck(id: string): boolean {
  return id.startsWith('harness.');
}

/** A check's title: the runner's own words, or a readable form of the id. */
export function checkWords(id: string): CheckWords {
  const known = HARNESS_CHECKS[id];
  if (known) return known;
  const [owner, ...rest] = id.split('.');
  const subject = (rest.length > 0 ? rest.join(' ') : id).replace(/[-_]/g, ' ');
  const title = subject.charAt(0).toUpperCase() + subject.slice(1);
  if (owner && rest.length > 0 && isKnownArchitecture(owner)) {
    return { title, means: `A fidelity check declared by ${architectureName(owner)}.` };
  }
  return { title, means: 'A check recorded with the run.' };
}

export interface CheckRate {
  id: string;
  ok: number;
  total: number;
  /** Detail of the most recent failure, for a tooltip. */
  example?: string;
}

/**
 * How often each recorded check held over a set of runs, harness checks
 * first, then the architecture's own. Runs recorded before integrity existed
 * contribute nothing, rather than counting as passes.
 */
export function checkRates(records: readonly RunRecord[]): CheckRate[] {
  const rates = new Map<string, CheckRate>();
  for (const record of records) {
    for (const check of record.integrity?.checks ?? []) {
      let rate = rates.get(check.id);
      if (!rate) {
        rate = { id: check.id, ok: 0, total: 0 };
        rates.set(check.id, rate);
      }
      rate.total += 1;
      if (check.ok) rate.ok += 1;
      else if (check.detail) rate.example = check.detail;
    }
  }
  return [...rates.values()].sort(
    (a, b) =>
      Number(isHarnessCheck(b.id)) - Number(isHarnessCheck(a.id)) ||
      a.id.localeCompare(b.id),
  );
}

/** The checks a run failed, in recorded order. */
export function failedChecks(record: RunRecord): { id: string; detail?: string }[] {
  return (record.integrity?.checks ?? []).filter((check) => !check.ok);
}
