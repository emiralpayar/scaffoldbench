'use client';

import { useEffect, useState } from 'react';

import { THEME_STORAGE_KEY } from '../lib/theme';

type Theme = 'light' | 'dark';

function currentTheme(): Theme {
  const explicit = document.documentElement.getAttribute('data-theme');
  if (explicit === 'light' || explicit === 'dark') return explicit;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/**
 * Light/dark switch. Without a stored choice the site follows the OS; a click
 * pins the other theme and remembers it in this browser only.
 */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme | null>(null);

  useEffect(() => {
    setTheme(currentTheme());
  }, []);

  const next: Theme = theme === 'dark' ? 'light' : 'dark';

  return (
    <button
      type="button"
      onClick={() => {
        document.documentElement.setAttribute('data-theme', next);
        try {
          localStorage.setItem(THEME_STORAGE_KEY, next);
        } catch {
          // Private windows can refuse storage; the switch still works for this page.
        }
        setTheme(next);
      }}
      aria-label={theme ? `Switch to ${next} theme` : 'Switch theme'}
      title={theme ? `Switch to ${next} theme` : 'Switch theme'}
      className="inline-flex h-10 w-10 shrink-0 cursor-pointer items-center justify-center rounded-full text-ink-2 transition-colors hover:bg-sunken hover:text-ink"
    >
      <svg viewBox="0 0 20 20" width={18} height={18} aria-hidden fill="none">
        {/* A half-filled disc reads as "theme" in either state, so no icon swap or flash. */}
        <circle cx={10} cy={10} r={7.25} stroke="currentColor" strokeWidth={1.5} />
        <path d="M10 2.75a7.25 7.25 0 0 1 0 14.5Z" fill="currentColor" />
      </svg>
    </button>
  );
}
