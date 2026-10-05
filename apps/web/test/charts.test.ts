import { analyzeRunSet } from '@scaffoldbench/core';
import { describe, expect, it } from 'vitest';

import type { Estimate, ModelAnalysis, SiteAnalysis } from '../lib/analysis';
import {
  describeModel,
  describeUnverifiedModel,
  modelTableRows,
  paretoPoints,
  payoffData,
  payoffDomains,
  payoffHeadline,
  scaleHeadline,
} from '../lib/chartData';
import {
  estimateTextWidth,
  linearTicks,
  logTicks,
  niceDomain,
  niceStep,
  placeLabels,
} from '../lib/charts';

describe('scales and ticks', () => {
  it('picks round steps', () => {
    expect(niceStep(1, 5)).toBe(0.2);
    expect(niceStep(0.37, 4)).toBe(0.1);
    expect(niceStep(37, 4)).toBe(10);
  });

  it('expands a domain outward to round numbers', () => {
    expect(niceDomain(0.612, 0.958, 4)).toEqual([0.6, 1]);
    expect(niceDomain(-0.13, 0.22, 5)).toEqual([-0.2, 0.3]);
  });

  it('places linear ticks exactly on the step', () => {
    expect(linearTicks([-0.2, 0.3], 5)).toEqual([-0.2, -0.1, 0, 0.1, 0.2, 0.3]);
  });

  it('labels a log axis with plain multiples', () => {
    expect(logTicks([0.85, 4.2], 6)).toEqual([1, 1.5, 2, 3, 4]);
    const many = logTicks([0.01, 0.6], 5);
    expect(many.length).toBeLessThanOrEqual(5);
    expect(many[0]).toBeGreaterThanOrEqual(0.01);
  });
});

describe('placeLabels', () => {
  const bounds = { x: 0, y: 0, width: 300, height: 200 };

  it('never overlaps two labels when there is room', () => {
    // Five points stacked almost on top of each other.
    const requests = ['Plan-execute', 'Orchestrator-workers', 'Plan-execute-verify', 'Propose-select', 'Gated-execute'].map(
      (text, i) => ({ id: text, text, x: 150 + i * 4, y: 100 + i * 3, r: 6, fontSize: 11.5 }),
    );
    const placed = placeLabels(requests, bounds);
    for (let i = 0; i < placed.length; i++) {
      for (let j = i + 1; j < placed.length; j++) {
        const a = placed[i]!.box;
        const b = placed[j]!.box;
        const overlap = a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
        expect(overlap, `${placed[i]!.id} / ${placed[j]!.id}`).toBe(false);
      }
    }
  });

  it('keeps labels inside the plot and adds a leader when a label had to move away', () => {
    const placed = placeLabels(
      [
        { id: 'a', text: 'Alpha', x: 296, y: 100, r: 6, fontSize: 12 },
        { id: 'b', text: 'Beta', x: 296, y: 104, r: 6, fontSize: 12 },
      ],
      bounds,
    );
    for (const label of placed) {
      expect(label.box.x).toBeGreaterThanOrEqual(0);
      expect(label.box.x + label.box.width).toBeLessThanOrEqual(300);
    }
  });

  it('estimates wider text for wider glyphs', () => {
    expect(estimateTextWidth('WWW', 12)).toBeGreaterThan(estimateTextWidth('iii', 12));
  });
});

const e = (mean: number, low: number, high: number): Estimate => ({ mean, ci: { low, high } });

