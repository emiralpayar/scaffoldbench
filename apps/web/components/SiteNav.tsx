'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const LINKS = [
  { href: '/results/', label: 'Results', match: ['/results', '/runs'] },
  { href: '/matrix/', label: 'Matrix', match: ['/matrix', '/tasks'] },
  { href: '/pareto/', label: 'Cost', match: ['/pareto'] },
  { href: '/live/', label: 'Run it', match: ['/live'] },
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
            className={`relative rounded-full px-3 py-2 text-[0.9375rem] transition-colors ${
              active ? 'text-ink' : 'text-ink-2 hover:bg-sunken hover:text-ink'
            }`}
          >
            {link.label}
            {active ? (
              <span
                aria-hidden
                className="absolute inset-x-3 -bottom-[3px] h-[2px] rounded-full bg-ink"
              />
            ) : null}
          </Link>
        );
      })}
    </nav>
  );
}
