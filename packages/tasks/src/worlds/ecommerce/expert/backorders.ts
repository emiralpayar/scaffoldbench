import type { Task } from '@arena/core';
import {
  defineToolUseTask,
  type AssertionSpec,
  type ToolUseTaskSpec,
} from '../../../defineToolUseTask';
import { addedTo, anyOf, blastRadiusRule, within } from '../../../worldDiff';
import { emptyStoreOps, type EcommerceOpsWorld } from '../ops';
import { daysBetween, findCustomer, findProduct, type Order, type OrderLine } from '../world';
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
 * ecommerce-backorder-allocation: short deliveries shared out among fifteen
 * orders waiting for them, with two more deliveries arriving mid-run.
 *
 * Seven docks and four monitors go down one priority list, whole lines only,
 * with a ship-complete order that cannot take a dock while its hub is
 * missing, another that can take both its lines, and an order on risk hold
 * that must not be touched. The list is not the handbook's alone: a policy
 * update in force puts orders that have waited two weeks ahead of every
 * tier, and an expired one would put gold beside platinum. (Applying the
 * expired one reorders the list without changing who gets stock or when it
 * is promised for this seed, so it is a distractor, not a scored trap; the
 * tests pin that.) What is left
 * waiting is promised a date by walking the same list over the purchase
 * orders still in transit, two of which are received early, while the
 * agent is allocating. Every unit given to the wrong order is a unit some
 * other order should have had: the stock is shared, and the order of
 * allocation is the whole task.
 */

const TODAY = '2026-07-25';
export const BACKORDER_PRODUCTS = ['P-DOC', 'P-MON'];
const RISK_HELD = 'O-5205';
/** PU-12: orders placed at least this many days before allocation go first. */
export const AGED_AFTER_DAYS = 14;
/** PO-91 is received once this many backordered lines have been allocated. */
export const MID_RUN_DELIVERY_AFTER = 4;
/** PO-93 is received once this many have. */
export const LATE_DELIVERY_AFTER = 10;

