/**
 * `scaffoldbench doctor`: is this machine ready to run the benchmark, and what will
 * a run bill? Every check prints one ✓ / ⚠ / ✗ line; any ✗ exits 1.
 *
 * Nothing here calls a model unless `--wiring-live` asks for it. The account
 * check starts a Claude Code session and asks it which credential it would
 * use, which the CLI answers before any request is made.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { query } from '@anthropic-ai/claude-agent-sdk';
import { FIXTURES_DIR, REPO_ROOT, gitState, hermeticOptions, sdkVersions } from '@scaffoldbench/core';
import { ALL_TASKS } from '@scaffoldbench/tasks';

import type { DoctorArgs } from '../args';
import { credentialText, describeCredential, maskEmail } from '../env';
import { plural } from '../format';
import { listRunSets, readLatestPointer } from '../runSet';
import { GLYPH, PLAIN } from '../style';
import type { Style } from '../style';
import type { CliContext } from './context';

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'info';

export interface Check {
  status: CheckStatus;
  title: string;
  detail?: string;
  /** Further lines, printed indented under the check. */
  lines?: string[];
}

export function renderChecks(checks: readonly Check[], style: Style = PLAIN): string {
  const mark = (status: CheckStatus) =>
    status === 'ok'
      ? style.ok(GLYPH.ok)
      : status === 'warn'
        ? style.warn(GLYPH.warn)
        : status === 'fail'
          ? style.bad(GLYPH.fail)
          : style.dim(GLYPH.info);
  const width = Math.max(...checks.map((check) => check.title.length));
  const lines: string[] = [];
  for (const check of checks) {
    lines.push(`  ${mark(check.status)} ${check.title.padEnd(width)}  ${check.detail ?? ''}`.trimEnd());
    for (const line of check.lines ?? []) lines.push(style.dim(`      ${line}`));
  }
  return lines.join('\n');
}

export function nodeCheck(version: string = process.versions.node): Check {
  const major = Number(version.split('.')[0]);
  return major >= 22
    ? { status: 'ok', title: 'Node', detail: `v${version}` }
    : { status: 'fail', title: 'Node', detail: `v${version}: ScaffoldBench needs Node 22 or newer` };
}

export async function doctorCommand(args: DoctorArgs, ctx: CliContext): Promise<number> {
  const style = ctx.outStyle;
  ctx.out(`${style.bold('ScaffoldBench doctor')}  ${style.dim(REPO_ROOT)}`);
  ctx.out('');

  const checks: Check[] = [nodeCheck(), dotEnvCheck(ctx)];
  checks.push(...credentialChecks(ctx));
  checks.push(await accountCheck(ctx.env));
  checks.push(...(await sdkChecks()));
  checks.push(await gitCheck());
  checks.push(...(await researchChecks()));
  checks.push(await resultsCheck());
  checks.push(...(await scratchChecks()));
  if (args.wiring !== 'none') checks.push(await wiringCheck(args.wiring, ctx.env));

  ctx.out(renderChecks(checks, style));
  const failed = checks.filter((check) => check.status === 'fail').length;
  const warned = checks.filter((check) => check.status === 'warn').length;
  ctx.out('');
  if (failed > 0) {
    ctx.out(style.bad(`${plural(failed, 'problem')} to fix before running.`));
    return 1;
  }
  ctx.out(
    warned > 0
      ? style.warn(`Ready, with ${plural(warned, 'warning')} worth reading.`)
      : style.ok('Ready.'),
  );
  if (args.wiring === 'none') {
    ctx.out(style.dim('Add --wiring to start the SDK canary for free, or --wiring-live to run it on Haiku (~$0.02).'));
  }
  return 0;
}

function dotEnvCheck(ctx: CliContext): Check {
  const file = path.join(REPO_ROOT, '.env');
  if (!existsSync(file)) {
    return { status: 'info', title: '.env', detail: 'none (optional: cp .env.example .env)' };
  }
  const keys = [...ctx.dotEnvKeys];
  return {
    status: 'ok',
    title: '.env',
    detail: keys.length > 0 ? `loaded: ${keys.join(', ')}` : 'loaded; every variable in it was already set in the shell',
  };
}

function credentialChecks(ctx: CliContext): Check[] {
  const credential = describeCredential(ctx.env, ctx.dotEnvKeys);
  const detail = credentialText(credential);
  if (credential.problem) {
    return [{ status: 'fail', title: 'Credentials', detail: `${detail}: ${credential.problem}` }];
  }
  if (credential.kind === 'both') return [{ status: 'warn', title: 'Credentials', detail }];
  return [{ status: credential.kind === 'login' ? 'info' : 'ok', title: 'Credentials', detail }];
}

