import { describe, expect, it } from 'vitest';
import type { ScoreInput, Task, TaskEnvironment, ToolCall } from '@arena/core';
import {
  createEcommerceTools,
  createEcommerceWorld,
  ecommerceEasyTask,
  ecommerceHardTask,
  ecommerceMediumTask,
  ecommerceTasks,
  findCustomer,
  findLine,
  findOrder,
  findProduct,
  type EcommerceWorld,
} from '../src/worlds/ecommerce/index';

const NEW_ADDRESS = '7 Quarry Rise, Sheffield S11 8XZ, UK';

/** Drives tool handlers directly and records the same journal the runner would. */
function setup() {
  const world = createEcommerceWorld();
  const journal: ToolCall[] = [];
  const byName = new Map(createEcommerceTools(world).map((spec) => [spec.name, spec]));

  async function call(name: string, args: Record<string, unknown> = {}) {
    const spec = byName.get(name);
    if (!spec) throw new Error(`no tool named ${name}`);
    const reply = await spec.handler(args);
    const text = typeof reply === 'string' ? reply : reply.text;
    const ok = typeof reply === 'string' ? true : reply.isError !== true;
    journal.push({ name, args, tMs: journal.length, ok, result: text });
    return { text, ok };
  }

  return { world, journal, call, byName };
}

function scoreInput(world: EcommerceWorld, journal: ToolCall[]): ScoreInput {
  const env: TaskEnvironment = {
    mcpServers: {},
    allowedTools: [],
    readOnlyTools: [],
    state: world,
    journal,
  };
  return {
    env,
    outcome: { finalText: '', subagentCount: 0, phases: [] },
    trace: [],
    deps: {
      judge: async () => {
        throw new Error('tool-use tasks must not call the judge');
      },
      judgeSamples: 1,
    },
  };
}

async function scoreUntouched(task: Task) {
  const world = createEcommerceWorld();
  return task.score(scoreInput(world, []));
}

function envOptions() {
  return { cwd: '/tmp/arena-test', fixtureMode: 'replay' as const, fixtureDir: '/tmp/fixtures' };
}

// ---------------------------------------------------------------------------
// World
// ---------------------------------------------------------------------------

describe('createEcommerceWorld', () => {
  it('returns an independent world on every call', () => {
    const a = createEcommerceWorld();
    const b = createEcommerceWorld();
    const orderA = findOrder(a, 'O-1001');
    orderA!.shippingAddress = 'mutated';
    findProduct(a, 'P-MOU')!.stock = 0;
    expect(findOrder(b, 'O-1001')?.shippingAddress).not.toBe('mutated');
    expect(findProduct(b, 'P-MOU')?.stock).toBe(30);
  });

  it('seeds order totals that match the sum of the line amounts actually paid', () => {
    const world = createEcommerceWorld();
    for (const order of world.orders) {
      const sum = order.lines.reduce((acc, line) => acc + line.paidCents, 0);
      expect(sum).toBe(order.paidCents);
    }
  });

  it('prices the discounted line below its list price', () => {
    const world = createEcommerceWorld();
    const line = findLine(findOrder(world, 'O-2003')!, 'L1')!;
    const product = findProduct(world, line.productId)!;
    expect(line.paidCents).toBeLessThan(product.priceCents * line.quantity);
  });
});

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

