import { describe, expect, it } from 'vitest';

import {
  abbreviationLegend,
  abbreviations,
  niceAxis,
  renderBar,
  renderForestPlot,
  renderPairwiseGrid,
  renderScatter,
  verdictBetween,
} from '../src/plots';
import type { ForestRow, Pair } from '../src/plots';
import { PLAIN, clipLine, createStyle, renderTable, shouldColor, visibleWidth } from '../src/style';
import { plain } from './support';

describe('style', () => {
  it('decides colour the way Node does', () => {
    const tty = { isTTY: true, hasColors: () => true };
    expect(shouldColor(tty, {})).toBe(true);
    expect(shouldColor({ isTTY: false }, {})).toBe(false);
    expect(shouldColor({ isTTY: true, hasColors: () => false }, {})).toBe(false);
    // FORCE_COLOR wins in both directions, on any stream.
    expect(shouldColor({ isTTY: false }, { FORCE_COLOR: '1' })).toBe(true);
    expect(shouldColor({ isTTY: false }, { FORCE_COLOR: '' })).toBe(true);
    expect(shouldColor(tty, { FORCE_COLOR: '0' })).toBe(false);
  });

  it('paints with util.styleText only when colour is on', () => {
    expect(createStyle(true).bad('x')).toBe('\u001b[31mx\u001b[39m');
    expect(PLAIN.bad('x')).toBe('x');
    const both = createStyle(true).paint(['red', 'bold'], 'x');
    expect(both).toContain('\u001b[31m');
    expect(both).toContain('\u001b[1m');
    expect(plain(both)).toBe('x');
  });

  it('measures and clips what is visible, not the escape codes', () => {
    const red = createStyle(true).bad('abcdef');
    expect(visibleWidth(red)).toBe(6);
    expect(visibleWidth('●◑✗')).toBe(3);
    const clipped = clipLine(`${red} tail`, 4);
    expect(plain(clipped)).toBe('abcd');
    expect(clipped.endsWith('\u001b[0m')).toBe(true);
  });

  it('aligns table columns whether or not cells carry colour', () => {
    const style = createStyle(true);
    const rows = [
      [style.ok('pass'), '1'],
      ['a-much-longer-cell', style.bad('22')],
    ];
    const lines = renderTable([{ header: 'NAME' }, { header: 'N', align: 'right' }], rows, style).split('\n');
    const widths = lines.map((line) => visibleWidth(line));
    expect(new Set(widths).size).toBe(1);
  });
});

describe('niceAxis', () => {
  it('snaps to round steps and never leaves the clamp', () => {
    const axis = niceAxis(0.62, 1, 6, { low: 0, high: 1 });
    expect(axis.ticks).toEqual([0.6, 0.7, 0.8, 0.9, 1]);
    expect(axis.decimals).toBe(1);
  });

  it('knows how many decimals its ticks need', () => {
    expect(niceAxis(0.031, 0.047, 5).decimals).toBe(3);
    expect(niceAxis(0, 0.19, 5).ticks).toEqual([0, 0.05, 0.1, 0.15, 0.2]);
  });

  it('opens up a zero-width range instead of dividing by zero', () => {
    const axis = niceAxis(1, 1, 5, { low: 0, high: 1 });
    expect(axis.high).toBe(1);
    expect(axis.low).toBeLessThan(1);
  });
});

describe('renderForestPlot', () => {
  const rows: ForestRow[] = [
    { label: 'single', estimate: { value: 0.99, ci: { low: 0.97, high: 1 } }, marker: '★' },
    { label: 'orchestrator-workers', estimate: { value: 0.8, ci: { low: 0.62, high: 0.93 } } },
    { label: 'propose-select', estimate: { value: 0.7, ci: null } },
  ];

  it('draws each interval on one shared axis, numbers beside it', () => {
    const lines = renderForestPlot(rows, { width: 90, clamp: { low: 0, high: 1 }, format: (v) => v.toFixed(2) });

    expect(lines).toHaveLength(4);
    expect(lines[0]).toMatch(/0\.6.*0\.7.*0\.8.*0\.9.*1\.0/);
    expect(lines[1]).toMatch(/^★ single\s+.*├─*●─*┤.*0\.99 \[0\.97, 1\.00\]$/);
    expect(lines[2]).toMatch(/├─+●─+┤/);
    // No interval: the point alone, and the numbers say so.
    expect(lines[3]).not.toMatch(/[├┤]/);
    expect(lines[3]).toMatch(/●.*0\.70$/);
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(90);
  });

  it('places the point between its whiskers', () => {
    const line = renderForestPlot(rows, { width: 90 })[2] ?? '';
    expect(line.indexOf('├')).toBeLessThan(line.indexOf('●'));
    expect(line.indexOf('●')).toBeLessThan(line.indexOf('┤'));
  });
});

