/**
 * Rendering for the arena report. Pure functions only: a `ReportView` in,
 * text out, for the terminal and for REPORT.md.
 *
 * Health comes first, because a leaderboard is only worth reading once the
 * runs behind it are known to have measured what they claim to: the first
 * published run set ranked five architectures of which four never ran as
 * designed, and nothing in its report said so. Every headline number then
 * sits next to its bootstrap interval, and a comparison whose intervals
 * overlap is printed as inconclusive rather than as a winner.
 */

import { MODEL_STOP_LABELS } from '@arena/core';
import type { ModelStop } from '@arena/core';

import { formatBudget, formatDelta, formatDuration, formatScore, formatUsd, plural, shortModel } from './format';
import {
  abbreviationLegend,
  abbreviations,
  renderForestPlot,
  renderPairwiseGrid,
  renderScatter,
  verdictGlyph,
} from './plots';
import { GLYPH, PLAIN, heading, renderTable, visibleWidth, wrap } from './style';
import type { Column, Style } from './style';
import type { ArmView, HealthView, ModelView, ReportView } from './view';

export interface RenderOptions {
  style?: Style;
  /** Terminal columns to lay out for. */
  width?: number;
}

const DEFAULT_WIDTH = 100;
/** A task every strategy scores at least this well on cannot tell them apart. */
const CEILING = 0.99;

// ---------------------------------------------------------------------------
// Terminal
// ---------------------------------------------------------------------------

export function formatReport(view: ReportView, options: RenderOptions = {}): string {
  const style = options.style ?? PLAIN;
  const width = Math.max(60, options.width ?? DEFAULT_WIDTH);
  const blocks: string[] = [];

  if (view.synthetic) blocks.push(syntheticBanner(width, style));
  blocks.push(
    [
      `${style.bold('ScaffoldBench report')}${view.runSetId ? `  ${style.accent(view.runSetId)}` : ''}`,
      ...headerLines(view).flatMap(([key, value]) => hanging(`  ${style.dim(key.padEnd(10))}  `, 14, value, width)),
    ].join('\n'),
  );
  blocks.push(formatHealth(view.health, style, width));

  for (const model of view.models) {
    if (view.models.length > 1) {
      const title = ` ${model.model} `;
      blocks.push(style.bold(`──${title}${'─'.repeat(Math.max(4, width - visibleWidth(title) - 2))}`));
    }
    blocks.push(...modelBlocks(model, view.models.length > 1, width, style));
  }

  if (view.models.length === 0) blocks.push(style.dim('No runs to rank.'));
  return blocks.join('\n\n');
}

function syntheticBanner(width: number, style: Style): string {
  const text = 'SYNTHETIC DATA: these numbers were fabricated for interface development and must never be quoted.';
  const inner = Math.min(width, 100) - 4;
  const lines = wrap(text, inner);
  const bar = '━'.repeat(inner + 2);
  return [
    style.paint(['red', 'bold'], `┏${bar}┓`),
    ...lines.map((line) => style.paint(['red', 'bold'], `┃ ${line.padEnd(inner)} ┃`)),
    style.paint(['red', 'bold'], `┗${bar}┛`),
  ].join('\n');
}

