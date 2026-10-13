/**
 * Draws the README and docs figures for a run set as self-contained SVG.
 *
 *   npx tsx scripts/figures.ts                         # scaffold-or-scale-v1 → docs/figures/
 *   npx tsx scripts/figures.ts <runSetId> [outDir]
 *
 * No dependencies beyond the repository itself: the numbers come from
 * `analyzeRunSet` (the pre-registered analysis, with its defaults) over the
 * committed run records, plus medians read straight from those records for
 * H6. Every figure carries its own <style> with a light and a dark palette
 * (prefers-color-scheme), draws its own card background, and uses only
 * system fonts, so it renders the same on GitHub, in an editor, or offline.
 *
 * Writes hero.svg, cost-vs-score.svg, vs-single.svg and scorecard.svg.
 * Deterministic: the same records give byte-identical files.
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  analyzeRunSet,
  type Contrast,
  type RunSetAnalysis,
  type StrategyAnalysis,
} from '../packages/core/src/analysis';
import type { RunRecord } from '../packages/core/src/types';

const runSetId = process.argv[2] ?? 'scaffold-or-scale-v1';
const outDir = process.argv[3] ?? join('docs', 'figures');

interface RunLite {
  model: string;
  strategyId: string;
  taskId: string;
  latencyMs: number;
  score: number | null;
}

const runsDir = join('results', runSetId, 'runs');
const records: unknown[] = readdirSync(runsDir)
  .filter((f) => f.endsWith('.json'))
  .sort()
  .map((f) => JSON.parse(readFileSync(join(runsDir, f), 'utf8')) as unknown);
const runs = records as RunLite[];
const analysis: RunSetAnalysis = analyzeRunSet(records as RunRecord[]);
const manifest = JSON.parse(readFileSync(join('results', runSetId, 'manifest.json'), 'utf8')) as {
  gitSha?: string;
};
const commit = (manifest.gitSha ?? '').slice(0, 7);

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/** Display order, also the colour order (control first, then palette slots 1–5). */
const ARCHS = [
  'single',
  'plan-execute',
  'plan-execute-verify',
  'orchestrator-workers',
  'propose-select',
  'gated-execute',
] as const;
const SCAFFOLDS = ARCHS.slice(1);

const MODELS = analysis.models.map((m) => m.model);
function modelName(id: string): string {
  const m = /claude-(haiku|sonnet|opus)-(\d+)-(\d+)/.exec(id);
  if (!m) return id;
  const fam = m[1] ?? '';
  return `${fam[0]?.toUpperCase()}${fam.slice(1)} ${m[2]}.${m[3]}`;
}

const N_RUNS = analysis.health.runs;
const N_TASKS = analysis.models[0]?.tasks ?? 0;
const N_REPEATS = analysis.models[0]?.repeats ?? 0;
const ITER = analysis.settings.iterations.toLocaleString('en-US');

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

function arm(model: string, strategyId: string): StrategyAnalysis {
  const s = analysis.models.find((m) => m.model === model)?.strategies.find((x) => x.strategyId === strategyId);
  if (!s) throw new Error(`no arm ${model} ${strategyId}`);
  return s;
}
function vsSingle(model: string, strategyId: string, metric: Contrast['metric']): Contrast {
  const c = analysis.models
    .find((m) => m.model === model)
    ?.vsBaseline.find((x) => x.a.strategyId === strategyId && x.metric === metric);
  if (!c) throw new Error(`no contrast ${model} ${strategyId} ${metric}`);
  return c;
}
function scaleContrast(aModel: string, aStrategy: string, metric: Contrast['metric']): Contrast {
  const c = analysis.scaffoldOrScale.find(
    (x) => x.a.model === aModel && x.a.strategyId === aStrategy && x.metric === metric,
  );
  if (!c) throw new Error(`no scale contrast ${aModel} ${aStrategy} ${metric}`);
  return c;
}
function interaction(strategyId: string, metric: Contrast['metric']) {
  const c = analysis.interactions.find((x) => x.strategyId === strategyId && x.metric === metric);
  if (!c) throw new Error(`no interaction ${strategyId}`);
  return c;
}
function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  if (n === 0) return NaN;
  return n % 2 ? (s[(n - 1) / 2] as number) : ((s[n / 2 - 1] as number) + (s[n / 2] as number)) / 2;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const MINUS = '−';
const signed = (x: number, d = 3) => {
  const r = Number(x.toFixed(d));
  if (r === 0) return (0).toFixed(d);
  return (r > 0 ? '+' : MINUS) + Math.abs(r).toFixed(d);
};
const ci = (lo: number, hi: number, d = 3) => `[${signed(lo, d)}, ${signed(hi, d)}]`;
const fix = (x: number, d = 3) => x.toFixed(d);
const usd = (x: number) => `$${x.toFixed(x < 1 ? 3 : 2)}`;
const times = (x: number) => `×${x.toFixed(2)}`;
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const r1 = (x: number) => Math.round(x * 10) / 10;

