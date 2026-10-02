'use client';

import { usePathname } from 'next/navigation';

import Link from './Link';

const LINKS = [
  { href: '/results/', label: 'Results', match: ['/results', '/runs', '/pareto'] },
  { href: '/matrix/', label: 'Matrix', match: ['/matrix', '/tasks'] },
  { href: '/strategies/', label: 'Designs', match: ['/strategies'] },
  { href: '/methodology/', label: 'Method', match: ['/methodology', '/health', '/postmortem'] },
  { href: '/live/', label: 'Replay', match: ['/live'] },
];

/** Primary navigation. Client-side only to know which section is current. */
export function SiteNav() {
  const pathname = usePathname() ?? '/';

  return (
    <nav aria-label="Primary" className="flex items-center gap-1">
      {LINKS.map((link) => {
        const active = link.match.some((prefix) => pathname.startsWith(prefix));
        return (
          <Link
            key={link.href}
            href={link.href}
            aria-current={active ? 'page' : undefined}
            className={`relative rounded-full px-2.5 py-2 text-[0.9375rem] transition-colors sm:px-3 ${
              active ? 'text-ink' : 'text-ink-2 hover:bg-sunken hover:text-ink'
            }`}
          >
            {link.label}
            {active ? (
              <span
                aria-hidden
                className="absolute inset-x-2.5 -bottom-[3px] h-[2px] rounded-full bg-ink sm:inset-x-3"
              />
            ) : null}
          </Link>
        );
      })}
    </nav>
  );
}