describe('pairwise grid', () => {
  const ids = ['single', 'plan-execute', 'orchestrator-workers'];
  const pairs: Pair[] = [
    { a: 'single', b: 'orchestrator-workers', verdict: 'better' },
    { a: 'plan-execute', b: 'single', verdict: 'equivalent' },
    { a: 'plan-execute', b: 'orchestrator-workers', verdict: 'inconclusive' },
  ];

  it('reads a verdict from either orientation', () => {
    expect(verdictBetween(pairs, 'single', 'orchestrator-workers')).toBe('better');
    expect(verdictBetween(pairs, 'orchestrator-workers', 'single')).toBe('worse');
    expect(verdictBetween(pairs, 'single', 'plan-execute')).toBe('equivalent');
    expect(verdictBetween(pairs, 'single', 'nobody')).toBeUndefined();
  });

  it('draws one row per strategy against every column', () => {
    const lines = renderPairwiseGrid(ids, pairs, { headers: abbreviations(ids) });

    expect(lines[0]).toMatch(/S\s+PE\s+OW/);
    expect(lines[1]).toMatch(/single\s+—\s+≈\s+▲/);
    expect(lines[2]).toMatch(/plan-execute\s+≈\s+—\s+·/);
    expect(lines[3]).toMatch(/orchestrator-workers\s+▼\s+·\s+—/);
  });
});

describe('renderScatter', () => {
  it('labels every point beside it and puts the frontier in stars', () => {
    const lines = renderScatter(
      [
        { label: 'S', x: 0.05, y: 0.99, highlight: true },
        { label: 'PE', x: 0.07, y: 0.95 },
        { label: 'DS', x: 0.19, y: 1 },
      ],
      { width: 48, height: 8, xFromZero: true, formatX: (v, d) => `$${v.toFixed(Math.max(2, d))}` },
    );
    const text = lines.join('\n');

    expect(text).toContain('★S');
    expect(text).toContain('●PE');
    expect(text).toContain('●DS');
    expect(lines.at(-1)).toMatch(/\$0\.00/);
    expect(lines.at(-2)).toMatch(/└┬─+┬/);
  });

  it('joins points that land on the same cell instead of drawing one over the other', () => {
    const text = renderScatter(
      [
        { label: 'A', x: 0.1, y: 0.5 },
        { label: 'B', x: 0.1, y: 0.5 },
      ],
      { width: 30, height: 6 },
    ).join('\n');
    expect(text).toContain('A,B');
  });

  it('lists a label it has no room for rather than overlapping', () => {
    const text = renderScatter(
      [
        { label: 'LONGLABEL', x: 0, y: 1 },
        { label: 'OTHERLONG', x: 1, y: 1 },
      ],
      { width: 16, height: 4 },
    ).join('\n');
    expect(text).toMatch(/not labelled for lack of room: .*LONGLABEL|OTHERLONG/);
  });
});

describe('small pieces', () => {
  it('fills a bar to the eighth of a column', () => {
    expect(renderBar(0, 10)).toBe('░'.repeat(10));
    expect(renderBar(1, 10)).toBe('█'.repeat(10));
    expect(renderBar(0.55, 10)).toBe('█████▌░░░░');
    expect(visibleWidth(renderBar(0.33, 17))).toBe(17);
  });

  it('abbreviates ids by their initials, numbering every collision', () => {
    const short = abbreviations(['single', 'plan-execute', 'propose-execute', 'plan-execute-verify']);
    expect(short.get('single')).toBe('S');
    expect(short.get('plan-execute')).toBe('PE1');
    expect(short.get('propose-execute')).toBe('PE2');
    expect(short.get('plan-execute-verify')).toBe('PEV');
    expect(abbreviationLegend(short)).toBe('S single · PE1 plan-execute · PE2 propose-execute · PEV plan-execute-verify');
  });
});

describe('trailing padding', () => {
  it('leaves no spaces after the last column of a coloured pairwise grid', () => {
    const style = createStyle(true);
    const lines = renderPairwiseGrid(['a', 'bb'], [{ a: 'a', b: 'bb', verdict: 'better' }], { style });
    for (const line of lines) expect(line, JSON.stringify(line)).not.toMatch(/ +(\u001b\[\d+m)*$/);
  });
});
