/**
 * What the social card says, derived at build time so it never goes stale.
 * Kept apart from the image routes so both cards share one source.
 */

import { architectureName } from './architectures';
import { formatScore } from './format';
import { derivePostmortem } from './postmortem';
import { SITE_URL } from './site';
import { loadPostmortemRunSet } from './server/runSet';

export interface PostmortemCardData {
  host: string;
  tied: string;
  degraded: string;
  rows: {
    strategyId: string;
    name: string;
    score: string;
    deadNodes: string[];
    ranAsDesigned: boolean;
  }[];
}

/** The post-mortem card's content, or `null` in a checkout without the first run set's records. */
export async function postmortemCardData(): Promise<PostmortemCardData | null> {
  const evidence = await loadPostmortemRunSet();
  const postmortem = evidence ? derivePostmortem(evidence.runSetId, evidence.records) : null;
  if (!postmortem || postmortem.degraded === 0) return null;
  return {
    host: cardHost(),
    tied: spell(postmortem.rows.length),
    degraded: spell(postmortem.degraded),
    rows: postmortem.rows.map((row) => ({
      strategyId: row.strategyId,
      name: architectureName(row.strategyId),
      score: formatScore(row.meanScore),
      deadNodes: row.deadNodes,
      ranAsDesigned: row.ranAsDesigned,
    })),
  };
}

function cardHost(): string {
  const url = new URL(SITE_URL);
  return `${url.host}${url.pathname === '/' ? '' : url.pathname}`;
}

export async function socialCardText(): Promise<{ footnote: string; host: string }> {
  const evidence = await loadPostmortemRunSet();
  const postmortem = evidence ? derivePostmortem(evidence.runSetId, evidence.records) : null;
  const footnote =
    postmortem && postmortem.degraded > 0
      ? `Our first leaderboard said ${spell(postmortem.rows.length)} architectures tied. ${capitalize(spell(postmortem.degraded))} of them never ran as designed.`
      : 'Six agent harness architectures on the same models, tools and tasks.';
  return { footnote, host: cardHost() };
}

const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];

/** Small counts read better as words in a sentence. */
function spell(n: number): string {
  return WORDS[n] ?? String(n);
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