// ---------------------------------------------------------------------------
// Theme: one stylesheet, two palettes. Categorical slots are the validated
// reference palette in its fixed order; the control (`single`) is neutral ink.
// ---------------------------------------------------------------------------

const ARCH_SLOT: Record<string, number> = Object.fromEntries(ARCHS.map((a, i) => [a, i]));

const STYLE = `
  svg { font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    --bg: #fcfcfb; --ring: #e6e5df; --ink: #0b0b0b; --ink2: #52514e; --muted: #77756f;
    --grid: #ebeae4; --axis: #c3c2b7; --band: #f1f0ec; --eq: #e9f1fb;
    --a0: #3f3e3b; --a1: #2a78d6; --a2: #eb6834; --a3: #1baf7a; --a4: #eda100; --a5: #e87ba4;
    --good: #0b7a0b; --good-bg: #e3f4e3; --warn: #8a5a00; --warn-bg: #fdf0d2;
    --bad: #b42323; --bad-bg: #fbe4e4; --info: #1c5cab; --info-bg: #e3eefb; }
  @media (prefers-color-scheme: dark) {
    svg { --bg: #1a1a19; --ring: #2f2f2c; --ink: #f0efec; --ink2: #c3c2b7; --muted: #9b9991;
      --grid: #2a2a28; --axis: #45453f; --band: #232321; --eq: #1b2633;
      --a0: #d6d5cf; --a1: #3987e5; --a2: #d95926; --a3: #199e70; --a4: #c98500; --a5: #d55181;
      --good: #4fcf4f; --good-bg: #173117; --warn: #f2b73d; --warn-bg: #3a2d10;
      --bad: #f07a7a; --bad-bg: #3d1a1a; --info: #86b6ef; --info-bg: #17263a; }
  }
  .bg { fill: var(--bg); stroke: var(--ring); }
  .title { fill: var(--ink); font-size: 26px; font-weight: 700; letter-spacing: -0.01em; }
  .sub { fill: var(--ink2); font-size: 15px; }
  .h { fill: var(--ink); font-size: 15px; font-weight: 650; }
  .t { fill: var(--ink); font-size: 14px; }
  .t2 { fill: var(--ink2); font-size: 13px; }
  .num { fill: var(--ink); font-size: 13px; font-variant-numeric: tabular-nums; }
  .num2 { fill: var(--ink2); font-size: 13px; font-variant-numeric: tabular-nums; }
  .tick { fill: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; }
  .cap { fill: var(--muted); font-size: 12px; }
  .b { font-weight: 650; }
  .grid { stroke: var(--grid); stroke-width: 1; }
  .axis { stroke: var(--axis); stroke-width: 1; }
  .zero { stroke: var(--ink2); stroke-width: 1.25; }
  .band { fill: var(--band); }
  .eq { fill: var(--eq); }
  .ink { fill: var(--ink); } .inks { stroke: var(--ink); fill: none; }
  .ink2s { stroke: var(--ink2); fill: none; }
  .muted { fill: var(--muted); }
  .hole { fill: var(--bg); }
  ${ARCHS.map((_, i) => `.f${i} { fill: var(--a${i}); } .s${i} { stroke: var(--a${i}); }`).join('\n  ')}
  .good { fill: var(--good); } .good-bg { fill: var(--good-bg); }
  .warn { fill: var(--warn); } .warn-bg { fill: var(--warn-bg); }
  .bad { fill: var(--bad); } .bad-bg { fill: var(--bad-bg); }
  .info { fill: var(--info); } .info-bg { fill: var(--info-bg); }
`;

