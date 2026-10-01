/**
 * Why the numbers can be trusted, each claim naming the file that enforces
 * it. "Show me the line" is the only kind of trust an engineer extends to a
 * benchmark, so `test/trust.test.ts` fails if a named file disappears.
 *
 * Pure data: the landing page draws it, and the icons live with the page.
 */

export interface TrustClaim {
  title: string;
  body: string;
  /** Repository path of the file a reader can open to check the claim. */
  source: string;
  icon: 'check' | 'equal' | 'grid' | 'shield' | 'pair' | 'pulse';
}

export const TRUST_CLAIMS: readonly TrustClaim[] = [
  {
    title: 'Proof the design ran',
    body: 'Each architecture declares what running as designed looks like: a non-empty plan, a real fan-out, a parsed verdict. A run that fails a check is excluded from rankings and counted, never scored.',
    source: 'apps/web/lib/records.ts',
    icon: 'check',
  },
  {
    title: 'Same inputs for every design',
    body: 'Every architecture gets the same model, tools, task prompt, domain policy and budget. Only the harness around the model changes.',
    source: 'packages/core/src/systemPrompt.ts',
    icon: 'equal',
  },
  {
    title: 'Scored by state, not by vibes',
    body: 'Tool-use tasks are graded by checking the final state of the world and the journal of tool calls. No language model decides who won.',
    source: 'packages/tasks/src/defineToolUseTask.ts',
    icon: 'grid',
  },
  {
    title: 'A sandbox that says no',
    body: 'A guard denies any tool outside the task’s toolset, before it runs, and every denial is written to the trace.',
    source: 'packages/core/src/guard.ts',
    icon: 'shield',
  },
  {
    title: 'Paired, task-clustered statistics',
    body: 'Architectures are compared on the same task and repeat, bootstrapped over tasks so repeats are not mistaken for independent evidence.',
    source: 'apps/web/lib/analysis.ts',
    icon: 'pair',
  },
  {
    title: 'Outages are not failures',
    body: 'A run lost to the API is never scored as the architecture failing. It is excluded from every ranking and reported in the health count.',
    source: 'apps/web/lib/records.ts',
    icon: 'pulse',
  },
];
