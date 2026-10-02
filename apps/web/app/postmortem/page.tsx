import type { Metadata } from 'next';

import Link from '../../components/Link';
import { ScrollRegion } from '../../components/ScrollRegion';
import { Cause, Evidence } from '../../components/postmortem/Cause';
import { DesignedVsRan } from '../../components/postmortem/DesignedVsRan';
import { ScoreStrip } from '../../components/postmortem/ScoreStrip';
import { WasteBars } from '../../components/postmortem/WasteBars';
import { ReplayGallery } from '../../components/timeline/ReplayGallery';
import { summarizeHealth } from '../../lib/analysis';
import { formatInt, formatPercent, formatScore, formatUsd } from '../../lib/format';
import { modelShortName } from '../../lib/models';
import { pageMetadata } from '../../lib/pageMetadata';
import type { Postmortem } from '../../lib/postmortem';
import { ACT_ONE, derivePostmortem } from '../../lib/postmortem';
import { loadEvidenceRace, toReplayEntries } from '../../lib/server/replays';
import { POSTMORTEM_RUN_SET_ID, hasTrace, loadPostmortemRunSet, loadRunSet } from '../../lib/server/runSet';
import { sourceUrl, treeUrl } from '../../lib/site';

export const metadata: Metadata = pageMetadata({
  title: 'Post-mortem: the run set that tied',
  description:
    'The first run set scored five agent architectures between 0.980 and 1.000. The traces showed that four of them never ran as designed: what broke, the receipts, and why every score still looked plausible.',
  path: '/postmortem/',
});

const PUBLISHED_HERE = 'results';