/** Key/value lines describing what the run set measured and how. */
export function headerLines(view: ReportView): [string, string][] {
  const manifest = view.manifest;
  const lines: [string, string][] = [];
  if (manifest) {
    const models = manifest.models ?? [manifest.model];
    lines.push([
      models.length === 1 ? 'Model' : 'Models',
      `${models.join(', ')} · effort ${manifest.effort} · ${plural(manifest.repeats, 'repeat')} · fixtures ${manifest.fixtureMode}`,
    ]);
    // The effort a model ran at can differ from the one asked for: a model
    // without effort support is sent none, whatever the flag says.
    const ranAt = Object.entries(manifest.effectiveEffort ?? {});
    if (ranAt.some(([, level]) => level !== manifest.effort)) {
      lines.push([
        'Effort',
        `${manifest.effort} requested; ran at ${ranAt
          .map(([model, level]) => `${shortModel(model)} ${level ?? 'none (no effort parameter sent)'}`)
          .join(', ')}`,
      ]);
    }
    const status = manifest.status
      ? ` · ${manifest.status}${manifest.stoppedBy ? ` (${stopReasonText(manifest.stoppedBy)})` : ''}`
      : '';
    lines.push(['Runs', `${manifest.completedRuns} of ${manifest.totalRuns} recorded${status}`]);
    const provenance = manifest.provenance;
    const sha = provenance?.gitSha ?? manifest.gitSha;
    if (sha) {
      const dirty =
        provenance?.gitDirty === true ? ' · uncommitted changes' : provenance?.gitDirty === false ? ' · clean' : '';
      lines.push(['Commit', `${sha.slice(0, 12)}${dirty}`]);
    }
    if (provenance) {
      const parts = [
        provenance.agentSdkVersion ? `Agent SDK ${provenance.agentSdkVersion}` : undefined,
        provenance.claudeCodeVersion ? `Claude Code ${provenance.claudeCodeVersion}` : undefined,
        `Node ${provenance.nodeVersion}`,
        provenance.platform,
      ].filter((part): part is string => part !== undefined);
      lines.push(['Software', parts.join(' · ')]);
    }
    if (manifest.judge) {
      const judge = manifest.judge;
      lines.push([
        'Judge',
        `${judge.model ?? 'unrecorded model'}${judge.effort ? ` · effort ${judge.effort}` : ''} · ` +
          `${plural(judge.samples, 'sample')} per graded run`,
      ]);
    }
    const caps = [
      `${formatBudget(manifest.maxCostUsdPerRun)}${manifest.maxWallClockMsPerRun ? ` / ${formatDuration(manifest.maxWallClockMsPerRun)}` : ''} per run`,
      manifest.totalBudgetUsd !== undefined ? `total ${formatBudget(manifest.totalBudgetUsd)}` : undefined,
      manifest.concurrency !== undefined ? `concurrency ${manifest.concurrency}` : undefined,
    ].filter((part): part is string => part !== undefined);
    lines.push(['Caps', caps.join(' · ')]);
  }
  lines.push([
    'Spend',
    `${formatUsd(view.totals.costUsd)} on runs · ${formatUsd(view.totals.judgeCostUsd)} on grading` +
      (view.totals.discardedCostUsd > 0 ? ` · ${formatUsd(view.totals.discardedCostUsd)} on discarded attempts` : ''),
  ]);
  if (manifest?.notes && !view.synthetic) lines.push(['Notes', manifest.notes]);
  return lines;
}

