import type { Metadata } from 'next';
import Link from 'next/link';

import { ArchitectureGlyph } from '../../../components/ArchitectureGlyph';
import { EmptyState } from '../../../components/EmptyState';
import { PageHeader } from '../../../components/Layout';
import { RunSetBanner } from '../../../components/RunSetMeta';
import { CheckRateList } from '../../../components/health/CheckRateList';
import { HealthStrip } from '../../../components/leaderboard/HealthStrip';
import { ARCHITECTURES, architectureName } from '../../../lib/architectures';
import { checkWords, failedChecks } from '../../../lib/integrity';
import { formatInt, formatPercent } from '../../../lib/format';
import { modelShortName } from '../../../lib/models';
import { pageMetadata } from '../../../lib/pageMetadata';
import { runReceipts } from '../../../lib/postmortem';
import type { RunRecord } from '../../../lib/records';
import { analysisFor } from '../../../lib/server/analysis';
import { loadRunSet } from '../../../lib/server/runSet';
import { harnessCheckRates, ownCheckRates } from '../../../lib/strategies';

export const metadata: Metadata = pageMetadata({
  title: 'Harness health',
  description:
    'Did every run measure what it claims? The integrity checks behind every number on ScaffoldBench, how often each held, and the runs that were excluded because one did not.',
  path: '/health/',
});

/** Excluded runs are listed in full up to here; the rest are counted. */
const LISTED = 40;

export default async function HealthPage() {
  const data = await loadRunSet();
  if (!data || data.records.length === 0) return <EmptyState />;

  const analysis = analysisFor(data);
  const health = analysis.health;
  const verified = data.verification !== 'unverified';
  const retried = data.records.filter((record) => (record.attempts ?? 1) > 1).length;
  const excluded = data.records.filter((record) => record.integrity && !record.integrity.ok);
  const lostToApi = data.records.filter((record) => record.failureMode === 'api_error');
  const harness = harnessCheckRates(data.records);
  const architectures = ARCHITECTURES.map((info) => ({
    info,
    runs: data.records.filter((record) => record.strategyId === info.id),
  })).filter(({ runs }) => runs.length > 0);

  return (
    <>
      <RunSetBanner data={data} />

      <PageHeader
        eyebrow="Harness health"
        title="Did every run measure what it claims?"
        lede="A score says how a run went. It does not say whether the architecture it is filed under actually ran. Every run carries a list of checks that say so, and a run that fails one is excluded from every ranking and counted here instead."
      />

      <HealthStrip health={health} verified={verified} retried={retried} showLink={false} scope="in this run set, every model" />

      {verified ? (
        <>
          <section aria-labelledby="by-arch-title" className="mb-20">
            <h2 id="by-arch-title" className="h2 mb-3 max-w-3xl text-ink">
              Which designs lost runs
            </h2>
            <p className="prose-serif mb-8 max-w-3xl">
              An exclusion is the harness failing the design, not the design failing the task: a planner that
              returned no plan, a proposer that started without its tools. It is counted against the harness, and the
              run is left out so that it cannot flatter or sink the architecture it was filed under.
            </p>
            <ArchitectureHealth health={health} />
          </section>

          <section aria-labelledby="checks-title" className="mb-20">
            <h2 id="checks-title" className="h2 mb-3 max-w-3xl text-ink">
              Every check, and how often it held
            </h2>
            <p className="prose-serif mb-8 max-w-3xl">
              The runner’s own checks apply to every architecture. Each architecture adds checks that say what running
              as designed means for it.
            </p>
            <div className="card px-5 py-2 sm:px-6">
              <h3 className="eyebrow pt-4 !text-ink-2">The runner’s checks, on every run</h3>
              <CheckRateList rates={harness} />
            </div>
            <div className="mt-6 grid gap-6 lg:grid-cols-2">
              {architectures.map(({ info, runs }) => (
                <div key={info.id} className="card min-w-0 px-5 py-2 sm:px-6">
                  <div className="flex items-center gap-3 pt-4">
                    <ArchitectureGlyph id={info.id} width={44} />
                    <h3 className="text-[1rem] text-ink">
                      <Link href={`/strategies/${info.id}/`} className="link">
                        {info.name}
                      </Link>
                    </h3>
                  </div>
                  <CheckRateList rates={ownCheckRates(runs, info.id)} />
                </div>
              ))}
            </div>
          </section>

          <section aria-labelledby="excluded-title" className="mb-20">
            <h2 id="excluded-title" className="h2 mb-3 max-w-3xl text-ink">
              The runs that were left out
            </h2>
            {excluded.length === 0 ? (
              <p className="prose-serif max-w-3xl">No run failed a check. Every recorded run was ranked, except as noted below.</p>
            ) : (
              <>
                <p className="prose-serif mb-8 max-w-3xl">
                  {formatInt(excluded.length)} of {formatInt(data.records.length)} runs failed at least one check
                  ({formatPercent(excluded.length / data.records.length, 1)}). Each is on its own page, with the trace
                  when it is in this build.
                </p>
                <ExcludedRuns runs={excluded} />
              </>
            )}
            {lostToApi.length > 0 ? (
              <p className="prose-serif mt-8 max-w-3xl">
                {formatInt(lostToApi.length)} run{lostToApi.length === 1 ? ' was' : 's were'} lost to the API (an
                outage, a rate limit, an overload) after the runner retried. They are not the architecture’s failure
                and are never scored as one.
              </p>
            ) : null}
          </section>
        </>
      ) : (
        <LegacyHealth records={data.records} />
      )}

      <nav aria-label="More" className="flex flex-wrap gap-x-6 gap-y-2 border-t border-rule pt-5 text-[0.9375rem]">
        <Link href="/methodology/" className="link">
          How the numbers are made →
        </Link>
        <Link href="/postmortem/" className="link">
          The run set that taught us to check →
        </Link>
      </nav>
    </>
  );
}

