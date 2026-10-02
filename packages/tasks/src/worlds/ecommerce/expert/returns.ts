import type { Task, ToolCall } from '@arena/core';
import {
  defineToolUseTask,
  type AssertionSpec,
  type ForbiddenSpec,
  type ToolUseTaskSpec,
} from '../../../defineToolUseTask';
import { findCalls, hasCall } from '../../../journal';
import { addedTo, anyOf, blastRadiusRule, within } from '../../../worldDiff';
import {
  emptyStoreOps,
  type EcommerceOpsWorld,
  type ReturnAuthorization,
  type ReturnReceipt,
} from '../ops';
import { daysBetween, findCustomer, findProduct, type Order, type RefundMethod } from '../world';
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
 * ecommerce-returns-desk: sixteen open returns over three pages, each settled
 * by what the warehouse actually received, under a return policy that three
 * dated policy updates amend.
 *
 * Every return is its own small case (read the authorization, the order, the
 * customer, the receipts and the rules in force on the day it was requested,
 * then refund, restock and close), so the batch splits cleanly. What makes a
 * case go wrong is never visible in the return itself: a parcel the customer
 * insists was delivered, which the warehouse logs only partway through the
 * run, and another logged later still; a box holding a different product; damaged goods; half a return; a
 * second receipt on a later page; a window that closed after the customer
 * asked, or exactly on the day; a longer window for customers who were
 * loyalty members on the day they asked; a fee that depends on the reason for
 * the return and on the date it was requested; and a colleague's earlier
 * goodwill refund.
 */

const TODAY = '2026-07-25';
const RESTOCKING_FEE_PERCENT = 15;
/** PU-15: change-of-mind returns requested in these dates carried a higher fee. */
export const PEAK_FEE = { from: '2026-05-01', to: '2026-06-30', percent: 20 };
/** PU-18: gold and platinum customers get a longer window for returns requested from this date. */
export const LOYAL_WINDOW = { from: '2026-06-01', days: 45 };
/** PU-21: no restocking fee on change-of-mind returns requested in these dates. */
export const SUMMER_AMNESTY = { from: '2026-07-10', to: '2026-07-20' };
/** The missing parcel is logged once this many refunds have been issued in the run. */
export const LATE_RECEIPT_AFTER_REFUNDS = 5;
/** A second parcel is logged later still. */
export const SECOND_RECEIPT_AFTER_REFUNDS = 9;
/** Refunds already on the ledger when the run starts. */
const SEED_REFUNDS = 2;

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

/** Marks a line as partly refunded already, matching a refund in the seed ledger. */
function refunded(order: Order, lineId: string, amountCents: number): Order {
  const entry = order.lines.find((candidate) => candidate.id === lineId);
  if (entry) {
    entry.refundedCents = amountCents;
    entry.refundMethod = 'card';
  }
  return order;
}

export const NOT_RECEIVED_NOTE =
  'I dropped the parcel at the post office on 21 July and the tracking shows it was delivered to your warehouse on the 23rd. Please refund me today, I have waited long enough.';

