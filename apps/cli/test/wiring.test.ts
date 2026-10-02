import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { REPO_ROOT } from '@arena/core';

/**
 * `check-wiring --init-only` is documented as free, and `arena doctor
 * --wiring` and the CI canary rely on that. It starts four real Claude Code
 * sessions, and a session sends its first request right after it reports its
 * tools, so "stopped at start-up" alone is not free: this test points the
 * sessions at a server that counts what reaches it, with a credential in the
 * environment, and requires that nothing does.
 */

const run = promisify(execFile);

let server: Server;
let port: number;
const requests: string[] = [];

beforeAll(async () => {
  server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    response.writeHead(500).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  port = typeof address === 'object' && address ? address.port : 0;
});
afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

describe('check-wiring --init-only', () => {
  it('passes without sending a single request, even with a credential and an endpoint to send it to', async () => {
    const { stdout } = await run(
      process.execPath,
      ['--import', 'tsx', path.join(REPO_ROOT, 'scripts', 'check-wiring.ts'), '--init-only'],
      {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
          ANTHROPIC_API_KEY: `sk-ant-api03-${'0'.repeat(48)}`,
        },
        timeout: 60_000,
      },
    );

    expect(stdout).toMatch(/Wiring check OK \(init only\)/);
    expect(requests).toEqual([]);
    // Four real Claude Code processes: seconds on a laptop, longer on a loaded runner.
  }, 60_000);
});
