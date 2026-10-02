import Link from 'next/link';

import { REPO_URL, SITE_NAME, TAGLINE } from '../lib/site';
import { LogoMark, Wordmark } from './Logo';
import { SiteNav } from './SiteNav';
import { ThemeToggle } from './ThemeToggle';

export function SiteHeader() {
  return (
    <header className="z-40 border-b sm:sticky sm:top-0 border-rule bg-plane/85 backdrop-blur-md backdrop-saturate-150">
      <div className="container-page flex flex-wrap items-center gap-x-4 gap-y-1 py-2.5">
        <Link href="/" className="flex items-center gap-2.5 text-ink" aria-label={`${SITE_NAME} home`}>
          <LogoMark size={28} />
          <Wordmark />
        </Link>

        <div className="order-3 -mx-2 w-full overflow-x-auto sm:order-none sm:mx-0 sm:ml-auto sm:w-auto">
          <SiteNav />
        </div>

        <div className="ml-auto flex items-center gap-1 sm:ml-0">
          {REPO_URL ? (
            <a
              href={REPO_URL}
              className="inline-flex h-10 w-10 items-center justify-center rounded-full text-ink-2 transition-colors hover:bg-sunken hover:text-ink"
              aria-label="Source code on GitHub"
              title="Source code on GitHub"
            >
              <GitHubIcon />
            </a>
          ) : null}
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="border-t border-rule">
      <div className="container-page flex flex-col gap-6 py-10 sm:flex-row sm:items-end sm:justify-between">
        <div className="max-w-md">
          <div className="flex items-center gap-2.5 text-ink">
            <LogoMark size={24} />
            <Wordmark className="text-[1.0625rem]" />
          </div>
          <p className="mt-3 text-[0.9375rem] leading-relaxed text-ink-2">
            {TAGLINE} An open benchmark of agent harness architectures, built on the Claude Agent SDK.
          </p>
        </div>
        <nav aria-label="Footer" className="flex flex-wrap gap-x-6 gap-y-2 text-[0.9375rem]">
          <Link href="/results/" className="link">
            Results
          </Link>
          <Link href="/matrix/" className="link">
            Matrix
          </Link>
          <Link href="/strategies/" className="link">
            Designs
          </Link>
          <Link href="/pareto/" className="link">
            Score vs cost
          </Link>
          <Link href="/methodology/" className="link">
            Methodology
          </Link>
          <Link href="/health/" className="link">
            Harness health
          </Link>
          <Link href="/postmortem/" className="link">
            Post-mortem
          </Link>
          <Link href="/live/" className="link">
            Run it yourself
          </Link>
          {REPO_URL ? (
            <a href={REPO_URL} className="link">
              Source (MIT)
            </a>
          ) : null}
        </nav>
      </div>
    </footer>
  );
}

function GitHubIcon() {
  return (
    <svg viewBox="0 0 16 16" width={18} height={18} aria-hidden fill="currentColor">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}
