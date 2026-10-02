import type { ReactNode } from 'react';

/** One thing the traces showed: what broke, the receipts, and what it looked like. */
export function Cause({
  number,
  title,
  receipts,
  children,
}: {
  number: number;
  title: string;
  receipts: { value: string; label: ReactNode }[];
  children: ReactNode;
}) {
  return (
    <article className="grid gap-x-10 gap-y-6 border-t border-rule py-10 first:border-t-0 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
      <div className="min-w-0">
        <p className="eyebrow flex items-center gap-3">
          <span className="num inline-flex h-6 w-6 items-center justify-center rounded-full border border-rule-strong text-[0.75rem] text-ink">
            {number}
          </span>
          What the traces showed
        </p>
        <h3 className="h3 mt-3 text-ink">{title}</h3>
        <div className="prose-serif mt-4 space-y-4">{children}</div>
      </div>
      <dl className="grid content-start gap-px self-start overflow-hidden rounded-[14px] border border-rule bg-rule">
        {receipts.map((receipt) => (
          <div key={receipt.value + String(receipt.label)} className="grid grid-cols-[5.5rem_minmax(0,1fr)] items-baseline gap-x-4 bg-surface px-4 py-3.5">
            <dt className="num text-[1.375rem] leading-none text-ink">{receipt.value}</dt>
            <dd className="text-[0.875rem] leading-snug text-ink-2">{receipt.label}</dd>
          </div>
        ))}
      </dl>
    </article>
  );
}

/**
 * Words from a trace, set apart. The model speaking is set in the UI face, as
 * everywhere on the site, and the source run is named so the quote can be
 * found in the file it came from.
 */
export function Evidence({
  children,
  source,
  href,
  note,
}: {
  children: ReactNode;
  source: string;
  href?: string | undefined;
  note: string;
}) {
  return (
    <figure className="rounded-[12px] border border-rule bg-sunken px-4 py-3.5">
      <blockquote className="text-[0.875rem] leading-relaxed text-ink">{children}</blockquote>
      <figcaption className="mt-2.5 text-[0.75rem] leading-snug text-muted">
        {note}{' '}
        {href ? (
          <a href={href} className="link font-mono text-[0.6875rem] [overflow-wrap:anywhere]">
            {source}
          </a>
        ) : (
          <span className="font-mono text-[0.6875rem] [overflow-wrap:anywhere]">{source}</span>
        )}
      </figcaption>
    </figure>
  );
}
