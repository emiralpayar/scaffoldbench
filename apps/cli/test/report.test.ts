import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { RunRecord, RunSetManifest, TraceEvent } from '@arena/core';

import {
  formatFailureModes,
  formatHealth,
  formatLeaderboard,
  formatMatrix,
  formatPairwise,
  formatReport,
  inertMarkdown,
  publicationProblems,
  toMarkdown,
} from '../src/report';
import { auditLegacy } from '../src/runSet';
import { createStyle, visibleWidth } from '../src/style';
import { buildReportView, exclusionOf, orderModels } from '../src/view';
import type { ModelView } from '../src/view';
import { makeRecord, overlappingRecords, plain, runSetOf } from './support';

const manifest = (overrides: Partial<RunSetManifest> = {}): RunSetManifest => ({
  runSetId: 'test-set',
  createdAt: '2026-10-01T12:00:00.000Z',
  gitSha: 'abcdef0123456789',
  model: 'claude-haiku-4-5-20251001',
  models: ['claude-haiku-4-5-20251001'],
  effort: 'high',
  repeats: 3,
  fixtureMode: 'replay',
  strategyIds: ['alpha', 'beta'],
  taskIds: ['airline-easy', 'airline-hard'],
  totalRuns: 12,
  completedRuns: 12,
  totalCostUsd: 0.96,
  totalJudgeCostUsd: 0,
  durationMs: 60_000,
  maxCostUsdPerRun: 0.75,
  status: 'complete',
  ...overrides,
});