function stopReasonText(reason: string): string {
  switch (reason) {
    case 'signal':
      return 'aborted';
    case 'drain':
      return 'stopped on request';
    case 'total_budget':
      return 'total budget reached';
    case 'auth':
      return 'credentials rejected';
    case 'usage_limit':
      return 'usage limit spent';
    default:
      return reason;
  }
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

/** The health verdict lines, worst first. Shared by the terminal and markdown renderings. */
export function healthSummary(health: HealthView): { level: 'ok' | 'warn' | 'bad'; text: string }[] {
  const lines: { level: 'ok' | 'warn' | 'bad'; text: string }[] = [];
  if (health.runs === 0) return [{ level: 'warn', text: 'No runs recorded.' }];

  if (health.integrityFailed > 0) {
    lines.push({
      level: 'bad',
      text: `${health.integrityFailed} of ${health.runs} runs failed their integrity checks and are not ranked: they did not measure the architecture they are labelled with.`,
    });
  }
  if (health.apiErrors > 0) {
    const kinds = health.apiErrorKinds.map((kind) => `${kind.kind} ×${kind.runs}`).join(', ');
    lines.push({
      level: 'bad',
      text: `${plural(health.apiErrors, 'run')} hit an API error (${kinds}) and ${health.apiErrors === 1 ? 'was' : 'were'} not scored. Not the architecture's fault; resume the run set to run ${health.apiErrors === 1 ? 'it' : 'them'} again.`,
    });
  }
  if (health.unverified > 0) {
    lines.push({
      level: 'warn',
      text: `${health.unverified} of ${health.runs} runs predate integrity checks and have no trace to audit. They are ranked, unverified.`,
    });
  }
  if (health.audited > 0) {
    lines.push({
      level: 'warn',
      text: `${health.audited} runs predate integrity checks; their traces were audited with the current checks.`,
    });
  }
  if (health.excluded === 0 && health.unverified === 0) {
    lines.push({ level: 'ok', text: `Every run passed its integrity checks (${health.runs} of ${health.runs}).` });
  }
  if (health.denied.total > 0) {
    const tools = [...health.denied.byTool].map(([tool, count]) => `${tool} ×${count}`).join(', ');
    lines.push({
      level: 'warn',
      text: `${plural(health.denied.total, 'tool call')} denied by the sandbox guard${tools ? `: ${tools}` : ''}.`,
    });
  } else {
    lines.push({ level: 'ok', text: 'No tool call was denied.' });
  }
  if (health.modelStops.runs > 0) {
    const { byReason, byCategory, calls, runs } = health.modelStops;
    const reasons = [...byReason]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([reason, count]) => `${MODEL_STOP_LABELS[reason as ModelStop['reason']] ?? reason} ×${count}`)
      .join(', ');
    const categories = [...byCategory].map(([category, count]) => `${category} ×${count}`).join(', ');
    lines.push({
      level: 'warn',
      text:
        `${plural(runs, 'run')} had ${plural(calls, 'call')} end because the model could not finish the turn (${reasons}` +
        `${categories ? `; refusal categories: ${categories}` : ''}). ` +
        "That is the run's own limit, like running out of turns: these runs stay ranked, and count against the architecture when they fail.",
    });
  }
  if (health.retried > 0) {
    lines.push({
      level: 'warn',
      text: `${plural(health.retried, 'run')} needed a retry after a transient API failure; only the last attempt is recorded.`,
    });
  }
  return lines;
}

export function formatHealth(health: HealthView, style: Style = PLAIN, width = DEFAULT_WIDTH): string {
  const mark = (level: 'ok' | 'warn' | 'bad') =>
    level === 'ok' ? style.ok(GLYPH.ok) : level === 'warn' ? style.warn(GLYPH.warn) : style.bad(GLYPH.fail);
  const out: string[] = [heading('HEALTH', `${health.ranked} of ${health.runs} runs ranked`, style)];
  for (const line of healthSummary(health)) out.push(...hanging(`  ${mark(line.level)} `, 4, line.text, width));

  if (health.failingChecks.length > 0) {
    const idWidth = Math.max(13, ...health.failingChecks.map((check) => check.id.length));
    const room = Math.max(20, width - 2 - idWidth - 2 - 4 - 2);
    out.push('');
    out.push(
      renderTable(
        [{ header: 'FAILING CHECK' }, { header: 'RUNS', align: 'right' }, { header: 'BY STRATEGY' }],
        health.failingChecks.map((check) => [
          style.bad(check.id),
          String(check.runs),
          truncateText([...check.byStrategy].map(([id, count]) => `${id} ${count}`).join(' · '), room),
        ]),
        style,
        '  ',
      ),
    );
    for (const check of health.failingChecks.slice(0, 5)) {
      if (check.example) out.push(style.dim(truncateText(`    ${check.id}: ${check.example}`, width)));
    }
  }

  const issues = health.phaseIssues.slice(0, 8);
  if (issues.length > 0) {
    const phaseWidth = Math.max(5, ...issues.map((issue) => `${issue.strategyId} · ${issue.phase}`.length));
    const room = Math.max(20, width - 2 - phaseWidth - 2 - 5 - 2);
    out.push('');
    out.push(
      renderTable(
        [{ header: 'PHASE' }, { header: 'ENDED', align: 'right' }, { header: 'HOW' }],
        issues.map((issue) => [
          `${issue.strategyId} · ${issue.phase}`,
          `${issue.runs}/${issue.of}`,
          truncateText(issue.outcome, room),
        ]),
        style,
        '  ',
      ),
    );
    if (health.phaseIssues.length > issues.length) {
      out.push(style.dim(`  and ${health.phaseIssues.length - issues.length} more phase outcomes`));
    }
    const note =
      'Phases listed for information: only the integrity checks decide what is ranked. A phase that ran out of ' +
      'turns while doing the task lost on its own terms; a planner that never answered did not.';
    out.push(...wrap(note, width - 2).map((line) => style.dim(`  ${line}`)));
  }
  return out.join('\n');
}

