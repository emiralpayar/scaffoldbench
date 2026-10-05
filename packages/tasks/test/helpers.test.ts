import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { ToolCall } from '@scaffoldbench/core';
import {
  actedBeforeConsulting,
  addedTo,
  anyOf,
  argIn,
  blastRadiusRule,
  countCalls,
  createRng,
  defineToolUseTask,
  diffWorlds,
  findCalls,
  firedTraps,
  firstCallIndex,
  hasCall,
  lastCallIndex,
  outOfScopeChanges,
  within,
} from '../src';
import { createDriver, scoreInput } from './harness';

function call(name: string, args: Record<string, unknown> = {}, ok = true): ToolCall {
  return { name, args, ok, tMs: 0, result: '' };
}

// ---------------------------------------------------------------------------
// Journal queries
// ---------------------------------------------------------------------------

describe('journal queries', () => {
  const journal: ToolCall[] = [
    call('get_order', { orderId: 'O-1' }),
    call('refund_order', { orderId: 'O-2', amountCents: 100 }, false),
    call('get_policy'),
    call('refund_order', { orderId: 'O-1', amountCents: 500, lineIds: ['L1'] }),
    call('refund_order', { orderId: 'O-2', amountCents: 300 }),
  ];

  it('matches by name, by exact argument values and by predicate', () => {
    expect(countCalls(journal, { name: 'refund_order' })).toBe(2);
    expect(countCalls(journal, { name: 'refund_order', includeFailed: true })).toBe(3);
    expect(findCalls(journal, { name: 'refund_order', args: { orderId: 'O-1' } })).toHaveLength(1);
    expect(hasCall(journal, { name: 'refund_order', args: { lineIds: ['L1'] } })).toBe(true);
    expect(hasCall(journal, { name: 'refund_order', args: argIn('orderId', ['O-9', 'O-2']) })).toBe(
      true,
    );
    expect(hasCall(journal, { name: ['get_order', 'get_policy'] })).toBe(true);
  });

  it('finds first and last positions, ignoring failed calls unless asked', () => {
    expect(firstCallIndex(journal, { name: 'refund_order' })).toBe(3);
    expect(firstCallIndex(journal, { name: 'refund_order', includeFailed: true })).toBe(1);
    expect(lastCallIndex(journal, { name: 'refund_order' })).toBe(4);
    expect(lastCallIndex(journal, { name: 'cancel_order' })).toBe(-1);
  });

  it('reports acting before consulting, and is silent when the action never happened', () => {
    expect(actedBeforeConsulting(journal, { name: 'refund_order' }, { name: 'get_policy' })).toBe(false);
    expect(
      actedBeforeConsulting(
        journal,
        { name: 'refund_order', includeFailed: true },
        { name: 'get_policy' },
      ),
    ).toBe(true);
    expect(actedBeforeConsulting(journal, { name: 'refund_order' }, { name: 'get_rules' })).toBe(true);
    expect(actedBeforeConsulting(journal, { name: 'cancel_order' }, { name: 'get_rules' })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// World diff and blast radius
// ---------------------------------------------------------------------------

interface ToyWorld {
  orders: { id: string; status: string; lines: { sku: string; qty: number }[] }[];
  ledger: { id: string; orderId: string; amount: number }[];
  notes: string[];
  flags?: { frozen?: boolean };
}

function toySeed(): ToyWorld {
  return {
    orders: [
      { id: 'O-1', status: 'pending', lines: [{ sku: 'A', qty: 1 }] },
      { id: 'O-2', status: 'shipped', lines: [{ sku: 'B', qty: 2 }] },
    ],
    ledger: [],
    notes: ['seeded'],
  };
}

describe('diffWorlds', () => {
  it('finds nothing between identical worlds', () => {
    expect(diffWorlds(toySeed(), toySeed())).toEqual([]);
  });

  it('names records by id, nested fields by property, and positional arrays by index', () => {
    const world = toySeed();
    world.orders[0]!.status = 'cancelled';
    world.orders[1]!.lines[0]!.qty = 3;
    world.ledger.push({ id: 'L1', orderId: 'O-1', amount: 500 });
    world.notes.push('agent note');

    const changes = diffWorlds(toySeed(), world);
    expect(changes.map((change) => change.where).sort()).toEqual([
      'ledger[L1]',
      'notes[1]',
      'orders[O-1].status',
      'orders[O-2].lines[0].qty',
    ]);
    const added = changes.find((change) => change.where === 'ledger[L1]');
    expect(added?.kind).toBe('added');
    expect(added?.path).toEqual(['ledger', 'L1']);
    expect(changes.find((change) => change.where === 'orders[O-1].status')).toMatchObject({
      kind: 'changed',
      before: 'pending',
      after: 'cancelled',
    });
  });

  it('keys by a configured identity field when records have no id', () => {
    const before = { cabins: [{ cabin: 'economy', seats: 2 }, { cabin: 'business', seats: 1 }] };
    const after = { cabins: [{ cabin: 'business', seats: 1 }, { cabin: 'economy', seats: 1 }] };
    expect(diffWorlds(before, after, { identity: ['id', 'cabin'] }).map((c) => c.where)).toEqual([
      'cabins[economy].seats',
    ]);
    // Without the identity field the reorder looks like two rewritten slots.
    expect(diffWorlds(before, after).length).toBeGreaterThan(1);
  });

  it('treats a key holding undefined as the same state as a missing key', () => {
    const world = toySeed();
    world.flags = undefined;
    expect(diffWorlds(toySeed(), world)).toEqual([]);
    world.flags = { frozen: true };
    expect(diffWorlds(toySeed(), world).map((c) => c.where)).toEqual(['flags']);
  });

  it('falls back to positions when ids repeat, rather than conflating records', () => {
    const before = { rows: [{ id: 'x', v: 1 }, { id: 'x', v: 2 }] };
    const after = { rows: [{ id: 'x', v: 1 }, { id: 'x', v: 3 }] };
    expect(diffWorlds(before, after).map((c) => c.where)).toEqual(['rows[1].v']);
  });
});

describe('blast radius', () => {
  const allow = anyOf(
    within('orders', 'O-1'),
    addedTo('ledger', (entry) => entry.orderId === 'O-1'),
  );

  it('lets through only the changes the task allows', () => {
    const world = toySeed();
    world.orders[0]!.status = 'cancelled';
    world.ledger.push({ id: 'L1', orderId: 'O-1', amount: 500 });
    expect(outOfScopeChanges(toySeed(), world, allow)).toEqual([]);

    world.ledger.push({ id: 'L2', orderId: 'O-2', amount: 1 });
    world.orders[1]!.status = 'returned';
    expect(outOfScopeChanges(toySeed(), world, allow).map((c) => c.where)).toEqual([
      'orders[O-2].status',
      'ledger[L2]',
    ]);
  });

  it('builds a forbidden rule whose detail names what was touched', () => {
    const rule = blastRadiusRule<ToyWorld>({ seed: toySeed, allow, multiplier: 0.5 });
    const world = toySeed();
    expect(rule.violated(world, [])).toBe(false);
    world.notes.push('x');
    expect(rule.violated(world, [])).toBe(true);
    expect(rule.multiplier).toBe(0.5);
    expect(rule.id).toBe('out-of-scope-change');
    const detail = typeof rule.detail === 'function' ? rule.detail(world, []) : rule.detail;
    expect(detail).toContain('notes[1]');
  });

  it('summarises long lists of offending paths', () => {
    const rule = blastRadiusRule<ToyWorld>({ seed: toySeed, allow });
    const world = toySeed();
    for (let index = 0; index < 9; index++) world.notes.push(`n${index}`);
    const detail = typeof rule.detail === 'function' ? rule.detail(world, []) : rule.detail;
    expect(detail).toMatch(/and 3 more\.$/);
  });
});

// ---------------------------------------------------------------------------
// Seeded randomness
// ---------------------------------------------------------------------------

describe('createRng', () => {
  it('is deterministic per seed and differs between seeds', () => {
    const a = createRng(7);
    const b = createRng(7);
    const c = createRng(8);
    const draw = (rng: ReturnType<typeof createRng>) => Array.from({ length: 5 }, () => rng.next());
    const first = draw(a);
    expect(draw(b)).toEqual(first);
    expect(draw(c)).not.toEqual(first);
  });

  it('keeps integers in range and shuffles without losing or mutating items', () => {
    const rng = createRng(1);
    for (let index = 0; index < 200; index++) {
      const value = rng.int(3, 5);
      expect(value).toBeGreaterThanOrEqual(3);
      expect(value).toBeLessThanOrEqual(5);
    }
    const items = [1, 2, 3, 4, 5];
    const shuffled = rng.shuffle(items);
    expect([...shuffled].sort()).toEqual(items);
    expect(items).toEqual([1, 2, 3, 4, 5]);
    expect(() => rng.pick([])).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Trap metadata
// ---------------------------------------------------------------------------

describe('trap metadata', () => {
  interface Counter {
    value: number;
  }

  const spec = {
    id: 'toy',
    world: 'toy',
    title: 'Toy',
    prompt: 'Set the counter to 2.',
    difficulty: 'expert' as const,
    tags: [],
    maxTurns: 4,
    hypothesis: 'single wins: there is nothing to split.',
    createWorld: (): Counter => ({ value: 0 }),
    createTools: (world: Counter) => [
      {
        name: 'set',
        description: 'Set the counter.',
        schema: { value: z.number().int() },
        handler: ({ value }: { value: number }) => {
          world.value = value;
          return `counter = ${value}`;
        },
      },
    ],
    assertions: [
      { id: 'is-two', label: 'Counter is 2', weight: 1, check: (w: Counter) => w.value === 2 },
    ],
    forbidden: [
      {
        id: 'went-negative',
        label: 'Counter went negative',
        multiplier: 0.5,
        violated: (_w: Counter, journal: readonly ToolCall[]) =>
          journal.some((entry) => (entry.args.value as number) < 0),
        detail: (_w: Counter, journal: readonly ToolCall[]) =>
          `${journal.filter((entry) => (entry.args.value as number) < 0).length} negative write(s)`,
      },
    ],
    traps: [
      { id: 'off-by-one', description: 'Sets 1 or 3.', caughtBy: ['is-two'] },
      { id: 'negative', description: 'Writes a negative.', caughtBy: ['went-negative'] },
    ],
  };

  it('carries difficulty, hypothesis and traps onto the task', () => {
    const task = defineToolUseTask(spec);
    expect(task.difficulty).toBe('expert');
    expect(task.hypothesis).toContain('single');
    expect(task.traps?.map((trap) => trap.id)).toEqual(['off-by-one', 'negative']);
  });

  it('refuses a trap that names a scorer item that does not exist', () => {
    expect(() =>
      defineToolUseTask({
        ...spec,
        traps: [{ id: 'typo', description: 'x', caughtBy: ['is-tow'] }],
      }),
    ).toThrow(/unknown scorer item is-tow/);
    expect(() =>
      defineToolUseTask({ ...spec, traps: [{ id: 'empty', description: 'x', caughtBy: [] }] }),
    ).toThrow(/names no scorer item/);
  });

  it('reports which traps a run fell into, with a computed penalty detail', async () => {
    const task = defineToolUseTask(spec);
    const world = spec.createWorld();
    const d = createDriver(world, spec.createTools(world));
    await d.call('set', { value: -1 });
    await d.call('set', { value: 3 });
    const score = await task.score(scoreInput(d));
    expect(score.penalties[0]?.detail).toBe('1 negative write(s)');
    expect(firedTraps(task, score)).toEqual(['off-by-one', 'negative']);

    const clean = spec.createWorld();
    const ok = createDriver(clean, spec.createTools(clean));
    await ok.call('set', { value: 2 });
    expect(firedTraps(task, await task.score(scoreInput(ok)))).toEqual([]);
  });

  it('validates tool arguments in the test driver the way the MCP server does', async () => {
    const world = spec.createWorld();
    const d = createDriver(world, spec.createTools(world));
    await expect(d.call('set', { value: 'two' })).rejects.toThrow(/invalid arguments/);
    expect(d.journal).toEqual([]);
  });
});
