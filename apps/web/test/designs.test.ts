import { describe, expect, it } from 'vitest';

import { ARCHITECTURES } from '../lib/architectures';
import { DESIGNS, designFor, fidelityCheckInfo, stageOfPhase } from '../lib/designs';
import { GLYPHS } from '../lib/glyphs';
import { checkWords } from '../lib/integrity';
import { schematicTimeline } from '../lib/schematic';

describe('the architecture designs', () => {
  it('describes every architecture the site draws', () => {
    expect(Object.keys(DESIGNS).sort()).toEqual(ARCHITECTURES.map((a) => a.id).sort());
  });

  it('draws each stage as real glyph nodes and leaves no node unexplained', () => {
    for (const info of ARCHITECTURES) {
      const nodes = GLYPHS[info.id].nodes.map((node) => node.id).sort();
      const staged = DESIGNS[info.id].stages.flatMap((stage) => stage.nodes);
      expect([...staged].sort(), info.id).toEqual(nodes);
      expect(new Set(staged).size, `${info.id} draws a node in two stages`).toBe(staged.length);
    }
  });

  it('prefixes every fidelity check with its architecture', () => {
    const seen = new Set<string>();
    for (const design of Object.values(DESIGNS)) {
      for (const check of design.checks) {
        expect(check.id.startsWith(`${design.id}.`), check.id).toBe(true);
        expect(seen.has(check.id), `${check.id} is declared twice`).toBe(false);
        seen.add(check.id);
      }
    }
  });

  it('knows the phase names of every schematic timeline, so the picture and the page agree', () => {
    for (const info of ARCHITECTURES) {
      for (const call of schematicTimeline(info.id).calls) {
        expect(stageOfPhase(info.id, call.phase), `${info.id}/${call.phase}`).toBeDefined();
      }
    }
  });

  it('files the phases of both vocabularies under the same stage', () => {
    expect(stageOfPhase('plan-execute-verify', 'verify')?.id).toBe('verify');
    expect(stageOfPhase('plan-execute-verify', 'verify-2-retry')?.id).toBe('verify');
    expect(stageOfPhase('plan-execute-verify', 'revise-1')?.id).toBe('execute');
    expect(stageOfPhase('orchestrator-workers', 'worker-all')?.id).toBe('workers');
    expect(stageOfPhase('orchestrator-workers', 'worker-refund')?.id).toBe('workers');
    expect(stageOfPhase('gated-execute', 'review-3')?.id).toBe('review');
    expect(stageOfPhase('single', 'main')?.id).toBe('agent');
    expect(stageOfPhase('debate-select', 'propose-2')?.id).toBe('propose');
    expect(stageOfPhase('single', 'plan')).toBeUndefined();
  });

  it('resolves a fidelity check to its words, and falls back for ones nobody described', () => {
    expect(fidelityCheckInfo('propose-select.selection')?.title).toBe('The selector chose');
    expect(checkWords('orchestrator-workers.fan-out').title).toBe('The fan-out happened');
    expect(checkWords('harness.api').title).toBe('No API failures');
    expect(checkWords('plan-execute.future-check').title).toBe('Future check');
    expect(designFor('debate-select')?.id).toBe('propose-select');
  });
});
