import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { REPO_ROOT } from '@arena/core';

/**
 * The properties of the two workflows that exist to keep money and results
 * safe, checked as text (there is no YAML parser to depend on). They are not
 * a substitute for actionlint; they stop a later edit from quietly undoing a
 * decision that was made on purpose.
 */

const read = (name: string) => readFile(path.join(REPO_ROOT, '.github', 'workflows', name), 'utf8');

/** The workflow without its comments, which are free to say what they must not contain. */
const code = (workflow: string) => workflow.replace(/^\s*#.*$/gm, '');

/** Split a workflow into its steps: each starts at a `- ` at step indentation. */
function steps(workflow: string): string[] {
  return workflow.split(/\n(?=      - )/).slice(1);
}

describe('bench.yml', () => {
  it('runs only when someone dispatches it', async () => {
    const text = await read('bench.yml');
    const triggers = text.slice(text.indexOf('\non:'), text.indexOf('\nconcurrency:'));
    expect(triggers).toMatch(/workflow_dispatch:/);
    expect(triggers).not.toMatch(/schedule:|cron:|push:|pull_request/);
  });

  it('gives the API key to the benchmark step and to nothing else', async () => {
    const text = await read('bench.yml');
    expect(text.match(/secrets\.ANTHROPIC_API_KEY/g)).toHaveLength(1);
    const holder = steps(text).filter((step) => step.includes('secrets.ANTHROPIC_API_KEY'));
    expect(holder).toHaveLength(1);
    expect(holder[0]).toMatch(/name: Run the benchmark/);
    // Nothing above the steps (workflow or job env) mentions it either.
    expect(text.slice(0, text.indexOf('    steps:'))).not.toMatch(/ANTHROPIC_API_KEY/);
  });

  it('keeps the results whatever happened, and gates what it publishes', async () => {
    const text = await read('bench.yml');
    const all = steps(text);
    const upload = all.find((step) => step.includes('actions/upload-artifact'));
    expect(upload).toMatch(/if: always\(\)/);
    expect(upload).toMatch(/path: results\/\$\{\{ env\.BENCH_RUN_SET \}\}/);

    const names = all.map((step) => /name: (.+)/.exec(step)?.[1] ?? '');
    const at = (name: string) => names.findIndex((candidate) => candidate.startsWith(name));
    expect(at('Run the benchmark')).toBeLessThan(at('Keep the results'));
    // The gate sits between the run and the pull request, and is not optional.
    const gate = all[at('Health gate')];
    expect(gate).toMatch(/report "\$BENCH_RUN_SET" --strict/);
    expect(gate).not.toMatch(/if:|continue-on-error/);
    expect(at('Health gate')).toBeLessThan(at('Open a pull request'));
  });

  it('proposes the result as a pull request and never pushes to a protected branch', async () => {
    const text = await read('bench.yml');
    expect(text).toMatch(/gh pr create/);
    expect(text).toMatch(/git push origin "\$branch"/);
    expect(text).not.toMatch(/git push\s*$/m);
    expect(text).not.toMatch(/git push (origin )?(HEAD:)?(main|master)/);
  });

  it('names its run set instead of guessing, and never reaches for the synthetic one', async () => {
    const text = await read('bench.yml');
    expect(text).toMatch(/--run-set "\$BENCH_RUN_SET"/);
    expect(text).not.toMatch(/demo-synthetic|latest\.json.*sort|readdirSync/);
  });

  it('routes inputs through the environment, not into the script text', async () => {
    const text = await read('bench.yml');
    const scripts = steps(text)
      .flatMap((step) => step.split(/\n {8}run: /).slice(1))
      .join('\n');
    expect(scripts).not.toMatch(/\$\{\{\s*(inputs|github\.event)\./);
  });

  it('pins every third-party action to a commit', async () => {
    const text = await read('bench.yml');
    for (const use of text.matchAll(/uses: (\S+)/g)) expect(use[1]).toMatch(/@[0-9a-f]{40}$/);
  });
});

describe('ci.yml', () => {
  it('checks a commit once, and on both supported Node lines', async () => {
    const text = await read('ci.yml');
    const triggers = text.slice(text.indexOf('\non:'), text.indexOf('\nconcurrency:'));
    expect(triggers).toMatch(/push:\s+branches: \[main\]/);
    expect(triggers).toMatch(/pull_request:/);
    expect(triggers).not.toMatch(/'\*\*'/);
    expect(text).toMatch(/node: \[22, 24\]/);
  });

  it('smoke-tests the CLI without a model call or a credential', async () => {
    const text = code(await read('ci.yml'));
    expect(text).not.toMatch(/ANTHROPIC_API_KEY|secrets\./);
    for (const command of ['arena -- tasks', 'arena -- strategies', 'arena -- report']) {
      expect(text).toContain(command);
    }
  });

  it('pins every third-party action to a commit', async () => {
    const text = await read('ci.yml');
    for (const use of text.matchAll(/uses: (\S+)/g)) expect(use[1]).toMatch(/@[0-9a-f]{40}$/);
  });
});