export function createBackorderWorld(): EcommerceOpsWorld {
  const backordered = (id: string, productId: string, quantity: number, unit: number) =>
    line(id, productId, quantity, unit, { status: 'backordered' });
  const DOC = 21_900;
  const MON = 32_900;

  return {
    ...emptyStoreOps({
      today: TODAY,
      returnPolicy: { returnWindowDays: 30, outOfWindowMethod: 'store_credit', restockOnReceiptOnly: true },
      products: [
        product('P-DOC', 'Laptop Dock', DOC, 7),
        product('P-MON', '27-inch Monitor', MON, 4),
        product('P-HUB', 'USB-C Hub', 6_900, 0),
        product('P-KEY', 'Mechanical Keyboard', 12_900, 12),
        product('P-CAB', 'Braided USB Cable', 1_900, 50),
      ],
      customers: [
        customer('C-521', 'Ana Costa', 'standard'),
        customer('C-522', 'Ben Okafor', 'gold'),
        customer('C-523', 'Cara Jensen', 'standard'),
        customer('C-524', 'Dev Patel', 'platinum'),
        customer('C-525', 'Jon Reyes', 'standard'),
        customer('C-526', 'Ivo Petrov', 'platinum'),
        customer('C-527', 'Lena Brandt', 'platinum'),
        customer('C-528', 'Fay Morgan', 'gold'),
        customer('C-529', 'Gus Lindgren', 'gold'),
        customer('C-530', 'Hana Sato', 'gold'),
        customer('C-531', 'Eli Brooks', 'standard'),
        customer('C-532', 'Mona Aziz', 'standard'),
        customer('C-533', 'Nils Berg', 'standard'),
        customer('C-534', 'Olga Petrova', 'standard'),
        customer('C-535', 'Paul Kim', 'standard'),
        customer('C-536', 'Kim Novak', 'gold'),
      ],
      orders: [
        order('O-5201', 'C-521', '2026-07-03', [backordered('L1', 'P-DOC', 2, DOC)]),
        order('O-5202', 'C-522', '2026-07-05', [
          backordered('L1', 'P-MON', 1, MON),
          backordered('L2', 'P-DOC', 1, DOC),
        ]),
        order('O-5203', 'C-523', '2026-07-08', [backordered('L1', 'P-MON', 2, MON)]),
        order('O-5204', 'C-524', '2026-07-10', [backordered('L1', 'P-DOC', 2, DOC)]),
        order('O-5205', 'C-525', '2026-07-11', [backordered('L1', 'P-DOC', 1, DOC)], { riskHold: true }),
        order(
          'O-5206',
          'C-526',
          '2026-07-14',
          [
            backordered('L1', 'P-DOC', 1, DOC),
            backordered('L2', 'P-HUB', 1, 6_900),
            line('L3', 'P-CAB', 2, 1_900),
          ],
          { shipComplete: true },
        ),
        order(
          'O-5207',
          'C-527',
          '2026-07-20',
          [backordered('L1', 'P-DOC', 1, DOC), backordered('L2', 'P-MON', 1, MON)],
          { shipComplete: true },
        ),
        order('O-5208', 'C-528', '2026-07-13', [backordered('L1', 'P-MON', 2, MON)]),
        order('O-5209', 'C-529', '2026-07-16', [backordered('L1', 'P-DOC', 2, DOC)]),
        order('O-5210', 'C-530', '2026-07-22', [
          backordered('L1', 'P-DOC', 1, DOC),
          line('L2', 'P-KEY', 1, 12_900),
        ]),
        order('O-5213', 'C-533', '2026-07-18', [backordered('L1', 'P-DOC', 2, DOC)]),
        order('O-5214', 'C-534', '2026-07-21', [backordered('L1', 'P-MON', 1, MON)]),
        order('O-5215', 'C-535', '2026-07-23', [backordered('L1', 'P-DOC', 1, DOC)]),
        // Allocated from an earlier delivery: already holds its dock.
        order('O-5216', 'C-536', '2026-07-20', [line('L1', 'P-DOC', 1, DOC)]),
        // Entered late by the phone team, so they list last.
        order('O-5211', 'C-531', '2026-07-12', [
          backordered('L1', 'P-DOC', 1, DOC),
          line('L2', 'P-CAB', 1, 1_900, { status: 'shipped', shippedAt: '2026-07-13' }),
        ]),
        order('O-5212', 'C-532', '2026-07-15', [backordered('L1', 'P-MON', 1, MON)]),
      ],
      inventoryMovements: [
        { productId: 'P-KEY', deltaUnits: 12, reason: 'supplier delivery PO-80', at: '2026-07-02' },
        { productId: 'P-DOC', deltaUnits: 7, reason: 'supplier delivery PO-88', at: TODAY },
        { productId: 'P-MON', deltaUnits: 4, reason: 'supplier delivery PO-89', at: TODAY },
      ],
      refunds: [],
    }),
    policyUpdates: [
      {
        id: 'PU-9',
        title: 'Loyalty month: gold ranks with platinum for backorders',
        publishedOn: '2026-05-25',
        effectiveFrom: '2026-06-01',
        effectiveTo: '2026-06-30',
        body: 'For stock allocated during June, gold customers rank alongside platinum customers in the backorder priority list. Within that group, the earliest order goes first.',
      },
      {
        id: 'PU-12',
        title: 'Aged backorders go first',
        publishedOn: '2026-06-28',
        effectiveFrom: '2026-07-01',
        effectiveTo: null,
        body: `From 1 July, when stock is allocated, orders placed ${AGED_AFTER_DAYS} or more days before the day of allocation go to the head of the backorder priority list, the oldest order first, whatever the customer's tier. All other orders follow in the order the handbook sets. Whole lines, ship-complete orders and risk holds keep their own rules.`,
      },
    ],
    purchaseOrders: [
      { id: 'PO-80', productId: 'P-KEY', quantity: 12, status: 'received', receivedOn: '2026-07-02' },
      { id: 'PO-88', productId: 'P-DOC', quantity: 7, status: 'received', receivedOn: TODAY },
      { id: 'PO-89', productId: 'P-MON', quantity: 4, status: 'received', receivedOn: TODAY },
      { id: 'PO-90', productId: 'P-HUB', quantity: 6, status: 'in_transit', eta: '2026-08-06' },
      { id: 'PO-91', productId: 'P-DOC', quantity: 4, status: 'in_transit', eta: '2026-08-03' },
      { id: 'PO-93', productId: 'P-MON', quantity: 3, status: 'in_transit', eta: '2026-08-05' },
      { id: 'PO-95', productId: 'P-DOC', quantity: 10, status: 'in_transit', eta: '2026-08-14' },
      { id: 'PO-97', productId: 'P-MON', quantity: 6, status: 'in_transit', eta: '2026-08-19' },
    ],
    // The next dock delivery turns up early, while the agent is allocating,
    // and the next monitor delivery near the end of it.
    scheduledDeliveries: [
      { afterAllocations: MID_RUN_DELIVERY_AFTER, purchaseOrderId: 'PO-91' },
      { afterAllocations: LATE_DELIVERY_AFTER, purchaseOrderId: 'PO-93' },
    ],
  };
}

