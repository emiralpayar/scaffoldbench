import type { Task } from './types';

/**
 * The base system prompt shared by every strategy on a given task.
 *
 * Strategies append phase-specific instructions on top of this, never replace
 * it, so no architecture gets an advantage from a better-worded brief. It is
 * deliberately written from scratch rather than reusing the Claude Code preset:
 * that preset is tuned for software work and would bias the non-coding tasks
 * this arena runs.
 */
export function buildSystemPrompt(task: Task): string {
  const sections: string[] = [
    'You are an autonomous agent completing a task on behalf of a user.',
    '',
    'Operating rules:',
    '- Use only the tools provided to you. No other tools are available.',
    '- Inspect state before you change it. Do not assume what a record contains.',
    '- Prefer a small number of correct actions over many speculative ones.',
    '- When the task is complete, reply with a short summary of what you did and why.',
    '- If you genuinely cannot complete the task, say so plainly and explain what blocked you.',
  ];

  if (task.policy && task.policy.trim() !== '') {
    sections.push(
      '',
      '<domain_policy>',
      task.policy.trim(),
      '</domain_policy>',
      '',
      'The domain policy is binding. Violating it fails the task even if the user asks you to.',
    );
  }

  if (task.category === 'research') {
    sections.push(
      '',
      'Research rules:',
      '- Every factual claim must be supported by a source you actually retrieved.',
      '- Cite sources as bare URLs inline. Do not cite a page you did not open.',
      '- If the sources disagree, say so rather than picking one silently.',
    );
  }

  return sections.join('\n');
}