/**
 * Ask a Claude Code session which account it would bill. The session is
 * given no prompt, so it starts, answers the control request and is aborted
 * before it sends anything to the API.
 */
async function accountCheck(env: NodeJS.ProcessEnv, timeoutMs = 30_000): Promise<Check> {
  const controller = new AbortController();
  const idle = new Promise<void>((resolve) => controller.signal.addEventListener('abort', () => resolve()));
  async function* noPrompt(): AsyncGenerator<never> {
    await idle;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const session = query({
    prompt: noPrompt(),
    options: {
      ...hermeticOptions(),
      abortController: controller,
      cwd: tmpdir(),
      env,
      tools: [],
      mcpServers: {},
    },
  });
  try {
    const info = await Promise.race([
      session.accountInfo(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`no answer within ${timeoutMs / 1_000}s`)), timeoutMs);
      }),
    ]);
    const provider = info.apiProvider && info.apiProvider !== 'firstParty' ? ` via ${info.apiProvider}` : '';
    const key = info.apiKeySource && info.apiKeySource !== 'none' ? info.apiKeySource : undefined;
    // `claude.ai` is the machine's own login, which a key or token takes over from.
    const token = info.tokenSource && !['none', 'claude.ai'].includes(info.tokenSource) ? info.tokenSource : undefined;
    if (key && token) {
      return {
        status: 'warn',
        title: 'Billed account',
        detail: `the session sees both a token (${token}) and an API key (${key}); unset one to be sure which is billed`,
      };
    }
    if (key) return { status: 'ok', title: 'Billed account', detail: `the API key from ${key}${provider}` };
    if (token) return { status: 'ok', title: 'Billed account', detail: `the token from ${token}${provider}` };
    if (info.email) {
      const plan = info.subscriptionType ? ` · ${info.subscriptionType}` : '';
      return { status: 'ok', title: 'Billed account', detail: `Claude Code login ${maskEmail(info.email)}${plan}${provider}` };
    }
    if (provider) return { status: 'ok', title: 'Billed account', detail: `cloud provider${provider}` };
    return {
      status: 'fail',
      title: 'Billed account',
      detail: 'none: no key in the environment and no Claude Code login on this machine',
    };
  } catch (error) {
    return {
      status: 'warn',
      title: 'Billed account',
      detail: `could not ask a Claude Code session (${error instanceof Error ? error.message : String(error)})`,
    };
  } finally {
    if (timer) clearTimeout(timer);
    controller.abort();
    // Drain the aborted session so its subprocess is gone before the next check.
    try {
      for await (const message of session) void message;
    } catch {
      // Aborted, as intended.
    }
  }
}

async function sdkChecks(): Promise<Check[]> {
  const sdk = await sdkVersions();
  const checks: Check[] = [];
  checks.push(
    sdk.agentSdkVersion
      ? { status: 'ok', title: 'Agent SDK', detail: `${sdk.agentSdkVersion} · bundled Claude Code ${sdk.claudeCodeVersion ?? 'unknown'}` }
      : { status: 'fail', title: 'Agent SDK', detail: 'not installed: run npm install' },
  );
  const binary = nativeBinary();
  checks.push(
    binary.found
      ? { status: 'ok', title: 'Claude Code binary', detail: path.relative(REPO_ROOT, binary.found) }
      : {
          status: 'fail',
          title: 'Claude Code binary',
          detail: `no ${binary.packages.join(' or ')} in node_modules: run npm install (installing with --omit=optional removes it)`,
        },
  );
  return checks;
}

/** The SDK runs Claude Code from a per-platform optional package. */
function nativeBinary(): { found?: string; packages: string[] } {
  const base = `claude-agent-sdk-${process.platform}-${process.arch}`;
  const packages = process.platform === 'linux' ? [base, `${base}-musl`] : [base];
  const file = process.platform === 'win32' ? 'claude.exe' : 'claude';
  for (const name of packages) {
    const candidate = path.join(REPO_ROOT, 'node_modules', '@anthropic-ai', name, file);
    if (existsSync(candidate)) return { found: candidate, packages };
  }
  return { packages };
}

async function gitCheck(): Promise<Check> {
  const git = await gitState(REPO_ROOT);
  if (git.sha === null) return { status: 'warn', title: 'Git', detail: 'not a git checkout: run sets will not record a commit' };
  if (git.dirty) {
    return {
      status: 'warn',
      title: 'Git',
      detail: `${git.sha.slice(0, 12)} with uncommitted changes: a run set records gitDirty, and cannot name the code it ran`,
    };
  }
  return { status: 'ok', title: 'Git', detail: `${git.sha.slice(0, 12)}, clean` };
}

