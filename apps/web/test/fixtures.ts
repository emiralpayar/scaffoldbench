/** Record and event builders shared by the web tests. */

import type { TraceEvent } from '@scaffoldbench/core';

import type { PhaseRecord, RunRecord } from '../lib/records';

export const BASE_RUN: RunRecord = {
  runId: 'single__alpha__r1',
  runSetId: 'set-1',
  taskId: 'alpha',
  taskTitle: 'Alpha task',
  taskCategory: 'tool-use',
  taskWorld: 'airline',
  taskDifficulty: 'easy',
  strategyId: 'single',
  model: 'claude-sonnet-5-5',
  effort: 'high',
  repeat: 1,
  startedAt: '2026-01-01T00:00:00.000Z',
  finishedAt: '2026-01-01T00:00:10.000Z',
  latencyMs: 10_000,
  score: 1,
  passed: true,
  breakdown: [],
  penalties: [],
  failureMode: 'none',
  scoreMetadata: {},
  costUsd: 0.1,
  judgeCostUsd: 0,
  usage: {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
  },
  turns: 3,
  toolCalls: 2,
  deniedToolCalls: 0,
  subagentCount: 0,
  phases: [],
  finalText: 'done',
};

export function run(overrides: Partial<RunRecord>): RunRecord {
  return { ...BASE_RUN, ...overrides };
}

export function phase(overrides: Partial<PhaseRecord> & Pick<PhaseRecord, 'phase'>): PhaseRecord {
  return {
    label: overrides.phase,
    startedAtMs: 0,
    durationMs: 1000,
    costUsd: 0.01,
    turns: 1,
    toolCalls: 1,
    model: 'claude-sonnet-5',
    aborted: false,
    ...overrides,
  };
}

const BASE_EVENT: TraceEvent = { seq: 0, tMs: 0, phase: 'main', depth: 0, kind: 'note' };

export function event(overrides: Partial<TraceEvent>): TraceEvent {
  return { ...BASE_EVENT, ...overrides };
}
