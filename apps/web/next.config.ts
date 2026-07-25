import path from 'node:path';

import type { NextConfig } from 'next';

const repoRoot = path.join(process.cwd(), '..', '..');

const nextConfig: NextConfig = {
  /** @arena/core ships TypeScript sources, so Next has to compile it itself. */
  transpilePackages: ['@arena/core'],
  /** Results and the core package both live above this app; trace from the repo root. */
  outputFileTracingRoot: repoRoot,
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
