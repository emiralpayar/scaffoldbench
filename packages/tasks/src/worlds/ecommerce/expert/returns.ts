import type { Task } from '@arena/core';
import {
  defineToolUseTask,
  type AssertionSpec,
  type ForbiddenSpec,
  type ToolUseTaskSpec,
} from '../../../defineToolUseTask';
import { hasCall } from '../../../journal';
import { addedTo, anyOf, blastRadiusRule, within } from '../../../worldDiff';
import {
  emptyStoreOps,
  type EcommerceOpsWorld,
  type ReturnAuthorization,
  type ReturnReceipt,
} from '../ops';
import {
  daysBetween,
  findCustomer,
  findProduct,
  type RefundMethod,
} from '../world';
import {
  ECOMMERCE_EXPERT_BASE,
  addedRefunds,
  customer,
  feeCents,
  line,
  lineOrThrow,
  order,
  product,
  stockOf,
} from './common';

/**
 * ecommerce-returns-desk: nine open returns, each settled by what the
 * warehouse actually received.
 *
 * Every return is its own small case (read the authorization, the order, the
 * receipts and the policy, then refund, restock and close), so the batch splits
 * cleanly. What makes a case go wrong is never visible in the return itself:
 * a parcel that has not arrived although the customer insists it has, a box
 * holding a different product, a damaged item, half a return, a window that
 * closed after the customer asked, a colleague's earlier goodwill refund, and
 * a restocking fee that depends on why the goods came back, not on the state
 * they arrived in.
 */

const TODAY = '2026-07-25';
const RESTOCKING_FEE_PERCENT = 15;

const shipped = (id: string, productId: string, quantity: number, unit: number, on: string, paid?: number) =>
  line(id, productId, quantity, unit, { status: 'shipped', shippedAt: on, ...(paid ? { paid } : {}) });

function rma(
  id: string,
  orderId: string,
  lineId: string,
  quantity: number,
  requestedOn: string,
  reason: ReturnAuthorization['reason'],
  fields: Partial<Pick<ReturnAuthorization, 'status' | 'customerNote' | 'note'>> = {},
): ReturnAuthorization {
  return { id, orderId, lineId, quantity, requestedOn, reason, status: fields.status ?? 'open', ...fields };
}

function receipt(
  rmaId: string,
  receivedOn: string,
  quantity: number,
  grade: ReturnReceipt['grade'],
  productReceived: string,
): ReturnReceipt {
  return { rmaId, receivedOn, quantity, grade, productReceived };
}

export const NOT_RECEIVED_NOTE =
  'I dropped the parcel at the post office on 21 July and the tracking shows it was delivered to your warehouse on the 23rd. Please refund me today, I have waited long enough.';