function svgDoc(w: number, h: number, title: string, desc: string, body: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-labelledby="t d">
<title id="t">${esc(title)}</title>
<desc id="d">${esc(desc)}</desc>
<style>${STYLE}</style>
<rect class="bg" x="0.5" y="0.5" width="${w - 1}" height="${h - 1}" rx="14"/>
${body}
</svg>
`;
}

const text = (x: number, y: number, cls: string, s: string, anchor: 'start' | 'middle' | 'end' = 'start', extra = '') =>
  `<text x="${r1(x)}" y="${r1(y)}" class="${cls}"${anchor === 'start' ? '' : ` text-anchor="${anchor}"`}${extra ? ' ' + extra : ''}>${esc(s)}</text>`;
const line = (x1: number, y1: number, x2: number, y2: number, cls: string, extra = '') =>
  `<line x1="${r1(x1)}" y1="${r1(y1)}" x2="${r1(x2)}" y2="${r1(y2)}" class="${cls}"${extra ? ' ' + extra : ''}/>`;

const caption = (w: number, y: number, lines: string[]) =>
  lines.map((l, i) => text(32, y + i * 17, 'cap', l)).join('\n');

const METHOD = `task-clustered paired bootstrap (${ITER} draws), Holm-adjusted within each pre-registered family`;
const SOURCE = `Run set ${runSetId}${commit ? ` @ ${commit}` : ''} · ScaffoldBench`;

// ---------------------------------------------------------------------------
// a. hero.svg
// ---------------------------------------------------------------------------

function hero(): string {
  const W = 1000;
  const H = 640;
  const x0 = 84;
  const x1 = W - 32;
  const yTop = 150;
  const yBot = 470;
  const lo = 0.5;
  const hi = 1.0;
  const Y = (v: number) => yBot - ((v - lo) / (hi - lo)) * (yBot - yTop);
  const gw = (x1 - x0) / MODELS.length;
  const out: string[] = [];

  const singles = MODELS.map((m) => arm(m, 'single').score.value);
  const step1 = (singles[1] ?? 0) - (singles[0] ?? 0);
  const bestGain = Math.max(
    ...MODELS.flatMap((m) => SCAFFOLDS.map((s) => vsSingle(m, s, 'score').estimate)),
  );

  out.push(text(32, 52, 'title', 'Scaffold or Scale?'));
  out.push(
    text(
      32,
      80,
      'sub',
      `Moving the single agent from ${modelName(MODELS[0] ?? '')} to ${modelName(MODELS[1] ?? '')} raised its score by ${signed(step1)}.`,
    ),
  );
  out.push(
    text(
      32,
      101,
      'sub',
      `No scaffold beat the single agent on any model: the largest gain was ${signed(bestGain)}, and none was significant.`,
    ),
  );

  // grid
  for (let v = lo; v <= hi + 1e-9; v += 0.1) {
    out.push(line(x0, Y(v), x1, Y(v), 'grid'));
    out.push(text(x0 - 12, Y(v) + 4, 'tick', v.toFixed(1), 'end'));
  }
  out.push(text(32, yTop - 22, 't2', 'Mean score, 95% CI'));

  const pad = 44;
  const step = (gw - 2 * pad) / (ARCHS.length - 1);
  const singlePts: [number, number][] = [];
  MODELS.forEach((m, gi) => {
    const gx = x0 + gi * gw;
    const means = ARCHS.map((a) => arm(m, a).score.value);
    const mn = Math.min(...means);
    const mx = Math.max(...means);
    // spread band
    out.push(
      `<rect class="band" x="${r1(gx + 10)}" y="${r1(Y(mx))}" width="${r1(gw - 20)}" height="${r1(Math.max(2, Y(mn) - Y(mx)))}" rx="4"/>`,
    );
    if (gi > 0) out.push(line(gx, yTop - 6, gx, yBot, 'grid', 'stroke-dasharray="2 4"'));
    ARCHS.forEach((a, i) => {
      const s = arm(m, a).score;
      const cx = gx + pad + i * step;
      if (s.ci) {
        out.push(line(cx, Y(s.ci.low), cx, Y(s.ci.high), `s${i}`, 'stroke-width="2.5" stroke-linecap="round"'));
      }
      out.push(`<circle cx="${r1(cx)}" cy="${r1(Y(s.value))}" r="6.5" class="f${i}" stroke="var(--bg)" stroke-width="2"/>`);
      if (a === 'single') singlePts.push([cx, Y(s.value)]);
    });
    // group label
    const sgl = arm(m, 'single');
    out.push(text(gx + gw / 2, yBot + 32, 'h', modelName(m), 'middle'));
    out.push(
      text(gx + gw / 2, yBot + 52, 't2', `spread of means ${fix(mx - mn)} · single ${usd(sgl.costUsd.value)}/run`, 'middle'),
    );
  });

  // single connector across models
  for (let i = 0; i + 1 < singlePts.length; i++) {
    const [ax, ay] = singlePts[i] as [number, number];
    const [bx, by] = singlePts[i + 1] as [number, number];
    out.push(line(ax + 9, ay, bx - 9, by, 'ink2s', 'stroke-width="1.25" stroke-dasharray="4 4"'));
    const d = (singles[i + 1] ?? 0) - (singles[i] ?? 0);
    const mx = x0 + (i + 1) * gw;
    const my = ay + ((by - ay) * (mx - ax)) / (bx - ax);
    out.push(
      `<rect x="${r1(mx - 30)}" y="${r1(my - 12)}" width="60" height="22" rx="11" class="bg"/>`,
      text(mx, my + 4, 'num b', signed(d), 'middle'),
    );
  }

  // legend
  const ly = 562;
  let lx = 32;
  const legendW = [86, 124, 170, 178, 140, 136];
  ARCHS.forEach((a, i) => {
    out.push(`<circle cx="${lx + 6}" cy="${ly - 4}" r="6" class="f${i}"/>`);
    out.push(text(lx + 18, ly, 't', a));
    lx += legendW[i] ?? 140;
  });
  out.push(
    caption(W, 598, [
      `n = ${N_RUNS} runs: ${MODELS.length} models × ${ARCHS.length} architectures × ${N_TASKS} tasks × ${N_REPEATS} repeats; 50 runs per dot. Grey band: range of the six means. Dashed: single across models.`,
      `Intervals: ${ITER}-draw bootstrap resampling tasks. ${SOURCE}.`,
    ]),
  );
  return svgDoc(
    W,
    H,
    'Scaffold or Scale? Score by architecture and model',
    'Mean score with 95% task-clustered confidence intervals for six agent architectures on Haiku 4.5, Sonnet 5.5 and Opus 5.5.',
    out.join('\n'),
  );
}

// ---------------------------------------------------------------------------
// b. cost-vs-score.svg
// ---------------------------------------------------------------------------

const SHAPES = ['circle', 'square', 'diamond'] as const;
function marker(shape: (typeof SHAPES)[number], x: number, y: number, r: number, cls: string, extra = ''): string {
  if (shape === 'circle') return `<circle cx="${r1(x)}" cy="${r1(y)}" r="${r}" class="${cls}" ${extra}/>`;
  if (shape === 'square') {
    const s = r * 0.9;
    return `<rect x="${r1(x - s)}" y="${r1(y - s)}" width="${r1(2 * s)}" height="${r1(2 * s)}" rx="1.5" class="${cls}" ${extra}/>`;
  }
  const d = r * 1.25;
  return `<path d="M${r1(x)} ${r1(y - d)} L${r1(x + d)} ${r1(y)} L${r1(x)} ${r1(y + d)} L${r1(x - d)} ${r1(y)} Z" class="${cls}" ${extra}/>`;
}

function costVsScore(): string {
  const W = 1000;
  const H = 748;
  const x0 = 84;
  const x1 = W - 40;
  const yTop = 120;
  const yBot = 560;
  const cLo = 0.07;
  const cHi = 1.25;
  const sLo = 0.65;
  const sHi = 1.0;
  const X = (c: number) => x0 + ((Math.log(c) - Math.log(cLo)) / (Math.log(cHi) - Math.log(cLo))) * (x1 - x0);
  const Y = (v: number) => yBot - ((v - sLo) / (sHi - sLo)) * (yBot - yTop);
  const out: string[] = [];
  const [hz, sn, op] = [MODELS[0] ?? '', MODELS[1] ?? '', MODELS[2] ?? ''];

  out.push(text(32, 52, 'title', 'What a point of score costs'));
  out.push(
    text(
      32,
      80,
      'sub',
      `All ${MODELS.length * ARCHS.length} (model, architecture) arms. The cheap way up was a bigger model, not a scaffold.`,
    ),
  );

  for (const c of [0.1, 0.2, 0.5, 1.0]) {
    out.push(line(X(c), yTop, X(c), yBot, 'grid'));
    out.push(text(X(c), yBot + 20, 'tick', c < 1 ? `$${c.toFixed(1)}` : '$1.0', 'middle'));
  }
  for (let v = 0.7; v <= sHi + 1e-9; v += 0.05) {
    out.push(line(x0, Y(v), x1, Y(v), 'grid'));
    out.push(text(x0 - 12, Y(v) + 4, 'tick', v.toFixed(2), 'end'));
  }
  out.push(line(x0, yBot, x1, yBot, 'axis'));
  out.push(text((x0 + x1) / 2, yBot + 44, 't2', 'Mean cost per run (USD, log scale)', 'middle'));
  out.push(text(32, yTop - 18, 't2', 'Mean score'));

  // frontier staircase on point estimates, through the arms the analysis keeps on the frontier
  const fr = analysis.frontier.filter((f) => f.status === 'frontier').sort((a, b) => a.costUsd - b.costUsd);
  let d = '';
  fr.forEach((f, i) => {
    const x = X(f.costUsd);
    const y = Y(f.quality);
    d += i === 0 ? `M${r1(x)} ${r1(y)}` : ` H${r1(x)} V${r1(y)}`;
  });
  if (fr.length) d += ` H${r1(x1)}`;
  out.push(`<path d="${d}" class="ink2s" stroke-width="1.5" stroke-dasharray="5 4"/>`);

  // the exploratory callout, drawn under the points
  const sonPE = arm(sn, 'plan-execute');
  const opS = arm(op, 'single');
  const eqC = scaleContrast(sn, 'plan-execute', 'score');
  const eqR = scaleContrast(sn, 'plan-execute', 'cost');
  const bx0 = X(sonPE.costUsd.value) - 14;
  const bx1 = X(opS.costUsd.value) + 14;
  const by = Y(Math.min(sonPE.score.value, opS.score.value) - 0.024);
  out.push(`<path d="M${r1(bx0)} ${r1(by - 8)} V${r1(by)} H${r1(bx1)} V${r1(by - 8)}" class="ink2s" stroke-width="1.25"/>`);
  const tx = (bx0 + bx1) / 2;
  out.push(line(tx, by, tx, Y(0.875) - 14, 'ink2s', 'stroke-width="1.25"'));
  out.push(text(tx - 40, Y(0.875) + 2, 't b', 'Sonnet plan-execute ≈ Opus single (exploratory)'));
  out.push(
    text(
      tx - 40,
      Y(0.875) + 21,
      't2',
      `Δ ${signed(eqC.estimate)} ${ci(eqC.ci?.low ?? 0, eqC.ci?.high ?? 0)}, equivalent within ±0.05, at ${times(eqR.estimate)} the cost.`,
    ),
  );

  // Haiku callout
  const hzCost = SCAFFOLDS.map((a) => vsSingle(hz, a, 'cost').estimate);
  out.push(text(X(0.3), Y(0.77), 't b', 'Every Haiku scaffold costs more than Haiku single'));
  out.push(
    text(
      X(0.3),
      Y(0.77) + 19,
      't2',
      `(${times(Math.min(...hzCost))} to ${times(Math.max(...hzCost))}); none separates from it on score.`,
    ),
  );

  // points: tied first, frontier on top
  const status = (m: string, a: string) =>
    analysis.frontier.find((f) => f.arm.model === m && f.arm.strategyId === a)?.status ?? 'tied';
  const allArms = MODELS.flatMap((m, mi) => ARCHS.map((a, ai) => ({ m, mi, a, ai, s: arm(m, a) })));
  const rank = (p: { m: string; a: string }) => (status(p.m, p.a) === 'frontier' ? 1 : 0);
  for (const p of [...allArms].sort((u, v) => rank(u) - rank(v))) {
    const st = status(p.m, p.a);
    const x = X(p.s.costUsd.value);
    const y = Y(p.s.score.value);
    const shape = SHAPES[p.mi] ?? 'circle';
    if (st === 'dominated') out.push(marker(shape, x, y, 7, `hole s${p.ai}`, 'stroke-width="2.25"'));
    else out.push(marker(shape, x, y, st === 'frontier' ? 8 : 7, `f${p.ai}`, 'stroke="var(--bg)" stroke-width="2"'));
  }

  // direct labels: [model, arch, dx, dy, anchor, label override]
  const labels: [string, string, number, number, 'start' | 'end' | 'middle', string?][] = [
    [hz, 'single', 0, 26, 'middle'],
    [hz, 'propose-select', 14, 5, 'start'],
    [hz, 'gated-execute', 0, 26, 'middle', 'Haiku · gated-execute (dominated)'],
    [sn, 'single', -14, 5, 'end'],
    [sn, 'plan-execute', -14, 5, 'end'],
    [op, 'single', 0, -16, 'middle'],
    [op, 'plan-execute', 0, -34, 'middle'],
    [op, 'plan-execute-verify', 0, -16, 'middle'],
    [op, 'propose-select', 0, -34, 'end', 'Opus · propose-select, gated-execute'],
  ];
  for (const [m, a, dx, dy, anchor, label] of labels) {
    const s = arm(m, a);
    const x = X(s.costUsd.value);
    const y = Y(s.score.value);
    if (dy < -20) out.push(line(x, y - 10, x, y + dy + 5, 'ink2s', 'stroke-width="1"'));
    out.push(text(x + dx + (anchor === 'end' && dy < -20 ? 6 : 0), y + dy, 'num2', label ?? `${modelName(m).split(' ')[0]} · ${a}`, anchor));
  }

  // legend (bottom, two rows)
  let lx = 32;
  let ly = yBot + 84;
  const archW = [78, 116, 160, 170, 132, 130];
  ARCHS.forEach((a, i) => {
    out.push(`<circle cx="${lx + 6}" cy="${ly - 5}" r="6" class="f${i}"/>`);
    out.push(text(lx + 18, ly, 't', a));
    lx += archW[i] ?? 130;
  });
  lx = 32;
  ly += 26;
  MODELS.forEach((m, mi) => {
    out.push(marker(SHAPES[mi] ?? 'circle', lx + 6, ly - 5, 6, 'muted'));
    out.push(text(lx + 18, ly, 't', modelName(m)));
    lx += 116;
  });
  lx += 12;
  out.push(line(lx, ly - 5, lx + 26, ly - 5, 'ink2s', 'stroke-width="1.5" stroke-dasharray="5 4"'));
  out.push(text(lx + 34, ly, 't2', 'frontier: no arm is both cheaper and as good'));
  lx += 340;
  out.push(marker('circle', lx + 6, ly - 5, 6, 'hole s0', 'stroke-width="2.25"'));
  out.push(text(lx + 18, ly, 't2', 'dominated on paired evidence'));

  out.push(
    caption(W, H - 40, [
      `n = 50 runs per point (${N_TASKS} tasks × ${N_REPEATS} repeats); points are means. Cost is the Agent SDK's reported spend at list prices.`,
      `Frontier and dominance from paired, task-clustered contrasts across all 18 arms. ${SOURCE}.`,
    ]),
  );
  return svgDoc(
    W,
    H,
    'Cost against score for every model and architecture',
    'Scatter of mean cost per run (log scale) against mean score for 18 arms, with the uncertainty-aware Pareto frontier.',
    out.join('\n'),
  );
}