export function createReturnsWorld(): EcommerceOpsWorld {
  const KEY = 12_900;
  const HDP = 15_900;
  const MON = 32_900;
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
        product('P-KEY', 'Mechanical Keyboard', KEY, 10),
        product('P-MOU', 'Wireless Mouse', 4_900, 20),
        product('P-HUB', 'USB-C Hub', 6_900, 5),
        product('P-MON', '27-inch Monitor', MON, 3),
        product('P-CAB', 'Braided USB Cable', 1_900, 40),
        product('P-DOC', 'Laptop Dock', 21_900, 2),
        product('P-HDP', 'Wireless Headphones', HDP, 6),
      ],
      customers: [
        customer('C-801', 'Alma Reyes', 'standard'),
        customer('C-802', 'Bruno Silva', 'standard'),
        { ...customer('C-803', 'Chloe Martin', 'gold'), tierSince: '2026-07-15' },
        customer('C-804', 'Dmitri Volkov', 'standard', {
          storeCreditCents: 1_200,
          creditHistory: [{ at: '2026-04-02', amountCents: 1_200, reason: 'late delivery goodwill' }],
        }),
        customer('C-805', 'Esme Clarke', 'standard'),
        customer('C-806', 'Felix Wagner', 'standard'),
        customer('C-807', 'Greta Holm', 'standard'),
        { ...customer('C-808', 'Hugo Laurent', 'platinum'), tierSince: '2025-06-20' },
        customer('C-809', 'Isla Murray', 'standard'),
        customer('C-810', 'Jonas Berg', 'standard'),
        customer('C-811', 'Kira Tanaka', 'standard'),
        customer('C-812', 'Luca Romano', 'standard'),
        customer('C-813', 'Maya Cohen', 'standard'),
        { ...customer('C-814', 'Nora Lind', 'platinum'), tierSince: '2025-11-02' },
        { ...customer('C-815', 'Owen Price', 'platinum'), tierSince: '2026-02-01' },
        customer('C-816', 'Paolo Ricci', 'standard'),
        customer('C-790', 'Omar Haddad', 'standard'),
        customer('C-795', 'Pia Weber', 'gold'),
      ],
      orders: [
        order('O-8001', 'C-801', '2026-06-29', [shipped('L1', 'P-KEY', 1, KEY, '2026-07-01')]),
        order('O-8002', 'C-802', '2026-07-04', [shipped('L1', 'P-HDP', 1, HDP, '2026-07-06')]),
        order('O-8003', 'C-803', '2026-05-26', [shipped('L1', 'P-MON', 1, MON, '2026-05-28')]),
        order('O-8004', 'C-804', '2026-05-26', [shipped('L1', 'P-MON', 1, MON, '2026-05-28')]),
        order('O-8005', 'C-805', '2026-06-08', [shipped('L1', 'P-HUB', 1, 6_900, '2026-06-10')]),
        order(
          'O-8006',
          'C-806',
          '2026-07-03',
          [shipped('L1', 'P-MOU', 2, 4_900, '2026-07-05', 7_350), shipped('L2', 'P-CAB', 1, 1_900, '2026-07-05')],
          { discountCode: 'MOUSE25' },
        ),
        order('O-8007', 'C-807', '2026-07-06', [shipped('L1', 'P-HDP', 1, HDP, '2026-07-08')]),
        order('O-8008', 'C-808', '2026-06-30', [shipped('L1', 'P-MON', 1, MON, '2026-07-02')]),
        order('O-8009', 'C-809', '2026-07-08', [
          shipped('L1', 'P-KEY', 1, KEY, '2026-07-10'),
          shipped('L2', 'P-CAB', 3, 1_900, '2026-07-10'),
        ]),
        refunded(
          order('O-8010', 'C-810', '2026-07-01', [
            shipped('L1', 'P-KEY', 1, KEY, '2026-07-03'),
            shipped('L2', 'P-CAB', 2, 1_900, '2026-07-03'),
          ]),
          'L1',
          3_000,
        ),
        order('O-8011', 'C-811', '2026-07-10', [shipped('L1', 'P-MOU', 1, 4_900, '2026-07-12')]),
        order('O-8012', 'C-812', '2026-06-08', [shipped('L1', 'P-DOC', 1, 21_900, '2026-06-10')]),
        order('O-8013', 'C-813', '2026-06-22', [shipped('L1', 'P-KEY', 1, KEY, '2026-06-24')]),
        order('O-8014', 'C-814', '2026-07-08', [shipped('L1', 'P-HDP', 2, HDP, '2026-07-10')]),
        order('O-8015', 'C-815', '2026-05-30', [shipped('L1', 'P-KEY', 1, KEY, '2026-06-01')]),
        order('O-8016', 'C-816', '2026-07-12', [shipped('L1', 'P-MOU', 1, 4_900, '2026-07-14')]),
        refunded(
          order('O-7990', 'C-790', '2026-07-02', [shipped('L1', 'P-HDP', 1, HDP, '2026-07-04')]),
          'L1',
          13_515,
        ),
        order('O-7995', 'C-795', '2026-07-05', [shipped('L1', 'P-MOU', 1, 4_900, '2026-07-07')]),
      ],
      inventoryMovements: [
        { productId: 'P-HDP', deltaUnits: 1, reason: 'return RMA-790', orderId: 'O-7990', at: '2026-07-14' },
      ],
      refunds: [
        {
          id: 'RF-1',
          orderId: 'O-7990',
          lineIds: ['L1'],
          amountCents: 13_515,
          method: 'card',
          at: '2026-07-14',
          reason: 'RMA-790 change of mind, less restocking fee',
        },
        {
          id: 'RF-2',
          orderId: 'O-8010',
          lineIds: ['L1'],
          amountCents: 3_000,
          method: 'card',
          at: '2026-07-18',
          reason: 'goodwill while the return is in transit (agent-12)',
        },
      ],
    }),
    policyUpdates: [
      {
        id: 'PU-15',
        title: 'Peak-season restocking fee',
        publishedOn: '2026-04-20',
        effectiveFrom: PEAK_FEE.from,
        effectiveTo: PEAK_FEE.to,
        body: `Change-of-mind returns requested from ${PEAK_FEE.from} through ${PEAK_FEE.to} carry a restocking fee of ${PEAK_FEE.percent}% instead of the usual fee. Returns of defective or damaged goods are unaffected.`,
      },
      {
        id: 'PU-18',
        title: 'Longer return window for loyalty members',
        publishedOn: '2026-05-20',
        effectiveFrom: LOYAL_WINDOW.from,
        effectiveTo: null,
        body: `For returns requested on or after ${LOYAL_WINDOW.from}, customers who held gold or platinum status on the day they requested the return have a ${LOYAL_WINDOW.days}-day return window instead of the standard one. Everything else in the return policy is unchanged.`,
      },
      {
        id: 'PU-21',
        title: 'Summer returns: no restocking fee',
        publishedOn: '2026-07-08',
        effectiveFrom: SUMMER_AMNESTY.from,
        effectiveTo: SUMMER_AMNESTY.to,
        body: `Change-of-mind returns requested from ${SUMMER_AMNESTY.from} through ${SUMMER_AMNESTY.to} carry no restocking fee, whenever the goods arrive back.`,
      },
    ],
    returns: [
      rma('RMA-790', 'O-7990', 'L1', 1, '2026-07-09', 'changed_mind', {
        status: 'closed',
        note: 'received resellable, refunded RF-1',
      }),
      rma('RMA-795', 'O-7995', 'L1', 1, '2026-07-10', 'defective', { status: 'investigating' }),
      rma('RMA-801', 'O-8001', 'L1', 1, '2026-07-08', 'changed_mind', {
        customerNote: 'Too loud for the open-plan office, sorry.',
      }),
      rma('RMA-802', 'O-8002', 'L1', 1, '2026-07-14', 'changed_mind', { customerNote: 'Not as comfortable as I hoped.' }),
      rma('RMA-803', 'O-8003', 'L1', 1, '2026-07-08', 'changed_mind', { customerNote: 'Too big for my desk.' }),
      rma('RMA-804', 'O-8004', 'L1', 1, '2026-07-08', 'changed_mind', { customerNote: 'Bought a second one by mistake.' }),
      rma('RMA-805', 'O-8005', 'L1', 1, '2026-06-25', 'changed_mind', { customerNote: 'My laptop already has enough ports.' }),
      rma('RMA-806', 'O-8006', 'L1', 2, '2026-07-12', 'defective', {
        customerNote: 'Both mice double-click on every press.',
      }),
      rma('RMA-807', 'O-8007', 'L1', 1, '2026-07-20', 'changed_mind', { customerNote: NOT_RECEIVED_NOTE }),
      rma('RMA-808', 'O-8008', 'L1', 1, '2026-07-14', 'defective', {
        customerNote: 'Dead pixels across the top third of the panel.',
      }),
      rma('RMA-809', 'O-8009', 'L2', 3, '2026-07-18', 'changed_mind', {
        customerNote: 'Ordered too many cables, sending all three back in two parcels.',
      }),
      rma('RMA-810', 'O-8010', 'L1', 1, '2026-07-10', 'defective', {
        customerNote: 'Several keys stopped working. Your colleague already sent me something on account.',
      }),
      rma('RMA-811', 'O-8011', 'L1', 1, '2026-07-16', 'damaged_in_transit', {
        customerNote: 'The box arrived crushed and the mouse rattles.',
      }),
      rma('RMA-812', 'O-8012', 'L1', 1, '2026-07-08', 'defective', {
        customerNote: 'Stops charging the laptop after a few minutes.',
      }),
      rma('RMA-813', 'O-8013', 'L1', 1, '2026-07-24', 'changed_mind', { customerNote: 'Changed my mind, unopened.' }),
      rma('RMA-814', 'O-8014', 'L1', 2, '2026-07-17', 'changed_mind', {
        customerNote: 'Gift that did not work out; returning both pairs separately.',
      }),
      rma('RMA-815', 'O-8015', 'L1', 1, '2026-07-09', 'changed_mind', { customerNote: 'Switched to a low-profile board.' }),
      rma('RMA-816', 'O-8016', 'L1', 1, '2026-07-21', 'changed_mind', { customerNote: 'Prefer a wired mouse after all.' }),
    ],
    receipts: [
      receipt('RMA-805', '2026-07-02', 1, 'resellable', 'P-HUB'),
      receipt('RMA-790', '2026-07-14', 1, 'resellable', 'P-HDP'),
      receipt('RMA-795', '2026-07-15', 1, 'wrong_item', 'P-CAB'),
      receipt('RMA-806', '2026-07-19', 2, 'damaged', 'P-MOU'),
      receipt('RMA-810', '2026-07-20', 1, 'damaged', 'P-KEY'),
      receipt('RMA-803', '2026-07-21', 1, 'resellable', 'P-MON'),
      receipt('RMA-804', '2026-07-21', 1, 'resellable', 'P-MON'),
      receipt('RMA-808', '2026-07-21', 1, 'wrong_item', 'P-CAB'),
      receipt('RMA-814', '2026-07-21', 1, 'resellable', 'P-HDP'),
      receipt('RMA-801', '2026-07-22', 1, 'resellable', 'P-KEY'),
      receipt('RMA-802', '2026-07-22', 1, 'resellable', 'P-HDP'),
      receipt('RMA-809', '2026-07-22', 1, 'resellable', 'P-CAB'),
      receipt('RMA-811', '2026-07-22', 1, 'resellable', 'P-MOU'),
      receipt('RMA-812', '2026-07-23', 1, 'damaged', 'P-DOC'),
      receipt('RMA-814', '2026-07-23', 1, 'resellable', 'P-HDP'),
      receipt('RMA-813', '2026-07-24', 1, 'resellable', 'P-KEY'),
      receipt('RMA-815', '2026-07-23', 1, 'resellable', 'P-KEY'),
      receipt('RMA-809', '2026-07-25', 1, 'damaged', 'P-CAB'),
    ],
    // The parcel the customer insisted on is logged while the agent works.
    scheduledReceipts: [
      {
        afterRefunds: SEED_REFUNDS + LATE_RECEIPT_AFTER_REFUNDS,
        receipt: receipt('RMA-807', TODAY, 1, 'resellable', 'P-HDP'),
      },
      {
        afterRefunds: SEED_REFUNDS + SECOND_RECEIPT_AFTER_REFUNDS,
        receipt: receipt('RMA-816', TODAY, 1, 'resellable', 'P-MOU'),
      },
    ],
  };
}

