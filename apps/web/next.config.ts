import path from 'node:path';

import type { NextConfig } from 'next';

const repoRoot = path.join(process.cwd(), '..', '..');

const nextConfig: NextConfig = {
  /** The workspace packages ship TypeScript sources, so Next compiles them itself. */
  transpilePackages: ['@arena/core', '@arena/strategies', '@arena/tasks'],
  /** Results and the core package both live above this app; trace from the repo root. */
  outputFileTracingRoot: repoRoot,
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