describe('which runs are ranked', () => {
  it('leaves out API errors and failed integrity, and ranks the unverified', () => {
    const healthy = makeRecord({ strategyId: 'alpha', taskId: 'airline-easy' });
    const api = makeRecord({ strategyId: 'alpha', taskId: 'airline-easy', repeat: 2, failureMode: 'api_error' });
    const broken = makeRecord({
      strategyId: 'alpha',
      taskId: 'airline-easy',
      repeat: 3,
      integrity: { ok: false, checks: [{ id: 'harness.mcp-connected', ok: false, detail: 'propose-2: shop failed' }] },
    });
    const legacy = makeRecord({ strategyId: 'beta', taskId: 'airline-easy', integrity: undefined });

    expect(exclusionOf(healthy, healthy.integrity)).toBeUndefined();
    expect(exclusionOf(api, api.integrity)).toBe('api_error');
    expect(exclusionOf(broken, broken.integrity)).toBe('integrity');
    expect(exclusionOf(legacy, undefined)).toBeUndefined();

    const view = buildReportView(runSetOf([healthy, api, broken, legacy]));
    expect(view.health).toMatchObject({ runs: 4, ranked: 2, excluded: 2, integrityFailed: 1, apiErrors: 1, unverified: 1 });
    expect(view.models[0]?.arms.map((arm) => [arm.strategyId, arm.runs])).toEqual([
      ['alpha', 1],
      ['beta', 1],
    ]);
    expect(view.health.failingChecks).toEqual([
      expect.objectContaining({ id: 'harness.mcp-connected', runs: 1, example: 'propose-2: shop failed' }),
    ]);
  });

  it('audits a legacy record from its trace when it has one', () => {
    const legacy = makeRecord({ strategyId: 'alpha', taskId: 'airline-easy', integrity: undefined, deniedToolCalls: 1 });
    const trace: TraceEvent[] = [
      { seq: 1, tMs: 0, phase: 'plan', depth: 0, kind: 'phase_start' },
      { seq: 2, tMs: 1, phase: 'plan', depth: 0, kind: 'system_init', meta: { tools: ['StructuredOutput'], mcpServers: [] } },
      { seq: 3, tMs: 2, phase: 'plan', depth: 0, kind: 'tool_denied', toolName: 'StructuredOutput' },
      { seq: 4, tMs: 3, phase: 'plan', depth: 0, kind: 'phase_end', meta: { subtype: 'error_max_turns' } },
    ];
    const audit = auditLegacy(legacy, trace);
    expect(audit.ok).toBe(false);
    expect(audit.checks.find((check) => !check.ok)?.id).toBe('harness.harness-tools');

    const view = buildReportView(
      runSetOf([legacy], { audits: new Map([[legacy.runId, audit]]), deniedTools: new Map([[legacy.runId, ['StructuredOutput']]]) }),
    );
    expect(view.health).toMatchObject({ ranked: 0, integrityFailed: 1, audited: 1, unverified: 0 });
    expect([...view.health.denied.byTool]).toEqual([['StructuredOutput', 1]]);
  });

  it('orders models by the manifest, then from the cheapest tier', () => {
    expect(orderModels([], ['claude-opus-5-5', 'claude-haiku-4-5-20251001', 'claude-sonnet-5-5'])).toEqual([
      'claude-haiku-4-5-20251001',
      'claude-sonnet-5-5',
      'claude-opus-5-5',
    ]);
    expect(orderModels(['claude-opus-5-5'], ['claude-sonnet-5-5', 'claude-opus-5-5'])).toEqual([
      'claude-opus-5-5',
      'claude-sonnet-5-5',
    ]);
  });

  it('gives each model its own leaderboard', () => {
    const records = [
      ...overlappingRecords(),
      ...overlappingRecords().map((record) => ({
        ...record,
        model: 'claude-sonnet-5-5',
        runId: record.runId.replace('claude-haiku-4-5-20251001', 'claude-sonnet-5-5'),
        score: Math.min(1, record.score + 0.3),
      })),
    ];
    const view = buildReportView(runSetOf(records));
    expect(view.models.map((model) => model.model)).toEqual(['claude-haiku-4-5-20251001', 'claude-sonnet-5-5']);
    const text = formatReport(view);
    expect(text).toMatch(/── claude-haiku-4-5-20251001 ─/);
    expect(text).toMatch(/── claude-sonnet-5-5 ─/);
  });

  it('counts phases that did not simply succeed, without counting API failures twice', () => {
    const phase = (overrides: Partial<RunRecord['phases'][number]>): RunRecord['phases'][number] => ({
      phase: 'plan',
      label: 'Plan',
      startedAtMs: 0,
      durationMs: 1,
      costUsd: 0,
      turns: 1,
      toolCalls: 0,
      model: 'm',
      aborted: false,
      ...overrides,
    });
    const records = [1, 2, 3].map((repeat) =>
      makeRecord({
        strategyId: 'alpha',
        taskId: 'airline-easy',
        repeat,
        phases: [
          repeat === 3
            ? phase({ error: 'Claude Code returned an error result: Reached maximum number of turns (1)' })
            : phase({ subtype: 'success' }),
          phase({ phase: 'execute', apiError: { kind: 'overloaded', retryable: true, message: 'x' } }),
        ],
      }),
    );
    const issues = buildReportView(runSetOf(records)).health.phaseIssues;
    expect(issues).toEqual([
      { strategyId: 'alpha', phase: 'plan', outcome: 'Reached maximum number of turns (1)', runs: 1, of: 3 },
    ]);
  });
});

