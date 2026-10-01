import type { Task } from '@arena/core';
import {
  defineToolUseTask,
  type AssertionSpec,
  type ToolUseTaskSpec,
} from '../../../defineToolUseTask';
import { addedTo, anyOf, blastRadiusRule, within } from '../../../worldDiff';
import { emptyStoreOps, type EcommerceOpsWorld } from '../ops';
import { findCustomer, findProduct, type Order, type OrderLine } from '../world';
import {
  ECOMMERCE_EXPERT_BASE,
  TIER_RANK,
  customer,
  line,
  order,
  orderOrThrow,
  product,
  stockOf,
} from './common';
import { mentionsDate } from '../../../text';

/**
 * ecommerce-backorder-allocation: seven docks, sixteen wanted.
 *
 * A supplier delivery has to be shared out among ten orders waiting for it,
 * strictly by priority (tier, then order date), whole lines only, with a
 * ship-complete order that cannot take a dock while its hub is missing and an
 * order on risk hold that must not be touched at all. What is left waiting is
 * promised a date by walking the same list over the purchase orders still in
 * transit, so the second half of the task repeats the first against a
 * different supply. Every unit given to the wrong order is a unit some other
 * order should have had: the stock is shared, and the order of allocation is
 * the whole task.
 */

const TODAY = '2026-07-25';
export const BACKORDER_PRODUCT = 'P-DOC';
const RISK_HELD = 'O-5111';

export function createBackorderWorld(): EcommerceOpsWorld {
  const backordered = (id: string, productId: string, quantity: number, unit: number) =>
    line(id, productId, quantity, unit, { status: 'backordered' });
  const DOC = 21_900;

  return {
    ...emptyStoreOps({
      today: TODAY,
      returnPolicy: { returnWindowDays: 30, outOfWindowMethod: 'store_credit', restockOnReceiptOnly: true },
      products: [
        product('P-DOC', 'Laptop Dock', DOC, 7),
        product('P-HUB', 'USB-C Hub', 6_900, 0),
        product('P-KEY', 'Mechanical Keyboard', 12_900, 12),
        product('P-CAB', 'Braided USB Cable', 1_900, 50),
        product('P-MON', '27-inch Monitor', 32_900, 4),
      ],
      customers: [
        customer('C-501', 'Ana Costa', 'standard'),
        customer('C-502', 'Ben Okafor', 'gold'),
        customer('C-503', 'Cara Jensen', 'standard'),
        customer('C-504', 'Dev Patel', 'platinum'),
        customer('C-505', 'Eli Brooks', 'standard'),
        customer('C-506', 'Fay Morgan', 'gold'),
        customer('C-507', 'Gus Lindgren', 'standard'),
        customer('C-508', 'Hana Sato', 'standard'),
        customer('C-509', 'Ivo Petrov', 'platinum'),
        customer('C-511', 'Jon Reyes', 'gold'),
        customer('C-512', 'Kim Novak', 'gold'),
      ],
      orders: [
        order('O-5101', 'C-501', '2026-07-06', [
          backordered('L1', 'P-DOC', 2, DOC),
          line('L2', 'P-CAB', 1, 1_900, { status: 'shipped', shippedAt: '2026-07-07' }),
        ]),
        order('O-5102', 'C-502', '2026-07-08', [backordered('L1', 'P-DOC', 1, DOC)]),
        order('O-5103', 'C-503', '2026-07-09', [
          backordered('L1', 'P-DOC', 1, DOC),
          line('L2', 'P-KEY', 1, 12_900),
        ]),
        order('O-5104', 'C-504', '2026-07-10', [backordered('L1', 'P-DOC', 2, DOC)]),
        order('O-5105', 'C-505', '2026-07-12', [backordered('L1', 'P-DOC', 1, DOC)]),
        order('O-5106', 'C-506', '2026-07-13', [backordered('L1', 'P-DOC', 3, DOC)]),
        order('O-5107', 'C-507', '2026-07-16', [backordered('L1', 'P-DOC', 1, DOC)]),
        order('O-5108', 'C-508', '2026-07-18', [backordered('L1', 'P-DOC', 2, DOC)]),
        order(
          'O-5109',
          'C-509',
          '2026-07-14',
          [
            backordered('L1', 'P-DOC', 1, DOC),
            backordered('L2', 'P-HUB', 1, 6_900),
            line('L3', 'P-CAB', 2, 1_900),
          ],
          { shipComplete: true },
        ),
        order('O-5111', 'C-511', '2026-07-11', [backordered('L1', 'P-DOC', 2, DOC)], {
          riskHold: true,
        }),
        // Allocated from an earlier delivery: already holds its dock.
        order('O-5112', 'C-512', '2026-07-20', [line('L1', 'P-DOC', 1, DOC)]),
        order('O-5113', 'C-504', '2026-07-21', [line('L1', 'P-MON', 1, 32_900)]),
      ],
      inventoryMovements: [
        { productId: 'P-KEY', deltaUnits: 12, reason: 'supplier delivery PO-80', at: '2026-07-02' },
        { productId: 'P-DOC', deltaUnits: 7, reason: 'supplier delivery PO-88', at: TODAY },
      ],
      refunds: [],
    }),
    purchaseOrders: [
      { id: 'PO-80', productId: 'P-KEY', quantity: 12, status: 'received', receivedOn: '2026-07-02' },
      { id: 'PO-88', productId: 'P-DOC', quantity: 7, status: 'received', receivedOn: TODAY },
      { id: 'PO-90', productId: 'P-HUB', quantity: 6, status: 'in_transit', eta: '2026-08-06' },
      { id: 'PO-91', productId: 'P-DOC', quantity: 4, status: 'in_transit', eta: '2026-08-03' },
      { id: 'PO-95', productId: 'P-DOC', quantity: 10, status: 'in_transit', eta: '2026-08-14' },
    ],
  };
}

