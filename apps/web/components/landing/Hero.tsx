import type { ReactNode } from 'react';

import Link from '../Link';
import type { RaceLane } from './TraceRace';
import { TraceRace } from './TraceRace';

export interface HeroFact {
  label: string;
  value: string;
}

export interface HeroRace {
  lanes: RaceLane[];
  recorded: boolean;
  speed: number;
  /** What is being raced, in a line: the task and run, or "schematic". */
  title: ReactNode;
  note: ReactNode;
}

/**
 * The first screen. Always on the dark stage, in both themes: it is the
 * brand moment. Under the question, the same task run by every architecture,
 * replayed side by side: the designs explained without a word.
 */
export function Hero({ facts, note, race }: { facts: HeroFact[]; note?: string; race: HeroRace }) {
  return (
    <section className="stage theme-dark border-b border-rule">
      <div className="container-page pb-16 pt-14 sm:pb-24 sm:pt-20">
        <div className="grid gap-10 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)] lg:items-end lg:gap-16">
          <div className="min-w-0">
            <p className="eyebrow">An open benchmark of agent harness architectures</p>
            <h1 className="display mt-6 text-ink">
              Does your agent scaffold <em className="italic text-ink">pay for itself?</em>
            </h1>
          </div>
          <div className="min-w-0 lg:pb-2">
            <p className="lede">
              Planners, verifiers, worker pools, selectors and gates all cost tokens and time.
              ScaffoldBench runs six harness architectures on the same Claude models, tools and tasks,
              checks that each design actually ran, and reports what the extra structure buys, with an
              interval on every number.
            </p>
            <div className="mt-8 grid gap-3 sm:flex sm:flex-wrap">
              <Link href="/results/" className="btn btn-primary">
                See the results <span aria-hidden>→</span>
              </Link>
              <Link href="/postmortem/" className="btn btn-secondary">
                What went wrong <span aria-hidden>→</span>
              </Link>
            </div>
          </div>
        </div>

        <div className="relative mt-14 sm:mt-16">
          <div
            aria-hidden
            className="pointer-events-none absolute -inset-x-10 -inset-y-12 -z-10 opacity-50 blur-3xl"
            style={{
              background:
                'radial-gradient(35% 45% at 18% 30%, color-mix(in oklab, var(--arch-plan-execute) 20%, transparent), transparent 70%), radial-gradient(30% 40% at 82% 75%, color-mix(in oklab, var(--arch-gated-execute) 16%, transparent), transparent 70%)',
            }}
          />
          <figure className="overflow-hidden rounded-[18px] border border-rule bg-surface/80 backdrop-blur-md">
            <figcaption className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 border-b border-rule px-4 py-3.5 sm:px-5">
              <span className="text-[0.9375rem] text-ink">{race.title}</span>
              <span className="text-[0.8125rem] text-muted">{race.note}</span>
            </figcaption>
            <TraceRace lanes={race.lanes} speed={race.speed} recorded={race.recorded} />
          </figure>
        </div>

        {facts.length > 0 ? (
          <dl className="mt-12 grid max-w-[40rem] grid-cols-2 gap-x-8 gap-y-5 sm:grid-cols-4">
            {facts.map((fact) => (
              <div key={fact.label}>
                <dt className="eyebrow">{fact.label}</dt>
                <dd className="mt-1.5 text-[1.625rem] font-[460] leading-none tracking-[-0.02em] text-ink">
                  {fact.value}
                </dd>
              </div>
            ))}
          </dl>
        ) : null}
        {note ? <p className="mt-5 text-[0.8125rem] text-muted">{note}</p> : null}
      </div>
    </section>
  );
}