function model(id: string, verdicts: ('better' | 'worse' | 'equivalent' | 'inconclusive')[]): ModelAnalysis {
  const ids = ['plan-execute', 'orchestrator-workers', 'plan-execute-verify', 'propose-select', 'gated-execute'];
  return {
    model: id,
    architectures: [
      { strategyId: 'single', runs: 10, tasks: 5, score: e(0.5, 0.4, 0.6), passRate: e(0.5, 0.2, 0.8), costUsd: e(0.1, 0.09, 0.11), latencyMs: e(1000, 900, 1100) },
      ...verdicts.map((_, i) => ({
        strategyId: ids[i] as string,
        runs: 10,
        tasks: 5,
        score: e(0.6, 0.5, 0.7),
        passRate: e(0.6, 0.3, 0.8),
        costUsd: e(0.2, 0.18, 0.22),
        latencyMs: e(2000, 1800, 2200),
      })),
    ],
    contrasts: verdicts.map((verdict, i) => ({
      strategyId: ids[i] as string,
      baselineId: 'single',
      pairs: 10,
      tasks: 5,
      scoreDelta: verdict === 'better' ? e(0.1, 0.06, 0.14) : verdict === 'worse' ? e(-0.1, -0.14, -0.06) : e(0, -0.03, 0.03),
      costRatio: e(2, 1.9, 2.1),
      latencyRatio: e(2, 1.9, 2.1),
      verdict,
      costVerdict: 'worse' as const,
      latencyVerdict: 'worse' as const,
      pAdjusted: verdict === 'inconclusive' ? 0.4 : 0.01,
    })),
    pairwise: [],
    ranks: [],
    frontier: ['single'],
    frontierTied: [],
    meanFrontier: ['single'],
    health: EMPTY_HEALTH,
  };
}

const EMPTY_HEALTH = { total: 0, rankable: 0, integrityFailed: 0, apiErrors: 0, withoutIntegrity: 0, failedChecks: [], byStrategy: [] };

function analysis(models: ModelAnalysis[]): SiteAnalysis {
  return {
    baselineId: 'single',
    confidence: 0.95,
    margin: 0.05,
    settings: analyzeRunSet([]).settings,
    method: 'method',
    models,
    scale: [],
    health: EMPTY_HEALTH,
  };
}

describe('headline prose', () => {
  it('names only reliable wins and accounts for every other combination', () => {
    const text = payoffHeadline(
      analysis([model('claude-sonnet-5-5', ['better', 'worse', 'equivalent', 'inconclusive'])]),
    );
    expect(text).toContain('1 of 4');
    expect(text).toContain('Plan-execute on Sonnet 5.5');
    expect(text).toContain('1 scores reliably below it');
    expect(text).toContain('The other 2 are equivalent to it or not separable');
  });

  it('does not crown anything when nothing separates', () => {
    const text = payoffHeadline(analysis([model('claude-opus-5-5', ['inconclusive', 'inconclusive'])]));
    expect(text).toMatch(/^None of the 2/);
    expect(text).toContain('All 2 are equivalent to it or not separable');
  });

  it('describes one model with a proper list', () => {
    const text = describeModel(model('claude-haiku-4-5-20251001', ['better', 'better', 'better']));
    expect(text).toContain('Plan-execute, Orchestrator-workers and Plan-execute-verify score reliably above');
  });

  it('draws no verdict from a run set without fidelity checks', () => {
    const text = describeUnverifiedModel(model('claude-sonnet-5-5', ['better', 'equivalent', 'worse']));
    expect(text).toContain('Sonnet 5.5');
    expect(text).not.toMatch(/\b(better|worse|equivalent|reliably)\b/);
  });

  it('says nothing about scale when there is only one model', () => {
    expect(scaleHeadline(analysis([model('claude-sonnet-5-5', ['better'])]))).toBeNull();
  });
});