// ---------------------------------------------------------------------------
// c. vs-single.svg
// ---------------------------------------------------------------------------

function verdictMark(v: string, x: number, y: number, i: number): string {
  if (v === 'better' || v === 'worse')
    return `<circle cx="${r1(x)}" cy="${r1(y)}" r="6" class="f${i}" stroke="var(--bg)" stroke-width="1.5"/>`;
  if (v === 'equivalent')
    return `<rect x="${r1(x - 5.5)}" y="${r1(y - 5.5)}" width="11" height="11" class="f${i}" transform="rotate(45 ${r1(x)} ${r1(y)})"/>`;
  return `<circle cx="${r1(x)}" cy="${r1(y)}" r="5.5" class="hole s${i}" stroke-width="2.25"/>`;
}
const VERDICT_WORD: Record<string, string> = {
  better: 'better',
  worse: 'worse',
  equivalent: 'equivalent',
  inconclusive: 'inconclusive',
};

function vsSinglePlot(): string {
  const W = 1000;
  const rowH = 27;
  const groupHead = 40;
  const top = 168;
  const H = top + MODELS.length * (groupHead + SCAFFOLDS.length * rowH) + 110;
  const sx0 = 224;
  const sx1 = 484;
  const sLo = -0.25;
  const sHi = 0.15;
  const SX = (v: number) => sx0 + ((v - sLo) / (sHi - sLo)) * (sx1 - sx0);
  const cx0 = 790;
  const cx1 = 900;
  const cLo = 1;
  const cHi = 8;
  const CX = (v: number) => cx0 + (Math.log(v / cLo) / Math.log(cHi / cLo)) * (cx1 - cx0);
  const out: string[] = [];

  out.push(text(32, 52, 'title', 'Every scaffold against a single agent'));
  out.push(
    text(32, 80, 'sub', 'Paired difference in score and ratio of cost, same model, same tasks. None separated on score; all cost more.'),
  );

  // column heads
  const bodyTop = top;
  const bodyBot = H - 110;
  out.push(text(sx0, 126, 'h', 'Score Δ vs single'));
  out.push(text(sx0, 146, 't2', 'shaded: equivalence margin ±0.05'));
  out.push(text(500, 126, 'h', 'Score Δ [95% CI]'));
  out.push(text(500, 146, 't2', 'with its Holm-adjusted verdict'));
  out.push(text(cx0, 126, 'h', 'Cost × single'));
  out.push(text(cx0, 146, 't2', 'log scale'));

  out.push(`<rect class="eq" x="${r1(SX(-0.05))}" y="${bodyTop}" width="${r1(SX(0.05) - SX(-0.05))}" height="${bodyBot - bodyTop}"/>`);
  for (const v of [-0.2, -0.1, 0, 0.1]) {
    out.push(line(SX(v), bodyTop, SX(v), bodyBot, v === 0 ? 'zero' : 'grid'));
    out.push(text(SX(v), bodyBot + 18, 'tick', v === 0 ? '0' : signed(v, 1), 'middle'));
  }
  for (const v of [1, 2, 4, 8]) {
    out.push(line(CX(v), bodyTop, CX(v), bodyBot, v === 1 ? 'zero' : 'grid'));
    out.push(text(CX(v), bodyBot + 18, 'tick', `×${v}`, 'middle'));
  }

  let y = bodyTop;
  MODELS.forEach((m) => {
    const sgl = arm(m, 'single');
    y += groupHead;
    out.push(text(32, y - 12, 'h', modelName(m)));
    out.push(
      text(
        140,
        y - 12,
        't2',
        `single ${fix(sgl.score.value)} · ${usd(sgl.costUsd.value)}/run`,
      ),
    );
    out.push(line(32, y - 4, W - 32, y - 4, 'axis'));
    SCAFFOLDS.forEach((a) => {
      const i = ARCH_SLOT[a] ?? 0;
      const sc = vsSingle(m, a, 'score');
      const cc = vsSingle(m, a, 'cost');
      const cy = y + rowH / 2 + 2;
      out.push(`<circle cx="44" cy="${r1(cy - 4)}" r="5" class="f${i}"/>`);
      out.push(text(56, cy, 't', a));
      if (sc.ci) out.push(line(SX(sc.ci.low), cy - 4, SX(sc.ci.high), cy - 4, `s${i}`, 'stroke-width="2.5" stroke-linecap="round"'));
      out.push(verdictMark(sc.verdict, SX(sc.estimate), cy - 4, i));
      out.push(text(500, cy, 'num', `${signed(sc.estimate)} ${sc.ci ? ci(sc.ci.low, sc.ci.high) : ''}`));
      out.push(text(684, cy, 'num2', VERDICT_WORD[sc.verdict] ?? sc.verdict));
      if (cc.ci) out.push(line(CX(cc.ci.low), cy - 4, CX(cc.ci.high), cy - 4, `s${i}`, 'stroke-width="2.5" stroke-linecap="round"'));
      out.push(verdictMark(cc.verdict, CX(cc.estimate), cy - 4, i));
      out.push(text(W - 32, cy, 'num b', times(cc.estimate), 'end'));
      y += rowH;
    });
  });

  // glyph legend
  const gy = bodyBot + 46;
  out.push(verdictMark('worse', 40, gy - 4, 0));
  out.push(text(52, gy, 't2', 'separated (better or worse)'));
  out.push(verdictMark('inconclusive', 252, gy - 4, 0));
  out.push(text(264, gy, 't2', 'inconclusive'));
  out.push(verdictMark('equivalent', 372, gy - 4, 0));
  out.push(text(386, gy, 't2', 'equivalent within the margin'));
  out.push(
    caption(W, gy + 26, [
      `n = ${N_TASKS} tasks × ${N_REPEATS} repeats per contrast, paired by (task, repeat). 95% CIs: ${METHOD}.`,
      `Cost ratio is the geometric mean of paired ratios. ${SOURCE}.`,
    ]),
  );
  return svgDoc(
    W,
    H,
    'Each scaffold against the single agent, per model',
    'Forest plot of paired score differences and cost ratios of five scaffolds against the single-agent control on three models.',
    out.join('\n'),
  );
}