/** `prefix` then `text` wrapped to `width`, continuation lines indented by `indent` columns. */
function hanging(prefix: string, indent: number, text: string, width: number): string[] {
  const lines = wrap(text, Math.max(20, width - Math.max(indent, visibleWidth(prefix))));
  return lines.map((line, index) => (index === 0 ? prefix : ' '.repeat(indent)) + line);
}

function truncateText(text: string, max: number): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
}

// ---------------------------------------------------------------------------
// One model
// ---------------------------------------------------------------------------

function modelBlocks(model: ModelView, multiModel: boolean, width: number, style: Style): string[] {
  const tag = multiModel ? shortModel(model.model) : undefined;
  if (model.arms.length === 0) {
    return [style.dim('No ranked runs for this model: every run was excluded (see HEALTH).')];
  }
  const short = abbreviations(model.arms.map((arm) => arm.strategyId));
  const blocks = [
    `${heading('LEADERBOARD', [tag, `${plural(sum(model.arms.map((a) => a.runs)), 'ranked run')}`].filter(Boolean).join(' · '), style)}\n${formatLeaderboard(model, style, width)}`,
    `${heading('SCORE', 'mean and 95% bootstrap interval', style)}\n${renderForestPlot(
      model.arms.map((arm) => ({
        label: arm.strategyId,
        estimate: arm.score,
        ...(arm.frontier ? { marker: GLYPH.frontier } : {}),
      })),
      { width, style, format: (v) => v.toFixed(3), clamp: { low: 0, high: 1 } },
    ).join('\n')}`,
  ];
  if (model.arms.length >= 2) {
    blocks.push(`${heading('PAIRWISE', 'row against column, on score', style)}\n${formatPairwise(model, short, style, width)}`);
    blocks.push(
      `${heading('COST vs SCORE', 'mean cost per run against mean score', style)}\n${renderScatter(
        model.arms.map((arm) => ({
          label: short.get(arm.strategyId) ?? arm.strategyId,
          x: arm.costUsd.value,
          y: arm.score.value,
          highlight: arm.frontier,
        })),
        {
          width: Math.min(64, width - 12),
          height: 10,
          style,
          xFromZero: true,
          formatX: (value, decimals) => `$${value.toFixed(Math.max(2, decimals))}`,
          clampY: { low: 0, high: 1 },
        },
      ).join('\n')}\n${wrap(`${GLYPH.frontier} Pareto frontier · ${abbreviationLegend(short)}`, width - 2).map((line) => style.dim(`  ${line}`)).join('\n')}`,
    );
  }
  blocks.push(`${heading('SCORE BY TASK', 'mean over repeats, ranked runs', style)}\n${formatMatrix(model, width, style)}`);
  blocks.push(`${heading('FAILURE MODES', 'every run, ranked or not', style)}\n${formatFailureModes(model, style, width)}`);
  return blocks;
}

const LEADERBOARD_COLUMNS: Column[] = [
  { header: ' ' },
  { header: 'STRATEGY' },
  { header: 'N', align: 'right' },
  { header: 'SCORE (95% CI)' },
  { header: 'PASS', align: 'right' },
  { header: 'COST/RUN', align: 'right' },
  { header: 'LATENCY', align: 'right' },
  { header: 'SCORE/$', align: 'right' },
];