describe('terminal report', () => {
  const view = buildReportView(runSetOf(overlappingRecords(), { manifest: manifest() }));
  const model = view.models[0];
  if (!model) throw new Error('no model');

  it('puts health before the leaderboard', () => {
    const text = formatReport(view);
    expect(text.indexOf('HEALTH')).toBeGreaterThan(0);
    expect(text.indexOf('HEALTH')).toBeLessThan(text.indexOf('LEADERBOARD'));
    expect(text).toMatch(/✓ Every run passed its integrity checks \(12 of 12\)/);
  });

  it('describes what the run set measured', () => {
    const text = formatReport(view);
    expect(text).toMatch(/Model\s+claude-haiku-4-5-20251001 · effort high · 3 repeats · fixtures replay/);
    expect(text).toMatch(/Runs\s+12 of 12 recorded · complete/);
    expect(text).toMatch(/Caps\s+\$0\.75 per run/);
  });

  it('renders the leaderboard with intervals, exact pass counts and aligned columns', () => {
    const lines = formatLeaderboard(model).split('\n');
    const header = lines[0] ?? '';
    const scoreColumn = header.indexOf('SCORE');

    expect(header).toMatch(/STRATEGY\s+N\s+SCORE \(95% CI\)\s+PASS\s+COST\/RUN\s+LATENCY\s+SCORE\/\$/);
    for (const line of lines.slice(1, 3)) {
      expect(line.slice(scoreColumn)).toMatch(/^\d\.\d{3} \[\d\.\d{3}, \d\.\d{3}\]/);
      expect(line).toMatch(/0\/6/);
    }
  });

  it('ranks every section in the same order', () => {
    const text = formatReport(view);
    const order = (section: string) => {
      const block = text.slice(text.indexOf(section));
      return ['alpha', 'beta'].sort((a, b) => block.indexOf(a) - block.indexOf(b));
    };
    expect(order('LEADERBOARD')).toEqual(['alpha', 'beta']);
    expect(order('SCORE BY TASK')).toEqual(['alpha', 'beta']);
    expect(order('FAILURE MODES')).toEqual(['alpha', 'beta']);
  });

  it('says inconclusive when the intervals overlap, and names a winner when they do not', () => {
    expect(formatPairwise(model)).toMatch(/No pair separates|does not separate/);

    const decisive: RunRecord[] = [];
    for (let repeat = 1; repeat <= 4; repeat++) {
      decisive.push(makeRecord({ strategyId: 'winner', taskId: 'airline-easy', repeat, score: 1, passed: true }));
      decisive.push(makeRecord({ strategyId: 'loser', taskId: 'airline-easy', repeat, score: 0 }));
    }
    const decided = buildReportView(runSetOf(decisive)).models[0];
    if (!decided) throw new Error('no model');
    const text = formatPairwise(decided);
    expect(text).toMatch(/▲ winner beats loser by \+1\.000/);
    expect(text).toMatch(/winner\s+—\s+▲/);
  });

  it('dims the tasks every strategy aces and counts them', () => {
    const records = [1, 2].flatMap((repeat) => [
      makeRecord({ strategyId: 'alpha', taskId: 'airline-easy', repeat, score: 1, passed: true }),
      makeRecord({ strategyId: 'beta', taskId: 'airline-easy', repeat, score: 1, passed: true }),
      makeRecord({ strategyId: 'alpha', taskId: 'airline-hard', repeat, score: 0.4 }),
      makeRecord({ strategyId: 'beta', taskId: 'airline-hard', repeat, score: 0.9 }),
    ]);
    const matrix = formatMatrix(buildReportView(runSetOf(records)).models[0]!);
    expect(matrix).toMatch(/1 of 2 tasks \(dimmed\) score at least 0\.99 for every strategy/);
  });

  it('switches the matrix to short headers when the full ids would not fit', () => {
    const narrow = formatMatrix(model, 20);
    expect(narrow).toMatch(/A\s+B/);
    expect(narrow).toMatch(/A alpha · B beta/);
  });

  it('counts failure modes over every run, ranked or not', () => {
    const records = [
      ...overlappingRecords(),
      makeRecord({ strategyId: 'beta', taskId: 'airline-easy', repeat: 9, failureMode: 'api_error' }),
    ];
    const text = formatFailureModes(buildReportView(runSetOf(records)).models[0]!);
    expect(text).toMatch(/api_error/);
    expect(text).toMatch(/ALL\s+13/);
  });

  it('opens a synthetic report with an unmissable banner', () => {
    const text = formatReport(buildReportView(runSetOf(overlappingRecords(), { manifest: manifest({ synthetic: true }) })));
    expect(text.split('\n')[1]).toMatch(/SYNTHETIC DATA/);
  });

  it('lays out within the width it is given, in colour too', () => {
    for (const width of [80, 100, 140]) {
      const text = formatReport(view, { width, style: createStyle(true) });
      for (const line of text.split('\n')) {
        expect(visibleWidth(line), `${width}: ${plain(line)}`).toBeLessThanOrEqual(width);
      }
    }
  });

  it('stays inside 80 columns with long ids, many failure modes and long problems', () => {
    const ids = ['single', 'plan-execute', 'orchestrator-workers', 'plan-execute-verify', 'propose-select', 'gated-execute'];
    const modes = ['none', 'wrong_answer', 'policy_violation', 'max_turns', 'timeout', 'budget_exceeded', 'harness_error', 'api_error'] as const;
    const records = ids.flatMap((strategyId, s) =>
      modes.map((failureMode, m) =>
        makeRecord({
          strategyId,
          taskId: m % 2 === 0 ? 'research-password-hashing' : 'ecommerce-medium',
          repeat: m + 1,
          failureMode,
          score: failureMode === 'none' ? 1 : (s + m) % 3 === 0 ? 0 : 0.5,
          passed: failureMode === 'none',
          costUsd: 0.01 * (s + 1),
          phases: [
            {
              phase: 'plan',
              label: 'Plan',
              startedAtMs: 0,
              durationMs: 1,
              costUsd: 0,
              turns: 1,
              toolCalls: 0,
              model: 'm',
              aborted: false,
              error: 'x'.repeat(300),
            },
          ],
          ...(failureMode === 'harness_error'
            ? { integrity: { ok: false, checks: [{ id: 'harness.mcp-connected', ok: false, detail: 'y'.repeat(300) }] } }
            : {}),
        }),
      ),
    );
    const text = formatReport(buildReportView(runSetOf(records, { manifest: manifest() })), { width: 80 });
    for (const line of text.split('\n')) expect(visibleWidth(line), line).toBeLessThanOrEqual(80);
    expect(text).toMatch(/runs: none 1 · .*api_error 1/);
  });

  it('shows what failed in health, worst first', () => {
    const records = [
      makeRecord({
        strategyId: 'alpha',
        taskId: 'airline-easy',
        integrity: { ok: false, checks: [{ id: 'harness.harness-tools', ok: false, detail: 'plan: StructuredOutput was offered, then denied' }] },
        deniedToolCalls: 2,
      }),
      makeRecord({
        strategyId: 'beta',
        taskId: 'airline-easy',
        failureMode: 'api_error',
        apiError: { kind: 'rate_limit', retryable: true, message: 'slow down', status: 429 },
      }),
    ];
    const text = formatHealth(buildReportView(runSetOf(records)).health);
    expect(text).toMatch(/✗ 1 of 2 runs failed their integrity checks/);
    expect(text).toMatch(/✗ 1 run hit an API error \(rate_limit ×1\)/);
    expect(text).toMatch(/⚠ 2 tool calls denied/);
    expect(text).toMatch(/harness\.harness-tools\s+1\s+alpha 1/);
    expect(text).toMatch(/StructuredOutput was offered, then denied/);
  });
});