/**
 * The seed with every scheduled delivery already received: the stock the run
 * ends up having to share out. Allocating in priority order before and after
 * a delivery reaches the same lines as one walk over all of it, because the
 * delivery lands only after the top of the list (whose allocation the walk
 * fixes first either way) has been served; the tests check this for this
 * seed rather than assume it.
 */
export function settledBackorderWorld(seed: EcommerceOpsWorld): EcommerceOpsWorld {
  const settled = structuredClone(seed);
  for (const { purchaseOrderId } of settled.scheduledDeliveries) {
    const po = settled.purchaseOrders.find((entry) => entry.id === purchaseOrderId);
    const stocked = po ? findProduct(settled, po.productId) : undefined;
    if (!po || !stocked) continue;
    po.status = 'received';
    po.receivedOn = settled.today;
    delete po.eta;
    stocked.stock += po.quantity;
  }
  settled.scheduledDeliveries = [];
  return settled;
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

/** True when an order had waited long enough on `today` to go first under PU-12. */
function isAged(seed: EcommerceOpsWorld, entry: Order): boolean {
  return daysBetween(entry.placedAt, seed.today) >= AGED_AFTER_DAYS;
}

/**
 * Orders waiting for a delivered product, in allocation priority order:
 * aged orders first, oldest first (PU-12), then tier, then order date.
 */
export function backorderPriority(seed: EcommerceOpsWorld): Order[] {
  const tierOf = (entry: Order) => TIER_RANK[findCustomer(seed, entry.customerId)?.tier ?? 'standard'];
  const byDate = (a: Order, b: Order) => a.placedAt.localeCompare(b.placedAt) || a.id.localeCompare(b.id);
  const waiting = seed.orders.filter((entry) =>
    entry.lines.some(
      (candidate) => candidate.status === 'backordered' && BACKORDER_PRODUCTS.includes(candidate.productId),
    ),
  );
  const aged = waiting.filter((entry) => isAged(seed, entry)).sort(byDate);
  const rest = waiting
    .filter((entry) => !isAged(seed, entry))
    .sort((a, b) => tierOf(b) - tierOf(a) || byDate(a, b));
  return [...aged, ...rest];
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

const ORACLE = backorderOracle(settledBackorderWorld(createBackorderWorld()));
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
 * Lines passed over: an eligible line left waiting while orders below it in
 * priority took at least as many units of the same product as it needed. In
 * a single pass down the list, whatever is left when a line is skipped is
 * less than it needs, and everything allocated below it comes out of that
 * remainder, so a correct allocation never produces this. Ship-complete
 * orders may rightly wait with stock on the shelf, so they are never counted
 * as passed over; risk holds have rules of their own.
 */
export function backorderInversions(world: EcommerceOpsWorld): string[] {
  const ranked = backorderPriority(createBackorderWorld()).filter((entry) => !entry.riskHold);
  const lineOf = (orderId: string, productId: string) =>
    orderOrThrow(world, orderId).lines.find((entry) => entry.productId === productId);
  const passedOver: string[] = [];
  for (const productId of BACKORDER_PRODUCTS) {
    ranked.forEach((higher, index) => {
      const waiting = lineOf(higher.id, productId);
      if (higher.shipComplete || !waiting || waiting.status !== 'backordered') return;
      const takenBelow = ranked
        .slice(index + 1)
        .map((lower) => lineOf(lower.id, productId))
        .filter((entry): entry is OrderLine => entry !== undefined && isAllocated(entry))
        .reduce((total, entry) => total + entry.quantity, 0);
      if (takenBelow >= waiting.quantity) {
        passedOver.push(`${higher.id} waited for ${productId} while lower-priority orders took ${takenBelow}`);
      }
    });
  }
  return passedOver;
}

export const ecommerceBackordersSpec: ToolUseTaskSpec<EcommerceOpsWorld> = {
  ...ECOMMERCE_EXPERT_BASE,
  id: 'ecommerce-backorder-allocation',
  title: 'Share two short deliveries out among backorders',
  tags: ['ecommerce', 'backorders', 'scarce-resource', 'priority', 'rules-via-tools', 'long-horizon'],
  maxTurns: 120,
  prompt: [
    'Purchase orders PO-88 (seven laptop docks, P-DOC) and PO-89 (four monitors, P-MON) were received this morning.',
    'Work the backorders for both products: allocate the new stock under the backorder rules, give every line',
    'that is still waiting a promise date, and let each customer know where their order stands.',
  ].join(' '),
  hypothesis:
    'single >= propose-select > orchestrator-workers, and plan-execute-verify > plan-execute. Docks and monitors are shared, scarce resources handed out down one global list with two skip rules (whole lines only; a ship-complete order waits while any of its lines cannot ship), and the list itself is set by a policy update in force that puts aged orders ahead of every tier, beside an expired one that would rank gold with platinum. Workers that each take a slice of the backorders allocate in their own local order and race for the same units, inverting priority or starving a later order, while a single agent or a read-only proposer sees the whole list before any unit moves. Two deliveries are received while the agent is allocating, so a plan fixed at the start goes stale: only an agent that re-reads stock (or a state-grounded verifier) allocates them and promises the rest correctly.',
  traps: [
    {
      id: 'aged-first',
      description:
        'Ranks by tier, then order date, as the handbook alone says, missing the policy update in force that puts orders waiting two weeks or more first.',
      caughtBy: ['priority-inverted', 'outcome:O-5201', 'outcome:O-5203'],
    },
    {
      id: 'mid-run-delivery',
      description:
        'Allocates from the plan it made at the start and never notices the dock delivery received while it worked, leaving docks on the shelf and orders waiting.',
      caughtBy: ['outcome:O-5209', 'outcome:O-5211'],
    },
    {
      id: 'late-delivery',
      description:
        'Finishes allocating without checking stock again, and never allocates the monitors received near the end of the run.',
      caughtBy: ['outcome:O-5208', 'outcome:O-5212'],
    },
    {
      id: 'stops-at-first-miss',
      description:
        'Stops allocating when the next order needs more docks than are left, leaving a dock on the shelf that a smaller order further down should have had.',
      // Not stock-used: every unallocated delivery fails that, so it would
      // fire this trap whenever a delivery was missed. O-5215's dock comes
      // from the early delivery, so this still fires alongside
      // mid-run-delivery when that delivery is never allocated.
      caughtBy: ['outcome:O-5215'],
    },
    {
      id: 'ship-complete',
      description:
        'Gives a dock to the ship-complete order whose hub is still on backorder, or holds back the ship-complete order whose lines can all ship.',
      caughtBy: ['outcome:O-5206', 'outcome:O-5207'],
    },
    {
      id: 'ship-complete-date',
      description:
        "Promises the ship-complete order's dock for the dock delivery date rather than the date its last line can ship.",
      caughtBy: ['promised:O-5206'],
    },
    {
      id: 'flat-promise-date',
      description:
        'Promises every waiting line for the next delivery of its product, although that delivery cannot cover them all.',
      caughtBy: ['promised:O-5214'],
    },
    {
      id: 'third-page',
      description:
        'Reads only the first pages of the backorder list and never works the orders on the last one, whose customers are never told where they stand.',
      // The notices, not the outcomes: those two orders are also served by
      // the deliveries that arrive mid-run, so their outcomes fail whenever a
      // delivery is missed, while a notice is sent whatever the allocation.
      caughtBy: ['notified:O-5211', 'notified:O-5212'],
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
      label: 'Both deliveries were allocated in full',
      weight: 1,
      check: (world) => BACKORDER_PRODUCTS.every((id) => findProduct(world, id)?.stock === 0),
      detail: (world) =>
        BACKORDER_PRODUCTS.map((id) => `${id} stock=${findProduct(world, id)?.stock}`).join(', '),
    },
  ],
  forbidden: [
    {
      id: 'priority-inverted',
      label: 'An order waited while lower-priority orders took the units it needed',
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
        stockOf(...BACKORDER_PRODUCTS),
        addedTo('inventoryMovements'),
        within('purchaseOrders', 'PO-91'),
        within('purchaseOrders', 'PO-93'),
        within('scheduledDeliveries'),
        addedTo('notices', (entry) => ALL_BACKORDERS.includes(String(entry.orderId))),
      ),
      label: 'Changed an order, product or customer outside the backorders',
    }),
  ],
};

export const ecommerceBackordersTask: Task = defineToolUseTask(ecommerceBackordersSpec);

export { WORKED as BACKORDER_ORDERS };