/**
 * Whether every research task can build its environment from what is on
 * disk, in replay mode, plus a description of that corpus. Building the
 * environment is the task's own check, whatever the corpus format.
 */
async function researchChecks(): Promise<Check[]> {
  const research = ALL_TASKS.filter((task) => task.category === 'research');
  if (research.length === 0) return [];
  const checks: Check[] = [await corpusCheck()];
  for (const task of research) {
    const cwd = await mkdtemp(path.join(tmpdir(), 'scaffoldbench-doctor-'));
    try {
      const env = await task.createEnvironment({ cwd, fixtureMode: 'replay', fixtureDir: FIXTURES_DIR });
      await env.dispose?.();
      checks.push({ status: 'ok', title: `  ${task.id}`, detail: 'environment builds in replay mode' });
    } catch (error) {
      checks.push({
        status: 'fail',
        title: `  ${task.id}`,
        detail: error instanceof Error ? error.message.split('\n')[0] : String(error),
      });
    } finally {
      await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
    }
  }
  return checks;
}

async function corpusCheck(): Promise<Check> {
  const corpusManifest = path.join(FIXTURES_DIR, 'corpus', 'manifest.json');
  if (existsSync(corpusManifest)) {
    try {
      const manifest = JSON.parse(await readFile(corpusManifest, 'utf8')) as {
        snapshot?: unknown;
        documents?: unknown[];
      };
      const documents = Array.isArray(manifest.documents) ? manifest.documents.length : 0;
      return {
        status: documents > 0 ? 'ok' : 'fail',
        title: 'Research corpus',
        detail: `${plural(documents, 'document')}${typeof manifest.snapshot === 'string' ? `, snapshot ${manifest.snapshot}` : ''}`,
      };
    } catch (error) {
      return { status: 'fail', title: 'Research corpus', detail: `unreadable manifest: ${String(error)}` };
    }
  }
  const recorded = existsSync(FIXTURES_DIR)
    ? (await readdir(FIXTURES_DIR)).filter((name) => name.endsWith('.json')).length
    : 0;
  return recorded > 0
    ? { status: 'ok', title: 'Research fixtures', detail: `${plural(recorded, 'recorded web response')} in fixtures/` }
    : {
        status: 'warn',
        title: 'Research fixtures',
        detail: 'none in fixtures/: replayed research runs will find nothing',
      };
}

async function resultsCheck(): Promise<Check> {
  const sets = await listRunSets();
  const latest = await readLatestPointer();
  if (latest === undefined) {
    return { status: 'info', title: 'Results', detail: `${plural(sets.length, 'run set')}; results/latest.json names none` };
  }
  const known = sets.some((entry) => entry.runSetId === latest);
  return known
    ? { status: 'ok', title: 'Results', detail: `${plural(sets.length, 'run set')}; the site shows ${latest}` }
    : { status: 'warn', title: 'Results', detail: `results/latest.json points at ${latest}, which does not exist` };
}

/** Scratch directories a killed run could not clean up. */
async function scratchChecks(): Promise<Check[]> {
  const checks: Check[] = [];
  const temp = (await readdir(tmpdir()).catch(() => [] as string[])).filter((name) => name.startsWith('scaffoldbench-'));
  checks.push(
    temp.length > 0
      ? {
          status: 'warn',
          title: 'Scratch',
          detail: `${plural(temp.length, 'run directory', 'run directories')} left in ${tmpdir()} (scaffoldbench-*): from killed runs, or from a session still running`,
        }
      : { status: 'ok', title: 'Scratch', detail: 'no leftover run directories' },
  );
  return checks;
}

/** Run `scripts/check-wiring.ts` the way this process runs: same Node, same TypeScript loader. */
async function wiringCheck(mode: 'init' | 'live', env: NodeJS.ProcessEnv): Promise<Check> {
  const script = path.join(REPO_ROOT, 'scripts', 'check-wiring.ts');
  const loader = process.execArgv.filter((arg) => !arg.startsWith('--eval') && !arg.startsWith('--print'));
  const argv = [...loader, script, ...(mode === 'init' ? ['--init-only'] : [])];
  const title = mode === 'init' ? 'Wiring (init only)' : 'Wiring (live)';
  const result = await new Promise<{ code: number | null; output: string }>((resolve) => {
    const child = spawn(process.execPath, argv, { cwd: REPO_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.on('error', (error) => resolve({ code: null, output: error.message }));
    child.on('close', (code) => resolve({ code, output }));
  });
  const lines = result.output
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line !== '');
  return result.code === 0
    ? { status: 'ok', title, detail: lines[0] ?? 'passed', lines: lines.slice(1) }
    : { status: 'fail', title, detail: `the canary failed (exit ${result.code ?? 'none'})`, lines };
}
