import { sourceUrl } from '../../lib/site';
import { TRUST_CLAIMS } from '../../lib/trust';

/** The trust claims as tiles, each linking to the file that enforces it. */
export function TrustTiles() {
  return (
    <section aria-labelledby="trust-title" className="section border-t border-rule">
      <div className="container-page">
        <div className="max-w-[46rem]">
          <p className="eyebrow">Why you can trust this</p>
          <h2 id="trust-title" className="h1 mt-4 text-ink">
            Trust, but verify: each claim links to the code that enforces it.
          </h2>
        </div>
        <ul className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {TRUST_CLAIMS.map((tile) => {
            const href = sourceUrl(tile.source);
            return (
              <li key={tile.title} className="card flex flex-col p-6">
                <span
                  aria-hidden
                  className="flex h-10 w-10 items-center justify-center rounded-full border border-rule-strong text-ink"
                >
                  {ICONS[tile.icon]}
                </span>
                <h3 className="mt-5 text-[1.0625rem] font-medium text-ink">{tile.title}</h3>
                <p className="mt-2 flex-1 text-[0.9375rem] leading-relaxed text-ink-2">{tile.body}</p>
                <p className="mt-5 border-t border-rule pt-4 font-mono text-[0.75rem] text-muted">
                  {href ? (
                    <a href={href} className="link !text-ink-2 [overflow-wrap:anywhere]">
                      {tile.source}
                    </a>
                  ) : (
                    <span className="[overflow-wrap:anywhere]">{tile.source}</span>
                  )}
                </p>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}

const stroke = { stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', fill: 'none' } as const;

const ICONS = {
  check: (
    <svg viewBox="0 0 20 20" width={18} height={18}>
      <path d="M4 10.5 8 14.5 16 5.5" {...stroke} />
    </svg>
  ),
  equal: (
    <svg viewBox="0 0 20 20" width={18} height={18}>
      <path d="M4 7.5h12M4 12.5h12" {...stroke} />
    </svg>
  ),
  grid: (
    <svg viewBox="0 0 20 20" width={18} height={18}>
      <rect x={3.5} y={3.5} width={5} height={5} rx={1} {...stroke} />
      <rect x={11.5} y={3.5} width={5} height={5} rx={1} {...stroke} />
      <rect x={3.5} y={11.5} width={5} height={5} rx={1} {...stroke} />
      <path d="m12 14 1.6 1.6L16.5 12" {...stroke} />
    </svg>
  ),
  shield: (
    <svg viewBox="0 0 20 20" width={18} height={18}>
      <path d="M10 2.8 4 5v4.6c0 3.6 2.6 6.3 6 7.6 3.4-1.3 6-4 6-7.6V5l-6-2.2Z" {...stroke} />
      <path d="M7.5 10h5" {...stroke} />
    </svg>
  ),
  pair: (
    <svg viewBox="0 0 20 20" width={18} height={18}>
      <circle cx={6} cy={6} r={2.2} {...stroke} />
      <circle cx={14} cy={14} r={2.2} {...stroke} />
      <path d="M7.6 7.6l4.8 4.8M6 10.5v5M14 4.5v5" {...stroke} />
    </svg>
  ),
  pulse: (
    <svg viewBox="0 0 20 20" width={18} height={18}>
      <path d="M2.5 10.5h3.5l2-5 4 9 2-4h3.5" {...stroke} />
    </svg>
  ),
} as const;
