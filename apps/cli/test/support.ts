import { EventEmitter } from 'node:events';
import { stripVTControlCharacters } from 'node:util';

import type { RunRecord, StrategyInfo, TaskInfo } from '@arena/core';

import type { CliContext } from '../src/commands/context';
import type { Catalog, LoadedRunSet } from '../src/runSet';
import { PLAIN } from '../src/style';

export function makeRecord(
  overrides: Partial<RunRecord> & Pick<RunRecord, 'strategyId' | 'taskId'>,
): RunRecord {
  const model = overrides.model ?? 'claude-haiku-4-5-20251001';
  const repeat = overrides.repeat ?? 1;
  return {
    runId: `${model}__${overrides.strategyId}__${overrides.taskId}__r${repeat}`,
    runSetId: 'test-set',
    taskTitle: 'A task',
    taskCategory: 'tool-use',
    taskWorld: 'airline',
    taskDifficulty: 'easy',
    model,
    effort: 'high',
    repeat,
    startedAt: '2026-10-01T12:00:00.000Z',
    finishedAt: '2026-10-01T12:00:30.000Z',
    latencyMs: 30_000,
    score: 0.5,
    passed: false,
    breakdown: [],
    penalties: [],
    failureMode: 'wrong_answer',
    scoreMetadata: {},
    costUsd: 0.04,
    judgeCostUsd: 0,
    usage: { inputTokens: 1000, outputTokens: 100, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
    turns: 5,
    toolCalls: 4,
    deniedToolCalls: 0,
    subagentCount: 0,
    phases: [],
    finalText: 'done',
    integrity: { ok: true, checks: [{ id: 'harness.api', ok: true }] },
    ...overrides,
  };
}

export const catalog: Catalog = {
  strategies: [
    { id: 'alpha', label: 'Alpha harness', description: 'The baseline.' },
    { id: 'beta', label: 'Beta harness', description: 'More structure, more cost.' },
  ] satisfies StrategyInfo[],
  tasks: [
    {
      id: 'airline-easy',
      category: 'tool-use',
      world: 'airline',
      title: 'An easy airline task',
      prompt: 'Do the easy thing.',
      difficulty: 'easy',
      tags: ['airline'],
      maxTurns: 12,
    },
    {
      id: 'airline-hard',
      category: 'tool-use',
      world: 'airline',
      title: 'A hard airline task',
      prompt: 'Do the hard thing.',
      difficulty: 'hard',
      tags: ['airline'],
      maxTurns: 20,
    },
  ] satisfies TaskInfo[],
};

/** Two strategies whose intervals overlap, over two tasks and three repeats. */
export function overlappingRecords(): RunRecord[] {
  const scores: Record<string, number[]> = {
    alpha: [0.6, 0.7, 0.5, 0.6, 0.7, 0.5],
    beta: [0.55, 0.65, 0.45, 0.55, 0.65, 0.45],
  };
  const records: RunRecord[] = [];
  for (const strategyId of ['alpha', 'beta']) {
    let i = 0;
    for (const taskId of ['airline-easy', 'airline-hard']) {
      for (let repeat = 1; repeat <= 3; repeat++) {
        const score = scores[strategyId]?.[i] ?? 0;
        i += 1;
        records.push(
          makeRecord({
            strategyId,
            taskId,
            repeat,
            score,
            passed: score >= 0.999,
            failureMode: repeat === 1 ? 'wrong_answer' : 'policy_violation',
            costUsd: strategyId === 'alpha' ? 0.04 : 0.12,
            latencyMs: strategyId === 'alpha' ? 20_000 : 45_000,
          }),
        );
      }
    }
  }
  return records;
}

/** A little deterministic noise in [-0.02, 0.02], so no two tasks move by exactly the same amount. */
export function jitter(task: number, repeat: number, salt = 0): number {
  return (((task * 7 + repeat * 3 + salt * 2) % 5) - 2) * 0.01;
}

export interface ArmSpec {
  score: (task: number, repeat: number, model: string) => number;
  /** Cost of a run; defaults to $0.04 on the first model and $0.12 on any other. */
  cost?: (task: number, model: string) => number;
}

/**
 * A full (task × repeat) grid per arm. The paired analysis needs at least five
 * tasks for any verdict and six that differ for a difference, which the
 * two-task `overlappingRecords` cannot give.
 */
export function gridRecords(options: {
  strategies: Record<string, ArmSpec>;
  models?: string[];
  tasks?: number;
  repeats?: number;
}): RunRecord[] {
  const models = options.models ?? ['claude-haiku-4-5-20251001'];
  const records: RunRecord[] = [];
  for (const [modelIndex, model] of models.entries()) {
    for (const [strategyId, spec] of Object.entries(options.strategies)) {
      for (let task = 0; task < (options.tasks ?? 8); task++) {
        for (let repeat = 1; repeat <= (options.repeats ?? 2); repeat++) {
          const score = Math.min(1, Math.max(0, spec.score(task, repeat, model)));
          records.push(
            makeRecord({
              strategyId,
              taskId: `grid-${String(task + 1).padStart(2, '0')}`,
              repeat,
              model,
              score,
              passed: score >= 0.999,
              costUsd: spec.cost?.(task, model) ?? (modelIndex === 0 ? 0.04 : 0.12),
            }),
          );
        }
      }
    }
  }
  return records;
}

export function runSetOf(records: RunRecord[], extra: Partial<LoadedRunSet> = {}): LoadedRunSet {
  return {
    runSetId: 'test-set',
    manifest: undefined,
    catalog,
    records,
    audits: new Map(),
    deniedTools: new Map(),
    ...extra,
  };
}

/** Collected output of a command run against `fakeContext`. */
export interface Captured {
  ctx: CliContext;
  out: string[];
  err: string[];
  /** Everything written to stderr's stream (the live view, the plain lines). */
  stderrText: () => string;
  signals: EventEmitter;
}

export function fakeContext(
  overrides: Partial<CliContext> = {},
  options: { tty?: boolean; columns?: number; rows?: number } = {},
): Captured {
  const out: string[] = [];
  const err: string[] = [];
  let stderrText = '';
  const signals = new EventEmitter();
  const ctx: CliContext = {
    argv: ['test'],
    env: {},
    cwd: process.cwd(),
    stdout: { write: (chunk: string) => (out.push(chunk), true) },
    stderr: {
      write: (chunk: string) => ((stderrText += chunk), true),
      isTTY: options.tty === true,
      columns: options.columns ?? 110,
      rows: options.rows ?? 40,
    },
    signals,
    out: (line) => out.push(line),
    err: (line) => {
      err.push(line);
      stderrText += `${line}\n`;
    },
    fail: (message) => err.push(`error: ${message}`),
    outStyle: PLAIN,
    errStyle: PLAIN,
    width: 100,
    dotEnvKeys: new Set(),
    ...overrides,
  };
  return { ctx, out, err, stderrText: () => stderrText, signals };
}

export const plain = (text: string): string => stripVTControlCharacters(text);