export function formatLeaderboard(model: ModelView, style: Style = PLAIN, width = DEFAULT_WIDTH): string {
  if (model.arms.length === 0) return 'No runs to rank.';
  const table = (withCi: boolean) =>
    renderTable(
      withCi ? LEADERBOARD_COLUMNS : LEADERBOARD_COLUMNS.map((c) => (c.header === 'SCORE (95% CI)' ? { header: 'SCORE' } : c)),
      model.arms.map((arm) => [
        arm.frontier ? style.warn(GLYPH.frontier) : ' ',
        style.bold(arm.strategyId),
        String(arm.runs),
        scoreTone(arm.score.value, style)(formatScore(arm.score.value)) + (withCi ? ` ${style.dim(formatCi(arm))}` : ''),
        passText(arm),
        formatUsd(arm.costUsd.value),
        formatDuration(arm.latencyMs.value),
        arm.scorePerDollar === null ? '-' : arm.scorePerDollar.toFixed(1),
      ]),
      style,
      ' ',
    );
  // On a narrow terminal the interval goes: the forest plot below prints it.
  const full = table(true);
  const fits = full.split('\n').every((line) => visibleWidth(line) <= width);
  return [
    fits ? full : table(false),
    style.dim(`  ${GLYPH.frontier} Pareto frontier: no other strategy scores at least as high for less.`),
  ].join('\n');
}

function formatCi(arm: ArmView): string {
  const ci = arm.score.ci;
  return ci ? `[${ci.low.toFixed(3)}, ${ci.high.toFixed(3)}]` : '';
}

/** `17/18`: exact, so a perfect 18/18 is not mistaken for certainty about the next run. */
function passText(arm: ArmView): string {
  return `${Math.round(arm.passRate.value * arm.runs)}/${arm.runs}`;
}

function scoreTone(score: number, style: Style): (text: string) => string {
  if (score >= CEILING) return style.ok;
  if (score >= 0.5) return (text) => text;
  return style.bad;
}

export function formatPairwise(
  model: ModelView,
  short: ReadonlyMap<string, string> = abbreviations(model.arms.map((arm) => arm.strategyId)),
  style: Style = PLAIN,
  width = DEFAULT_WIDTH,
): string {
  const ids = model.arms.map((arm) => arm.strategyId);
  if (ids.length < 2) return 'Nothing to compare.';
  const lines = renderPairwiseGrid(ids, model.contrasts, { style, headers: short });
  const prose = (text: string) => lines.push(...wrap(text, width - 2).map((line) => style.dim(`  ${line}`)));
  prose(
    `${GLYPH.better} row better · ${GLYPH.worse} row worse · ${GLYPH.equivalent} equivalent · ` +
      `${GLYPH.inconclusive} inconclusive. Compared by ${model.contrastMethod}.`,
  );

  const decided = model.contrasts.filter((c) => c.verdict === 'better' || c.verdict === 'worse');
  if (decided.length === 0) {
    lines.push(
      model.contrasts.length === 1
        ? '  The pair does not separate: the comparison is inconclusive.'
        : `  No pair separates: all ${model.contrasts.length} comparisons are inconclusive.`,
    );
  } else {
    for (const contrast of decided) {
      const [winner, loser, delta] =
        contrast.verdict === 'better'
          ? [contrast.a, contrast.b, contrast.estimate]
          : [contrast.b, contrast.a, -contrast.estimate];
      lines.push(`  ${verdictGlyph('better', style)} ${style.bold(winner)} beats ${loser} by ${formatDelta(delta)}`);
    }
  }
  return lines.join('\n');
}

