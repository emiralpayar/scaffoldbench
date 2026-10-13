/**
 * The runs of the published set whose traces are committed, and why each one
 * is worth opening. A run set's traces are gitignored by default (the 900 of
 * scaffold-or-scale-v1 come to about 106 MB), so the site replays call by call
 * only the handful listed in `.gitignore`'s exception and here.
 *
 * Each caption states what the run record shows and nothing more; a test
 * re-reads the records and holds every number here to them.
 *
 * Pure: safe anywhere. `lib/server/featured.ts` keeps only the ones whose
 * trace is in the checkout.
 */

export interface FeaturedRun {
  runId: string;
  /** A short label for a card. */
  title: string;
  /** One or two sentences: what to look for in the trace. */
  caption: string;
}

export const FEATURED_RUNS: readonly FeaturedRun[] = [
  {
    runId: 'claude-haiku-4-5-20251001__gated-execute__airline-hard__r1',
    title: 'A gate that blocked the right move',
    caption:
      'Haiku 4.5 behind a review gate: the first reviewer denied the cancellation the task called for, reasoning that the flight had already flown, and the second approved closing the fare out instead. 0.000 for $0.086; the plain single agent solved the same task for $0.031.',
  },
  {
    runId: 'claude-haiku-4-5-20251001__propose-select__airline-easy__r1',
    title: 'Three proposals beat one agent',
    caption:
      'A propose-select win: three plans, one selected and executed, scoring 1.000 where the single Haiku agent on the same task and repeat scored 0.429. It cost 4.4× as much.',
  },
  {
    runId: 'claude-sonnet-5-5__plan-execute-verify__ecommerce-hard__r1',
    title: 'A verifier that earned its keep',
    caption:
      'Sonnet 5.5 planned, executed, was sent back by its verifier, revised once and passed verification: a full 1.000 on a hard task.',
  },
  {
    runId: 'claude-haiku-4-5-20251001__plan-execute-verify__airline-hard__r1',
    title: 'A revision that did not help',
    caption:
      'The same loop on Haiku 4.5: the verifier asked for a revision, the revision was verified, and the run still scored 0.429, below the single agent’s 1.000.',
  },
  {
    runId: 'claude-haiku-4-5-20251001__single__airline-easy__r1',
    title: 'The control, missing a step',
    caption: 'The single Haiku agent the propose-select run above beat: 0.429 in 17 seconds for $0.026.',
  },
];
