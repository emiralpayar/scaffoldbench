import type { ReactNode } from 'react';

import Link from '../Link';
import type { RaceLane } from './TraceRace';
import { TraceRace } from './TraceRace';

export interface HeroStat {
  value: string;
  label: string;
  detail: ReactNode;
}

export interface HeroRace {
  lanes: RaceLane[];
  recorded: boolean;
  speed: number;
  /** What is being raced, in a line: the task and run, or "schematic". */
  title: ReactNode;
  note: ReactNode;
}

export interface HeroCopy {
  eyebrow: ReactNode;
  /** The headline; the `<em>` part is set in italic. */
  title: ReactNode;
  lede: ReactNode;
}

/**
 * The first screen. Always on the dark stage, in both themes: it is the
 * brand moment. The answer first, in a line and four numbers, then the same
 * task run by every architecture, replayed side by side.
 */
export function Hero({
  copy,
  stats,
  note,
  race,
}: {
  copy: HeroCopy;
  stats: HeroStat[];
  note?: string;
  race: HeroRace;
}) {
  return (
    <section className="stage theme-dark border-b border-rule">
      <div className="container-page pb-16 pt-14 sm:pb-24 sm:pt-20">
        <div className="grid gap-10 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)] lg:items-end lg:gap-16">
          <div className="min-w-0">
            <p className="eyebrow">{copy.eyebrow}</p>
            <h1 className="display mt-6 text-ink">{copy.title}</h1>
          </div>
          <div className="min-w-0 lg:pb-3">
            <div className="lede">{copy.lede}</div>
            <div className="mt-8 grid gap-3 sm:flex sm:flex-wrap">
              <Link href="/results/scale/" className="btn btn-primary">
                See the results <span aria-hidden>→</span>
              </Link>
              <a href="#scorecard" className="btn btn-secondary">
                Pre-registration scorecard <span aria-hidden>↓</span>
              </a>
            </div>
          </div>
        </div>

        {stats.length > 0 ? (
          <dl className="mt-14 grid gap-px overflow-hidden rounded-[16px] border border-rule bg-rule sm:mt-16 sm:grid-cols-2 lg:grid-cols-4">
            {stats.map((stat) => (
              <div key={stat.label} className="flex min-w-0 flex-col bg-plane/95 p-5 sm:p-6">
                <dt className="order-2 mt-3 text-[0.9375rem] font-medium leading-snug text-ink">{stat.label}</dt>
                <dd className="order-1 num text-[2.25rem] leading-none tracking-[-0.03em] text-ink sm:text-[2.5rem]">{stat.value}</dd>
                <dd className="order-3 mt-1.5 text-[0.8125rem] leading-relaxed text-muted">{stat.detail}</dd>
              </div>
            ))}
          </dl>
        ) : null}
        {note ? <p className="mt-5 text-[0.8125rem] text-muted">{note}</p> : null}

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
      </div>
    </section>
  );
}