export function createReturnsWorld(): EcommerceOpsWorld {
  const o7008 = order('O-7008', 'C-708', '2026-07-01', [
    shipped('L1', 'P-KEY', 1, 12_900, '2026-07-03'),
    shipped('L2', 'P-CAB', 2, 1_900, '2026-07-03'),
  ]);
  const goodwill = o7008.lines[0];
  if (goodwill) {
    goodwill.refundedCents = 3_000;
    goodwill.refundMethod = 'card';
  }
  const o7010 = order('O-7010', 'C-710', '2026-07-02', [
    shipped('L1', 'P-HDP', 1, 15_900, '2026-07-04'),
  ]);
  const earlier = o7010.lines[0];
  if (earlier) {
    earlier.refundedCents = 13_515;
    earlier.refundMethod = 'card';
  }

  return {
    ...emptyStoreOps({
      today: TODAY,
      returnPolicy: {
        returnWindowDays: 30,
        outOfWindowMethod: 'store_credit',
        restockOnReceiptOnly: true,
        restockingFeePercent: RESTOCKING_FEE_PERCENT,
      },
      products: [
        product('P-KEY', 'Mechanical Keyboard', 12_900, 10),
        product('P-MOU', 'Wireless Mouse', 4_900, 20),
        product('P-HUB', 'USB-C Hub', 6_900, 5),
        product('P-MON', '27-inch Monitor', 32_900, 3),
        product('P-CAB', 'Braided USB Cable', 1_900, 40),
        product('P-DOC', 'Laptop Dock', 21_900, 2),
        product('P-HDP', 'Wireless Headphones', 15_900, 6),
      ],
      customers: [
        customer('C-701', 'Alma Reyes', 'standard'),
        customer('C-702', 'Bruno Silva', 'gold'),
        customer('C-703', 'Chloe Martin', 'standard'),
        customer('C-704', 'Dmitri Volkov', 'standard'),
        customer('C-705', 'Esme Clarke', 'platinum'),
        customer('C-706', 'Felix Wagner', 'standard', {
          storeCreditCents: 1_200,
          creditHistory: [{ at: '2026-04-02', amountCents: 1_200, reason: 'late delivery goodwill' }],
        }),
        customer('C-707', 'Greta Holm', 'gold'),
        customer('C-708', 'Hugo Laurent', 'standard'),
        customer('C-709', 'Isla Murray', 'standard'),
        customer('C-710', 'Jonas Berg', 'standard'),
        customer('C-711', 'Kira Tanaka', 'gold'),
      ],
      orders: [
        order('O-7001', 'C-701', '2026-06-29', [shipped('L1', 'P-KEY', 1, 12_900, '2026-07-01')]),
        order(
          'O-7002',
          'C-702',
          '2026-07-03',
          [
            shipped('L1', 'P-MOU', 2, 4_900, '2026-07-05', 7_350),
            shipped('L2', 'P-CAB', 1, 1_900, '2026-07-05'),
          ],
          { discountCode: 'MOUSE25' },
        ),
        order('O-7003', 'C-703', '2026-07-08', [
          shipped('L1', 'P-KEY', 1, 12_900, '2026-07-10'),
          shipped('L2', 'P-CAB', 3, 1_900, '2026-07-10'),
        ]),
        order('O-7004', 'C-704', '2026-07-06', [shipped('L1', 'P-HDP', 1, 15_900, '2026-07-08')]),
        order('O-7005', 'C-705', '2026-06-30', [shipped('L1', 'P-MON', 1, 32_900, '2026-07-02')]),
        order('O-7006', 'C-706', '2026-05-18', [shipped('L1', 'P-HUB', 1, 6_900, '2026-05-20')]),
        order('O-7007', 'C-707', '2026-06-08', [shipped('L1', 'P-DOC', 1, 21_900, '2026-06-10')]),
        o7008,
        order('O-7009', 'C-709', '2026-07-10', [shipped('L1', 'P-MOU', 1, 4_900, '2026-07-12')]),
        o7010,
        order('O-7011', 'C-711', '2026-07-05', [shipped('L1', 'P-MOU', 1, 4_900, '2026-07-07')]),
      ],
      inventoryMovements: [
        { productId: 'P-HDP', deltaUnits: 1, reason: 'return RMA-690', orderId: 'O-7010', at: '2026-07-14' },
      ],
      refunds: [
        {
          id: 'RF-1',
          orderId: 'O-7010',
          lineIds: ['L1'],
          amountCents: 13_515,
          method: 'card',
          at: '2026-07-14',
          reason: 'RMA-690 change of mind, less restocking fee',
        },
        {
          id: 'RF-2',
          orderId: 'O-7008',
          lineIds: ['L1'],
          amountCents: 3_000,
          method: 'card',
          at: '2026-07-18',
          reason: 'goodwill while the return is in transit (agent-12)',
        },
      ],
    }),
    returns: [
      rma('RMA-690', 'O-7010', 'L1', 1, '2026-07-09', 'changed_mind', {
        status: 'closed',
        note: 'received resellable, refunded RF-1',
      }),
      rma('RMA-695', 'O-7011', 'L1', 1, '2026-07-10', 'defective', { status: 'investigating' }),
      rma('RMA-701', 'O-7001', 'L1', 1, '2026-07-15', 'changed_mind', {
        customerNote: 'Too loud for the open-plan office, sorry.',
      }),
      rma('RMA-702', 'O-7002', 'L1', 2, '2026-07-12', 'defective', {
        customerNote: 'Both mice double-click on every press.',
      }),
      rma('RMA-703', 'O-7003', 'L2', 2, '2026-07-18', 'changed_mind', {
        customerNote: 'Ordered one cable too many - two too many in fact. Sending two back.',
      }),
      rma('RMA-704', 'O-7004', 'L1', 1, '2026-07-20', 'changed_mind', { customerNote: NOT_RECEIVED_NOTE }),
      rma('RMA-705', 'O-7005', 'L1', 1, '2026-07-14', 'defective', {
        customerNote: 'Dead pixels across the top third of the panel.',
      }),
      rma('RMA-706', 'O-7006', 'L1', 1, '2026-07-02', 'changed_mind', {
        customerNote: 'Never used it, still sealed.',
      }),
      rma('RMA-707', 'O-7007', 'L1', 1, '2026-07-08', 'defective', {
        customerNote: 'Stops charging the laptop after a few minutes.',
      }),
      rma('RMA-708', 'O-7008', 'L1', 1, '2026-07-10', 'defective', {
        customerNote: 'Several keys stopped working. Your colleague already sent me something on account.',
      }),
      rma('RMA-709', 'O-7009', 'L1', 1, '2026-07-16', 'damaged_in_transit', {
        customerNote: 'The box arrived crushed and the mouse rattles.',
      }),
    ],
    receipts: [
      receipt('RMA-690', '2026-07-14', 1, 'resellable', 'P-HDP'),
      receipt('RMA-695', '2026-07-15', 1, 'wrong_item', 'P-CAB'),
      receipt('RMA-701', '2026-07-22', 1, 'resellable', 'P-KEY'),
      receipt('RMA-702', '2026-07-19', 2, 'damaged', 'P-MOU'),
      receipt('RMA-703', '2026-07-24', 1, 'resellable', 'P-CAB'),
      receipt('RMA-705', '2026-07-21', 1, 'wrong_item', 'P-CAB'),
      receipt('RMA-706', '2026-07-12', 1, 'resellable', 'P-HUB'),
      receipt('RMA-707', '2026-07-23', 1, 'damaged', 'P-DOC'),
      receipt('RMA-708', '2026-07-20', 1, 'damaged', 'P-KEY'),
      receipt('RMA-709', '2026-07-22', 1, 'resellable', 'P-MOU'),
    ],
  };
}

