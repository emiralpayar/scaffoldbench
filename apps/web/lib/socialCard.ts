/**
 * What the social card says, derived at build time so it never goes stale.
 * Kept apart from the image routes so both cards share one source.
 */

import { derivePostmortem } from './postmortem';
import { SITE_URL } from './site';
import { loadPostmortemRunSet } from './server/runSet';

export async function socialCardText(): Promise<{ footnote: string; host: string }> {
  const evidence = await loadPostmortemRunSet();
  const postmortem = evidence ? derivePostmortem(evidence.runSetId, evidence.records) : null;
  const footnote =
    postmortem && postmortem.degraded > 0
      ? `Our first leaderboard said ${spell(postmortem.rows.length)} architectures tied. ${capitalize(spell(postmortem.degraded))} of them never ran as designed.`
      : 'Six agent harness architectures on the same models, tools and tasks.';
  const url = new URL(SITE_URL);
  const host = `${url.host}${url.pathname === '/' ? '' : url.pathname}`;
  return { footnote, host };
}

const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];

/** Small counts read better as words in a sentence. */
function spell(n: number): string {
  return WORDS[n] ?? String(n);
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
