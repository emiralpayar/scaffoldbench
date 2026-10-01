import Link from 'next/link';
import type { ReactNode } from 'react';

interface Destination {
  href: string;
  title: string;
  body: string;
  art: ReactNode;
}

const DESTINATIONS: Destination[] = [
  {
    href: '/results/',
    title: 'Results',
    body: 'Every architecture on one model at a time: mean score with its interval, cost and latency.',
    art: <ForestArt />,
  },
  {
    href: '/matrix/',
    title: 'Where it breaks',
    body: 'Architecture by task, down to every repeat. Click a square to read the run.',
    art: <MatrixArt />,
  },
  {
    href: '/pareto/',
    title: 'Score against cost',
    body: 'The plane architectures are actually chosen on, with intervals on both axes.',
    art: <ScatterArt />,
  },
  {
    href: '/live/',
    title: 'Run it yourself',
    body: 'One command re-runs any cell of the benchmark on your own machine and key.',
    art: <TerminalArt />,
  },
];

export function Explore() {
  return (
    <section aria-labelledby="explore-title" className="section border-t border-rule">
      <div className="container-page">
        <p className="eyebrow">Explore</p>
        <h2 id="explore-title" className="h1 mt-4 max-w-[40rem] text-ink">
          Go as deep as the data goes.
        </h2>
        <ul className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {DESTINATIONS.map((destination) => (
            <li key={destination.href}>
              <Link
                href={destination.href}
                className="card group flex h-full flex-col p-6 transition-[border-color,transform] duration-200 hover:-translate-y-0.5 hover:border-rule-strong"
              >
                <div className="flex h-20 items-center text-ink-2" aria-hidden>
                  {destination.art}
                </div>
                <h3 className="mt-5 flex items-center justify-between text-[1.0625rem] font-medium text-ink">
                  {destination.title}
                  <span aria-hidden className="text-muted transition-transform duration-200 group-hover:translate-x-1">
                    →
                  </span>
                </h3>
                <p className="mt-2 text-[0.9375rem] leading-relaxed text-ink-2">{destination.body}</p>
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

/* Small illustrative marks, drawn in the site's own chart language. */

function ForestArt() {
  const rows = [
    ['var(--arch-single)', 40, 70],
    ['var(--arch-plan-execute)', 52, 88],
    ['var(--arch-plan-execute-verify)', 70, 112],
    ['var(--arch-gated-execute)', 60, 96],
  ] as const;
  return (
    <svg viewBox="0 0 140 72" width={140} height={72}>
      {rows.map(([color, a, b], i) => (
        <g key={i} stroke={color} strokeWidth={2} strokeLinecap="round">
          <line x1={a} x2={b} y1={12 + i * 16} y2={12 + i * 16} />
          <circle cx={(a + b) / 2} cy={12 + i * 16} r={4} fill={color} stroke="none" />
        </g>
      ))}
    </svg>
  );
}

function MatrixArt() {
  const fills = ['var(--good)', 'var(--good)', 'none', 'var(--good)', 'var(--warn)', 'var(--good)'];
  return (
    <svg viewBox="0 0 140 72" width={140} height={72}>
      {Array.from({ length: 4 }, (_, r) =>
        Array.from({ length: 6 }, (_, c) => {
          const fill = fills[(r * 5 + c * 3) % fills.length] as string;
          return (
            <rect
              key={`${r}-${c}`}
              x={6 + c * 22}
              y={6 + r * 16}
              width={11}
              height={11}
              rx={2.5}
              fill={fill === 'none' ? 'none' : fill}
              stroke={fill === 'none' ? 'var(--bad)' : fill}
              strokeWidth={1.6}
            />
          );
        }),
      )}
    </svg>
  );
}

function ScatterArt() {
  const points = [
    [22, 52, 'var(--arch-single)'],
    [48, 40, 'var(--arch-plan-execute)'],
    [78, 24, 'var(--arch-plan-execute-verify)'],
    [104, 30, 'var(--arch-propose-select)'],
    [122, 46, 'var(--arch-orchestrator-workers)'],
  ] as const;
  return (
    <svg viewBox="0 0 140 72" width={140} height={72}>
      <path d="M 22 52 H 48 V 40 H 78 V 24" fill="none" stroke="var(--ink-2)" strokeWidth={1.4} opacity={0.6} />
      {points.map(([x, y, color], i) => (
        <g key={i} stroke={color} strokeWidth={2} strokeLinecap="round">
          <line x1={x} x2={x} y1={y - 9} y2={y + 9} opacity={0.8} />
          <circle cx={x} cy={y} r={4.5} fill={color} stroke="none" />
        </g>
      ))}
    </svg>
  );
}

function TerminalArt() {
  return (
    <svg viewBox="0 0 140 72" width={140} height={72}>
      <rect x={4} y={6} width={132} height={60} rx={8} fill="none" stroke="var(--rule-strong)" strokeWidth={1.4} />
      <path d="M16 26 24 33 16 40" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />
      <line x1={30} x2={92} y1={40} y2={40} stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" />
      <line x1={16} x2={70} y1={54} y2={54} stroke="var(--good)" strokeWidth={1.8} strokeLinecap="round" />
    </svg>
  );
}
