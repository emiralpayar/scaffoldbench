import { describe, expect, it } from 'vitest';

import { buildDemoRunSet } from '../../../scripts/generate-demo-data';
import { ARCHITECTURES } from '../lib/architectures';
import { isRankable } from '../lib/records';

/**
 * The synthetic set exists to exercise every state the site has to draw, so
 * these tests pin that it actually contains each of them.
 */
describe('the synthetic demo run set', () => {
  const demo = buildDemoRunSet();

  it('is labelled synthetic in the manifest and in every task prompt', () => {
    expect(demo.manifest.synthetic).toBe(true);
    expect(demo.manifest.notes).toMatch(/SYNTHETIC/);
    for (const task of demo.catalog.tasks) expect(task.prompt).toMatch(/^\[synthetic\]/);
  });

  it('covers three models, all six architectures and an expert tier', () => {
    expect(demo.manifest.models).toHaveLength(3);
    expect(new Set(demo.records.map((r) => r.model)).size).toBe(3);
    expect(new Set(demo.records.map((r) => r.strategyId))).toEqual(
      new Set(ARCHITECTURES.map((a) => a.id)),
    );
    expect(demo.records.some((r) => r.taskDifficulty === 'expert')).toBe(true);
    expect(demo.records.some((r) => r.taskCategory === 'research')).toBe(true);
    expect(demo.catalog.tasks.some((t) => t.traps && t.traps.length > 0)).toBe(true);
  });

  it('includes failed integrity checks and API errors, which are not rankable', () => {
    const failedIntegrity = demo.records.filter((r) => r.integrity && !r.integrity.ok);
    const apiErrors = demo.records.filter((r) => r.failureMode === 'api_error');

    expect(failedIntegrity.length).toBeGreaterThan(0);
    expect(apiErrors.length).toBeGreaterThan(0);
    expect([...failedIntegrity, ...apiErrors].every((r) => !isRankable(r))).toBe(true);
    expect(apiErrors.every((r) => r.attempts === 3 && !r.passed)).toBe(true);
    // A failed check is reflected in the phase that degraded.
    expect(failedIntegrity.some((r) => r.phases.some((p) => p.degraded))).toBe(true);
  });

  it('records parallel phases that overlap in time', () => {
    const orchestrated = demo.records.find((r) => r.strategyId === 'orchestrator-workers');
    const workers = orchestrated?.phases.filter((p) => p.phase.startsWith('worker-')) ?? [];
    expect(workers).toHaveLength(3);
    const [a, b] = workers;
    expect(a && b && a.startedAtMs < b.startedAtMs + b.durationMs && b.startedAtMs < a.startedAtMs + a.durationMs).toBe(true);
  });

  it('gives every run a unique id and keeps traces for a representative slice', () => {
    expect(new Set(demo.records.map((r) => r.runId)).size).toBe(demo.records.length);
    expect(demo.traces.size).toBeGreaterThan(0);
    for (const runId of demo.traces.keys()) {
      expect(demo.records.find((r) => r.runId === runId)?.traceFile).toBe(`traces/${runId}.jsonl`);
    }
  });

  it('is deterministic', () => {
    expect(buildDemoRunSet().records).toEqual(demo.records);
  });
});
