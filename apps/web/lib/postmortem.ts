/**
 * Act 1: what each architecture was designed to do against what it did, read
 * off the committed run records of the first published run set.
 *
 * Every receipt is a count over `runs/*.json` — phase errors, worker counts,
 * tool calls per proposer, revision phases — so the claim on the page is
 * re-derived on every build from files anyone can open, not typed into copy.
 * The traces that first exposed the failure are not committed; nothing here
 * depends on them.
 */

import { compareArchitectures } from './architectures';
import type { RunRecord } from './records';

export interface Receipt {
  /** What went wrong, as a sentence fragment that reads after the count. */
  label: string;
  count: number;
  of: number;
  /** What `count` and `of` count: runs, or individual phases. */
  unit: 'runs' | 'proposals';
}

export interface PostmortemRow {
  strategyId: string;
  runs: number;
  /** What the leaderboard said: the plain mean score over these runs. */
  meanScore: number;
  /** True when no receipt below fired in any run. */
  ranAsDesigned: boolean;
  /** Glyph node ids that never did their job (see `lib/glyphs.ts`). */
  deadNodes: string[];
  receipts: Receipt[];
}

export interface Postmortem {
  runSetId: string;
  runs: number;
  models: string[];
  rows: PostmortemRow[];
  /** Architectures with at least one receipt. */
  degraded: number;
  /** Runs in which the sandbox guard denied a tool call. */
  runsWithDenials: number;
}

export function derivePostmortem(runSetId: string, records: readonly RunRecord[]): Postmortem {
  const strategies = [...new Set(records.map((record) => record.strategyId))].sort(
    compareArchitectures,
  );

  const rows = strategies.map((strategyId) => {
    const runs = records.filter((record) => record.strategyId === strategyId);
    const { receipts, deadNodes } = inspect(strategyId, runs);
    return {
      strategyId,
      runs: runs.length,
      meanScore: runs.reduce((sum, record) => sum + record.score, 0) / Math.max(1, runs.length),
      ranAsDesigned: receipts.every((receipt) => receipt.count === 0),
      deadNodes,
      receipts: receipts.filter((receipt) => receipt.count > 0),
    };
  });

  return {
    runSetId,
    runs: records.length,
    models: [...new Set(records.map((record) => record.model))],
    rows,
    degraded: rows.filter((row) => !row.ranAsDesigned).length,
    runsWithDenials: records.filter((record) => record.deniedToolCalls > 0).length,
  };
}

function inspect(
  strategyId: string,
  runs: readonly RunRecord[],
): { receipts: Receipt[]; deadNodes: string[] } {
  const n = runs.length;
  const receipts: Receipt[] = [];
  const dead = new Set<string>();
  const all = (count: number) => n > 0 && count === n;

  const phaseErrored = (name: string) =>
    runs.filter((run) => run.phases.some((phase) => phase.phase === name && !!phase.error)).length;

  switch (strategyId) {
    case 'plan-execute':
    case 'plan-execute-verify': {
      const planFailed = phaseErrored('plan');
      receipts.push({
        label: 'the planning phase ended in an error',
        count: planFailed,
        of: n,
        unit: 'runs',
      });
      if (all(planFailed)) dead.add('plan');

      if (strategyId === 'plan-execute-verify') {
        const revised = runs.filter((run) =>
          run.phases.some((phase) => phase.phase.startsWith('revise')),
        ).length;
        const imperfect = runs.filter((run) => run.score < 1).length;
        if (revised === 0 && imperfect > 0) {
          receipts.push({
            label: `the verifier sent nothing back for revision, including the ${imperfect} that scored below 1.0`,
            count: n,
            of: n,
            unit: 'runs',
          });
          dead.add('verify');
        }
      }
      break;
    }

    case 'orchestrator-workers': {
      const decomposeFailed = phaseErrored('decompose');
      receipts.push({
        label: 'the decomposition phase ended in an error',
        count: decomposeFailed,
        of: n,
        unit: 'runs',
      });
      if (all(decomposeFailed)) dead.add('orchestrate');

      const singleWorker = runs.filter(
        (run) => run.phases.filter((phase) => phase.phase.startsWith('worker')).length <= 1,
      ).length;
      receipts.push({
        label: 'the task went to a single worker',
        count: singleWorker,
        of: n,
        unit: 'runs',
      });
      if (all(singleWorker)) {
        dead.add('w1');
        dead.add('w3');
      }
      break;
    }

    case 'propose-select': {
      const proposers = runs.flatMap((run) =>
        run.phases.filter((phase) => /^propose-\d+$/.test(phase.phase)),
      );
      const idle = proposers.filter((phase) => phase.toolCalls === 0);
      receipts.push({
        label: 'made without a single tool call',
        count: idle.length,
        of: proposers.length,
        unit: 'proposals',
      });
      for (const id of ['1', '2', '3']) {
        const these = proposers.filter((phase) => phase.phase === `propose-${id}`);
        if (these.length > 0 && these.every((phase) => phase.toolCalls === 0)) dead.add(`p${id}`);
      }

      const selectFailed = phaseErrored('select');
      receipts.push({
        label: 'the selection phase ended in an error',
        count: selectFailed,
        of: n,
        unit: 'runs',
      });
      if (all(selectFailed)) dead.add('select');
      break;
    }

    default: {
      const failed = runs.filter((run) => run.phases.some((phase) => !!phase.error)).length;
      receipts.push({ label: 'a phase ended in an error', count: failed, of: n, unit: 'runs' });
    }
  }

  return { receipts, deadNodes: [...dead] };
}