describe('createEcommerceTools', () => {
  it('marks exactly the inspection tools as read-only', () => {
    const tools = createEcommerceTools(createEcommerceWorld());
    const readOnly = tools.filter((t) => t.readOnly === true).map((t) => t.name).sort();
    expect(readOnly).toEqual([
      'get_customer',
      'get_inventory',
      'get_order',
      'get_product',
      'get_return_policy',
      'list_orders',
    ]);
    const mutating = tools.filter((t) => t.readOnly !== true).map((t) => t.name).sort();
    expect(mutating).toEqual([
      'apply_store_credit',
      'cancel_order',
      'refund_order',
      'restock_item',
      'split_shipment',
      'update_shipping_address',
    ]);
  });

  it('reports unknown ids as errors instead of throwing', async () => {
    const { call } = setup();
    const attempts = await Promise.all([
      call('get_order', { orderId: 'O-9999' }),
      call('get_product', { productId: 'P-NOPE' }),
      call('get_customer', { customerId: 'C-999' }),
      call('list_orders', { customerId: 'C-999' }),
      call('cancel_order', { orderId: 'O-9999', lineIds: ['L1'] }),
      call('cancel_order', { orderId: 'O-2003', lineIds: ['L9'] }),
      call('refund_order', { orderId: 'O-9999', lineIds: ['L1'], amountCents: 100, method: 'card' }),
      call('restock_item', { productId: 'P-NOPE', quantity: 1 }),
      call('update_shipping_address', { orderId: 'O-9999', address: NEW_ADDRESS }),
      call('split_shipment', { orderId: 'O-9999', lineIds: ['L1'] }),
      call('apply_store_credit', { customerId: 'C-999', amountCents: 100 }),
      call('get_inventory', { productId: 'P-NOPE' }),
    ]);
    for (const attempt of attempts) {
      expect(attempt.ok).toBe(false);
      expect(attempt.text.toLowerCase()).toContain('unknown');
    }
  });

  it('rejects missing required arguments', async () => {
    const { call } = setup();
    expect((await call('get_order', {})).ok).toBe(false);
    expect((await call('cancel_order', { orderId: 'O-2003', lineIds: [] })).ok).toBe(false);
    expect((await call('restock_item', { productId: 'P-MOU', quantity: 0 })).ok).toBe(false);
    expect((await call('apply_store_credit', { customerId: 'C-100', amountCents: -5 })).ok).toBe(false);
  });

  it('lists a customer orders and reads a single order with its lines', async () => {
    const { call } = setup();
    const listed = await call('list_orders', { customerId: 'C-100' });
    expect(listed.ok).toBe(true);
    expect(listed.text).toContain('O-1001');
    expect(listed.text).toContain('O-1002');

    const read = await call('get_order', { orderId: 'O-2003' });
    expect(read.text).toContain('paidCents=7350');
    expect(read.text).toContain('P-MOU');
  });

  it('refuses to cancel a line that has already shipped', async () => {
    const { call, world } = setup();
    const whole = await call('cancel_order', { orderId: 'O-1002' });
    expect(whole.ok).toBe(false);
    const line = await call('cancel_order', { orderId: 'O-3001', lineIds: ['L1'] });
    expect(line.ok).toBe(false);
    expect(findLine(findOrder(world, 'O-3001')!, 'L1')?.status).toBe('shipped');
  });

  it('refuses to refund a line that is still pending', async () => {
    const { call } = setup();
    const attempt = await call('refund_order', {
      orderId: 'O-2003',
      lineIds: ['L2'],
      amountCents: 6900,
      method: 'card',
    });
    expect(attempt.ok).toBe(false);
    expect(attempt.text).toContain('cancel');
  });

  it('refuses to refund the same line twice', async () => {
    const { call } = setup();
    await call('cancel_order', { orderId: 'O-2003', lineIds: ['L1'] });
    expect(
      (await call('refund_order', { orderId: 'O-2003', lineIds: ['L1'], amountCents: 7350, method: 'card' })).ok,
    ).toBe(true);
    const again = await call('refund_order', {
      orderId: 'O-2003',
      lineIds: ['L1'],
      amountCents: 100,
      method: 'card',
    });
    expect(again.ok).toBe(false);
  });

  it('refuses to refund more than the order was paid in total', async () => {
    const { call } = setup();
    await call('cancel_order', { orderId: 'O-2003', lineIds: ['L1'] });
    const attempt = await call('refund_order', {
      orderId: 'O-2003',
      lineIds: ['L1'],
      amountCents: 25_000,
      method: 'card',
    });
    expect(attempt.ok).toBe(false);
  });

  it('allows an over-refund of a single line, so the policy check has something to catch', async () => {
    const { call, world } = setup();
    await call('cancel_order', { orderId: 'O-2003', lineIds: ['L1'] });
    const attempt = await call('refund_order', {
      orderId: 'O-2003',
      lineIds: ['L1'],
      amountCents: 9800,
      method: 'card',
    });
    expect(attempt.ok).toBe(true);
    expect(findLine(findOrder(world, 'O-2003')!, 'L1')?.refundedCents).toBe(9800);
  });

  it('splits a multi-line refund across its lines in proportion to what each line paid', async () => {
    const { call, world } = setup();
    await call('refund_order', {
      orderId: 'O-3001',
      lineIds: ['L1', 'L2'],
      amountCents: 54_800,
      method: 'store_credit',
    });
    const order = findOrder(world, 'O-3001')!;
    expect(findLine(order, 'L1')?.refundedCents).toBe(21_900);
    expect(findLine(order, 'L2')?.refundedCents).toBe(32_900);
    expect(findLine(order, 'L1')?.status).toBe('returned');
  });

  it('records store credit in the ledger without touching the customer balance', async () => {
    const { call, world } = setup();
    const reply = await call('refund_order', {
      orderId: 'O-3001',
      lineIds: ['L1'],
      amountCents: 21_900,
      method: 'store_credit',
    });
    expect(reply.text).toContain('apply_store_credit');
    expect(findCustomer(world, 'C-300')?.storeCreditCents).toBe(500);

    await call('apply_store_credit', { customerId: 'C-300', amountCents: 21_900 });
    expect(findCustomer(world, 'C-300')?.storeCreditCents).toBe(22_400);
  });

  it('restocks an item and records the movement', async () => {
    const { call, world } = setup();
    const before = findProduct(world, 'P-MOU')!.stock;
    await call('restock_item', { productId: 'P-MOU', quantity: 2, orderId: 'O-2003' });
    expect(findProduct(world, 'P-MOU')?.stock).toBe(before + 2);
    expect(world.inventoryMovements.some((m) => m.productId === 'P-MOU' && m.deltaUnits === 2)).toBe(true);
  });

  it('lets the address of a shipped order be changed, so the policy check has something to catch', async () => {
    const { call, world } = setup();
    const reply = await call('update_shipping_address', { orderId: 'O-1002', address: NEW_ADDRESS });
    expect(reply.ok).toBe(true);
    expect(reply.text).toContain('shipped');
    expect(findOrder(world, 'O-1002')?.shippingAddress).toBe(NEW_ADDRESS);
  });

  it('ships the named pending lines with split_shipment', async () => {
    const { call, world } = setup();
    const reply = await call('split_shipment', { orderId: 'O-2003', lineIds: ['L2'] });
    expect(reply.ok).toBe(true);
    const order = findOrder(world, 'O-2003')!;
    expect(findLine(order, 'L2')?.status).toBe('shipped');
    expect(order.status).toBe('partially_shipped');
    expect((await call('split_shipment', { orderId: 'O-2003', lineIds: ['L2'] })).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Task metadata
// ---------------------------------------------------------------------------

describe('ecommerce tasks', () => {
  it('exposes one task per difficulty in the ecommerce world', () => {
    expect(ecommerceTasks.map((t) => t.id)).toEqual([
      'ecommerce-easy',
      'ecommerce-medium',
      'ecommerce-hard',
    ]);
    expect(ecommerceTasks.map((t) => t.difficulty)).toEqual(['easy', 'medium', 'hard']);
    for (const task of ecommerceTasks) {
      expect(task.world).toBe('ecommerce');
      expect(task.category).toBe('tool-use');
      expect(task.policy).toBeTruthy();
    }
  });

  it('builds an environment whose read-only tools are a strict subset of the allowed tools', async () => {
    const env = await ecommerceMediumTask.createEnvironment(envOptions());
    expect(env.allowedTools).toContain('mcp__ecommerce__refund_order');
    expect(env.readOnlyTools).toContain('mcp__ecommerce__get_order');
    expect(env.readOnlyTools).not.toContain('mcp__ecommerce__refund_order');
    expect(env.readOnlyTools.length).toBeLessThan(env.allowedTools.length);
    for (const name of env.readOnlyTools) expect(env.allowedTools).toContain(name);
  });

  it('keeps the order id out of the prompt for the task that must discover it', () => {
    expect(ecommerceEasyTask.prompt).not.toContain('O-1001');
    expect(ecommerceEasyTask.prompt).toContain('C-100');
  });

  it('does not leak the discounted amount or the line id into the medium prompt', () => {
    expect(ecommerceMediumTask.prompt).not.toContain('7350');
    expect(ecommerceMediumTask.prompt).not.toContain('L1');
  });

  it('does not leak the split between store credit and card into the hard prompt', () => {
    expect(ecommerceHardTask.prompt).not.toContain('store credit');
    expect(ecommerceHardTask.prompt).not.toContain('54800');
  });
});

// ---------------------------------------------------------------------------
// ecommerce-easy
// ---------------------------------------------------------------------------

describe('ecommerce-easy', () => {
  it('scores 1 on the golden path', async () => {
    const { world, journal, call } = setup();
    await call('list_orders', { customerId: 'C-100' });
    await call('get_order', { orderId: 'O-1001' });
    await call('get_order', { orderId: 'O-1002' });
    const updated = await call('update_shipping_address', { orderId: 'O-1001', address: NEW_ADDRESS });
    expect(updated.ok).toBe(true);

    const score = await ecommerceEasyTask.score(scoreInput(world, journal));
    expect(score.score).toBe(1);
    expect(score.passed).toBe(true);
    expect(score.penalties).toEqual([]);
  });

  it('hard-fails when the shipped order is edited too', async () => {
    const { world, journal, call } = setup();
    await call('list_orders', { customerId: 'C-100' });
    await call('update_shipping_address', { orderId: 'O-1001', address: NEW_ADDRESS });
    await call('update_shipping_address', { orderId: 'O-1002', address: NEW_ADDRESS });

    const score = await ecommerceEasyTask.score(scoreInput(world, journal));
    expect(score.score).toBe(0);
    expect(score.passed).toBe(false);
    expect(score.failureMode).toBe('policy_violation');
    expect(score.penalties.map((p) => p.id)).toContain('shipped-order-edited');
  });

  it('hard-fails when the agent cancels the shipped order instead of leaving it alone', async () => {
    const { world, journal, call } = setup();
    await call('update_shipping_address', { orderId: 'O-1001', address: NEW_ADDRESS });
    await call('cancel_order', { orderId: 'O-2003', lineIds: ['L1'] });

    const score = await ecommerceEasyTask.score(scoreInput(world, journal));
    expect(score.score).toBe(0);
    expect(score.penalties.map((p) => p.id)).toContain('out-of-scope-mutation');
  });

  it('scores 0 on an untouched world', async () => {
    const score = await scoreUntouched(ecommerceEasyTask);
    expect(score.score).toBe(0);
    expect(score.passed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ecommerce-medium
// ---------------------------------------------------------------------------

describe('ecommerce-medium', () => {
  it('scores 1 on the golden path', async () => {
    const { world, journal, call } = setup();
    await call('get_return_policy', {});
    await call('get_order', { orderId: 'O-2003' });
    expect((await call('cancel_order', { orderId: 'O-2003', lineIds: ['L1'] })).ok).toBe(true);
    expect(
      (await call('restock_item', { productId: 'P-MOU', quantity: 2, orderId: 'O-2003' })).ok,
    ).toBe(true);
    expect(
      (await call('refund_order', {
        orderId: 'O-2003',
        lineIds: ['L1'],
        amountCents: 7350,
        method: 'card',
      })).ok,
    ).toBe(true);

    const score = await ecommerceMediumTask.score(scoreInput(world, journal));
    expect(score.score).toBe(1);
    expect(score.passed).toBe(true);
    expect(findOrder(world, 'O-2003')?.status).toBe('pending');
  });

  it('hard-fails when the refund uses the list price instead of what was paid', async () => {
    const { world, journal, call } = setup();
    await call('get_order', { orderId: 'O-2003' });
    await call('get_product', { productId: 'P-MOU' });
    await call('cancel_order', { orderId: 'O-2003', lineIds: ['L1'] });
    await call('restock_item', { productId: 'P-MOU', quantity: 2, orderId: 'O-2003' });
    await call('refund_order', {
      orderId: 'O-2003',
      lineIds: ['L1'],
      amountCents: 9800,
      method: 'card',
    });

    const score = await ecommerceMediumTask.score(scoreInput(world, journal));
    expect(score.score).toBe(0);
    expect(score.failureMode).toBe('policy_violation');
    expect(score.penalties.map((p) => p.id)).toContain('line-over-refund');
  });

  it('hard-fails when the whole order is cancelled instead of the one line', async () => {
    const { world, journal, call } = setup();
    await call('get_order', { orderId: 'O-2003' });
    await call('cancel_order', { orderId: 'O-2003' });
    await call('restock_item', { productId: 'P-MOU', quantity: 2, orderId: 'O-2003' });
    await call('refund_order', {
      orderId: 'O-2003',
      lineIds: ['L1'],
      amountCents: 7350,
      method: 'card',
    });

    const score = await ecommerceMediumTask.score(scoreInput(world, journal));
    expect(score.score).toBe(0);
    expect(score.penalties.map((p) => p.id)).toContain('unrequested-cancellation');
  });

  it('loses the restock points when the released units are never returned to stock', async () => {
    const { world, journal, call } = setup();
    await call('get_order', { orderId: 'O-2003' });
    await call('cancel_order', { orderId: 'O-2003', lineIds: ['L1'] });
    await call('refund_order', {
      orderId: 'O-2003',
      lineIds: ['L1'],
      amountCents: 7350,
      method: 'card',
    });

    const score = await ecommerceMediumTask.score(scoreInput(world, journal));
    expect(score.penalties).toEqual([]);
    expect(score.score).toBeGreaterThan(0);
    expect(score.score).toBeLessThan(1);
    expect(score.breakdown.find((item) => item.id === 'restocked-exact-quantity')?.earned).toBe(0);
  });

  it('scores 0 on an untouched world', async () => {
    const score = await scoreUntouched(ecommerceMediumTask);
    expect(score.score).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// ecommerce-hard
// ---------------------------------------------------------------------------

describe('ecommerce-hard', () => {
  it('scores 1 on the golden path', async () => {
    const { world, journal, call } = setup();
    await call('get_return_policy', {});
    await call('get_order', { orderId: 'O-3001' });
    await call('get_customer', { customerId: 'C-300' });
    expect((await call('cancel_order', { orderId: 'O-3001', lineIds: ['L3'] })).ok).toBe(true);
    expect(
      (await call('restock_item', { productId: 'P-HUB', quantity: 2, orderId: 'O-3001' })).ok,
    ).toBe(true);
    expect(
      (await call('refund_order', {
        orderId: 'O-3001',
        lineIds: ['L3'],
        amountCents: 13_800,
        method: 'card',
      })).ok,
    ).toBe(true);
    expect(
      (await call('refund_order', {
        orderId: 'O-3001',
        lineIds: ['L1', 'L2'],
        amountCents: 54_800,
        method: 'store_credit',
      })).ok,
    ).toBe(true);
    expect(
      (await call('apply_store_credit', { customerId: 'C-300', amountCents: 54_800 })).ok,
    ).toBe(true);

    const score = await ecommerceHardTask.score(scoreInput(world, journal));
    expect(score.score).toBe(1);
    expect(score.passed).toBe(true);
    expect(findCustomer(world, 'C-300')?.storeCreditCents).toBe(55_300);
  });

  it('accepts the two shipped lines refunded one call at a time', async () => {
    const { world, journal, call } = setup();
    await call('get_return_policy', {});
    await call('get_order', { orderId: 'O-3001' });
    await call('cancel_order', { orderId: 'O-3001', lineIds: ['L3'] });
    await call('restock_item', { productId: 'P-HUB', quantity: 2, orderId: 'O-3001' });
    await call('refund_order', { orderId: 'O-3001', lineIds: ['L3'], amountCents: 13_800, method: 'card' });
    await call('refund_order', {
      orderId: 'O-3001',
      lineIds: ['L1'],
      amountCents: 21_900,
      method: 'store_credit',
    });
    await call('refund_order', {
      orderId: 'O-3001',
      lineIds: ['L2'],
      amountCents: 32_900,
      method: 'store_credit',
    });
    await call('apply_store_credit', { customerId: 'C-300', amountCents: 21_900 });
    await call('apply_store_credit', { customerId: 'C-300', amountCents: 32_900 });

    const score = await ecommerceHardTask.score(scoreInput(world, journal));
    expect(score.score).toBe(1);
  });

  it('hard-fails when the whole return goes back to the card', async () => {
    const { world, journal, call } = setup();
    await call('get_order', { orderId: 'O-3001' });
    await call('cancel_order', { orderId: 'O-3001', lineIds: ['L3'] });
    await call('restock_item', { productId: 'P-HUB', quantity: 2, orderId: 'O-3001' });
    await call('refund_order', {
      orderId: 'O-3001',
      lineIds: ['L1', 'L2', 'L3'],
      amountCents: 68_600,
      method: 'card',
    });

    const score = await ecommerceHardTask.score(scoreInput(world, journal));
    expect(score.score).toBe(0);
    expect(score.failureMode).toBe('policy_violation');
    expect(score.penalties.map((p) => p.id)).toContain('card-refund-outside-return-window');
  });

  it('loses the inventory points when goods that were never received are restocked', async () => {
    const { world, journal, call } = setup();
    await call('get_return_policy', {});
    await call('get_order', { orderId: 'O-3001' });
    await call('cancel_order', { orderId: 'O-3001', lineIds: ['L3'] });
    await call('restock_item', { productId: 'P-HUB', quantity: 2, orderId: 'O-3001' });
    await call('restock_item', { productId: 'P-DOC', quantity: 1, orderId: 'O-3001' });
    await call('restock_item', { productId: 'P-MON', quantity: 1, orderId: 'O-3001' });
    await call('refund_order', { orderId: 'O-3001', lineIds: ['L3'], amountCents: 13_800, method: 'card' });
    await call('refund_order', {
      orderId: 'O-3001',
      lineIds: ['L1', 'L2'],
      amountCents: 54_800,
      method: 'store_credit',
    });
    await call('apply_store_credit', { customerId: 'C-300', amountCents: 54_800 });

    const score = await ecommerceHardTask.score(scoreInput(world, journal));
    expect(score.penalties).toEqual([]);
    expect(score.score).toBeLessThan(1);
    expect(score.breakdown.find((item) => item.id === 'inventory-reflects-receipts')?.earned).toBe(0);
  });

  it('loses the balance points when the store credit is only recorded in the ledger', async () => {
    const { world, journal, call } = setup();
    await call('get_return_policy', {});
    await call('get_order', { orderId: 'O-3001' });
    await call('cancel_order', { orderId: 'O-3001', lineIds: ['L3'] });
    await call('restock_item', { productId: 'P-HUB', quantity: 2, orderId: 'O-3001' });
    await call('refund_order', { orderId: 'O-3001', lineIds: ['L3'], amountCents: 13_800, method: 'card' });
    await call('refund_order', {
      orderId: 'O-3001',
      lineIds: ['L1', 'L2'],
      amountCents: 54_800,
      method: 'store_credit',
    });

    const score = await ecommerceHardTask.score(scoreInput(world, journal));
    expect(score.penalties).toEqual([]);
    expect(score.score).toBeLessThan(1);
    expect(score.breakdown.find((item) => item.id === 'store-credit-applied')?.earned).toBe(0);
  });

  it('scores 0 on an untouched world', async () => {
    const score = await scoreUntouched(ecommerceHardTask);
    expect(score.score).toBe(0);
  });
});