/** Per architecture: how many of its runs were ranked, lost to fidelity, or lost to the API. */
function ArchitectureHealth({ health }: { health: ReturnType<typeof analysisFor>['health'] }) {
  return (
    <ul className="card divide-y divide-rule px-5 py-2 sm:px-6">
      {health.byStrategy.map((row) => {
        const ranked = row.total - row.integrityFailed - row.apiErrors;
        const name = architectureName(row.strategyId);
        return (
          <li key={row.strategyId} className="grid gap-x-5 gap-y-2 py-3.5 md:grid-cols-[minmax(0,13rem)_minmax(0,1fr)_19rem] md:items-center">
            <span className="flex min-w-0 items-center gap-3">
              <ArchitectureGlyph id={row.strategyId} width={40} decorative />
              <Link href={`/strategies/${row.strategyId}/`} className="link truncate text-[0.9375rem]">
                {name}
              </Link>
            </span>
            <span
              role="img"
              aria-label={`${name}: ${ranked} ranked, ${row.integrityFailed} excluded for fidelity, ${row.apiErrors} lost to the API, of ${row.total}`}
              className="flex h-3 w-full overflow-hidden rounded-[4px] bg-sunken"
            >
              <span className="h-full bg-good" style={{ width: `${(ranked / row.total) * 100}%` }} />
              <span
                className="h-full"
                style={{
                  width: `${(row.integrityFailed / row.total) * 100}%`,
                  background: 'repeating-linear-gradient(135deg, var(--bad) 0 2px, transparent 2px 4px)',
                  boxShadow: 'inset 0 0 0 1px var(--bad)',
                }}
              />
              <span
                className="h-full"
                style={{ width: `${(row.apiErrors / row.total) * 100}%`, background: 'var(--warn)' }}
              />
            </span>
            <span className="num whitespace-nowrap text-[0.8125rem] text-ink-2 md:text-right">
              <span className="text-ink">{formatInt(ranked)}</span> ranked
              {row.integrityFailed > 0 ? <span className="text-bad"> · {formatInt(row.integrityFailed)} fidelity</span> : null}
              {row.apiErrors > 0 ? <span className="text-warn"> · {formatInt(row.apiErrors)} API</span> : null}
              <span className="text-muted"> of {formatInt(row.total)}</span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function ExcludedRuns({ runs }: { runs: readonly RunRecord[] }) {
  const shown = runs.slice(0, LISTED);
  return (
    <div className="card overflow-hidden">
      <div className="hidden grid-cols-[minmax(0,1.3fr)_7rem_minmax(0,2fr)] gap-x-5 border-b border-rule px-5 py-3 md:grid">
        <span className="eyebrow !text-[0.6875rem]">Run</span>
        <span className="eyebrow !text-[0.6875rem]">Model</span>
        <span className="eyebrow !text-[0.6875rem]">What failed</span>
      </div>
      <ul>
        {shown.map((record) => (
          <li
            key={record.runId}
            className="grid gap-x-5 gap-y-2 border-b border-rule px-5 py-3.5 text-[0.8125rem] last:border-0 md:grid-cols-[minmax(0,1.3fr)_7rem_minmax(0,2fr)]"
          >
            <div className="min-w-0">
              <Link href={`/runs/${record.runId}/`} className="link font-mono text-[0.75rem] [overflow-wrap:anywhere]">
                {record.runId}
              </Link>
              <span className="mt-0.5 block text-ink-2 md:hidden">{modelShortName(record.model)}</span>
            </div>
            <span className="hidden text-ink-2 md:block">{modelShortName(record.model)}</span>
            <ul className="space-y-1.5">
              {failedChecks(record).map((check) => (
                <li key={check.id}>
                  <span className="text-ink">{checkWords(check.id).title}</span>
                  {check.detail ? <span className="block text-ink-2">{check.detail}</span> : null}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
      {runs.length > shown.length ? (
        <p className="border-t border-rule px-5 py-3 text-[0.8125rem] text-muted">
          and {formatInt(runs.length - shown.length)} more, in the run records.
        </p>
      ) : null}
    </div>
  );
}

/**
 * A run set recorded before the checks existed has no health to report, only
 * what its own records admit to: the same receipts a run page shows.
 */
function LegacyHealth({ records }: { records: readonly RunRecord[] }) {
  const withProblems = records.filter((record) => runReceipts(record).length > 0);
  const byArchitecture = ARCHITECTURES.map((info) => {
    const mine = records.filter((record) => record.strategyId === info.id);
    return { info, runs: mine.length, problems: mine.filter((record) => runReceipts(record).length > 0).length };
  }).filter((row) => row.runs > 0);

  return (
    <section aria-labelledby="legacy-title" className="mb-20">
      <h2 id="legacy-title" className="h2 mb-3 max-w-3xl text-ink">
        This run set has no checks to report
      </h2>
      <p className="prose-serif mb-8 max-w-3xl">
        It was recorded before the checks existed, so nothing proves that any of its architectures ran. What its own
        run records admit to is that{' '}
        <span className="num text-ink">
          {formatInt(withProblems.length)} of {formatInt(records.length)}
        </span>{' '}
        runs contain a phase that ended in an error, a tool call the guard denied, a proposer with no tool call, or a
        fan-out that never happened.
      </p>
      <ul className="card divide-y divide-rule px-5 py-2 sm:px-6">
        {byArchitecture.map(({ info, runs, problems }) => (
          <li key={info.id} className="flex items-center justify-between gap-4 py-3">
            <span className="flex items-center gap-3">
              <ArchitectureGlyph id={info.id} width={40} decorative />
              <span className="text-[0.9375rem] text-ink">{info.name}</span>
            </span>
            <span className={`num text-[0.875rem] ${problems > 0 ? 'text-bad' : 'text-ink-2'}`}>
              {problems}/{runs} runs show a problem
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
