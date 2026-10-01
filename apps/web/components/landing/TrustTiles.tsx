import { sourceUrl } from '../../lib/site';

interface Tile {
  title: string;
  body: string;
  /** The file a reader can open to check the claim. */
  source: string;
  icon: keyof typeof ICONS;
}

/**
 * Why the numbers can be trusted, each claim pointing at the file that
 * enforces it. "Show me the line" is the only kind of trust an engineer
 * extends to a benchmark.
 */
const TILES: Tile[] = [
  {
    title: 'Proof the design ran',
    body: 'Each architecture declares what running as designed looks like: a non-empty plan, a real fan-out, a parsed verdict. A run that fails a check is excluded from rankings and counted, never scored.',
    source: 'apps/web/lib/records.ts',
    icon: 'check',
  },
  {
    title: 'Same inputs for every design',
    body: 'Every architecture gets the same model, tools, task prompt, domain policy and budget. Only the harness around the model changes.',
    source: 'packages/core/src/systemPrompt.ts',
    icon: 'equal',
  },
  {
    title: 'Scored by state, not by vibes',
    body: 'Tool-use tasks are graded by checking the final state of the world and the journal of tool calls. No language model decides who won.',
    source: 'packages/tasks/src/defineToolUseTask.ts',
    icon: 'grid',
  },
  {
    title: 'A sandbox that says no',
    body: 'A guard denies any tool outside the task’s toolset, before it runs, and every denial is written to the trace.',
    source: 'packages/core/src/guard.ts',
    icon: 'shield',
  },
  {
    title: 'Paired, task-clustered statistics',
    body: 'Architectures are compared on the same task and repeat, bootstrapped over tasks so repeats are not mistaken for independent evidence.',
    source: 'apps/web/lib/analysis.ts',
    icon: 'pair',
  },
  {
    title: 'Outages are not failures',
    body: 'A run lost to the API is never scored as the architecture failing. It is excluded from every ranking and reported in the health count.',
    source: 'apps/web/lib/records.ts',
    icon: 'pulse',
  },
];

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
          {TILES.map((tile) => {
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