export default async function PostmortemPage() {
  const [evidence, published, race] = await Promise.all([
    loadPostmortemRunSet(),
    loadRunSet(),
    loadEvidenceRace(),
  ]);

  const report = evidence && evidence.records.length > 0 ? derivePostmortem(evidence.runSetId, evidence.records) : null;
  const scores = report?.rows.map((row) => row.meanScore) ?? [];
  const evidenceUrl = treeUrl(`${PUBLISHED_HERE}/${POSTMORTEM_RUN_SET_ID}`);
  const runUrl = (runId: string): string | undefined =>
    published?.runSetId === POSTMORTEM_RUN_SET_ID
      ? `/runs/${runId}/`
      : sourceUrl(`${PUBLISHED_HERE}/${POSTMORTEM_RUN_SET_ID}/runs/${runId}.json`);
  const entries = race ? await toReplayEntries(race) : [];
  const entry = entries.find((e) => e.strategyId === 'propose-select') ?? entries[0];
  const gate = published?.verification === 'verified' ? summarizeHealth(published.records) : null;
  const extra = report ? wastedShareOfExtraCost(report) : null;
  const tracesPresent = !!evidence && !!evidence.records[0] && hasTrace(evidence, evidence.records[0]);

  return (
    <div className="container-page pb-24 pt-10 sm:pt-14">
      <header className="max-w-[50rem] border-b border-rule pb-10">
        <p className="eyebrow flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <span>Post-mortem · Act 1</span>
          <span className="chip !border-bad/50 !text-bad">retracted run set</span>
        </p>
        <h1 className="h1 mt-4 text-ink">
          The leaderboard said five architectures tied. The traces said four of them never ran as designed.
        </h1>
        <p className="lede mt-6">
          The first run set measured {report ? formatInt(report.runs) : ACT_ONE.runs} runs of five agent
          architectures on {report ? report.models.map(modelShortName).join(', ') : 'Claude Sonnet 5'}.
          {report
            ? ` Every architecture scored between ${formatScore(Math.min(...scores))} and ${formatScore(Math.max(...scores))}, and ${report.totals.runsWithoutFailure} of the ${report.runs} runs were recorded with no failure at all.`
            : ' Every architecture scored within a hair of the others.'}{' '}
          We read the traces before publishing it. This page is what they showed, with every count taken from
          files in the repository that anyone can open.
        </p>
      </header>

      <div role="note" className="banner banner-bad mt-8 max-w-[50rem]">
        <p className="banner-title">Retracted</p>
        <p className="banner-body">
          That run set is withdrawn. Its runs stay in the repository exactly as recorded
          {evidenceUrl ? (
            <>
              {' '}
              (
              <a href={evidenceUrl} className="link">
                <code className="code-inline">{PUBLISHED_HERE}/{POSTMORTEM_RUN_SET_ID}</code>
              </a>
              )
            </>
          ) : null}
          , as evidence. Nothing on this site ranks its architectures or draws a conclusion from its scores.
        </p>
      </div>

      <dl
        aria-label="The failure in six numbers"
        className="mt-12 grid grid-cols-2 gap-px overflow-hidden rounded-[14px] border border-rule bg-rule lg:grid-cols-6"
      >
        {[
          { value: `${ACT_ONE.structuredFailed}/${ACT_ONE.structuredPhases}`, label: 'plan, decompose and select steps that ended in an error' },
          { value: `${ACT_ONE.emptyPlans}/${ACT_ONE.plans}`, label: 'executors handed an empty plan' },
          { value: `${ACT_ONE.fannedOut}/${ACT_ONE.orchestratorRuns}`, label: 'orchestrator runs that split the task' },
          { value: `${ACT_ONE.laterProposersWithoutTools}/${ACT_ONE.laterProposers}`, label: 'second and third proposers that started with no tools' },
          { value: `${ACT_ONE.revisions}/${ACT_ONE.verifiedRuns}`, label: 'verified runs sent back for revision' },
          { value: String(ACT_ONE.deniedToolCalls), label: 'times the guard denied the harness’s own tool' },
        ].map((fact) => (
          <div key={fact.label} className="bg-surface px-4 py-4">
            <dt className="num text-[1.75rem] leading-none tracking-[-0.02em] text-ink">{fact.value}</dt>
            <dd className="mt-2 text-[0.8125rem] leading-snug text-ink-2">{fact.label}</dd>
          </div>
        ))}
      </dl>

      <section aria-labelledby="said-title" className="mt-24">
        <div className="max-w-[44rem]">
          <p className="eyebrow">What the leaderboard said</p>
          <h2 id="said-title" className="h2 mt-3 text-ink">
            A tie, and a tidy one.
          </h2>
          <p className="prose-serif mt-5">
            Five architectures, nine tasks, two repeats. The scores sat so close together that no interval was
            needed to see they overlapped, the failure column was nearly empty, and the verdict wrote itself: none of the extra structure earned
            back its cost. It matched what everyone already believed, which is the moment to be most careful.
          </p>
        </div>
        {report ? (
          <div className="mt-10">
            <ScoreStrip rows={report.rows} />
          </div>
        ) : null}
      </section>

      <section aria-labelledby="read-title" className="mt-24">
        <div className="max-w-[44rem]">
          <p className="eyebrow">What the traces said</p>
          <h2 id="read-title" className="h2 mt-3 text-ink">
            Three faults in our harness, none in the models.
          </h2>
          <p className="prose-serif mt-5">
            Every step of every run was recorded as a trace. Reading them showed that the designs were not the
            ones being compared. No run crashed, so nothing looked wrong in a table.
          </p>
        </div>

        <div className="mt-10">
          <Cause
            number={1}
            title="The sandbox refused the structured reply"
            receipts={[
              { value: `${ACT_ONE.structuredFailed}/${ACT_ONE.structuredPhases}`, label: 'plan, decompose and select steps ended in an error' },
              { value: `${ACT_ONE.deniedToolCalls}`, label: 'denials by the guard, every one of them of StructuredOutput' },
              { value: `${ACT_ONE.emptyPlans}/${ACT_ONE.plans}`, label: 'executors were handed <plan></plan>, empty' },
              { value: `${ACT_ONE.fannedOut}/${ACT_ONE.orchestratorRuns}`, label: 'orchestrator runs split the task' },
            ]}
          >
            <p>
              When an architecture asks the model for a structured reply (a plan, a list of subtasks, a choice
              of proposal), the Agent SDK has the model call a tool named{' '}
              <code className="code-inline">StructuredOutput</code>. Our sandbox guard denies any tool outside
              the task&rsquo;s toolset, and nobody had told it about this one. The reply was refused, the step
              had a single turn to recover in, and it ended in an error with nothing to hand on.
            </p>
            <p>
              The next step ran anyway. Executors received an empty plan; the orchestrator, with no
              decomposition, fell back to one worker given the whole task; the selector never returned a choice,
              so the first proposal stood in for it. The two steps the guard did not stop failed the same way, on
              a validation error from the same tool.
            </p>
          </Cause>

          <Cause
            number={2}
            title="Parallel agents shared one tool connection"
            receipts={[
              { value: `${ACT_ONE.laterProposersWithoutTools}/${ACT_ONE.laterProposers}`, label: 'second and third proposers started with none of the task’s tools' },
              { value: '0', label: 'tool calls made by those proposers' },
              { value: `${ACT_ONE.sessionsWithConnectors}/${ACT_ONE.sessions}`, label: 'sessions also listed claude.ai connectors from the operator’s own login' },
            ]}
          >
            <p>
              The task&rsquo;s tools were served by one in-process server object, handed to every model call.
              A server can serve one connection at a time. Sequential steps never noticed, because each
              connection closed before the next began. Parallel steps raced for it: the first proposer got the
              tools, and the other two started without them.
            </p>
            <Evidence
              source="debate-select__airline-easy__r1"
              href={runUrl('debate-select__airline-easy__r1')}
              note="Proposer 3, which was given no tool, in the trace of"
            >
              &ldquo;Since I only have read-only access, I was not given any actual tool schemas to invoke in this
              session, so I cannot report live data pulled from the system.&rdquo;
            </Evidence>
            <Evidence
              source="debate-select__airline-easy__r1"
              href={runUrl('debate-select__airline-easy__r1')}
              note="Proposer 2 wrote a tool call as text, for a tool the airline world does not have, in"
            >
              <code className="font-mono text-[0.8125rem]">get_reservation_details {'{"reservation_id": "R1042"}'}</code>
            </Evidence>
            <p>
              The same sessions listed Gmail, Calendar and Drive connectors from the operator&rsquo;s own
              account. They were unauthenticated and inert, but the claim that a run was shown exactly the
              task&rsquo;s tools and nothing else was not true.
            </p>
          </Cause>

          <Cause
            number={3}
            title="The verifier could not say no"
            receipts={[
              { value: `${ACT_ONE.revisions}/${ACT_ONE.verifiedRuns}`, label: 'verified runs were sent back for revision' },
              { value: '1', label: 'of those runs scored below 1.0, and was approved' },
            ]}
          >
            <p>
              The verifier was never asked for a structured verdict, and when its prose could not be read as
              one the code treated it as approval. The revise loop could never run. The one run that did fail its
              scorer was approved with a list of checks that all passed, including a restock that the
              task&rsquo;s own policy forbids (&ldquo;Never restock a line you have merely refunded&rdquo;).
            </p>
            <Evidence
              source="plan-execute-verify__ecommerce-hard__r1"
              href={runUrl('plan-execute-verify__ecommerce-hard__r1')}
              note="The verifier, on a run the scorer failed at 0.818, in"
            >
              &ldquo;All checks confirm the executor&rsquo;s work is correct and complete.&rdquo;
            </Evidence>
          </Cause>
        </div>
      </section>

      <section aria-labelledby="ran-title" className="mt-24">
        <div className="max-w-[44rem]">
          <p className="eyebrow">Designed against ran</p>
          <h2 id="ran-title" className="h2 mt-3 text-ink">
            Four of five were a single agent in a trench coat.
          </h2>
          <p className="prose-serif mt-5">
            Put the three faults together and each architecture reduces to something simpler than its name.
            Crossed-out steps never did their job in the runs recorded; the counts beside them are read off the
            run records.
          </p>
        </div>
        {report ? <DesignedVsRan rows={report.rows} className="mt-10" /> : null}

        {entry ? (
          <div className="mt-12">
            <h3 className="h3 text-ink">Watch it happen</h3>
            <p className="prose-serif mt-3 max-w-[44rem]">
              The same task, replayed from the recorded traces. Pick propose-select and watch the second and third
              proposers: they start, make no tool call, and finish. Pick plan-execute and watch the planner end in
              an error before the executor starts.
            </p>
            <div className="mt-6">
              <ReplayGallery entries={entries} initial={entry.runId} />
            </div>
          </div>
        ) : null}
      </section>

      <section aria-labelledby="masked-title" className="mt-24">
        <div className="max-w-[44rem]">
          <p className="eyebrow">Why it looked fine</p>
          <h2 id="masked-title" className="h2 mt-3 text-ink">
            Two bugs that cancelled into a plausible number.
          </h2>
          <p className="prose-serif mt-5">
            A step that errors does not fail the run: the next step still has the task. The selector failed, so
            proposal 1 won, and proposal 1 was the only one with tools. The planner failed, so the executor did what a single
            agent does. The score was the final agent&rsquo;s score, and the final agent was a single agent. Every
            number on the leaderboard was real; the conclusion it invited was about designs that did not exist.
          </p>
        </div>

        {report ? (
          <div className="mt-10 grid gap-x-12 gap-y-8 lg:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]">
            <div>
              <p className="num text-[2.25rem] leading-none tracking-[-0.02em] text-ink">{formatUsd(report.totals.wastedCostUsd)}</p>
              <p className="num mt-1.5 text-[0.875rem] text-muted">of {formatUsd(report.totals.costUsd)} spent</p>
              <p className="prose-serif mt-4">
                {formatPercent(report.totals.wastedCostUsd / report.totals.costUsd)} of the money went into{' '}
                {report.totals.wastedPhases} steps that errored or ran blind.
                {extra !== null ? ` Together they are ${formatPercent(extra)} of what the other four architectures cost over single.` : ''}
              </p>
            </div>
            <WasteBars rows={report.rows} />
          </div>
        ) : null}

        <div className="mt-12 max-w-[44rem]">
          <h3 className="h3 text-ink">Why {ACT_ONE.tests} passing tests did not catch it</h3>
          <p className="prose-serif mt-3">
            The strategy tests replaced the model call with a fake that returned a structured reply whether or
            not the code had asked for one, so a planner that never got its reply could not fail. The only check
            against the real SDK started a single session, so a second one could not lose its tools. Nothing asked
            the question that mattered: did the architecture actually run?
          </p>
        </div>
      </section>

      <section aria-labelledby="changed-title" className="mt-24">
        <div className="max-w-[44rem]">
          <p className="eyebrow">What changed</p>
          <h2 id="changed-title" className="h2 mt-3 text-ink">
            A run has to prove its design ran.
          </h2>
          <p className="prose-serif mt-5">
            The guard now knows about the structured-output tool, and every model call gets its own tool server.
            A verifier that returns no readable verdict is no longer an approval. More to the point, every
            architecture now declares what running as designed looks like (a plan with at least one step, a
            fan-out that happened, a verdict that was read, a selector that chose), and the runner adds checks of
            its own: no harness tool denied, every tool server connected, no foreign ones, no silent fallback.
            A run that fails a check is excluded from every ranking and counted, never scored.
          </p>
          <p className="prose-serif mt-4">
            The checks are listed one by one, with their pass rates, on the{' '}
            <Link href="/health/" className="link">
              harness health
            </Link>{' '}
            page, and the statistics that rank what is left are on the{' '}
            <Link href="/methodology/" className="link">
              methodology
            </Link>{' '}
            page.
            {gate
              ? ` In the run set published here, ${formatInt(gate.rankable)} of ${formatInt(gate.total)} runs passed every check and were ranked.`
              : ''}
          </p>
        </div>
      </section>

      <section aria-labelledby="check-title" className="mt-24">
        <div className="max-w-[44rem]">
          <p className="eyebrow">Check it yourself</p>
          <h2 id="check-title" className="h2 mt-3 text-ink">
            Every count above is a one-liner.
          </h2>
          <p className="prose-serif mt-5">
            The run records are plain JSON and stay in the repository unchanged. From the repository root:
          </p>
        </div>
        <ScrollRegion label="Commands that re-derive the counts" className="mt-6 max-w-[56rem] rounded-[12px] border border-rule bg-sunken">
          <pre className="w-max p-4 font-mono text-[0.75rem] leading-relaxed text-ink-2">{`cd results/${POSTMORTEM_RUN_SET_ID}

# steps that asked for a structured reply and ended in an error (72)
jq -s '[.[] | .phases[] | select(.phase | test("^(plan|decompose|select)$")) | select(.error)] | length' runs/*.json

# guard denials, over the whole set (70)
jq -s '[.[] | .deniedToolCalls] | add' runs/*.json

# orchestrator runs that never gave more than one worker a task (18 of 18)
jq -s '[.[] | select(.strategyId == "orchestrator-workers") | [.phases[] | select(.phase | startswith("worker"))] | length | select(. <= 1)] | length' runs/*.json

# second and third proposers that made no tool call (36)
jq -s '[.[] | select(.strategyId == "debate-select") | .phases[] | select((.phase | test("^propose-[23]$")) and .toolCalls == 0)] | length' runs/*.json`}</pre>
        </ScrollRegion>
        <p className="mt-4 max-w-[44rem] text-[0.875rem] leading-relaxed text-muted">
          The counts that need the traces (empty plans, the connectors, the proposers&rsquo; tool lists) were taken from
          the {ACT_ONE.runs} original traces
          {tracesPresent ? ', which this build carries under ' : ', which are not in this checkout. '}
          {tracesPresent ? <code className="code-inline">{PUBLISHED_HERE}/{POSTMORTEM_RUN_SET_ID}/traces/</code> : null}
          {tracesPresent ? '. ' : null}
          <code className="code-inline">apps/web/test/postmortem.test.ts</code> re-derives them whenever a checkout has the
          traces, and fails if a number on this page is wrong. The run set was recorded at{' '}
          <code className="code-inline">164f958</code>, where {ACT_ONE.tests} tests passed.
        </p>
      </section>

      <section aria-labelledby="after-title" className="mt-24 rounded-[18px] border border-rule bg-surface px-6 py-10 sm:px-10">
        <p className="eyebrow">What we took from it</p>
        <h2 id="after-title" className="h2 mt-3 max-w-[40rem] text-ink">
          Before you compare agent architectures, prove each one actually ran.
        </h2>
        <p className="prose-serif mt-5 max-w-[44rem]">
          A plausible score is not evidence that a design was measured, and an agreeable result is the one to
          distrust. The corrected benchmark runs every architecture on three Claude models, excludes any run that
          did not run as designed, and reports what the structure buys with an interval on every number.
        </p>
        <div className="mt-8 flex flex-wrap gap-3">
          <Link href="/results/" className="btn btn-primary">
            See the corrected results <span aria-hidden>→</span>
          </Link>
          <Link href="/methodology/" className="btn btn-secondary">
            How the numbers are made
          </Link>
        </div>
      </section>
    </div>
  );
}

/**
 * Of the money the four designs with structure spent beyond what the control
 * spent for the same work, the part that went to steps that failed or ran
 * blind. `null` when there is no control to compare with.
 */
function wastedShareOfExtraCost(report: Postmortem): number | null {
  const control = report.rows.find((row) => row.strategyId === 'single');
  if (!control) return null;
  const others = report.rows.filter((row) => row.strategyId !== control.strategyId);
  const extra = others.reduce((total, row) => total + (row.costUsdPerRun - control.costUsdPerRun), 0);
  const wasted = others.reduce((total, row) => total + row.wastedUsdPerRun, 0);
  return extra > 0 ? wasted / extra : null;
}
