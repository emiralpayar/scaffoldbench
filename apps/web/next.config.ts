import path from 'node:path';

import type { NextConfig } from 'next';

import { BASE_PATH } from './lib/site';

const repoRoot = path.join(process.cwd(), '..', '..');

/**
 * Two build modes.
 *
 * Static (the default, and the public site): `output: 'export'` writes plain
 * HTML to `out/`, servable from GitHub Pages under `NEXT_PUBLIC_BASE_PATH`.
 * Nothing in it can run a model or ask for a key.
 *
 * Server (`NEXT_PUBLIC_SCAFFOLDBENCH_LIVE=1`): a Node server that also serves
 * `/api/live`, which runs one task on a visitor's own API key. The route file
 * is named `route.live.ts`, and only this mode lists `live.ts` as a page
 * extension, so the static build never sees a route it cannot export.
 */
const live = process.env.NEXT_PUBLIC_SCAFFOLDBENCH_LIVE === '1';

const nextConfig: NextConfig = {
  ...(live ? {} : { output: 'export' as const }),
  /** Normalised once, in `lib/site.ts`, so pages and config cannot disagree. */
  ...(BASE_PATH ? { basePath: BASE_PATH, assetPrefix: BASE_PATH } : {}),
  /** `/results/` → `results/index.html`, which every static host resolves. */
  trailingSlash: true,
  images: { unoptimized: true },
  pageExtensions: live ? ['live.ts', 'tsx', 'ts'] : ['tsx', 'ts'],
  /** The Agent SDK resolves a native binary at runtime; bundling it breaks that. */
  serverExternalPackages: ['@anthropic-ai/claude-agent-sdk'],
  /** The workspace packages ship TypeScript sources, so Next compiles them itself. */
  transpilePackages: ['@scaffoldbench/core', '@scaffoldbench/strategies', '@scaffoldbench/tasks'],
  /** Results and the core package both live above this app; trace from the repo root. */
  outputFileTracingRoot: repoRoot,
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