export function formatMatrix(model: ModelView, width = DEFAULT_WIDTH, style: Style = PLAIN): string {
  const ids = model.arms.map((arm) => arm.strategyId);
  if (model.taskIds.length === 0 || ids.length === 0) return 'No cells to report.';

  const taskWidth = Math.max(4, ...model.taskIds.map((id) => id.length));
  const fullWidth = 2 + taskWidth + ids.reduce((total, id) => total + 2 + Math.max(id.length, 4), 0);
  const short = abbreviations(ids);
  const useShort = fullWidth > width;
  const header = (id: string) => (useShort ? (short.get(id) ?? id) : id);

  let saturated = 0;
  const rows = model.taskIds.map((taskId) => {
    const scores = ids.map((id) => model.scoreByTask.get(taskId)?.get(id));
    const atCeiling = scores.every((score) => score !== undefined && score >= CEILING);
    if (atCeiling) saturated += 1;
    const cells = scores.map((score) => {
      if (score === undefined) return style.dim('-');
      const text = score.toFixed(2);
      return atCeiling ? style.dim(text) : scoreTone(score, style)(text);
    });
    return [atCeiling ? style.dim(taskId) : taskId, ...cells];
  });

  const lines = [
    renderTable(
      [{ header: 'TASK' }, ...ids.map((id) => ({ header: header(id), align: 'right' as const }))],
      rows,
      style,
      '  ',
    ),
  ];
  const prose = (text: string) => lines.push(...wrap(text, width - 2).map((line) => style.dim(`  ${line}`)));
  if (useShort) prose(abbreviationLegend(short));
  if (saturated > 0) {
    prose(
      `${saturated} of ${model.taskIds.length} tasks (dimmed) score at least ${CEILING} for every strategy: ` +
        'they cannot tell the architectures apart.',
    );
  }
  return lines.join('\n');
}

/** Failure modes observed, `none` first and the rest by descending frequency. */
function observedModes(model: ModelView): string[] {
  const totals = new Map<string, number>();
  for (const row of model.failureModes.values()) {
    for (const [mode, count] of row) totals.set(mode, (totals.get(mode) ?? 0) + count);
  }
  return [...totals.keys()].sort((a, b) => {
    if (a === 'none') return -1;
    if (b === 'none') return 1;
    return (totals.get(b) ?? 0) - (totals.get(a) ?? 0) || a.localeCompare(b);
  });
}

/** Ranked strategies first, in rank order, then any whose every run was excluded. */
function failureRows(model: ModelView): string[] {
  const ranked = model.arms.map((arm) => arm.strategyId);
  return [...ranked, ...[...model.failureModes.keys()].filter((id) => !ranked.includes(id)).sort()];
}

function failureTable(model: ModelView): { columns: Column[]; rows: string[][] } {
  const modes = observedModes(model);
  const rows = failureRows(model).map((id) => {
    const row = model.failureModes.get(id) ?? new Map<string, number>();
    const total = sum([...row.values()]);
    return [id, String(total), ...modes.map((mode) => String(row.get(mode) ?? 0))];
  });
  const totals = modes.map((mode) =>
    String(sum([...model.failureModes.values()].map((row) => row.get(mode) ?? 0))),
  );
  rows.push(['ALL', String(sum([...model.failureModes.values()].flatMap((row) => [...row.values()]))), ...totals]);
  return {
    columns: [
      { header: 'STRATEGY' },
      { header: 'N', align: 'right' },
      ...modes.map((mode) => ({ header: mode, align: 'right' as const })),
    ],
    rows,
  };
}

