import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { ARCHITECTURES } from '../lib/architectures';
import { DARK } from '../lib/palette';
import { contrast, deltaE } from './color';

const css = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'app', 'globals.css'),
  'utf8',
);

/** The custom properties declared directly inside the first block opened by `selector`. */
function tokens(selector: string): Record<string, string> {
  const start = css.indexOf(selector);
  if (start < 0) throw new Error(`selector not found: ${selector}`);
  const open = css.indexOf('{', start);
  const close = css.indexOf('}', open);
  const body = css.slice(open + 1, close);
  const out: Record<string, string> = {};
  for (const match of body.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)) {
    out[match[1] as string] = (match[2] as string).toLowerCase();
  }
  return out;
}

const light = tokens(':root {\n  color-scheme: light;');
const dark = tokens(':root[data-theme="dark"],\n.theme-dark {');
const darkByOs = tokens(':root:not([data-theme="light"]) {');

const THEMES = { light, dark } as const;
const SURFACES = ['plane', 'surface', 'sunken'] as const;
const TEXT = ['ink', 'ink-2', 'muted', 'good', 'bad', 'warn', 'focus'] as const;
const ARCH = ARCHITECTURES.map((info) => `arch-${info.id}`);

describe('colour tokens', () => {
  it('declares the dark theme identically for the toggle and for the OS preference', () => {
    expect(Object.keys(dark).length).toBeGreaterThan(20);
    expect(darkByOs).toEqual(dark);
  });

  it('keeps the literal palette used by the social card equal to the dark tokens', () => {
    for (const [name, value] of Object.entries(DARK)) {
      expect(dark[name], name).toBe(value);
    }
  });

  it('declares every token in both themes', () => {
    expect(Object.keys(dark).sort()).toEqual(Object.keys(light).sort());
  });

  for (const [name, theme] of Object.entries(THEMES)) {
    it(`keeps every text token at WCAG AA (4.5:1) on every ${name} surface`, () => {
      for (const text of TEXT) {
        for (const surface of SURFACES) {
          const ratio = contrast(theme[text] as string, theme[surface] as string);
          expect(ratio, `${name} ${text} on ${surface}`).toBeGreaterThanOrEqual(4.5);
        }
      }
    });

    it(`keeps every architecture colour at 3:1 as a graphic on ${name} surfaces`, () => {
      for (const arch of ARCH) {
        for (const surface of ['plane', 'surface'] as const) {
          const ratio = contrast(theme[arch] as string, theme[surface] as string);
          expect(ratio, `${name} ${arch} on ${surface}`).toBeGreaterThanOrEqual(3);
        }
      }
    });

    it(`keeps all ${name} architecture colours apart, including under colour-blindness`, () => {
      // Scatter plots put any two architectures side by side, so every pair is
      // checked, not just neighbours: ΔE ≥ 15 with full colour vision and ≥ 8
      // simulated as protanopia or deuteranopia (the data-viz targets).
      for (let i = 0; i < ARCH.length; i++) {
        for (let j = i + 1; j < ARCH.length; j++) {
          const a = theme[ARCH[i] as string] as string;
          const b = theme[ARCH[j] as string] as string;
          const pair = `${ARCH[i]} / ${ARCH[j]}`;
          expect(deltaE(a, b), `${name} ${pair}`).toBeGreaterThanOrEqual(15);
          expect(Math.min(deltaE(a, b, 'protan'), deltaE(a, b, 'deutan')), `${name} ${pair} CVD`).toBeGreaterThanOrEqual(8);
        }
      }
    });
  }
});