describe('model stops', () => {
  const stopped = (repeat: number, reason: 'refusal' | 'output_limit', passed: boolean, category?: string) =>
    makeRecord({
      strategyId: 'alpha',
      taskId: 'airline-easy',
      repeat,
      passed,
      score: passed ? 1 : 0,
      failureMode: passed ? 'none' : 'model_stop',
      modelStops: [{ phase: 'agent', callId: `c${repeat}`, reason, ...(category ? { category } : {}) }],
    });

  it('counts them under health without leaving the run out of the ranking', () => {
    const records = [stopped(1, 'refusal', false, 'cyber'), stopped(2, 'refusal', true, 'cyber'), stopped(3, 'output_limit', false)];
    const view = buildReportView(runSetOf(records));
    expect(view.health.modelStops).toMatchObject({ runs: 3, calls: 3 });
    expect(view.health).toMatchObject({ ranked: 3, excluded: 0 });
    expect(view.models[0]?.arms[0]?.runs).toBe(3);

    const text = formatHealth(view.health).replace(/\s+/g, ' ');
    expect(text).toMatch(/⚠ 3 runs had 3 calls end because the model could not finish the turn \(refused ×2, output limit ×1; refusal categories: cyber ×2\)/);
    expect(text).toMatch(/these runs stay ranked/);
    // The failure-mode table names the mode like any other.
    expect(formatFailureModes(view.models[0] as ModelView)).toMatch(/model_stop/);
  });

  it('says nothing when no call stopped', () => {
    const view = buildReportView(runSetOf(overlappingRecords()));
    expect(view.health.modelStops.runs).toBe(0);
    expect(formatHealth(view.health)).not.toMatch(/could not finish the turn/);
  });
});

