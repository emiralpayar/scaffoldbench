import type { ReactNode } from 'react';

export function PageHeader({
  eyebrow,
  title,
  lede,
  aside,
  /** Identifiers read better in the data face than in the prose one. */
  mono = false,
}: {
  eyebrow: string;
  title: ReactNode;
  lede?: string;
  aside?: ReactNode;
  mono?: boolean;
}) {
  return (
    <header className="mb-10 grid gap-6 border-b border-rule pb-8 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
      <div className="min-w-0 max-w-3xl">
        <p className="eyebrow">{eyebrow}</p>
        <h1
          className={
            mono
              ? 'mt-3 font-mono text-[1.25rem] leading-snug text-ink [overflow-wrap:anywhere] sm:text-[1.5rem]'
              : 'h1 mt-3 text-ink'
          }
        >
          {title}
        </h1>
        {lede ? <p className="lede mt-4">{lede}</p> : null}
      </div>
      {/* min-w-0 rather than shrink-0: a long tag row must wrap, not widen the page. */}
      {aside ? <div className="min-w-0 max-w-full">{aside}</div> : null}
    </header>
  );
}

export function Panel({
  title,
  note,
  children,
  bleed = false,
}: {
  title?: string;
  note?: ReactNode;
  children: ReactNode;
  /** Let the child own its own padding — used for tables that scroll edge to edge. */
  bleed?: boolean;
}) {
  return (
    <section className="card mb-8 overflow-hidden">
      {title ? (
        <div className="flex flex-wrap items-baseline justify-between gap-3 border-b border-rule px-5 py-3">
          <h2 className="eyebrow !text-ink-2">{title}</h2>
          {note ? <div className="text-[0.8125rem] text-muted">{note}</div> : null}
        </div>
      ) : null}
      <div className={bleed ? '' : 'p-5'}>{children}</div>
    </section>
  );
}

const TONE_CLASS = {
  neutral: 'border-rule-strong text-ink-2',
  accent: 'border-focus/45 text-focus',
  good: 'border-good/45 text-good',
  bad: 'border-bad/45 text-bad',
  warn: 'border-warn/50 text-warn',
} as const;

export function Tag({
  children,
  tone = 'neutral',
}: {
  children: ReactNode;
  tone?: keyof typeof TONE_CLASS;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 font-mono text-[0.6875rem] uppercase leading-normal tracking-[0.08em] ${TONE_CLASS[tone]}`}
    >
      {children}
    </span>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="eyebrow">{label}</div>
      <div className="num mt-1 truncate text-[0.875rem] text-ink">{children}</div>
    </div>
  );
}

export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div className="min-w-0">
      <div className="eyebrow">{label}</div>
      <div className="mt-1.5 font-sans text-[1.75rem] font-[480] leading-none tracking-[-0.02em] text-ink">
        {value}
      </div>
      {hint ? <div className="mt-1.5 text-[0.75rem] text-muted">{hint}</div> : null}
    </div>
  );
}

export type VerdictState = 'pass' | 'partial' | 'fail';

const VERDICT = {
  pass: { glyph: '✓', className: 'text-good' },
  partial: { glyph: '◐', className: 'text-warn' },
  fail: { glyph: '✗', className: 'text-bad' },
} as const;

/** A glyph paired with its label, so an outcome never rests on colour alone. */
export function Verdict({ state, children }: { state: VerdictState; children?: ReactNode }) {
  const { glyph, className } = VERDICT[state];
  return (
    <span className={`inline-flex items-center gap-1.5 ${className}`}>
      <span aria-hidden className="font-mono text-[0.8125rem] leading-none">
        {glyph}
      </span>
      <span className="text-[0.8125rem]">{children ?? state}</span>
    </span>
  );
}
