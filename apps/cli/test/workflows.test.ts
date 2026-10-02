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

/** A workflow's jobs by id: each starts at a key two spaces in, under `jobs:`. */
function jobs(workflow: string): Record<string, string> {
  const found: Record<string, string> = {};
  for (const job of workflow.slice(workflow.indexOf('\njobs:') + 1).split(/\n(?=  [a-z][\w-]*:\n)/).slice(1)) {
    found[/^ {2}([\w-]+):/.exec(job)?.[1] ?? ''] = job;
  }
  return found;
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
    // Nothing above the steps (workflow or job env) names it either; comments may.
    expect(code(text.slice(0, text.indexOf('    steps:')))).not.toMatch(/ANTHROPIC_API_KEY/);
  });

  it('keeps the key and the power to write in different jobs', async () => {
    const text = await read('bench.yml');
    const { bench, propose, ...others } = jobs(text);
    expect(Object.keys(others)).toEqual([]);
    expect(bench).toBeDefined();
    expect(propose).toBeDefined();

    // The workflow is read-only unless a job asks for more, and only `propose` does.
    const workflowPermissions = text.slice(0, text.indexOf('\njobs:'));
    expect(workflowPermissions).toMatch(/permissions:\n {2}contents: read\n/);
    expect(workflowPermissions).not.toMatch(/: write/);
    expect(bench).not.toMatch(/: write/);
    expect(propose).toMatch(/contents: write/);
    expect(propose).toMatch(/pull-requests: write/);

    // The job that runs the model holds the key but not a token that could use it to change the repository.
    expect(bench).toMatch(/secrets\.ANTHROPIC_API_KEY/);
    expect(bench).toMatch(/uses: actions\/checkout@[0-9a-f]{40}.*\n\s+with:\n\s+# .*\n\s+persist-credentials: false/);
    expect(bench).toMatch(/environment: benchmark/);

    // The job that can write has no key, installs nothing and runs nothing from the repository.
    expect(code(propose ?? '')).not.toMatch(/secrets\.|ANTHROPIC_API_KEY/);
    expect(code(propose ?? '')).not.toMatch(/npm |npx |setup-node|arena/);
  });

  it('proposes a result only once the gate has passed', async () => {
    const text = await read('bench.yml');
    const { propose } = jobs(text);
    // `needs` alone means "after it succeeded"; an `if:` could say otherwise.
    expect(propose).toMatch(/needs: bench\n/);
    expect(propose).not.toMatch(/\n {4}if:/);
    // The gate is the last thing the benchmark job does.
    const benchSteps = steps(jobs(text).bench ?? '');
    expect(benchSteps[benchSteps.length - 1]).toMatch(/name: Health gate/);
  });

  it('looks for the key in the results before they leave the job that held it', async () => {
    const text = await read('bench.yml');
    const run = steps(text).find((step) => step.includes('name: Run the benchmark')) ?? '';
    const check = /leak_check\(\) \{[\s\S]*?\n {10}\}/.exec(run)?.[0] ?? '';
    expect(check).toMatch(/grep -rqF -- "\$ANTHROPIC_API_KEY" "results\/\$BENCH_RUN_SET"/);
    // Delete, not just fail: the upload that follows runs whatever the step did.
    expect(check).toMatch(/rm -rf "results\/\$BENCH_RUN_SET"/);
    expect(run).toMatch(/trap leak_check EXIT/);
    // ...and only after the key is known to be non-empty, since an empty pattern matches everything.
    expect(run.indexOf('-z "$ANTHROPIC_API_KEY"')).toBeGreaterThan(-1);
    expect(run.indexOf('-z "$ANTHROPIC_API_KEY"')).toBeLessThan(run.indexOf('trap leak_check'));
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

describe.each(['bench.yml', 'ci.yml'])('%s', (name) => {
  it('gives every job a time limit, so a hung step cannot hold a runner for six hours', async () => {
    const all = jobs(await read(name));
    expect(Object.keys(all).length).toBeGreaterThan(0);
    for (const [id, job] of Object.entries(all)) expect(job, id).toMatch(/\n {4}timeout-minutes: \d+\n/);
  });
});