describe('chart adapters', () => {
  it('shares one axis across small multiples and always includes 1× and the margin', () => {
    const data = payoffData(analysis([model('a', ['better']), model('b', ['worse'])]));
    const domains = payoffDomains(data);
    expect(domains.x[0]).toBeLessThanOrEqual(1);
    expect(domains.y[0]).toBeLessThanOrEqual(-0.14);
    expect(domains.y[1]).toBeGreaterThanOrEqual(0.14);
  });

  it('says "no interval" where core withheld one, and why, instead of printing a zero-width range', () => {
    const none = model('claude-sonnet-5-5', ['inconclusive']);
    const contrast = none.contrasts[0];
    if (!contrast) throw new Error('no contrast');
    contrast.scoreDelta = { mean: 0, ci: null };
    contrast.costRatio = { mean: 2, ci: null };
    contrast.caveat = 'no-variation';

    const [point] = payoffData(analysis([none])).panels[0]?.points ?? [];
    expect(point?.note).toContain('0.000 score no interval');
    expect(point?.note).toContain('every task moved by the same amount');
    expect(point?.caveat).toBe('no-variation');
    expect(modelTableRows(none, 'single')[1]).toMatchObject({ deltaInterval: 'no interval' });

    // A point with no interval is bounded by the point itself: the axes still hold 1×, the margin and the dot.
    const domains = payoffDomains(payoffData(analysis([none])));
    expect(domains.x).toEqual([1, 2]);
    expect(domains.y).toEqual([-0.05, 0.05]);
  });

  it('counts a pair without enough tasks as untested, not as a tie', () => {
    const m = model('claude-sonnet-5-5', ['better', 'inconclusive', 'inconclusive']);
    // Only the second inconclusive pair lacked the tasks; the other is a finding.
    m.contrasts[1]!.caveat = 'too-few-tasks';
    const text = describeModel(m);
    expect(text).toContain('One is not separable from it at this sample size.');
    expect(text).toContain('One has too few tasks for any verdict.');
  });

  it('draws the frontier from the paired evidence: a tied arm stays on it, a beaten one is a ring', () => {
    const m = model('claude-sonnet-5-5', ['inconclusive', 'worse']);
    m.frontier = ['single', 'plan-execute'];
    m.frontierTied = ['plan-execute'];
    const points = paretoPoints(m);
    expect(points.map((p) => [p.id, p.hollow])).toEqual([
      ['single', false],
      ['plan-execute', false],
      ['orchestrator-workers', true],
    ]);
    expect(points[1]?.note).toContain('does not separate them');
    expect(points[2]?.note).toContain('shown to be beaten');
  });

  it('reads the frontier off the means alone for a run set that cannot support a verdict', () => {
    const m = model('claude-sonnet-5-5', ['inconclusive']);
    m.frontier = ['single', 'plan-execute'];
    m.frontierTied = ['plan-execute'];
    m.meanFrontier = ['single'];
    expect(paretoPoints(m, { verdicts: false }).map((p) => [p.id, p.hollow])).toEqual([
      ['single', false],
      ['plan-execute', true],
    ]);
    expect(paretoPoints(m, { verdicts: false })[1]?.note).toContain('dominated on means');
    expect(paretoPoints(m)[1]?.note).toContain('does not separate them');
  });

  it('calls a scaffold reliably cheaper only when core\'s cost verdict says so', () => {
    const scale = (costVerdict: 'better' | 'worse', ci: { low: number; high: number } | null) => ({
      strategyId: 'plan-execute',
      model: 'claude-haiku-4-5-20251001',
      nextModel: 'claude-sonnet-5-5',
      pairs: 10,
      tasks: 5,
      scoreDelta: e(0.1, 0.05, 0.15),
      costRatio: { mean: 0.5, ci },
      verdict: 'better' as const,
      costVerdict,
    });
    const base = analysis([model('claude-haiku-4-5-20251001', []), model('claude-sonnet-5-5', [])]);
    expect(scaleHeadline({ ...base, scale: [scale('better', null)] })).toContain('it was reliably cheaper');
    expect(scaleHeadline({ ...base, scale: [scale('worse', { low: 0.4, high: 0.6 })] })).toContain('none was reliably cheaper');
  });

  it('marks the control in the model table instead of comparing it with itself', () => {
    const rows = modelTableRows(model('claude-sonnet-5-5', ['better']), 'single');
    expect(rows[0]).toMatchObject({ strategyId: 'single', verdict: 'control', delta: '' });
    expect(rows[1]).toMatchObject({ verdict: 'better', delta: '+0.100', costMultiple: '2.0×' });
  });
});
