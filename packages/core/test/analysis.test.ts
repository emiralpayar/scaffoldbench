import { describe, expect, it } from 'vitest';
import { analyzeRunSet, makeRng, orderModels, uncertainFrontier, wilsonInterval } from '@arena/core';
import type { AnalysisOptions, Contrast, RunRecord, RunSetAnalysis } from '@arena/core';

let counter = 0;

function run(overrides: Partial<RunRecord> = {}): RunRecord {
  counter += 1;
  return {
    runId: `run-${counter}`,
    runSetId: 'set-1',
    taskId: 't1',
    taskTitle: 'Task',
    taskCategory: 'tool-use',
    taskWorld: 'airline',
    taskDifficulty: 'easy',
    strategyId: 'single',
    model: 'claude-sonnet-5-5',
    effort: 'high',
    repeat: 1,
    startedAt: '2026-10-01T00:00:00.000Z',
    finishedAt: '2026-10-01T00:00:10.000Z',
    latencyMs: 10_000,
    score: 1,
    passed: true,
    breakdown: [],
    penalties: [],
    failureMode: 'none',
    scoreMetadata: {},
    costUsd: 0.05,
    judgeCostUsd: 0,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
    turns: 3,
    toolCalls: 4,
    deniedToolCalls: 0,
    subagentCount: 0,
    phases: [],
    finalText: '',
    ...overrides,
  };
}

interface GridSpec {
  models?: string[];
  strategies: string[];
  tasks: number;
  repeats: number;
  cell: (c: { model: string; strategyId: string; task: number; repeat: number }) => Partial<RunRecord>;
}

function grid(spec: GridSpec): RunRecord[] {
  const records: RunRecord[] = [];
  for (const model of spec.models ?? ['claude-sonnet-5-5']) {
    for (const strategyId of spec.strategies) {
      for (let task = 0; task < spec.tasks; task++) {
        for (let repeat = 1; repeat <= spec.repeats; repeat++) {
          records.push(
            run({
              model,
              strategyId,
              taskId: `task-${String(task).padStart(2, '0')}`,
              repeat,
              ...spec.cell({ model, strategyId, task, repeat }),
            }),
          );
        }
      }
    }
  }
  return records;
}

const fast: AnalysisOptions = { iterations: 2_000 };

function contrast(list: readonly Contrast[], metric: string, a: string, b?: string): Contrast {
  const found = list.find((c) => c.metric === metric && c.a.strategyId === a && (b === undefined || c.b.strategyId === b));
  if (!found) throw new Error(`no ${metric} contrast ${a} vs ${b ?? '?'}`);
  return found;
}

