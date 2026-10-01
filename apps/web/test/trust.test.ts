import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { TRUST_CLAIMS } from '../lib/trust';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

describe('trust claims', () => {
  it('names a file in this repository for every claim', () => {
    const missing = TRUST_CLAIMS.map((claim) => claim.source).filter(
      (source) => !existsSync(path.join(repoRoot, source)),
    );
    expect(missing).toEqual([]);
  });
});