// ---------------------------------------------------------------------------
// d. scorecard.svg
// ---------------------------------------------------------------------------

type Badge = 'Supported' | 'Consistent' | 'Partial' | 'Not supported';
const BADGE: Record<Badge, { cls: string; glyph: string }> = {
  Supported: { cls: 'good', glyph: '✓' },
  Consistent: { cls: 'info', glyph: '≈' },
  Partial: { cls: 'warn', glyph: '◐' },
  'Not supported': { cls: 'bad', glyph: '✗' },
};

interface Hyp {
  id: string;
  name: string;
  claim: string;
  result: string[];
  badge: Badge;
}

function hypotheses(): Hyp[] {
  const [hz, sn, op] = [MODELS[0] ?? '', MODELS[1] ?? '', MODELS[2] ?? ''];
  const pev = vsSingle(hz, 'plan-execute-verify', 'score');
  const ge = vsSingle(hz, 'gated-execute', 'score');
  const opusBetter = SCAFFOLDS.filter((a) => vsSingle(op, a, 'score').verdict === 'better').length;
  const opusEq = SCAFFOLDS.filter((a) => vsSingle(op, a, 'score').verdict === 'equivalent').length;
  const costs = MODELS.flatMap((m) => SCAFFOLDS.map((a) => vsSingle(m, a, 'cost')));
  const costWorse = costs.filter((c) => c.verdict === 'worse').length;
  const cmin = Math.min(...costs.map((c) => c.estimate));
  const cmax = Math.max(...costs.map((c) => c.estimate));
  const ix = interaction('plan-execute-verify', 'score');
  const h5 = ARCHS.map((a) => scaleContrast(hz, a, 'score'));
  const h5worse = h5.filter((c) => c.verdict === 'worse');
  const h5wn = h5worse.map((c) => c.a.strategyId).join(', ');

  // H6: gold-key research tasks, descriptive
  const gold = ['research-status-codes', 'research-header-fields', 'research-nist-password-rules'];
  const med = (m: string, a: string) =>
    median(runs.filter((r) => r.model === m && r.strategyId === a && gold.includes(r.taskId)).map((r) => r.latencyMs)) / 1000;
  const slower = MODELS.filter((m) => med(m, 'orchestrator-workers') > med(m, 'single')).length;
  const meanOf = (m: string, a: string, k: 'costUsd') => {
    const xs = (runs as (RunLite & { costUsd: number })[]).filter(
      (r) => r.model === m && r.strategyId === a && gold.includes(r.taskId),
    );
    return xs.reduce((t, r) => t + r[k], 0) / xs.length;
  };
  const owCost = MODELS.map((m) => meanOf(m, 'orchestrator-workers', 'costUsd') / meanOf(m, 'single', 'costUsd'));

  return [
    {
      id: 'H1',
      name: 'Scaffolds help the small model',
      claim: `On ${modelName(hz)}, plan-execute-verify or gated-execute scores better than single.`,
      result: [
        `Both inconclusive and below zero: plan-execute-verify ${signed(pev.estimate)} ${ci(pev.ci?.low ?? 0, pev.ci?.high ?? 0)},`,
        `gated-execute ${signed(ge.estimate)} ${ci(ge.ci?.low ?? 0, ge.ci?.high ?? 0)}.`,
      ],
      badge: 'Not supported',
    },
    {
      id: 'H2',
      name: 'Scaffolds stop paying on the large model',
      claim: `On ${modelName(op)}, no architecture scores better than single.`,
      result: [
        `${SCAFFOLDS.length - opusBetter} of ${SCAFFOLDS.length} not better (all inconclusive). ${opusEq === 0 ? 'None shown equivalent, so a gain under 0.05' : ''}`,
        opusEq === 0 ? 'is not established either.' : '',
      ],
      badge: 'Consistent',
    },
    {
      id: 'H3',
      name: 'Every scaffold costs more',
      claim: 'On every model, every multi-call architecture costs more than single.',
      result: [`${costWorse} of ${costs.length} contrasts costlier, intervals above ×1: ${times(cmin)} to ${times(cmax)} per run.`],
      badge: costWorse === costs.length ? 'Supported' : 'Partial',
    },
    {
      id: 'H4',
      name: 'Interaction: the gain shrinks with scale',
      claim: `plan-execute-verify gains more over single on ${modelName(hz)} than on ${modelName(op)}.`,
      result: [`Difference in gains ${signed(ix.estimate)} ${ci(ix.ci?.low ?? 0, ix.ci?.high ?? 0)}: inconclusive, and the wrong sign.`],
      badge: 'Not supported',
    },
    {
      id: 'H5',
      name: 'Scale beats scaffold, one step up',
      claim: `single on ${modelName(sn)} scores better than every architecture on ${modelName(hz)}.`,
      result: [
        `${h5worse.length} of ${h5.length} shown worse (${h5wn}); the other ${h5.length - h5worse.length}`,
        'below Sonnet single on point estimates but inconclusive after Holm.',
      ],
      badge: h5worse.length === h5.length ? 'Supported' : 'Partial',
    },
    {
      id: 'H6',
      name: 'Fan-out buys time on breadth research',
      claim: 'On gold-key research, orchestrator-workers ties single on score and is faster.',
      result: [
        `3 tasks, descriptive only. Slower on ${slower} of ${MODELS.length} models (median ${MODELS.map((m) => `${med(m, 'orchestrator-workers').toFixed(0)}s vs ${med(m, 'single').toFixed(0)}s`).join(', ')}),`,
        `at ${times(Math.min(...owCost))}–${times(Math.max(...owCost))} the mean cost on those tasks, and never ahead of single on score.`,
      ],
      badge: 'Not supported',
    },
  ];
}

