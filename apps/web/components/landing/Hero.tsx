import Link from 'next/link';

import { ARCHITECTURES } from '../../lib/architectures';
import { ArchitectureGlyph } from '../ArchitectureGlyph';

export interface HeroFact {
  label: string;
  value: string;
}

/**
 * The first screen. Always on the dark stage, in both themes: it is the
 * brand moment, and the six glyphs read best glowing on near-black.
 */
export function Hero({ facts, note }: { facts: HeroFact[]; note?: string }) {
  return (
    <section className="stage theme-dark border-b border-rule">
      <div className="container-page grid gap-12 pb-16 pt-14 sm:pb-24 sm:pt-20 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] lg:items-center lg:gap-16">
        <div className="min-w-0">
          <p className="eyebrow">An open benchmark of agent harness architectures</p>
          <h1 className="display mt-6 text-ink">
            Does your agent scaffold <em className="italic text-ink">pay for itself<span className="kern-q">?</span></em>
          </h1>
          <p className="lede mt-7 max-w-[38rem]">
            Planners, verifiers, worker pools, selectors and gates all cost tokens and time.
            ScaffoldBench runs six harness architectures on the same Claude models, tools and tasks,
            checks that each design actually ran, and reports what the extra structure buys, with an
            interval on every number.
          </p>
          <div className="mt-9 flex flex-wrap gap-3">
            <Link href="/results/" className="btn btn-primary">
              See the results <span aria-hidden>→</span>
            </Link>
            <a href="#act-1" className="btn btn-secondary">
              What went wrong first <span aria-hidden>↓</span>
            </a>
          </div>
          {facts.length > 0 ? (
            <dl className="mt-12 grid max-w-[34rem] grid-cols-2 gap-x-8 gap-y-5 border-t border-rule pt-6 sm:grid-cols-4">
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

        <div className="relative min-w-0">
          <div
            aria-hidden
            className="pointer-events-none absolute -inset-x-10 -inset-y-12 -z-10 opacity-60 blur-3xl"
            style={{
              background:
                'radial-gradient(40% 35% at 30% 30%, color-mix(in oklab, var(--arch-plan-execute) 22%, transparent), transparent 70%), radial-gradient(35% 30% at 75% 70%, color-mix(in oklab, var(--arch-gated-execute) 18%, transparent), transparent 70%)',
            }}
          />
          <div className="overflow-hidden rounded-[18px] border border-rule bg-surface/75 backdrop-blur-md">
            <p className="flex items-baseline justify-between px-5 pb-3 pt-4">
              <span className="eyebrow">Six architectures</span>
              <span className="eyebrow">one is the control</span>
            </p>
            <ol aria-label="The six architectures">
              {ARCHITECTURES.map((info, index) => (
                <li
                  key={info.id}
                  className="grid grid-cols-[4.75rem_minmax(0,1fr)_auto] items-center gap-4 border-t border-rule px-5 py-3.5 sm:grid-cols-[5.5rem_minmax(0,1fr)_auto]"
                >
                  <ArchitectureGlyph id={info.id} width={84} animated delayMs={150 + index * 160} className="h-auto w-full" />
                  <div className="min-w-0">
                    <p className="text-[0.9375rem] font-medium text-ink">{info.name}</p>
                    <p className="mt-0.5 text-[0.8125rem] leading-snug text-ink-2">{info.shape}</p>
                  </div>
                  <span className="num text-[0.75rem] text-muted">{String(index + 1).padStart(2, '0')}</span>
                </li>
              ))}
            </ol>
          </div>
        </div>
      </div>
    </section>
  );
}
