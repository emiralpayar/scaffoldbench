import { architectureName } from '../../lib/architectures';
import { formatScore } from '../../lib/format';
import { modelShortName } from '../../lib/models';
import type { Postmortem } from '../../lib/postmortem';
import { treeUrl } from '../../lib/site';
import { ArchitectureGlyph } from '../ArchitectureGlyph';

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

        {rows.length > 0 ? (
          <div className="card mt-12 overflow-hidden">
            <div className="hidden grid-cols-[minmax(0,15rem)_minmax(0,1fr)_7rem] gap-6 border-b border-rule px-6 py-3 md:grid">
              <span className="eyebrow">Designed → as it ran</span>
              <span className="eyebrow">What the run records show</span>
              <span className="eyebrow text-right">Scored</span>
            </div>
            <ol>
              {rows.map((row) => (
                <li
                  key={row.strategyId}
                  className="grid gap-4 border-b border-rule px-5 py-6 last:border-0 sm:px-6 md:grid-cols-[minmax(0,15rem)_minmax(0,1fr)_7rem] md:items-center md:gap-6"
                >
                  <div className="flex items-center gap-3">
                    <ArchitectureGlyph id={row.strategyId} width={72} title={`${architectureName(row.strategyId)} as designed`} />
                    <span aria-hidden className="text-muted">
                      →
                    </span>
                    <ArchitectureGlyph
                      id={row.strategyId}
                      width={72}
                      dead={row.deadNodes}
                      title={
                        row.deadNodes.length > 0
                          ? `${architectureName(row.strategyId)} as it ran: ${row.deadNodes.length} step${row.deadNodes.length === 1 ? '' : 's'} never did their job`
                          : `${architectureName(row.strategyId)} as it ran: as designed`
                      }
                    />
                  </div>
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                      <span className="text-[1.0625rem] font-medium text-ink">{architectureName(row.strategyId)}</span>
                      {row.ranAsDesigned ? (
                        <span className="chip !border-good/50 !text-good">ran as designed</span>
                      ) : (
                        <span className="chip !border-bad/50 !text-bad">did not run as designed</span>
                      )}
                    </p>
                    {row.receipts.length > 0 ? (
                      <ul className="mt-2 space-y-1 text-[0.9375rem] leading-snug text-ink-2">
                        {row.receipts.map((receipt) => (
                          <li key={receipt.label} className="flex gap-2">
                            <span className="num shrink-0 text-ink">
                              {receipt.count}/{receipt.of}
                            </span>
                            <span>
                              {receipt.unit === 'proposals' ? 'proposals ' : 'runs: '}
                              {receipt.label}
                            </span>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="mt-2 text-[0.9375rem] text-ink-2">
                        The control: one agent, nothing to skip. It ran as designed in{' '}
                        {row.runs}/{row.runs} runs.
                      </p>
                    )}
                  </div>
                  <div className="flex items-baseline gap-2 md:block md:text-right">
                    <span className="eyebrow md:hidden">Scored</span>
                    <span className="num text-[1.375rem] text-ink">{formatScore(row.meanScore)}</span>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        ) : null}

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
      </div>
    </section>
  );
}