function scorecard(): string {
  const W = 1000;
  const rowH = 96;
  const top = 116;
  const hs = hypotheses();
  const H = top + hs.length * rowH + 84;
  const out: string[] = [];
  out.push(text(32, 52, 'title', 'Pre-registration scorecard'));
  out.push(text(32, 80, 'sub', 'Six hypotheses, written and tagged (prereg-v1) before the first of the 900 runs.'));

  hs.forEach((h, i) => {
    const y = top + i * rowH;
    if (i > 0) out.push(line(32, y, W - 32, y, 'axis'));
    out.push(text(32, y + 34, 'title', h.id));
    out.push(text(96, y + 28, 'h', h.name));
    out.push(text(96, y + 49, 't2', h.claim));
    h.result.filter(Boolean).forEach((l, j) => out.push(text(96, y + 71 + j * 18, 'num', l)));
    const b = BADGE[h.badge];
    const bw = 150;
    const bx = W - 32 - bw;
    out.push(`<rect x="${bx}" y="${y + 14}" width="${bw}" height="30" rx="15" class="${b.cls}-bg"/>`);
    out.push(text(bx + bw / 2, y + 34, `${b.cls} b`, `${b.glyph}  ${h.badge}`, 'middle', 'style="font-size:14px"'));
  });
  out.push(
    caption(W, H - 56, [
      `H1–H3 confirmatory (baseline family); H4, H5 secondary, each its own Holm family; H6 descriptive (fewer than the 5 tasks a verdict needs).`,
      `n = ${N_RUNS} runs, all passing integrity checks. Verdicts: ${METHOD}.`,
      `${SOURCE}.`,
    ]),
  );
  return svgDoc(
    W,
    H,
    'Pre-registration scorecard, hypotheses H1 to H6',
    hs.map((h) => `${h.id}: ${h.badge}.`).join(' '),
    out.join('\n'),
  );
}

// ---------------------------------------------------------------------------

mkdirSync(outDir, { recursive: true });
const figures: [string, string][] = [
  ['hero.svg', hero()],
  ['cost-vs-score.svg', costVsScore()],
  ['vs-single.svg', vsSinglePlot()],
  ['scorecard.svg', scorecard()],
];
for (const [name, svg] of figures) {
  writeFileSync(join(outDir, name), svg);
  process.stdout.write(`wrote ${join(outDir, name)}\n`);
}