// ---------------------------------------------------------------------------
// Oracle
// ---------------------------------------------------------------------------

export interface ReturnSettlement {
  rmaId: string;
  orderId: string;
  lineId: string;
  productId: string;
  customerId: string;
  /** The single refund owed now, or undefined when nothing is owed. */
  refund?: { method: RefundMethod; amountCents: number };
  /** Units into each stock bucket. */
  sellable: number;
  damaged: number;
  status: ReturnAuthorization['status'];
  /** What the goods received are worth before any fee, net of earlier refunds: the most any refund may be. */
  ceilingCents: number;
}

/**
 * How each open return settles under the returns rules, from the seed: only
 * received units count; a different product means an investigation and
 * nothing else; the refund is the paid unit price for what arrived, less the
 * change-of-mind fee and anything already refunded on the line, paid as store
 * credit when the return was requested after the window closed.
 */
export function returnsOracle(seed: EcommerceOpsWorld): ReturnSettlement[] {
  return seed.returns
    .filter((entry) => entry.status === 'open')
    .map((entry) => {
      const owner = seed.orders.find((candidate) => candidate.id === entry.orderId);
      const returned = lineOrThrow(seed, entry.orderId, entry.lineId);
      const base = {
        rmaId: entry.id,
        orderId: entry.orderId,
        lineId: entry.lineId,
        productId: returned.productId,
        customerId: owner?.customerId ?? '',
        sellable: 0,
        damaged: 0,
        ceilingCents: 0,
      };
      const received = seed.receipts.filter((candidate) => candidate.rmaId === entry.id);
      if (received.length === 0) return { ...base, status: 'open' as const };
      if (received.some((candidate) => candidate.grade === 'wrong_item')) {
        return { ...base, status: 'investigating' as const };
      }
      const units = received.reduce((total, candidate) => total + candidate.quantity, 0);
      const gross = (returned.paidCents / returned.quantity) * units;
      const fee = entry.reason === 'changed_mind' ? feeCents(gross, seed.returnPolicy.restockingFeePercent ?? 0) : 0;
      const ceiling = gross - returned.refundedCents;
      const late = daysBetween(returned.shippedAt ?? entry.requestedOn, entry.requestedOn) >
        seed.returnPolicy.returnWindowDays;
      const sum = (grade: ReturnReceipt['grade']) =>
        received.filter((candidate) => candidate.grade === grade).reduce((t, c) => t + c.quantity, 0);
      return {
        ...base,
        refund: {
          method: late ? seed.returnPolicy.outOfWindowMethod : 'card',
          amountCents: ceiling - fee,
        },
        sellable: sum('resellable'),
        damaged: sum('damaged'),
        ceilingCents: ceiling,
        status: units >= entry.quantity ? ('closed' as const) : ('open' as const),
      };
    });
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

const ORACLE = returnsOracle(createReturnsWorld());
const OPEN_RMAS = ORACLE.map((entry) => entry.rmaId);
const RMA_ORDERS = ORACLE.map((entry) => entry.orderId);
const RMA_CUSTOMERS = ORACLE.map((entry) => entry.customerId);

/**
 * A return whose correct outcome is to do nothing earns credit only once the
 * agent has looked at what the warehouse received for it, so an untouched
 * world scores nothing.
 */
function checkedReceipts(rmaId: string, journal: Parameters<AssertionSpec<EcommerceOpsWorld>['check']>[1]) {
  return hasCall(journal, {
    name: 'list_return_receipts',
    args: (args) => args.rmaId === undefined || args.rmaId === rmaId,
  });
}

function perReturn(expected: ReturnSettlement): AssertionSpec<EcommerceOpsWorld>[] {
  const { rmaId, orderId, refund, status } = expected;
  const investigated = (world: EcommerceOpsWorld) =>
    world.investigations.some((entry) => entry.rmaId === rmaId);
  return [
    {
      id: `settled:${rmaId}`,
      label: refund
        ? `${rmaId}: one refund of the right amount and method`
        : status === 'investigating'
          ? `${rmaId}: investigation opened, nothing refunded`
          : `${rmaId}: nothing refunded while the goods are not back`,
      weight: 2,
      check: (world, journal) => {
        const added = addedRefunds(createReturnsWorld(), world, orderId);
        if (refund) {
          return (
            added.length === 1 &&
            added[0]?.method === refund.method &&
            added[0]?.amountCents === refund.amountCents
          );
        }
        if (added.length > 0) return false;
        return status === 'investigating' ? investigated(world) : checkedReceipts(rmaId, journal);
      },
      detail: (world) => {
        const added = addedRefunds(createReturnsWorld(), world, orderId).map(
          (entry) => `${entry.amountCents} ${entry.method}`,
        );
        const want = refund ? `${refund.amountCents} ${refund.method}` : 'no refund';
        return `expected ${want}; got ${added.join(', ') || 'no refund'}`;
      },
    },
    {
      id: `status:${rmaId}`,
      label: `${rmaId} left ${status}`,
      weight: 0.5,
      check: (world, journal) => {
        const current = world.returns.find((entry) => entry.id === rmaId);
        if (current?.status !== status) return false;
        // Open is the seed state: it only counts once the return was worked.
        if (status !== 'open') return true;
        return refund ? addedRefunds(createReturnsWorld(), world, orderId).length > 0 : checkedReceipts(rmaId, journal);
      },
    },
  ];
}

/** Expected movement of each product's stock counters, summed over every return. */
function expectedStock(): Map<string, { sellable: number; damaged: number }> {
  const totals = new Map<string, { sellable: number; damaged: number }>();
  for (const entry of ORACLE) {
    const current = totals.get(entry.productId) ?? { sellable: 0, damaged: 0 };
    totals.set(entry.productId, {
      sellable: current.sellable + entry.sellable,
      damaged: current.damaged + entry.damaged,
    });
  }
  return totals;
}

function stockDelta(world: EcommerceOpsWorld, productId: string) {
  const seed = createReturnsWorld();
  const before = findProduct(seed, productId);
  const after = findProduct(world, productId);
  return {
    sellable: (after?.stock ?? 0) - (before?.stock ?? 0),
    damaged: (after?.damagedStock ?? 0) - (before?.damagedStock ?? 0),
  };
}

const STOCK = expectedStock();

function stockAssertions(): AssertionSpec<EcommerceOpsWorld>[] {
  return [...STOCK]
    .filter(([, expected]) => expected.sellable > 0 || expected.damaged > 0)
    .map(([productId, expected]) => ({
      id: `stock:${productId}`,
      label: `${productId} returns restocked into the right buckets`,
      weight: 1,
      check: (world: EcommerceOpsWorld) => {
        const delta = stockDelta(world, productId);
        return delta.sellable === expected.sellable && delta.damaged === expected.damaged;
      },
      detail: (world: EcommerceOpsWorld) => {
        const delta = stockDelta(world, productId);
        return `sellable +${delta.sellable} damaged +${delta.damaged} (expected +${expected.sellable} / +${expected.damaged})`;
      },
    }));
}

/** True when the refunds added for a return exceed what the goods received for it are worth. */
export function refundedBeyondReceipts(world: EcommerceOpsWorld, expected: ReturnSettlement): boolean {
  const total = addedRefunds(createReturnsWorld(), world, expected.orderId).reduce(
    (sum, entry) => sum + entry.amountCents,
    0,
  );
  return total > expected.ceilingCents;
}

/**
 * Money sent for goods the store does not have, one rule per return so a
 * report can say which case it was. Refunds cannot be recalled, so this is
 * read off the ledger whatever happened afterwards.
 */
function overRefundRule(expected: ReturnSettlement): ForbiddenSpec<EcommerceOpsWorld> {
  return {
    id: `over-refunded:${expected.rmaId}`,
    label: `${expected.rmaId}: refunded more than the goods received are worth`,
    multiplier: 0.5,
    violated: (world) => refundedBeyondReceipts(world, expected),
    detail: `At most ${expected.ceilingCents} cents was owed for what the warehouse received.`,
  };
}

/** Products whose sellable stock rose by more than the resellable goods received. */
export function unsellableRestocked(world: EcommerceOpsWorld): string[] {
  return world.products
    .filter((entry) => stockDelta(world, entry.id).sellable > (STOCK.get(entry.id)?.sellable ?? 0))
    .map((entry) => entry.id);
}

function expectedCredit(customerId: string): number {
  const seed = createReturnsWorld();
  const owed = ORACLE.filter(
    (entry) => entry.customerId === customerId && entry.refund?.method === 'store_credit',
  ).reduce((total, entry) => total + (entry.refund?.amountCents ?? 0), 0);
  return (findCustomer(seed, customerId)?.storeCreditCents ?? 0) + owed;
}

export const ecommerceReturnsSpec: ToolUseTaskSpec<EcommerceOpsWorld> = {
  ...ECOMMERCE_EXPERT_BASE,
  id: 'ecommerce-returns-desk',
  title: 'Settle a desk of returns by what actually came back',
  tags: ['ecommerce', 'returns', 'refunds', 'batch', 'partial-observability', 'long-horizon'],
  maxTurns: 110,
  prompt: [
    'Work through the open return authorizations (RMAs).',
    'Settle each one under the returns rules and the return policy: refund, restock and close',
    'whatever is ready, and leave everything else in the state the rules call for.',
  ].join(' '),
  hypothesis:
    'orchestrator-workers >= single at lower latency; plan-execute-verify > single on accuracy. The nine returns are independent cases, each needing its own authorization, order, receipt and policy lookup, so they split cleanly across workers with nothing shared but the policy. The errors on offer are slips a state-grounded verifier can recompute: a restocking fee charged by the condition of the goods instead of the reason for the return, a window measured to the day the goods arrived instead of the day the customer asked, a colleague\'s earlier refund, half a return. The parcel that has not arrived, with a customer note insisting it has, measures fabrication: agents that settle from the customer\'s account instead of the receipts refund goods the store does not have.',
  traps: [
    {
      id: 'not-received',
      description:
        "Refunds a return the warehouse has not received, on the strength of the customer's note that it was delivered.",
      caughtBy: ['over-refunded:RMA-704'],
    },
    {
      id: 'wrong-item',
      description:
        'Refunds or restocks a return when the warehouse received a different product, instead of opening an investigation.',
      caughtBy: ['settled:RMA-705', 'over-refunded:RMA-705'],
    },
    {
      id: 'damaged-to-shelf',
      description: 'Puts goods the warehouse graded damaged (or never received) into sellable stock.',
      caughtBy: ['unsellable-restocked'],
    },
    {
      id: 'window-from-today',
      description:
        'Measures the return window to today or to the day the goods arrived rather than the day the return was requested, and pays a timely return in store credit.',
      caughtBy: ['settled:RMA-707'],
    },
    {
      id: 'fee-by-condition',
      description:
        'Charges the change-of-mind restocking fee on a return made because the goods were damaged in transit, because they arrived in resellable condition.',
      caughtBy: ['settled:RMA-709'],
    },
    {
      id: 'prior-refund',
      description: "Refunds the full line without netting off a colleague's earlier goodwill refund.",
      caughtBy: ['over-refunded:RMA-708'],
    },
    {
      id: 'partial-receipt',
      description:
        'Refunds or closes a return for every unit it covers when only some of them have arrived.',
      caughtBy: ['over-refunded:RMA-703', 'status:RMA-703'],
    },
    {
      id: 'credit-not-applied',
      description:
        "Records an out-of-window refund as store credit on the order but never adds it to the customer's balance.",
      caughtBy: ['credit-balances'],
    },
  ],
  createWorld: createReturnsWorld,
  assertions: [
    ...ORACLE.flatMap(perReturn),
    ...stockAssertions(),
    {
      id: 'credit-balances',
      label: 'Store-credit balances moved by exactly the store-credit refunds owed',
      weight: 1,
      check: (world) =>
        RMA_CUSTOMERS.every((id) => findCustomer(world, id)?.storeCreditCents === expectedCredit(id)),
      detail: (world) =>
        RMA_CUSTOMERS.filter((id) => findCustomer(world, id)?.storeCreditCents !== expectedCredit(id))
          .map((id) => `${id}=${findCustomer(world, id)?.storeCreditCents} (expected ${expectedCredit(id)})`)
          .join(', ') || undefined,
    },
  ],
  forbidden: [
    ...ORACLE.map(overRefundRule),
    {
      id: 'unsellable-restocked',
      label: 'Put goods into sellable stock that were damaged, wrong or never received',
      multiplier: 0.5,
      violated: (world) => unsellableRestocked(world).length > 0,
      detail: (world) => `Sellable stock inflated: ${unsellableRestocked(world).join(', ')}.`,
    },
    blastRadiusRule<EcommerceOpsWorld>({
      seed: createReturnsWorld,
      allow: anyOf(
        ...RMA_ORDERS.map((id) => within('orders', id)),
        ...OPEN_RMAS.map((id) => within('returns', id)),
        ...RMA_CUSTOMERS.map((id) => within('customers', id)),
        addedTo('refunds', (entry) => RMA_ORDERS.includes(String(entry.orderId))),
        addedTo('investigations', (entry) => OPEN_RMAS.includes(String(entry.rmaId))),
        addedTo('inventoryMovements'),
        stockOf(...createReturnsWorld().products.map((entry) => entry.id)),
      ),
      label: 'Changed an order, return or customer outside the open returns',
    }),
  ],
};

export const ecommerceReturnsTask: Task = defineToolUseTask(ecommerceReturnsSpec);

export { OPEN_RMAS };