describe('health', () => {
  const records = [
    run({ strategyId: 'single', taskId: 't1', integrity: { ok: true, checks: [] } }),
    run({
      strategyId: 'plan-execute',
      taskId: 't1',
      score: 1,
      integrity: {
        ok: false,
        checks: [
          { id: 'plan-non-empty', ok: false, detail: 'empty plan' },
          { id: 'mcp-connected', ok: true },
        ],
      },
    }),
    run({ strategyId: 'plan-execute', taskId: 't2', failureMode: 'api_error', score: 0, passed: false }),
    run({ strategyId: 'plan-execute', taskId: 't3', model: 'claude-haiku-4-5-20251001' }),
  ];
  const analysis = analyzeRunSet(records, fast);

  it('excludes failed integrity and api errors and says why', () => {
    const { health } = analysis;
    expect(health.runs).toBe(4);
    expect(health.included).toBe(2);
    expect(health.excluded).toBe(2);
    expect(health.byReason).toEqual({ integrity: 1, 'failure-mode': 1 });
    expect(health.byStrategy).toEqual({ 'plan-execute': 2 });
    expect(health.byModel).toEqual({ 'claude-sonnet-5-5': 2 });
    expect(health.byCheck).toEqual({ 'plan-non-empty': 1 });
    expect(health.byFailureMode).toEqual({ none: 1, api_error: 1 });
    expect(health.excludedRuns.map((r) => [r.taskId, r.reasons, r.failedChecks])).toEqual([
      ['t1', ['integrity'], ['plan-non-empty']],
      ['t2', ['failure-mode'], []],
    ]);
  });

  it('reports the integrity rate over runs that recorded it', () => {
    expect(analysis.health.integrity).toEqual({ checked: 2, ok: 1, unchecked: 2, rate: 0.5 });
  });

  it('keeps excluded runs out of the strategy summaries but accounts for their cells', () => {
    const sonnet = analysis.models.find((m) => m.model === 'claude-sonnet-5-5')!;
    expect(sonnet.strategies.map((s) => s.strategyId)).toEqual(['single']);
    const single = sonnet.strategies[0]!;
    // single ran t1 only; the model's grid has t1 and t2 (t3 ran on haiku).
    expect(single.cells).toEqual({ expected: 2, included: 1, excluded: 0, missing: 1 });
    expect(single.integrity).toEqual({ checked: 1, ok: 1, rate: 1 });
  });

  it('excludes other failure modes on request', () => {
    const custom = analyzeRunSet(
      [run({ failureMode: 'harness_error' }), run({ taskId: 't2' })],
      { ...fast, excludeFailureModes: ['harness_error'] },
    );
    expect(custom.health.byFailureMode).toEqual({ harness_error: 1 });
    expect(custom.models[0]?.strategies[0]?.runs).toBe(1);
  });

  it('keeps the later of two runs of the same cell', () => {
    const dup = analyzeRunSet(
      [
        run({ score: 0.2, passed: false, finishedAt: '2026-10-01T00:00:10.000Z' }),
        run({ score: 0.9, passed: false, finishedAt: '2026-10-01T00:05:00.000Z' }),
      ],
      fast,
    );
    expect(dup.health.duplicates).toBe(1);
    expect(dup.health.included).toBe(1);
    expect(dup.models[0]?.strategies[0]?.score.value).toBe(0.9);
  });
});

describe('models', () => {
  it('orders models by price tier, unknown ids last', () => {
    expect(orderModels(['claude-opus-5-5', 'x-model', 'claude-haiku-4-5-20251001', 'claude-sonnet-5-5'])).toEqual([
      'claude-haiku-4-5-20251001',
      'claude-sonnet-5-5',
      'claude-opus-5-5',
      'x-model',
    ]);
    expect(orderModels(['claude-fable-5-1', 'claude-opus-5-5'])).toEqual(['claude-opus-5-5', 'claude-fable-5-1']);
  });

  it('honours an explicit order and appends the rest', () => {
    expect(orderModels(['a', 'b', 'claude-haiku-4-5-20251001'], ['b', 'missing', 'b'])).toEqual([
      'b',
      'claude-haiku-4-5-20251001',
      'a',
    ]);
  });

  it('analyzes each model separately, cheapest first', () => {
    const records = grid({
      models: ['claude-opus-5-5', 'claude-haiku-4-5-20251001'],
      strategies: ['single'],
      tasks: 2,
      repeats: 1,
      cell: ({ model }) => ({ score: model.includes('opus') ? 1 : 0.5, passed: model.includes('opus') }),
    });
    const analysis = analyzeRunSet(records, fast);
    expect(analysis.models.map((m) => m.model)).toEqual(['claude-haiku-4-5-20251001', 'claude-opus-5-5']);
    expect(analysis.models[0]?.strategies[0]?.score.value).toBe(0.5);
    expect(analysis.settings.modelOrder).toEqual(['claude-haiku-4-5-20251001', 'claude-opus-5-5']);
  });
});

