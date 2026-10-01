import { describe, expect, it } from 'vitest';

import {
  ARCHITECTURES,
  architectureColor,
  architectureName,
  canonicalArchitectureId,
  compareArchitectures,
} from '../lib/architectures';
import { formatDelta, formatMultiple, joinList } from '../lib/format';
import { GLYPHS } from '../lib/glyphs';
import { MODELS, compareModels, modelShortName } from '../lib/models';
import { isRankable, normalizeRecord, runSetModels } from '../lib/records';
import { run } from './fixtures';

describe('architectures', () => {
  it('maps the legacy debate-select id to propose-select', () => {
    expect(canonicalArchitectureId('debate-select')).toBe('propose-select');
    expect(architectureName('debate-select')).toBe('Propose-select');
    expect(normalizeRecord(run({ strategyId: 'debate-select' })).strategyId).toBe('propose-select');
  });

  it('keeps the recorded run id when it renames the architecture', () => {
    const record = run({ strategyId: 'debate-select', runId: 'debate-select__a__r1' });
    expect(normalizeRecord(record).runId).toBe('debate-select__a__r1');
  });

  it('orders the control first and unknown strategies last', () => {
    const ids = ['ghost', 'gated-execute', 'single', 'plan-execute'];
    expect(ids.sort(compareArchitectures)).toEqual(['single', 'plan-execute', 'gated-execute', 'ghost']);
  });

  it('draws a glyph for every architecture and a colour token for each', () => {
    for (const info of ARCHITECTURES) {
      expect(GLYPHS[info.id].nodes.length).toBeGreaterThan(0);
      expect(architectureColor(info.id)).toBe(`var(--arch-${info.id})`);
    }
    expect(architectureColor('ghost')).toBe('var(--ink-2)');
  });

  it('only connects glyph edges between nodes that exist', () => {
    for (const geometry of Object.values(GLYPHS)) {
      const ids = new Set(geometry.nodes.map((node) => node.id));
      for (const edge of geometry.edges) {
        expect(ids.has(edge.from) && ids.has(edge.to)).toBe(true);
      }
    }
  });
});

describe('models', () => {
  it('orders models by capability tier', () => {
    const ids = MODELS.map((m) => m.id).reverse();
    expect(ids.sort(compareModels)).toEqual(MODELS.map((m) => m.id));
    expect(modelShortName('claude-haiku-4-5-20251001')).toBe('Haiku 4.5');
    expect(modelShortName('unknown-model')).toBe('unknown-model');
  });

  it('reads the models of a legacy single-model run set from the manifest', () => {
    expect(runSetModels(null, [run({ model: 'claude-sonnet-5' })])).toEqual(['claude-sonnet-5']);
  });
});

describe('rankability', () => {
  it('excludes API errors and failed integrity, but not a legacy run without a verdict', () => {
    expect(isRankable(run({}))).toBe(true);
    expect(isRankable(run({ failureMode: 'api_error' }))).toBe(false);
    expect(isRankable(run({ integrity: { ok: false, checks: [] } }))).toBe(false);
    expect(isRankable(run({ integrity: { ok: true, checks: [] } }))).toBe(true);
  });
});

describe('formatting', () => {
  it('signs deltas with a true minus and never prints -0', () => {
    expect(formatDelta(0.0512)).toBe('+0.051');
    expect(formatDelta(-0.0512)).toBe('−0.051');
    expect(formatDelta(-0.0001)).toBe('0.000');
  });

  it('prints cost multiples with one decimal below ten', () => {
    expect(formatMultiple(2.345)).toBe('2.3×');
    expect(formatMultiple(12.4)).toBe('12×');
    expect(formatMultiple(Number.NaN)).toBe('—');
  });

  it('joins lists for prose', () => {
    expect(joinList(['a', 'b', 'c'])).toBe('a, b and c');
  });
});