export function formatFailureModes(model: ModelView, style: Style = PLAIN, width = DEFAULT_WIDTH): string {
  if (model.failureModes.size === 0) return 'No runs to report.';
  const { columns, rows } = failureTable(model);
  const tone = (mode: string | undefined, cell: string) => {
    if (cell === '0') return cell;
    if (mode === 'api_error' || mode === 'harness_error') return style.infra(cell);
    return mode === 'none' ? style.ok(cell) : cell;
  };
  const table = renderTable(
    columns,
    rows.map((row) => row.map((cell, index) => (index < 2 ? cell : tone(columns[index]?.header, cell)))),
    style,
    '  ',
  );
  if (table.split('\n').every((line) => visibleWidth(line) <= width)) return table;

  // Too many modes for one line each: one wrapped line per strategy instead.
  const modes = columns.slice(2).map((column) => column.header);
  return rows
    .flatMap((row) => {
      const [id = '', total = ''] = row;
      const counts = modes
        .map((mode, index) => [mode, row[index + 2] ?? '0'] as const)
        .filter(([, count]) => count !== '0')
        .map(([mode, count]) => `${mode} ${tone(mode, count)}`)
        .join(' · ');
      return hanging(`  ${style.bold(id)} `, 4, `${total} runs: ${counts}`, width);
    })
    .join('\n');
}

// ---------------------------------------------------------------------------
// Health gate
// ---------------------------------------------------------------------------

/**
 * Why a run set must not be published, if anything: it is incomplete, a run
 * failed its integrity checks or hit an API error, or a run cannot be
 * verified at all. Empty means publishable.
 */