describe('what the effort was', () => {
  it('says so when a model ran at something other than the effort asked for', () => {
    const view = buildReportView(
      runSetOf(overlappingRecords(), {
        manifest: manifest({
          models: ['claude-haiku-4-5-20251001', 'claude-sonnet-5-5'],
          effectiveEffort: { 'claude-haiku-4-5-20251001': null, 'claude-sonnet-5-5': 'high' },
        }),
      }),
    );
    expect(formatReport(view)).toMatch(/Effort\s+high requested; ran at haiku-4-5 none \(no effort parameter sent\), sonnet-5-5 high/);
  });

  it('stays quiet when every model ran at the effort asked for', () => {
    const view = buildReportView(
      runSetOf(overlappingRecords(), { manifest: manifest({ effectiveEffort: { 'claude-haiku-4-5-20251001': 'high' } }) }),
    );
    expect(formatReport(view)).not.toMatch(/requested; ran at/);
  });

  it('names a spent usage limit as the reason a run set stopped', () => {
    const view = buildReportView(
      runSetOf(overlappingRecords(), { manifest: manifest({ status: 'interrupted', stoppedBy: 'usage_limit' }) }),
    );
    expect(formatReport(view)).toMatch(/interrupted \(usage limit spent\)/);
    expect(publicationProblems(view)[0]).toMatch(/usage limit spent/);
  });
});

describe('publication gate', () => {
  it('passes a complete run set whose every run is healthy', () => {
    expect(publicationProblems(buildReportView(runSetOf(overlappingRecords(), { manifest: manifest() })))).toEqual([]);
  });

  it('names every reason a run set must not be published', () => {
    const records = [
      ...overlappingRecords(),
      makeRecord({ strategyId: 'alpha', taskId: 'airline-easy', repeat: 7, failureMode: 'api_error' }),
      makeRecord({ strategyId: 'alpha', taskId: 'airline-easy', repeat: 8, integrity: { ok: false, checks: [] } }),
      makeRecord({ strategyId: 'alpha', taskId: 'airline-easy', repeat: 9, integrity: undefined }),
    ];
    const problems = publicationProblems(
      buildReportView(
        runSetOf(records, { manifest: manifest({ status: 'interrupted', stoppedBy: 'total_budget', completedRuns: 15 }) }),
      ),
    );
    expect(problems).toEqual([
      'the run set is interrupted (total budget reached), 15 of 12 runs recorded',
      '1 run failed integrity checks',
      '1 run hit API errors',
      '1 run predate integrity checks',
    ]);
  });

  it('does not take a complete manifest at its word when records are missing', () => {
    const records = overlappingRecords();
    expect(publicationProblems(buildReportView(runSetOf(records, { manifest: manifest({ totalRuns: 12 }) })))).toEqual([]);
    expect(publicationProblems(buildReportView(runSetOf(records.slice(1), { manifest: manifest({ totalRuns: 12 }) })))).toEqual([
      'the manifest plans 12 runs, but 11 records are on disk',
    ]);
  });

  it('never publishes synthetic data or a run set without a manifest', () => {
    expect(publicationProblems(buildReportView(runSetOf(overlappingRecords())))).toContain('the run set has no manifest');
    expect(
      publicationProblems(buildReportView(runSetOf(overlappingRecords(), { manifest: manifest({ synthetic: true }) }))),
    ).toContain('the run set is synthetic');
  });
});