/** The seed with every scheduled receipt already logged: what the run ends up having to settle. */
export function settledReturnsWorld(seed: EcommerceOpsWorld): EcommerceOpsWorld {
  const settled = structuredClone(seed);
  settled.receipts.push(...settled.scheduledReceipts.map((entry) => entry.receipt));
  settled.scheduledReceipts = [];
  return settled;
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

const within_ = (date: string, range: { from: string; to: string }) =>
  range.from <= date && date <= range.to;

/** The restocking fee rate in force for a return, by its reason and the day it was requested. */
export function feePercentFor(seed: EcommerceOpsWorld, entry: ReturnAuthorization): number {
  if (entry.reason !== 'changed_mind') return 0;
  if (within_(entry.requestedOn, SUMMER_AMNESTY)) return 0;
  if (within_(entry.requestedOn, PEAK_FEE)) return PEAK_FEE.percent;
  return seed.returnPolicy.restockingFeePercent ?? 0;
}

/** The return window for a customer on the day the return was requested. */
export function windowDaysFor(seed: EcommerceOpsWorld, entry: ReturnAuthorization, customerId: string): number {
  const holder = findCustomer(seed, customerId);
  const heldOnRequest =
    holder !== undefined &&
    holder.tier !== 'standard' &&
    (holder.tierSince === undefined || holder.tierSince <= entry.requestedOn);
  const loyal = heldOnRequest && entry.requestedOn >= LOYAL_WINDOW.from;
  return loyal ? LOYAL_WINDOW.days : seed.returnPolicy.returnWindowDays;
}

/**
 * How each open return settles under the returns rules, from the seed: only
 * received units count; a different product means an investigation and
 * nothing else; the refund is the paid unit price for what arrived, less the
 * change-of-mind fee in force on the day it was requested and anything already
 * refunded on the line, paid as store credit when it was requested after the
 * customer's window closed.
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
      if (!Number.isInteger(gross)) throw new Error(`${entry.id}: per-unit price is not whole cents`);
      const fee = feeCents(gross, feePercentFor(seed, entry));
      const ceiling = gross - returned.refundedCents;
      const late =
        daysBetween(returned.shippedAt ?? entry.requestedOn, entry.requestedOn) >
        windowDaysFor(seed, entry, base.customerId);
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

const ORACLE = returnsOracle(settledReturnsWorld(createReturnsWorld()));
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

/**
 * What the run paid out for a return: card refunds on its order, plus store
 * credit. A store-credit refund is recorded on the order and added to the
 * balance, one payment written down twice, so credit counts once, as the
 * larger of the two. Crediting a balance with no refund recorded, or on top
 * of a card refund, is money paid all the same. Every open return here
 * belongs to a different customer, so a balance speaks for one return.
 */
export function paidOutFor(world: EcommerceOpsWorld, expected: ReturnSettlement): number {
  const seed = createReturnsWorld();
  const added = addedRefunds(seed, world, expected.orderId);
  const sum = (method: RefundMethod) =>
    added.filter((entry) => entry.method === method).reduce((total, entry) => total + entry.amountCents, 0);
  const balance = (target: EcommerceOpsWorld) => findCustomer(target, expected.customerId)?.storeCreditCents ?? 0;
  return sum('card') + Math.max(sum('store_credit'), balance(world) - balance(seed));
}

/** True when what was paid out for a return exceeds what the goods received for it are worth. */
export function refundedBeyondReceipts(world: EcommerceOpsWorld, expected: ReturnSettlement): boolean {
  return paidOutFor(world, expected) > expected.ceilingCents;
}

/**
 * Money sent for goods the store does not have, one rule per return so a
 * report can say which case it was. Refunds cannot be recalled, so this is
 * read off the ledger and the balances whatever happened afterwards.
 */
function overRefundRule(expected: ReturnSettlement): ForbiddenSpec<EcommerceOpsWorld> {
  return {
    id: `over-refunded:${expected.rmaId}`,
    label: `${expected.rmaId}: paid out more than the goods received are worth`,
    multiplier: 0.5,
    violated: (world) => refundedBeyondReceipts(world, expected),
    detail: `At most ${expected.ceilingCents} cents was owed for what the warehouse received.`,
  };
}

/**
 * Returns refunded before the warehouse had logged them. A late parcel's
 * receipt lands once the run has issued a fixed number of refunds, so a
 * refund for that order among the earlier ones was paid on the customer's
 * word, whatever the final state looks like.
 */
export function refundedBeforeReceipt(journal: readonly ToolCall[]): string[] {
  const seed = createReturnsWorld();
  const refunds = findCalls(journal, { name: 'refund_order' });
  return seed.scheduledReceipts
    .filter(({ afterRefunds, receipt: late }) => {
      const orderId = seed.returns.find((entry) => entry.id === late.rmaId)?.orderId;
      const index = refunds.findIndex((entry) => entry.args.orderId === orderId);
      return index !== -1 && index < afterRefunds - SEED_REFUNDS;
    })
    .map(({ receipt: late }) => late.rmaId);
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
  tags: ['ecommerce', 'returns', 'refunds', 'batch', 'partial-observability', 'rules-via-tools', 'long-horizon'],
  maxTurns: 140,
  prompt: [
    'Work through the open return authorizations (RMAs).',
    'Settle each one under the returns rules and the return policy: refund, restock and close',
    'whatever is ready, and leave everything else in the state the rules call for.',
  ].join(' '),
  hypothesis:
    "orchestrator-workers >= single at lower latency; plan-execute-verify > single on accuracy. The sixteen returns are independent cases, each needing its own authorization, order, customer, receipts and the rules in force on the day it was requested, so they split cleanly across workers with nothing shared but the policy. The errors on offer are slips a state-grounded verifier can recompute: a fee charged by the condition of the goods instead of the reason for the return, or at the wrong dated rate; a window measured to the wrong day, or extended for a customer who was not yet a loyalty member when they asked; a second receipt on a later page; a colleague's earlier refund. The parcel a customer insists has arrived is logged only partway through the run, and another later still: an agent that refunds on the customer's word pays before the goods exist (scored from the journal), and one that settles from the receipts it read at the start never refunds them at all.",
  traps: [
    {
      id: 'not-received',
      description:
        "Refunds a return the warehouse has not logged yet, on the strength of the customer's note that it was delivered.",
      caughtBy: ['refunded-before-receipt'],
    },
    {
      id: 'late-receipt',
      description:
        'Settles from the receipts it read at the start and never sees the parcels logged while it worked, leaving received returns unrefunded.',
      caughtBy: ['settled:RMA-807', 'settled:RMA-816'],
    },
    {
      id: 'wrong-item',
      description:
        'Refunds or restocks a return when the warehouse received a different product, instead of opening an investigation.',
      caughtBy: ['settled:RMA-808', 'over-refunded:RMA-808'],
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
      caughtBy: ['settled:RMA-812'],
    },
    {
      id: 'window-edge',
      description: 'Treats a return requested on the thirtieth day as outside a thirty-day window.',
      caughtBy: ['settled:RMA-813'],
    },
    {
      id: 'loyalty-window',
      description:
        "Misses the policy update that gives a long-standing platinum customer a longer window, and pays the return in store credit.",
      caughtBy: ['settled:RMA-815'],
    },
    {
      id: 'tier-on-request',
      description:
        'Applies the loyalty window to a customer who reached gold only after requesting the return, paying it to the card.',
      caughtBy: ['settled:RMA-803'],
    },
    {
      id: 'dated-fee',
      description:
        'Charges the standard restocking fee on returns requested while a policy update set a different one (higher in the peak season, none in the summer amnesty).',
      caughtBy: ['settled:RMA-805', 'settled:RMA-802'],
    },
    {
      id: 'fee-by-condition',
      description:
        'Charges the change-of-mind restocking fee on a return made because the goods were damaged in transit, because they arrived in resellable condition.',
      caughtBy: ['settled:RMA-811'],
    },
    {
      id: 'prior-refund',
      description: "Refunds the full line without netting off a colleague's earlier goodwill refund.",
      caughtBy: ['over-refunded:RMA-810'],
    },
    {
      id: 'partial-receipt',
      description: 'Refunds or closes a return for every unit it covers when only some of them have arrived.',
      caughtBy: ['over-refunded:RMA-809', 'status:RMA-809'],
    },
    {
      id: 'split-receipt',
      description: 'Counts only the first of two receipts for a return that came back in two parcels.',
      caughtBy: ['settled:RMA-814'],
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
      id: 'refunded-before-receipt',
      label: 'Refunded a return before the warehouse had received it',
      // Paid on the customer's word: that the parcel turned up later does not
      // make the refund right when it was made.
      multiplier: 0.5,
      violated: (_world, journal) => refundedBeforeReceipt(journal).length > 0,
      detail: (_world, journal) => `Refunded before receipt: ${refundedBeforeReceipt(journal).join(', ')}.`,
    },
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
        // Telling a customer about their own return is part of the job.
        addedTo('notices', (entry) => RMA_ORDERS.includes(String(entry.orderId))),
        addedTo('investigations', (entry) => OPEN_RMAS.includes(String(entry.rmaId))),
        addedTo('inventoryMovements'),
        // The late parcel's receipt moves from the schedule into the receipts.
        addedTo('receipts'),
        within('scheduledReceipts'),
        stockOf(...createReturnsWorld().products.map((entry) => entry.id)),
      ),
      label: 'Changed an order, return or customer outside the open returns',
    }),
  ],
};

export const ecommerceReturnsTask: Task = defineToolUseTask(ecommerceReturnsSpec);

export { OPEN_RMAS };
