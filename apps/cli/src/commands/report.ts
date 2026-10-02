/**
 * `arena report`: render a stored run set, health first.
 *
 * `--strict` turns the health section into a gate: it exits 3 unless the run
 * set is complete and every run measured what it claims to, which is what
 * the benchmark workflow checks before it proposes publishing a run set.
 */

import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import { RESULTS_DIR, runSetDir } from '@arena/core';

import type { ReportArgs } from '../args';
import { displayPath } from '../format';
import { formatReport, publicationProblems, toMarkdown } from '../report';
import { listRunSets, loadRunSet, readLatestPointer } from '../runSet';
import { GLYPH } from '../style';
import { closest } from '../suggest';
import { buildReportView } from '../view';
import type { CliContext } from './context';

/** Exit status of `--strict` when the run set is not fit to publish. */
export const EXIT_UNHEALTHY = 3;

export async function reportCommand(args: ReportArgs, ctx: CliContext): Promise<number> {
  const root = args.resultsDir ? path.resolve(ctx.cwd, args.resultsDir) : RESULTS_DIR;
  const runSetId = args.runSetId ?? (await readLatestPointer(root));

  if (runSetId === undefined) {
    ctx.fail('No run set was given, and results/latest.json does not name one.');
    await listAvailable(ctx, root);
    return 1;
  }

  const runSet = await loadRunSet(runSetId, { root, traces: true });
  if (runSet.records.length === 0) {
    const known = (await listRunSets(root)).map((entry) => entry.runSetId);
    const guess = closest(runSetId, known);
    ctx.fail(
      `No runs found for "${runSetId}" under ${displayPath(ctx.cwd, root)}.` +
        (guess.length > 0 ? ` Did you mean ${guess.join(' or ')}?` : ''),
    );
    if (guess.length === 0) await listAvailable(ctx, root);
    return 1;
  }

  const view = buildReportView(runSet);
  ctx.out(formatReport(view, { style: ctx.outStyle, width: ctx.width }));

  if (args.markdown) {
    const target = path.join(runSetDir(runSetId, root), 'REPORT.md');
    await writeFile(target, toMarkdown(view), 'utf8');
    ctx.err('');
    ctx.err(`${ctx.errStyle.ok(GLYPH.ok)} Wrote ${displayPath(ctx.cwd, target)}`);
  }

  if (args.strict) {
    const problems = publicationProblems(view);
    ctx.err('');
    if (problems.length > 0) {
      ctx.err(`${ctx.errStyle.bad(GLYPH.fail)} Not fit to publish:`);
      for (const problem of problems) ctx.err(`    ${problem}`);
      return EXIT_UNHEALTHY;
    }
    ctx.err(`${ctx.errStyle.ok(GLYPH.ok)} Fit to publish: complete, and every run passed its integrity checks.`);
  }
  return 0;
}

async function listAvailable(ctx: CliContext, root: string): Promise<void> {
  const sets = await listRunSets(root);
  if (sets.length === 0) {
    ctx.err(`There are no run sets under ${displayPath(ctx.cwd, root)} yet. Start one with: arena run`);
    return;
  }
  ctx.err(`Run sets under ${displayPath(ctx.cwd, root)}:`);
  const width = Math.max(...sets.map((entry) => entry.runSetId.length));
  for (const entry of sets) {
    const manifest = entry.manifest;
    const detail = manifest
      ? `${manifest.models?.join(', ') ?? manifest.model} · ${manifest.completedRuns}/${manifest.totalRuns} runs` +
        (manifest.synthetic ? ' · synthetic' : '') +
        (manifest.status && manifest.status !== 'complete' ? ` · ${manifest.status}` : '')
      : 'no manifest';
    ctx.err(`  ${entry.runSetId.padEnd(width)}  ${ctx.errStyle.dim(detail)}`);
  }
}
