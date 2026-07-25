'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const LINKS = [
  { href: '/', label: 'Leaderboard' },
  { href: '/pareto', label: 'Score vs cost' },
  { href: '/matrix', label: 'Matrix' },
  { href: '/live', label: 'Run one live' },
];

export function SiteNav() {
  const pathname = usePathname();

  return (
    <header className="sticky top-0 z-30 border-b border-rule bg-plane/92 backdrop-blur">
      <div className="mx-auto flex w-full max-w-[80rem] flex-wrap items-center gap-x-6 gap-y-2 px-5 py-3 sm:px-8">
        <Link href="/" className="group flex items-baseline gap-2">
          <span className="font-mono text-[12px] uppercase tracking-[0.22em] text-ink">
            Agent&nbsp;Arena
          </span>
          <span className="hidden text-[11px] text-muted sm:inline">
            harness architectures, measured
          </span>
        </Link>

        <nav className="ml-auto flex items-center gap-1">
          {LINKS.map((link) => {
            const active =
              link.href === '/' ? pathname === '/' : pathname.startsWith(link.href);
            return (
              <Link
                key={link.href}
                href={link.href}
                aria-current={active ? 'page' : undefined}
                className={`rounded-[2px] px-2 py-1 text-[12px] transition-colors ${
                  active
                    ? 'bg-accent/12 text-accent'
                    : 'text-ink-2 hover:bg-sunken hover:text-ink'
                }`}
              >
                {link.label}
              </Link>
            );
          })}
        </nav>
      </div>
    </header>
  );
}