// ---------------------------------------------------------------------------
// Oracle
// ---------------------------------------------------------------------------

export interface BackorderOutcome {
  orderId: string;
  /** Lines allocated from the received stock. */
  allocated: string[];
  /** Promise date per line left waiting. */
  promised: Record<string, string>;
}

/** Orders waiting for the delivered product, in allocation priority order. */
export function backorderPriority(seed: EcommerceOpsWorld): Order[] {
  const tierOf = (entry: Order) => TIER_RANK[findCustomer(seed, entry.customerId)?.tier ?? 'standard'];
  return seed.orders
    .filter((entry) =>
      entry.lines.some(
        (candidate) => candidate.status === 'backordered' && candidate.productId === BACKORDER_PRODUCT,
      ),
    )
    .sort(
      (a, b) =>
        tierOf(b) - tierOf(a) || a.placedAt.localeCompare(b.placedAt) || a.id.localeCompare(b.id),
    );
}

/**
 * The allocation and the promise dates the rules produce from the seed: walk
 * the priority list against the received stock, whole lines only, a
 * ship-complete order all at once or not at all, risk holds skipped; then walk
 * it again for the lines left waiting against the in-transit purchase orders,
 * earliest arrival first.
 */
export function backorderOracle(seed: EcommerceOpsWorld): BackorderOutcome[] {
  const stock = new Map(seed.products.map((entry) => [entry.id, entry.stock]));
  const inTransit = seed.purchaseOrders
    .filter((po) => po.status === 'in_transit' && po.eta)
    .sort((a, b) => (a.eta ?? '').localeCompare(b.eta ?? ''))
    .map((po) => ({ ...po, left: po.quantity }));
  const fits = (lines: OrderLine[]) => {
    const need = new Map<string, number>();
    for (const entry of lines) need.set(entry.productId, (need.get(entry.productId) ?? 0) + entry.quantity);
    return [...need].every(([productId, quantity]) => (stock.get(productId) ?? 0) >= quantity);
  };
  const take = (entry: OrderLine) =>
    stock.set(entry.productId, (stock.get(entry.productId) ?? 0) - entry.quantity);

  const outcomes: BackorderOutcome[] = [];
  const priority = backorderPriority(seed).filter((entry) => !entry.riskHold);
  for (const entry of priority) {
    const waiting = entry.lines.filter((candidate) => candidate.status === 'backordered');
    const allocated: OrderLine[] = [];
    if (entry.shipComplete) {
      if (fits(waiting)) allocated.push(...waiting);
    } else {
      for (const candidate of waiting) if (fits([candidate])) allocated.push(candidate);
    }
    allocated.forEach(take);
    outcomes.push({ orderId: entry.id, allocated: allocated.map((x) => x.id), promised: {} });
  }

  for (const outcome of outcomes) {
    const entry = priority.find((candidate) => candidate.id === outcome.orderId) as Order;
    const left = entry.lines.filter(
      (candidate) => candidate.status === 'backordered' && !outcome.allocated.includes(candidate.id),
    );
    for (const candidate of left) {
      const po = inTransit.find(
        (supply) => supply.productId === candidate.productId && supply.left >= candidate.quantity,
      );
      if (!po?.eta) throw new Error(`no purchase order can cover ${entry.id}/${candidate.id}`);
      po.left -= candidate.quantity;
      outcome.promised[candidate.id] = po.eta;
    }
    if (entry.shipComplete && left.length > 0) {
      const latest = Object.values(outcome.promised).sort().at(-1) as string;
      for (const id of Object.keys(outcome.promised)) outcome.promised[id] = latest;
    }
  }
  return outcomes;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

const ORACLE = backorderOracle(createBackorderWorld());
const WORKED = ORACLE.map((outcome) => outcome.orderId);
const ALL_BACKORDERS = backorderPriority(createBackorderWorld()).map((entry) => entry.id);

const isAllocated = (entry: OrderLine) => entry.status === 'pending' || entry.status === 'shipped';

function perOrder(outcome: BackorderOutcome): AssertionSpec<EcommerceOpsWorld>[] {
  const { orderId, allocated, promised } = outcome;
  const waitingIds = Object.keys(promised);
  const latest = Object.values(promised).sort().at(-1);
  const assertions: AssertionSpec<EcommerceOpsWorld>[] = [
    {
      id: `outcome:${orderId}`,
      label:
        waitingIds.length === 0
          ? `${orderId} allocated from the delivery`
          : allocated.length === 0
            ? `${orderId} left waiting, with a promise date`
            : `${orderId} partly allocated, the rest waiting with a promise date`,
      weight: 2,
      check: (world) => {
        const current = orderOrThrow(world, orderId);
        const lineOf = (id: string) => current.lines.find((entry) => entry.id === id);
        const allocatedOk = allocated.every((id) => {
          const entry = lineOf(id);
          return entry !== undefined && isAllocated(entry);
        });
        // Waiting is the seed state, so it only counts once the line was worked.
        const waitingOk = waitingIds.every((id) => {
          const entry = lineOf(id);
          return entry?.status === 'backordered' && entry.promisedDate !== undefined;
        });
        return allocatedOk && waitingOk;
      },
      detail: (world) =>
        orderOrThrow(world, orderId)
          .lines.map(
            (entry) => `${entry.id}=${entry.status}${entry.promisedDate ? `@${entry.promisedDate}` : ''}`,
          )
          .join(' '),
    },
  ];
  if (waitingIds.length > 0) {
    assertions.push({
      id: `promised:${orderId}`,
      label: `${orderId} waiting lines promised for the date the in-transit supply gives them`,
      weight: 1,
      check: (world) =>
        waitingIds.every(
          (id) =>
            orderOrThrow(world, orderId).lines.find((entry) => entry.id === id)?.promisedDate ===
            promised[id],
        ),
      detail: () =>
        `expected ${waitingIds.map((id) => `${id}@${promised[id]}`).join(', ')}`,
    });
  }
  assertions.push({
    id: `notified:${orderId}`,
    label:
      latest === undefined
        ? `${orderId}: customer told once that the order is allocated`
        : `${orderId}: customer told once, with the promised date`,
    weight: 0.5,
    check: (world) => {
      const notices = world.notices.filter((entry) => entry.orderId === orderId);
      if (notices.length !== 1) return false;
      return latest === undefined || mentionsDate(notices[0]?.message ?? '', latest);
    },
  });
  return assertions;
}

/**
 * Orders passed over: an eligible order left waiting while orders below it in
 * priority took at least as many units as it needed. In a single pass down the
 * list, whatever is left when an order is skipped is less than it needs, and
 * everything allocated below it comes out of that remainder, so a correct
 * allocation never produces this. Any such order means the order of
 * allocation was wrong. Ship-complete orders may rightly wait with stock on
 * the shelf, so they are never counted as passed over; risk holds have rules
 * of their own.
 */
export function backorderInversions(world: EcommerceOpsWorld): string[] {
  const docLine = (orderId: string) =>
    orderOrThrow(world, orderId).lines.find((entry) => entry.productId === BACKORDER_PRODUCT);
  const ranked = backorderPriority(createBackorderWorld()).filter((entry) => !entry.riskHold);
  const passedOver: string[] = [];
  ranked.forEach((higher, index) => {
    const waiting = docLine(higher.id);
    if (higher.shipComplete || !waiting || waiting.status !== 'backordered') return;
    const takenBelow = ranked
      .slice(index + 1)
      .map((lower) => docLine(lower.id))
      .filter((entry): entry is OrderLine => entry !== undefined && isAllocated(entry))
      .reduce((total, entry) => total + entry.quantity, 0);
    if (takenBelow >= waiting.quantity) {
      passedOver.push(`${higher.id} waited while lower-priority orders took ${takenBelow}`);
    }
  });
  return passedOver;
}

export const ecommerceBackordersSpec: ToolUseTaskSpec<EcommerceOpsWorld> = {
  ...ECOMMERCE_EXPERT_BASE,
  id: 'ecommerce-backorder-allocation',
  title: 'Share a short delivery out among backorders',
  tags: ['ecommerce', 'backorders', 'scarce-resource', 'priority', 'long-horizon'],
  maxTurns: 100,
  prompt: [
    'Purchase order PO-88, seven laptop docks (P-DOC), was received this morning.',
    'Work the dock backorders: allocate the new stock under the backorder rules, give every line',
    'that is still waiting a promise date, and let each customer know where their order stands.',
  ].join(' '),
  hypothesis:
    'single >= propose-select > orchestrator-workers. Seven docks are a shared, scarce resource handed out down one global list (tier, then order date) with two skip rules: whole lines only, and a ship-complete order waits while any of its lines cannot ship. Workers that each take a slice of the backorders allocate in their own local order and race for the same units, inverting priority or starving a later order, while a single agent or a read-only proposer sees the whole list before any unit moves. The promise dates repeat the walk over the in-transit purchase orders, which a state-grounded verifier (plan-execute-verify) can recompute and correct.',
  traps: [
    {
      id: 'date-order',
      description:
        'Allocates in order-date order (first come, first served) instead of tier first, then order date.',
      caughtBy: ['priority-inverted'],
    },
    {
      id: 'stops-at-first-miss',
      description:
        'Stops allocating when the next order needs more docks than are left, leaving a dock on the shelf that a smaller order further down should have had.',
      caughtBy: ['outcome:O-5103', 'stock-used'],
    },
    {
      id: 'ship-complete',
      description:
        'Gives a dock to the ship-complete order even though its hub is still on backorder, taking it from an order that could ship.',
      caughtBy: ['outcome:O-5109'],
    },
    {
      id: 'ship-complete-date',
      description:
        "Promises the ship-complete order's dock for the dock delivery date rather than the date its last line can ship.",
      caughtBy: ['promised:O-5109'],
    },
    {
      id: 'flat-promise-date',
      description:
        'Promises every waiting line for the next delivery, although that delivery cannot cover them all.',
      caughtBy: ['promised:O-5107', 'promised:O-5108'],
    },
    {
      id: 'risk-hold',
      description: 'Allocates to, promises or contacts the order on risk hold.',
      caughtBy: ['risk-hold-allocated', 'risk-hold-worked'],
    },
  ],
  createWorld: createBackorderWorld,
  assertions: [
    ...ORACLE.flatMap(perOrder),
    {
      id: 'stock-used',
      label: 'The whole delivery was allocated',
      weight: 1,
      check: (world) => findProduct(world, BACKORDER_PRODUCT)?.stock === 0,
      detail: (world) => `P-DOC stock=${findProduct(world, BACKORDER_PRODUCT)?.stock}`,
    },
  ],
  forbidden: [
    {
      id: 'priority-inverted',
      label: 'An order waited while lower-priority orders took the docks it needed',
      multiplier: 0.8,
      violated: (world) => backorderInversions(world).length > 0,
      detail: (world) => backorderInversions(world).join('; ') || undefined,
    },
    {
      id: 'risk-hold-allocated',
      label: 'Allocated stock to an order on risk hold',
      multiplier: 0.5,
      violated: (world) =>
        orderOrThrow(world, RISK_HELD).lines.some((entry) => entry.status !== 'backordered'),
    },
    {
      id: 'risk-hold-worked',
      label: 'Promised or contacted an order on risk hold',
      multiplier: 0.8,
      violated: (world) =>
        world.notices.some((entry) => entry.orderId === RISK_HELD) ||
        orderOrThrow(world, RISK_HELD).lines.some((entry) => entry.promisedDate !== undefined),
    },
    blastRadiusRule<EcommerceOpsWorld>({
      seed: createBackorderWorld,
      allow: anyOf(
        ...ALL_BACKORDERS.map((id) => within('orders', id)),
        stockOf(BACKORDER_PRODUCT),
        addedTo('notices', (entry) => ALL_BACKORDERS.includes(String(entry.orderId))),
      ),
      label: 'Changed an order, product or customer outside the dock backorders',
    }),
  ],
};

export const ecommerceBackordersTask: Task = defineToolUseTask(ecommerceBackordersSpec);

export { WORKED as BACKORDER_ORDERS };
