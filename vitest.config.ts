import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@arena/core': `${root}packages/core/src/index.ts`,
      '@arena/strategies': `${root}packages/strategies/src/index.ts`,
      '@arena/tasks': `${root}packages/tasks/src/index.ts`,
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20_000,
  },
});