describe('markdown report', () => {
  const view = buildReportView(runSetOf(overlappingRecords(), { manifest: manifest() }));

  it('carries the leaderboard, intervals, verdicts and health', () => {
    const out = toMarkdown(view);
    expect(out).toMatch(/^# ScaffoldBench report — test-set/m);
    expect(out).toMatch(/^## Health/m);
    expect(out).toContain('Alpha harness');
    expect(out).toContain('inconclusive');
    expect(out).toMatch(/\[\d\.\d{3}, \d\.\d{3}\]/);
    expect(out).toMatch(/```text\n[\s\S]*├[\s\S]*```/);
  });

  it('gives every table a separator row and a uniform cell count', () => {
    const lines = toMarkdown(view).split('\n');
    const tables: string[][] = [];
    let current: string[] = [];
    for (const line of lines) {
      if (line.startsWith('|')) {
        current.push(line);
        continue;
      }
      if (current.length > 0) tables.push(current);
      current = [];
    }
    if (current.length > 0) tables.push(current);

    expect(tables.length).toBeGreaterThanOrEqual(4);
    for (const table of tables) {
      expect(table.length).toBeGreaterThanOrEqual(3);
      expect(table[1] ?? '').toMatch(/^\|[ :|-]+\|$/);
      const width = (table[0] ?? '').split('|').length;
      for (const row of table) expect(row.split('|').length).toBe(width);
    }
  });
});

describe('markdown from a model', () => {
  // What a prompt-injected model could make the harness quote: a tool name, then the failure that names it.
  const hostile = '@octocat [free tokens](http://evil.example) <img src=x onerror=1> `rm` | * _';

  it('leaves nothing in it that mentions, links, tags or formats', () => {
    const out = inertMarkdown(hostile);
    expect(out).not.toMatch(/@octocat/);
    expect(out).toContain('@\u200boctocat');
    // Every markdown-significant character is backslash-escaped, so none of it is syntax.
    expect(out).not.toMatch(/(?<!\\)[`*_[\]<>()|]/);
    expect(out).toContain('\\<img src=x onerror=1\\>');
    expect(inertMarkdown('two\nlines  and\ttabs')).toBe('two lines and tabs');
  });

  it('reaches the report only in that form, in the health lines and in the tables', () => {
    const records = [
      makeRecord({
        strategyId: 'alpha',
        taskId: 'airline-easy',
        deniedToolCalls: 1,
        integrity: { ok: false, checks: [{ id: 'harness.no-denials', ok: false, detail: `denied ${hostile}` }] },
      }),
      makeRecord({
        strategyId: 'alpha',
        taskId: 'airline-hard',
        phases: [{ phase: 'plan', subtype: 'success', error: hostile } as RunRecord['phases'][number]],
      }),
    ];
    const first = records[0]!;
    const out = toMarkdown(
      buildReportView(runSetOf(records, { manifest: manifest(), deniedTools: new Map([[first.runId, [hostile]]]) })),
    );

    expect(out).toContain('denied by the sandbox guard');
    // (An escaped `\<img` still contains `<img`, so look for the unescaped forms.)
    expect(out).not.toMatch(/@octocat|\]\(http|(?<!\\)<img|(?<!\\)`rm/);
    expect(out.match(/@\u200boctocat/g)?.length).toBeGreaterThanOrEqual(3);
    // The terminal rendering is for a person at a keyboard and stays as written.
    expect(plain(formatHealth(buildReportView(runSetOf(records, { manifest: manifest(), deniedTools: new Map([[first.runId, [hostile]]]) })).health))).toContain('@octocat');
  });
});

describe('source hygiene', () => {
  it('keeps every CLI source file free of control bytes, so git treats it as text', () => {
    const dir = path.join(__dirname, '..', 'src');
    const files = readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter((file) => file.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(5);
    for (const file of files) {
      const bytes = readFileSync(path.join(dir, file));
      expect(bytes.includes(0), file).toBe(false);
    }
  });
});
