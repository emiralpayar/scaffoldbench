import type { ReactNode } from 'react';

export function PageHeader({
  eyebrow,
  title,
  lede,
  aside,
}: {
  eyebrow: string;
  title: string;
  lede?: string;
  aside?: ReactNode;
}) {
  return (
    <header className="mb-7 flex flex-wrap items-end justify-between gap-4 border-b border-rule pb-5">
      <div className="max-w-2xl">
        <p className="eyebrow">{eyebrow}</p>
        <h1 className="mt-1 font-serif text-[30px] leading-[1.15] tracking-[-0.01em] text-ink">
          {title}
        </h1>
        {lede ? <p className="prose-serif mt-2">{lede}</p> : null}
      </div>
      {aside ? <div className="shrink-0">{aside}</div> : null}
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
    <section className="mb-8 rounded-[3px] border border-rule bg-surface">
      {title ? (
        <div className="flex flex-wrap items-baseline justify-between gap-3 border-b border-rule px-4 py-2.5">
          <h2 className="eyebrow !text-ink-2">{title}</h2>
          {note ? <div className="text-[12px] text-muted">{note}</div> : null}
        </div>
      ) : null}
      <div className={bleed ? '' : 'p-4'}>{children}</div>
    </section>
  );
}

const TONE_CLASS = {
  neutral: 'border-rule text-ink-2',
  accent: 'border-accent/40 text-accent',
  good: 'border-good/40 text-good',
  bad: 'border-bad/40 text-bad',
  warn: 'border-warn/40 text-warn',
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
      className={`inline-flex items-center gap-1 rounded-[2px] border px-1.5 py-px font-mono text-[10px] uppercase tracking-[0.08em] ${TONE_CLASS[tone]}`}
    >
      {children}
    </span>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="eyebrow">{label}</div>
      <div className="num mt-0.5 truncate text-[13px] text-ink">{children}</div>
    </div>
  );
}

export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div className="min-w-0">
      <div className="eyebrow">{label}</div>
      <div className="num mt-1 text-[22px] leading-none tracking-[-0.01em] text-ink">{value}</div>
      {hint ? <div className="mt-1 text-[11px] text-muted">{hint}</div> : null}
    </div>
  );
}

/** A verdict glyph paired with its label, so state never rests on colour alone. */
export function Verdict({ ok, children }: { ok: boolean; children?: ReactNode }) {
  return (
    <span className={`inline-flex items-center gap-1.5 ${ok ? 'text-good' : 'text-bad'}`}>
      <span aria-hidden className="font-mono text-[12px] leading-none">
        {ok ? '✓' : '✗'}
      </span>
      <span className="text-[12px]">{children ?? (ok ? 'pass' : 'fail')}</span>
    </span>
  );
}