export function publicationProblems(view: ReportView): string[] {
  const problems: string[] = [];
  const manifest = view.manifest;
  if (view.synthetic) problems.push('the run set is synthetic');
  if (!manifest) problems.push('the run set has no manifest');
  else if (manifest.status !== 'complete') {
    problems.push(
      manifest.status === undefined
        ? 'the manifest predates completion status'
        : `the run set is ${manifest.status}${manifest.stoppedBy ? ` (${stopReasonText(manifest.stoppedBy)})` : ''}, ${manifest.completedRuns} of ${manifest.totalRuns} runs recorded`,
    );
  }
  const health = view.health;
  if (health.integrityFailed > 0) problems.push(`${plural(health.integrityFailed, 'run')} failed integrity checks`);
  if (health.apiErrors > 0) problems.push(`${plural(health.apiErrors, 'run')} hit API errors`);
  if (health.unverified + health.audited > 0) {
    problems.push(`${plural(health.unverified + health.audited, 'run')} predate integrity checks`);
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

function markdownTable(columns: readonly Column[], rows: readonly (readonly string[])[]): string {
  const escape = (cell: string): string => cell.replace(/\|/g, '\\|');
  const header = `| ${columns.map((column) => escape(column.header.trim() || ' ')).join(' | ')} |`;
  const divider = `| ${columns.map((column) => (column.align === 'right' ? '---:' : ':---')).join(' | ')} |`;
  const body = rows.map((row) => `| ${columns.map((_, index) => escape(row[index] ?? '')).join(' | ')} |`);
  return [header, divider, ...body].join('\n');
}

function fenced(lines: readonly string[]): string {
  return ['```text', ...lines, '```'].join('\n');
}

export function toMarkdown(view: ReportView): string {
  const title = view.runSetId ? `ScaffoldBench report — ${view.runSetId}` : 'ScaffoldBench report';
  const parts: string[] = [`# ${title}`, ''];

  if (view.synthetic) {
    parts.push(
      '> **SYNTHETIC DATA.** These numbers were fabricated for interface development and must never be quoted as results.',
      '',
    );
  }
  for (const [key, value] of headerLines(view)) parts.push(`- **${key}:** ${value}`);
  parts.push('');

  parts.push('## Health', '');
  const marks = { ok: '✅', warn: '⚠️', bad: '❌' } as const;
  for (const line of healthSummary(view.health)) parts.push(`- ${marks[line.level]} ${line.text}`);
  parts.push('');
  if (view.health.failingChecks.length > 0) {
    parts.push(
      markdownTable(
        [{ header: 'Failing check' }, { header: 'Runs', align: 'right' }, { header: 'By strategy' }, { header: 'Example' }],
        view.health.failingChecks.map((check) => [
          `\`${check.id}\``,
          String(check.runs),
          [...check.byStrategy].map(([id, count]) => `${id} ${count}`).join(', '),
          truncateText(check.example ?? '', 200),
        ]),
      ),
      '',
    );
  }
  if (view.health.phaseIssues.length > 0) {
    parts.push(
      markdownTable(
        [{ header: 'Strategy' }, { header: 'Phase' }, { header: 'Ended', align: 'right' }, { header: 'How' }],
        view.health.phaseIssues.map((issue) => [
          issue.strategyId,
          issue.phase,
          `${issue.runs}/${issue.of}`,
          truncateText(issue.outcome, 120),
        ]),
      ),
      '',
      'Phase outcomes are informational; only the integrity checks decide what is ranked.',
      '',
    );
  }

  for (const model of view.models) {
    const suffix = view.models.length > 1 ? ` — ${model.model}` : '';
    parts.push(`## Leaderboard${suffix}`, '');
    if (model.arms.length === 0) {
      parts.push('No ranked runs: every run of this model was excluded (see Health).', '');
      continue;
    }
    parts.push(
      markdownTable(
        [
          { header: 'Strategy' },
          { header: 'Architecture' },
          { header: 'n', align: 'right' },
          { header: 'Mean score (95% CI)' },
          { header: 'Pass', align: 'right' },
          { header: 'Mean cost', align: 'right' },
          { header: 'Mean latency', align: 'right' },
          { header: 'Score per $', align: 'right' },
        ],
        model.arms.map((arm) => [
          `${arm.frontier ? '★ ' : ''}${arm.strategyId}`,
          arm.label,
          String(arm.runs),
          `${formatScore(arm.score.value)} ${formatCi(arm)}`,
          passText(arm),
          formatUsd(arm.costUsd.value),
          formatDuration(arm.latencyMs.value),
          arm.scorePerDollar === null ? '-' : arm.scorePerDollar.toFixed(1),
        ]),
      ),
      '',
      '★ Pareto frontier: no other strategy scores at least as high for less.',
      '',
    );
    parts.push(
      fenced(
        renderForestPlot(
          model.arms.map((arm) => ({
            label: arm.strategyId,
            estimate: arm.score,
            ...(arm.frontier ? { marker: GLYPH.frontier } : {}),
          })),
          { width: 96, format: (v) => v.toFixed(3), clamp: { low: 0, high: 1 } },
        ),
      ),
      '',
    );

    parts.push(`### Pairwise verdicts${suffix}`, '');
    if (model.contrasts.length === 0) {
      parts.push('Nothing to compare.', '');
    } else {
      parts.push(
        markdownTable(
          [{ header: 'Comparison' }, { header: 'Mean delta', align: 'right' }, { header: 'Verdict' }],
          model.contrasts.map((contrast) => [
            `${contrast.a} vs ${contrast.b}`,
            formatDelta(contrast.estimate),
            contrast.verdict === 'better'
              ? `${contrast.a} better`
              : contrast.verdict === 'worse'
                ? `${contrast.b} better`
                : contrast.verdict === 'equivalent'
                  ? 'equivalent'
                  : 'inconclusive (confidence intervals overlap)',
          ]),
        ),
        '',
        `Compared by ${model.contrastMethod}.`,
        '',
      );
    }

    parts.push(`### Score by task${suffix}`, '');
    const ids = model.arms.map((arm) => arm.strategyId);
    parts.push(
      markdownTable(
        [{ header: 'Task' }, ...ids.map((id) => ({ header: id, align: 'right' as const }))],
        model.taskIds.map((taskId) => [
          taskId,
          ...ids.map((id) => {
            const score = model.scoreByTask.get(taskId)?.get(id);
            return score === undefined ? '-' : score.toFixed(2);
          }),
        ]),
      ),
      '',
      'Cells are the mean score over the repeats of that pair, ranked runs only.',
      '',
    );

    parts.push(`### Failure modes${suffix}`, '');
    const { columns, rows } = failureTable(model);
    parts.push(markdownTable(columns, rows), '', 'Every run, ranked or not.', '');
  }

  return parts.join('\n');
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