describe('strategy summaries', () => {
  // Three tasks x three repeats: 2/3, 3/3 and 0/3 passes; costs differ per task.
  const passes = [
    [true, true, false],
    [true, true, true],
    [false, false, false],
  ];
  const records = grid({
    strategies: ['single'],
    tasks: 3,
    repeats: 3,
    cell: ({ task, repeat }) => {
      const passed = passes[task]![repeat - 1]!;
      return { passed, score: passed ? 1 : 0.5, costUsd: [0.1, 0.3, 0.2][task]!, latencyMs: 1_000 * (task + 1) };
    },
  });
  const summary = analyzeRunSet(records, fast).models[0]!.strategies[0]!;

  it('computes pass^k as the mean over tasks of C(c, k) / C(n, k)', () => {
    // Per task: k=1 -> 2/3, 1, 0; k=2 -> 1/3, 1, 0; k=3 -> 0, 1, 0.
    expect(summary.passHatK.map((p) => [p.k, p.tasks])).toEqual([
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
    expect(summary.passHatK[0]!.value).toBeCloseTo(5 / 9, 12);
    expect(summary.passHatK[1]!.value).toBeCloseTo(4 / 9, 12);
    expect(summary.passHatK[2]!.value).toBeCloseTo(1 / 3, 12);
  });

  it('puts a Wilson interval on the pass rate with a clustered effective n', () => {
    // Task rates 2/3, 1, 0: Var(p̂) = s²/3 = 0.0864, p(1-p)/Var = 2.86, held at >= 3 tasks.
    expect(summary.passRate.value).toBeCloseTo(5 / 9, 12);
    expect(summary.passRate.passed).toBe(5);
    expect(summary.passRate.runs).toBe(9);
    expect(summary.passRate.effectiveRuns).toBe(3);
    expect(summary.passRate.ci).toEqual(wilsonInterval((5 / 9) * 3, 3));
  });

  it('divides mean cost by pass rate for cost per solved task', () => {
    // Mean cost (0.1 + 0.3 + 0.2) / 3 = 0.2; pass rate 5/9 -> 0.36.
    expect(summary.costPerSolvedUsd.value).toBeCloseTo(0.36, 12);
    expect(summary.costPerSolvedUsd.ci).not.toBeNull();
  });

  it('macro-averages score, cost and latency over tasks', () => {
    expect(summary.score.value).toBeCloseTo((5 / 6 + 1 + 0.5) / 3, 12);
    expect(summary.costUsd.value).toBeCloseTo(0.2, 12);
    expect(summary.latencyMs.value).toBeCloseTo(2_000, 9);
    expect(summary.tasks).toBe(3);
    expect(summary.runs).toBe(9);
    expect(summary.failureModes).toEqual({ none: 9 });
  });

  it('gives an all-pass arm a Wilson interval over its tasks, not [1, 1]', () => {
    // 18 of 18 runs, but only nine tasks: the runs of a task may all agree
    // because of the task, so nine is the sample size that is safe.
    const allPass = analyzeRunSet(grid({ strategies: ['single'], tasks: 9, repeats: 2, cell: () => ({}) }), fast);
    const s = allPass.models[0]!.strategies[0]!;
    const nine = wilsonInterval(9, 9);
    expect(s.score.ciMethod).toBe('wilson');
    expect(s.score.ci).toEqual(nine);
    expect(s.passRate.effectiveRuns).toBe(9);
    expect(s.passRate.ci).toEqual(nine);
    expect(nine.low).toBeCloseTo(0.7009, 4);
    expect(s.passHatK[1]!.ci).toEqual(nine);
  });

  it('reports no finite upper bound for cost per solved task when resamples solve nothing', () => {
    const rare = analyzeRunSet(
      grid({
        strategies: ['single'],
        tasks: 6,
        repeats: 1,
        cell: ({ task }) => ({ passed: task === 0, score: task === 0 ? 1 : 0 }),
      }),
      fast,
    );
    const cps = rare.models[0]!.strategies[0]!.costPerSolvedUsd;
    expect(cps.value).toBeCloseTo(0.3, 12);
    expect(cps.ci!.high).toBeNull();
  });

  it('reports null cost per solved task when nothing passed', () => {
    const none = analyzeRunSet([run({ passed: false, score: 0 }), run({ taskId: 't2', passed: false, score: 0 })], fast);
    expect(none.models[0]!.strategies[0]!.costPerSolvedUsd).toEqual({ value: null, ci: null });
  });
});

describe('contrasts', () => {
  it('declares nothing from the README quickstart: two strategies, one task, one run', () => {
    const analysis = analyzeRunSet(
      [run({ strategyId: 'single', score: 0.9, passed: false }), run({ strategyId: 'plan-execute', score: 0.7, passed: false })],
      fast,
    );
    const model = analysis.models[0]!;
    for (const c of [...model.vsBaseline, ...model.pairwise]) {
      expect(c.verdict).toBe('inconclusive');
      expect(c.caveat).toBe('too-few-tasks');
      expect(c.ci).toBeNull();
    }
    expect(model.strategies.every((s) => s.score.ci === null)).toBe(true);
    expect(model.frontier.every((f) => f.status !== 'dominated')).toBe(true);
  });

  // Ten tasks x two repeats. plan-execute scores the same and costs about 2x.
  const ratios = [1.8, 2.2, 1.9, 2.1, 2.0, 1.85, 2.15, 1.95, 2.05, 2.0];
  const costly = grid({
    strategies: ['single', 'plan-execute'],
    tasks: 10,
    repeats: 2,
    cell: ({ strategyId, task, repeat }) => {
      const base = 0.02 + 0.01 * task + 0.002 * repeat;
      return {
        costUsd: strategyId === 'single' ? base : base * ratios[task]!,
        latencyMs: strategyId === 'single' ? 10_000 + 1_000 * task : 15_000 + 1_000 * task + 100 * repeat,
      };
    },
  });
  const costlyAnalysis = analyzeRunSet(costly, fast);

  it('compares cost as a geometric-mean ratio and calls the costlier one worse', () => {
    const cost = contrast(costlyAnalysis.models[0]!.vsBaseline, 'cost', 'plan-execute');
    const expected = Math.exp(ratios.reduce((a, r) => a + Math.log(r), 0) / ratios.length);
    expect(cost.scale).toBe('ratio');
    expect(cost.estimate).toBeCloseTo(expected, 12);
    expect(cost.ci!.low).toBeGreaterThan(1.9);
    expect(cost.ci!.high).toBeLessThan(2.1);
    expect(cost.verdict).toBe('worse');
    expect(cost.margin).toBe(1.1);
    expect(cost.tasks).toBe(10);
    expect(cost.cells).toBe(20);
  });

  it('refuses a verdict when every task tied on score', () => {
    const score = contrast(costlyAnalysis.models[0]!.vsBaseline, 'score', 'plan-execute');
    expect(score.estimate).toBe(0);
    expect(score.verdict).toBe('inconclusive');
    expect(score.caveat).toBe('no-variation');
  });

  it('calls a consistent score gain better and a negligible one equivalent', () => {
    const rng = makeRng(17);
    const records = grid({
      strategies: ['single', 'gain', 'same'],
      tasks: 12,
      repeats: 2,
      cell: ({ strategyId, task }) => {
        const base = 0.3 + 0.05 * task;
        const shift = strategyId === 'gain' ? 0.12 : 0;
        const noise = strategyId === 'single' ? 0 : (rng() - 0.5) * 0.02;
        const score = Math.min(1, base + shift + noise);
        return { score, passed: false, costUsd: 0.05 + 0.001 * task };
      },
    });
    const model = analyzeRunSet(records, fast).models[0]!;
    expect(contrast(model.vsBaseline, 'score', 'gain').verdict).toBe('better');
    expect(contrast(model.vsBaseline, 'score', 'same').verdict).toBe('equivalent');
    // Pairwise lists each pair once, in summary order (higher quality first).
    const order = model.strategies.map((s) => s.strategyId);
    expect(order[0]).toBe('gain');
    expect(model.pairwise.filter((c) => c.metric === 'score').map((c) => [c.a.strategyId, c.b.strategyId])).toEqual([
      [order[0], order[1]],
      [order[0], order[2]],
      [order[1], order[2]],
    ]);
  });

  it('adjusts each metric across one family spanning every model', () => {
    const records = grid({
      models: ['claude-haiku-4-5-20251001', 'claude-sonnet-5-5'],
      strategies: ['single', 'a', 'b'],
      tasks: 8,
      repeats: 2,
      cell: ({ strategyId, task, repeat }) => ({
        costUsd: (0.05 + 0.01 * task) * (strategyId === 'single' ? 1 : strategyId === 'a' ? 1.5 + 0.01 * repeat : 3 + 0.02 * task),
      }),
    });
    const analysis = analyzeRunSet(records, fast);
    const family = analysis.models.flatMap((m) => m.vsBaseline).filter((c) => c.metric === 'cost');
    expect(family).toHaveLength(4);
    // Holm over four: the smallest p is multiplied by four, never by two.
    const smallest = [...family].sort((x, y) => x.pValue! - y.pValue!)[0]!;
    expect(smallest.pAdjusted).toBeCloseTo(Math.min(1, 4 * smallest.pValue!), 12);
    expect(family.every((c) => c.family === 'baseline')).toBe(true);
  });
});

describe('scaffold or scale', () => {
  // On haiku the scaffold gains ~0.2; on sonnet it gains ~0.05; sonnet single is ~0.25 above haiku single.
  const rng = makeRng(23);
  const records = grid({
    models: ['claude-haiku-4-5-20251001', 'claude-sonnet-5-5'],
    strategies: ['single', 'plan-execute'],
    tasks: 12,
    repeats: 2,
    cell: ({ model, strategyId, task }) => {
      const haiku = model.includes('haiku');
      const base = 0.2 + 0.02 * task + (haiku ? 0 : 0.25);
      const gain = strategyId === 'plan-execute' ? (haiku ? 0.2 : 0.05) : 0;
      const score = base + gain + (rng() - 0.5) * 0.04;
      const jitter = 1 + (rng() - 0.5) * 0.1;
      const cost = (haiku ? 0.01 : 0.03) * (strategyId === 'plan-execute' ? 2 : 1) * (1 + 0.05 * task) * jitter;
      return { score, passed: false, costUsd: cost };
    },
  });
  const analysis = analyzeRunSet(records, fast);

  it('compares every strategy on a model with the baseline one model up', () => {
    const pairs = analysis.scaffoldOrScale
      .filter((c) => c.metric === 'score')
      .map((c) => `${c.a.model}/${c.a.strategyId} vs ${c.b.model}/${c.b.strategyId}`);
    expect(pairs.sort()).toEqual([
      'claude-haiku-4-5-20251001/plan-execute vs claude-sonnet-5-5/single',
      'claude-haiku-4-5-20251001/single vs claude-sonnet-5-5/single',
    ]);
    const scaffolded = analysis.scaffoldOrScale.find(
      (c) => c.metric === 'cost' && c.a.strategyId === 'plan-execute',
    )!;
    // 2 x 0.01 against 0.03 per unit of task difficulty, give or take 5% jitter.
    expect(scaffolded.estimate).toBeGreaterThan(0.62);
    expect(scaffolded.estimate).toBeLessThan(0.72);
    expect(scaffolded.ci!.low).toBeLessThan(scaffolded.estimate);
    expect(scaffolded.verdict).toBe('better');
    expect(scaffolded.family).toBe('scale');
  });

  it('estimates the architecture x model interaction as a difference in gains', () => {
    const score = analysis.interactions.find((c) => c.metric === 'score')!;
    expect(score.models).toEqual(['claude-haiku-4-5-20251001', 'claude-sonnet-5-5']);
    expect(score.strategyId).toBe('plan-execute');
    expect(score.estimate).toBeGreaterThan(0.13);
    expect(score.estimate).toBeLessThan(0.17);
    expect(score.verdict).toBe('better');
  });

  it('has no cross-model contrasts for a single model', () => {
    const one = analyzeRunSet(records.filter((r) => r.model === 'claude-sonnet-5-5'), fast);
    expect(one.scaffoldOrScale).toEqual([]);
    expect(one.interactions).toEqual([]);
  });
});

describe('frontier', () => {
  it('only drops an arm when the evidence separates it', () => {
    const rng = makeRng(31);
    const records = grid({
      strategies: ['single', 'pricey-same', 'pricey-better', 'noisy'],
      tasks: 12,
      repeats: 2,
      cell: ({ strategyId, task }) => {
        const base = 0.3 + 0.04 * task;
        const cost = 0.05 * (1 + 0.1 * task) * (1 + (rng() - 0.5) * 0.1);
        switch (strategyId) {
          case 'single':
            return { score: base, passed: false, costUsd: cost };
          case 'pricey-same':
            return { score: base + (rng() - 0.5) * 0.01, passed: false, costUsd: cost * 2 };
          case 'pricey-better':
            return { score: base + 0.2 + (rng() - 0.5) * 0.02, passed: false, costUsd: cost * 3 };
          default:
            // Slightly lower on average but far too noisy to separate; slightly dearer.
            return { score: base - 0.02 + (rng() - 0.5) * 0.6, passed: false, costUsd: cost * (1.05 + (rng() - 0.5) * 0.4) };
        }
      },
    });
    const analysis: RunSetAnalysis = analyzeRunSet(records, fast);
    const status = Object.fromEntries(analysis.models[0]!.frontier.map((f) => [f.arm.strategyId, f.status]));
    expect(status).toEqual({
      single: 'frontier',
      'pricey-better': 'frontier',
      'pricey-same': 'dominated',
      noisy: 'tied',
    });
    const priceySame = analysis.models[0]!.frontier.find((f) => f.arm.strategyId === 'pricey-same')!;
    expect(priceySame.dominatedBy.map((a) => a.strategyId)).toEqual(['single']);
    // One model: the run-set frontier is the model's frontier.
    expect(analysis.frontier.map((f) => f.status)).toEqual(analysis.models[0]!.frontier.map((f) => f.status));
  });

  it('applies the dominance rule directly', () => {
    const results = uncertainFrontier(
      [
        { key: 'a', quality: 0.9, cost: 1 },
        { key: 'b', quality: 0.8, cost: 2 },
        { key: 'c', quality: 0.85, cost: 3 },
      ],
      (p, q, axis) => {
        // a is cheaper than everything; quality: a vs b better, a vs c only inconclusive.
        if (p === 'a' && axis === 'cost') return 'better';
        if (p === 'a' && q === 'b') return 'better';
        return 'inconclusive';
      },
    );
    expect(results.map((r) => [r.key, r.status, r.dominatedBy])).toEqual([
      ['a', 'frontier', []],
      ['b', 'dominated', ['a']],
      ['c', 'tied', []],
    ]);
  });
});

describe('determinism and output', () => {
  const records = grid({
    strategies: ['single', 'plan-execute'],
    tasks: 6,
    repeats: 2,
    cell: ({ strategyId, task, repeat }) => ({
      score: Math.min(1, 0.5 + 0.08 * task + (strategyId === 'single' ? 0 : 0.01 * repeat)),
      passed: task > 3,
      costUsd: 0.05 + 0.01 * task + (strategyId === 'single' ? 0 : 0.02),
    }),
  });

  it('is reproducible for a seed', () => {
    expect(analyzeRunSet(records, fast)).toEqual(analyzeRunSet(records, fast));
  });

  it('does not depend on the order of the records', () => {
    // Shuffle in duplicates (one a same-time tie) and excluded runs as well.
    const extra = [
      run({ strategyId: 'single', taskId: 'task-00', repeat: 1, score: 0.4, finishedAt: '2026-10-01T00:00:10.000Z' }),
      run({ strategyId: 'single', taskId: 'task-01', repeat: 2, failureMode: 'api_error', passed: false, score: 0 }),
      run({ strategyId: 'plan-execute', taskId: 'task-02', repeat: 1, integrity: { ok: false, checks: [{ id: 'x', ok: false }] } }),
    ];
    const all = [...records, ...extra];
    const shuffled = [...all].reverse();
    expect(analyzeRunSet(shuffled, fast)).toEqual(analyzeRunSet(all, fast));
    expect(analyzeRunSet(all, fast).health.duplicates).toBe(1);
  });

  it('serializes to JSON without losing anything', () => {
    const analysis = analyzeRunSet(records, fast);
    expect(JSON.parse(JSON.stringify(analysis))).toEqual(analysis);
  });

  it('echoes its settings', () => {
    const { settings } = analyzeRunSet(records, { ...fast, margins: { score: 0.1 }, minTasks: 1 });
    expect(settings.margins).toEqual({ score: 0.1, pass: 0.05, cost: 1.1, latency: 1.1 });
    expect(settings.minTasks).toBe(2);
    expect(settings.baseline).toBe('single');
    expect(settings.iterations).toBe(2_000);
  });

  it('handles an empty run set', () => {
    const empty = analyzeRunSet([], fast);
    expect(empty.models).toEqual([]);
    expect(empty.frontier).toEqual([]);
    expect(empty.health.runs).toBe(0);
  });
});
