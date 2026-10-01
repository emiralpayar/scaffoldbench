/**
 * Site-wide constants and the deployment knobs, all read at build time.
 *
 * - `NEXT_PUBLIC_BASE_PATH`: the sub-path the static export is served under,
 *   e.g. `/scaffoldbench` on GitHub Pages. Empty for a root deployment.
 * - `NEXT_PUBLIC_SITE_URL`: the absolute origin plus base path, used for
 *   canonical URLs, the sitemap and social cards.
 * - `NEXT_PUBLIC_REPO_URL`: the repository, for "view source" links. Unset,
 *   source paths render as plain text instead of links to nowhere.
 * - `NEXT_PUBLIC_ARENA_LIVE=1`: server mode. Builds a Node server with the
 *   `/api/live` route instead of a static export. The public site never sets it.
 *
 * Pure and client-safe: `NEXT_PUBLIC_*` values are inlined into the bundle.
 */

export const SITE_NAME = 'ScaffoldBench';
export const TAGLINE = 'Does your agent scaffold pay for itself?';
export const SITE_DESCRIPTION =
  'An open benchmark of agent harness architectures on the Claude Agent SDK: the same models, tools and tasks for every design, a fidelity gate that proves each architecture actually ran, and paired statistics with confidence intervals on every number.';

function normalizeBasePath(value: string | undefined): string {
  if (!value || value === '/') return '';
  const trimmed = value.replace(/\/+$/, '');
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

export const BASE_PATH = normalizeBasePath(process.env.NEXT_PUBLIC_BASE_PATH);

export const SITE_URL = (
  process.env.NEXT_PUBLIC_SITE_URL || `http://localhost:3210${BASE_PATH}`
).replace(/\/+$/, '');

export const REPO_URL = process.env.NEXT_PUBLIC_REPO_URL?.replace(/\/+$/, '') || undefined;

export const LIVE_ENABLED = process.env.NEXT_PUBLIC_ARENA_LIVE === '1';

/**
 * Prefix a root-relative URL with the base path. `next/link` and the metadata
 * file conventions do this themselves; `fetch()` and plain `<a href>` do not.
 */
export function withBasePath(pathname: string): string {
  return `${BASE_PATH}${pathname.startsWith('/') ? pathname : `/${pathname}`}`;
}

/** Absolute URL for a route, e.g. for the sitemap. `SITE_URL` already holds the base path. */
export function absoluteUrl(pathname: string): string {
  return `${SITE_URL}${pathname.startsWith('/') ? pathname : `/${pathname}`}`;
}

/** Link to a file in the repository, or `undefined` when no repository URL is configured. */
export function sourceUrl(repoPath: string): string | undefined {
  return REPO_URL ? `${REPO_URL}/blob/main/${repoPath}` : undefined;
}

/** Link to a directory in the repository, or `undefined` without a repository URL. */
export function treeUrl(repoPath: string): string | undefined {
  return REPO_URL ? `${REPO_URL}/tree/main/${repoPath}` : undefined;
}
