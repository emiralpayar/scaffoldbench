import Link from 'next/link';

import { formatScore } from '../../lib/format';
import { modelShortName } from '../../lib/models';
import type { Postmortem } from '../../lib/postmortem';
import { treeUrl } from '../../lib/site';
import { DesignedVsRan } from '../postmortem/DesignedVsRan';

/**
 * Act 1: the harness that lied. Each architecture as designed beside the
 * same architecture as it ran, with the dead steps struck through and the
 * receipts — counts over the committed run records — next to the score the
 * leaderboard gave it anyway.
 */
export function ActOne({ postmortem, createdAt }: { postmortem: Postmortem | null; createdAt?: string }) {
  const rows = postmortem?.rows ?? [];
  const evidenceUrl = postmortem ? treeUrl(`results/${postmortem.runSetId}`) : undefined;
  const scores = rows.map((row) => row.meanScore);
  const when = createdAt
    ? new Date(createdAt).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })
    : null;

  return (
    <section id="act-1" aria-labelledby="act-1-title" className="section">
      <div className="container-page">
        <div className="max-w-[46rem]">
          <p className="eyebrow">Act 1 · The harness that lied</p>
          <h2 id="act-1-title" className="h1 mt-4 text-ink">
            The leaderboard said five architectures tied. The traces said four of them never ran.
          </h2>
          {postmortem && rows.length > 0 ? (
            <p className="lede mt-6">
              The first published run set, {postmortem.runs} runs on{' '}
              {postmortem.models.map(modelShortName).join(', ')}
              {when ? ` in ${when}` : ''}, scored every architecture between{' '}
              <span className="num text-ink">{formatScore(Math.min(...scores))}</span> and{' '}
              <span className="num text-ink">{formatScore(Math.max(...scores))}</span>. Reading the
              traces showed why it looked like a tie: {postmortem.degraded} of the {rows.length}{' '}
              designs never executed as designed, so what was measured was mostly a single agent with
              dead steps around it. No run crashed, and every score looked plausible.
            </p>
          ) : (
            <p className="lede mt-6">
              The first published run set scored every architecture within a hair of each other.
              Reading the traces showed why: most of the designs never executed as designed, so what
              was measured was mostly a single agent with dead steps around it.
            </p>
          )}
        </div>

        {rows.length > 0 ? <DesignedVsRan rows={rows} className="mt-12" /> : null}

        <div className="mt-12 grid gap-8 md:grid-cols-2">
          <p className="prose-serif">
            The fault was in our harness, not the models. The sandbox guard denied the tool the Agent
            SDK uses for structured output, so planning, decomposition and selection steps could not
            hand back their result, and with a single turn they had no way to recover.
            {postmortem
              ? ` The guard recorded denials in ${postmortem.runsWithDenials} of ${postmortem.runs} runs.`
              : ''}
          </p>
          <p className="prose-serif">
            So a run now has to prove that its architecture executed: each design declares checks such
            as &ldquo;the plan was not empty&rdquo; or &ldquo;the work fanned out&rdquo;, and a run that
            fails one is excluded from every ranking on this site and counted instead. The records
            behind every number above stay in the repository, unchanged, as evidence
            {evidenceUrl ? (
              <>
                :{' '}
                <a href={evidenceUrl} className="link">
                  <code className="code-inline">results/{postmortem?.runSetId}</code>
                </a>
              </>
            ) : null}
            .
          </p>
        </div>

        <p className="mt-10">
          <Link href="/postmortem/" className="btn btn-secondary">
            Read the post-mortem <span aria-hidden>→</span>
          </Link>
        </p>
      </div>
    </section>
  );
}
