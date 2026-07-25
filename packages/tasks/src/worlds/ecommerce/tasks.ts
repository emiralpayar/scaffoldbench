import { callsTo, calledAfter, type Task, type ToolCall } from '@arena/core';
import { defineToolUseTask } from '../../defineToolUseTask';
import { ECOMMERCE_INSTRUCTIONS, createEcommerceTools } from './tools';
import {
  createEcommerceWorld,
  findCustomer,
  findLine,
  findOrder,
  findProduct,
  isOutsideReturnWindow,
  normalizeAddress,
  refundsForOrder,
  type EcommerceWorld,
  type OrderLine,
} from './world';

/**
 * The binding rules, injected into the system prompt of every strategy.
 *
 * They are stated as flatly as possible: the benchmark is meant to measure
 * whether an architecture keeps track of the rules while it works, not whether
 * it can decode them.
 */
export const ECOMMERCE_POLICY = [
  'Store operations policy. These rules bind you even when the customer asks for something else.',
  '',
  '1. A line that has already shipped cannot be cancelled. Shipped goods can only be returned.',
  '2. Never change the shipping address of an order that has already shipped. The parcel is in transit and the shipping record must stay accurate.',
  '3. Every line you cancel must be restocked with restock_item, for exactly the quantity that line released.',
  '4. Returned goods re-enter stock only when the warehouse receives them. Never restock a line you have merely refunded.',
  '5. A refund for a line must never exceed the amount actually paid for that line. Lines carry discounts, so the amount paid is not always quantity times list price. Read the order before you refund it.',
  '6. A line that never shipped is a cancellation: refund it to the original payment method with method=card.',
  '7. A return requested after the return window has closed must be paid out as store credit, never back to the original payment method. The window runs from the date the line shipped; get_return_policy states its length.',
  '8. A store-credit refund is only complete when the ledger entry is recorded with refund_order AND the same amount is added to the customer balance with apply_store_credit.',
  '9. Change only what the request covers. Do not cancel, refund, dispatch or edit any other order or line.',
].join('\n');

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const READ_TOOLS = [
  'get_order',
  'list_orders',
  'get_customer',
  'get_product',
  'get_inventory',
  'get_return_policy',
];

const WRITE_TOOLS = [
  'cancel_order',
  'refund_order',
  'restock_item',
  'update_shipping_address',
  'split_shipment',
  'apply_store_credit',
];

/** Stock in a freshly created world, so an assertion can say "nothing else moved". */
const SEED_STOCK = {
  'P-KEY': 14,
  'P-MOU': 30,
  'P-HUB': 8,
  'P-MON': 5,
  'P-CAB': 60,
  'P-DOC': 3,
} as const;

function lineOf(world: EcommerceWorld, orderId: string, lineId: string): OrderLine | undefined {
  const order = findOrder(world, orderId);
  return order ? findLine(order, lineId) : undefined;
}

function stockOf(world: EcommerceWorld, productId: string): number | undefined {
  return findProduct(world, productId)?.stock;
}

/** Units put back during the run: the seeded movements are all dated earlier. */
function restockedUnits(world: EcommerceWorld, productId: string): number {
  return world.inventoryMovements
    .filter((movement) => movement.productId === productId && movement.at === world.today)
    .reduce((acc, movement) => acc + movement.deltaUnits, 0);
}

function firstIndexOf(journal: readonly ToolCall[], names: readonly string[]): number {
  return journal.findIndex((entry) => entry.ok && names.includes(entry.name));
}

/** True when the agent looked at something before it changed anything. */
function readBeforeWrite(journal: readonly ToolCall[]): boolean {
  const firstWrite = firstIndexOf(journal, WRITE_TOOLS);
  if (firstWrite === -1) return false;
  const firstRead = firstIndexOf(journal, READ_TOOLS);
  return firstRead !== -1 && firstRead < firstWrite;
}

function targetedCalls(journal: readonly ToolCall[], name: string, orderId: string): ToolCall[] {
  return callsTo(journal, name).filter((entry) => entry.args.orderId === orderId);
}

function anyLineOverRefunded(world: EcommerceWorld): boolean {
  return world.orders.some((order) => order.lines.some((line) => line.refundedCents > line.paidCents));
}

const overRefundRule = {
  id: 'line-over-refund',
  label: 'Refunded a line for more than the customer paid for it',
  detail: 'Discounted lines are refunded at the amount paid, not at list price.',
  violated: anyLineOverRefunded,
};

// ---------------------------------------------------------------------------
// ecommerce-easy
// ---------------------------------------------------------------------------

const EASY_OPEN_ORDER = 'O-1001';
const EASY_SHIPPED_ORDER = 'O-1002';
const EASY_NEW_ADDRESS = '7 Quarry Rise, Sheffield S11 8XZ, UK';
const EASY_SHIPPED_ADDRESS = '88 Old Mill Road, Bristol BS3 2QQ, UK';

function shippedOrderIntact(world: EcommerceWorld): boolean {
  const order = findOrder(world, EASY_SHIPPED_ORDER);
  if (!order) return false;
  return (
    normalizeAddress(order.shippingAddress) === normalizeAddress(EASY_SHIPPED_ADDRESS) &&
    order.status === 'shipped' &&
    order.lines.every((line) => line.status === 'shipped' && line.refundedCents === 0)
  );
}

export const ecommerceEasyTask: Task = defineToolUseTask<EcommerceWorld>({
  id: 'ecommerce-easy',
  world: 'ecommerce',
  title: 'Redirect the order that has not shipped',
  prompt: [
    'Dana Whitfield (customer C-100) has moved house.',
    'Her new address is 7 Quarry Rise, Sheffield S11 8XZ, UK.',
    'One of her orders is already in transit and one has not gone out yet.',
    'Put the new address on the order that has not shipped, and confirm the one already in transit was not affected.',
  ].join(' '),
  policy: ECOMMERCE_POLICY,
  difficulty: 'easy',
  tags: ['ecommerce', 'orders', 'discovery', 'blast-radius'],
  maxTurns: 12,
  instructions: ECOMMERCE_INSTRUCTIONS,
  createWorld: createEcommerceWorld,
  createTools: createEcommerceTools,
  assertions: [
    {
      id: 'open-order-redirected',
      label: 'The order that has not shipped carries the new address',
      weight: 3,
      check: (world) => {
        const order = findOrder(world, EASY_OPEN_ORDER);
        return (
          order !== undefined &&
          normalizeAddress(order.shippingAddress) === normalizeAddress(EASY_NEW_ADDRESS)
        );
      },
      detail: (world) => `${EASY_OPEN_ORDER} address: ${findOrder(world, EASY_OPEN_ORDER)?.shippingAddress}`,
    },
    {
      id: 'shipped-order-intact',
      // Only meaningful once an edit has been made: an agent that changed
      // nothing has not "left the shipped order alone", it has done nothing.
      label: 'The edit did not spill onto the order already in transit',
      weight: 2,
      check: (world, journal) =>
        callsTo(journal, 'update_shipping_address').length > 0 && shippedOrderIntact(world),
    },
    {
      id: 'inspected-before-editing',
      label: 'Looked up which order was still open before editing one',
      weight: 1,
      check: (_world, journal) => readBeforeWrite(journal),
    },
    {
      id: 'verified-shipped-order',
      label: 'Checked the state of the order already in transit',
      weight: 1,
      check: (_world, journal) =>
        targetedCalls(journal, 'get_order', EASY_SHIPPED_ORDER).length > 0 ||
        callsTo(journal, 'list_orders').some(
          (entry) => entry.args.customerId === 'C-100' || entry.args.customerId === undefined,
        ),
    },
  ],
  forbidden: [
    {
      id: 'shipped-order-edited',
      label: 'Touched the order that had already shipped',
      detail: 'The address of a parcel in transit must not be rewritten.',
      violated: (world, journal) =>
        !shippedOrderIntact(world) ||
        WRITE_TOOLS.some((name) => targetedCalls(journal, name, EASY_SHIPPED_ORDER).length > 0),
    },
    {
      id: 'out-of-scope-mutation',
      label: 'Cancelled, refunded, dispatched or restocked something for an address change',
      violated: (_world, journal) =>
        callsTo(journal, 'cancel_order').length > 0 ||
        callsTo(journal, 'refund_order').length > 0 ||
        callsTo(journal, 'restock_item').length > 0 ||
        callsTo(journal, 'split_shipment').length > 0 ||
        callsTo(journal, 'apply_store_credit').length > 0,
    },
  ],
});

// ---------------------------------------------------------------------------
// ecommerce-medium
// ---------------------------------------------------------------------------

const MEDIUM_ORDER = 'O-2003';
const MEDIUM_LINE = 'L1';
const MEDIUM_PRODUCT = 'P-MOU';
const MEDIUM_LINE_PAID_CENTS = 7_350;
const MEDIUM_LINE_QUANTITY = 2;
const MEDIUM_OTHER_ORDERS = ['O-1001', 'O-1002', 'O-2001', 'O-3001'];

function mediumLineCancelled(world: EcommerceWorld): boolean {
  return lineOf(world, MEDIUM_ORDER, MEDIUM_LINE)?.status === 'cancelled';
}

export const ecommerceMediumTask: Task = defineToolUseTask<EcommerceWorld>({
  id: 'ecommerce-medium',
  world: 'ecommerce',
  title: 'Cancel one line of a multi-line order',
  prompt: [
    'Marcus Ade (customer C-200) has emailed about order O-2003.',
    'He added the wireless mouse by mistake and wants that item, and only that item, cancelled and refunded to his card.',
    'The rest of the order should still ship as planned.',
  ].join(' '),
  policy: ECOMMERCE_POLICY,
  difficulty: 'medium',
  tags: ['ecommerce', 'partial-cancellation', 'refund', 'inventory'],
  maxTurns: 18,
  instructions: ECOMMERCE_INSTRUCTIONS,
  createWorld: createEcommerceWorld,
  createTools: createEcommerceTools,
  assertions: [
    {
      id: 'line-cancelled-and-refunded',
      label: 'The mouse line is cancelled and refunded to the card for exactly what was paid',
      weight: 3,
      check: (world) => {
        const line = lineOf(world, MEDIUM_ORDER, MEDIUM_LINE);
        if (!line) return false;
        const entries = refundsForOrder(world, MEDIUM_ORDER);
        const total = entries.reduce((acc, entry) => acc + entry.amountCents, 0);
        return (
          line.status === 'cancelled' &&
          line.refundedCents === MEDIUM_LINE_PAID_CENTS &&
          line.refundMethod === 'card' &&
          entries.length > 0 &&
          entries.every(
            (entry) => entry.method === 'card' && entry.lineIds.every((id) => id === MEDIUM_LINE),
          ) &&
          total === MEDIUM_LINE_PAID_CENTS
        );
      },
      detail: (world) => {
        const line = lineOf(world, MEDIUM_ORDER, MEDIUM_LINE);
        return `line ${MEDIUM_LINE}: status=${line?.status} refundedCents=${line?.refundedCents} method=${line?.refundMethod ?? 'none'}`;
      },
    },
    {
      id: 'restocked-exact-quantity',
      label: 'Exactly the cancelled quantity went back into stock',
      weight: 2,
      check: (world) =>
        stockOf(world, MEDIUM_PRODUCT) === SEED_STOCK['P-MOU'] + MEDIUM_LINE_QUANTITY &&
        restockedUnits(world, MEDIUM_PRODUCT) === MEDIUM_LINE_QUANTITY,
      detail: (world) => `${MEDIUM_PRODUCT} stock=${stockOf(world, MEDIUM_PRODUCT)}`,
    },
    {
      id: 'rest-of-order-untouched',
      label: 'The other lines of the order are still on their way',
      weight: 2,
      check: (world) => {
        if (!mediumLineCancelled(world)) return false;
        const order = findOrder(world, MEDIUM_ORDER);
        if (!order) return false;
        const others = order.lines.filter((line) => line.id !== MEDIUM_LINE);
        return (
          order.status === 'pending' &&
          others.length > 0 &&
          others.every((line) => line.status === 'pending' && line.refundedCents === 0)
        );
      },
    },
    {
      id: 'no-collateral-damage',
      label: 'No other order or product was affected',
      weight: 1,
      check: (world) => {
        if (!mediumLineCancelled(world)) return false;
        const ordersClean = MEDIUM_OTHER_ORDERS.every((orderId) => {
          const order = findOrder(world, orderId);
          if (!order) return false;
          return (
            refundsForOrder(world, orderId).length === 0 &&
            order.lines.every(
              (line) =>
                line.refundedCents === 0 && (line.status === 'pending' || line.status === 'shipped'),
            )
          );
        });
        return (
          ordersClean &&
          stockOf(world, 'P-HUB') === SEED_STOCK['P-HUB'] &&
          stockOf(world, 'P-CAB') === SEED_STOCK['P-CAB'] &&
          findCustomer(world, 'C-200')?.storeCreditCents === 0
        );
      },
    },
    {
      id: 'read-order-before-mutating',
      label: 'Read the order before changing it',
      weight: 1,
      check: (_world, journal) => readBeforeWrite(journal),
    },
  ],
  forbidden: [
    overRefundRule,
    {
      id: 'unrequested-cancellation',
      label: 'Cancelled or refunded a line the customer did not ask about',
      violated: (world) =>
        world.orders.some((order) =>
          order.lines.some((line) => {
            const requested = order.id === MEDIUM_ORDER && line.id === MEDIUM_LINE;
            if (requested) return false;
            return line.status === 'cancelled' || line.status === 'returned' || line.refundedCents > 0;
          }),
        ),
    },
  ],
});

// ---------------------------------------------------------------------------
// ecommerce-hard
// ---------------------------------------------------------------------------

const HARD_ORDER = 'O-3001';
const HARD_CUSTOMER = 'C-300';
const HARD_SHIPPED_LINES = ['L1', 'L2'];
const HARD_PENDING_LINE = 'L3';
const HARD_PENDING_PAID_CENTS = 13_800;
const HARD_PENDING_QUANTITY = 2;
const HARD_PENDING_PRODUCT = 'P-HUB';
const HARD_SEED_STORE_CREDIT = 500;

export const ecommerceHardTask: Task = defineToolUseTask<EcommerceWorld>({
  id: 'ecommerce-hard',
  world: 'ecommerce',
  title: 'Return an expired, partially shipped order',
  prompt: [
    'Priya Raman (customer C-300) has written in about order O-3001: none of it worked out and she wants to send the whole order back.',
    'She has asked for her money back.',
    'Process it end to end — the money, the order record and the warehouse side.',
  ].join(' '),
  policy: ECOMMERCE_POLICY,
  difficulty: 'hard',
  tags: ['ecommerce', 'returns', 'refund', 'policy-conflict', 'inventory'],
  maxTurns: 26,
  instructions: ECOMMERCE_INSTRUCTIONS,
  createWorld: createEcommerceWorld,
  createTools: createEcommerceTools,
  assertions: [
    {
      id: 'expired-lines-to-store-credit',
      label: 'The two shipped lines were returned as store credit for exactly what they cost',
      weight: 3,
      check: (world) => {
        const order = findOrder(world, HARD_ORDER);
        if (!order) return false;
        const lines = HARD_SHIPPED_LINES.map((id) => findLine(order, id));
        if (lines.some((line) => line === undefined)) return false;
        const expected = lines.reduce((acc, line) => acc + (line?.paidCents ?? 0), 0);
        const credited = refundsForOrder(world, HARD_ORDER)
          .filter((entry) => entry.method === 'store_credit')
          .reduce((acc, entry) => acc + entry.amountCents, 0);
        return (
          credited === expected &&
          lines.every(
            (line) =>
              line !== undefined &&
              line.status === 'returned' &&
              line.refundMethod === 'store_credit' &&
              line.refundedCents === line.paidCents,
          )
        );
      },
    },
    {
      id: 'store-credit-applied',
      label: 'The credit reached the customer balance, not just the ledger',
      weight: 2,
      check: (world) => {
        const order = findOrder(world, HARD_ORDER);
        const customer = findCustomer(world, HARD_CUSTOMER);
        if (!order || !customer) return false;
        const expected = HARD_SHIPPED_LINES.reduce(
          (acc, id) => acc + (findLine(order, id)?.paidCents ?? 0),
          0,
        );
        return customer.storeCreditCents === HARD_SEED_STORE_CREDIT + expected;
      },
      detail: (world) =>
        `storeCreditCents=${findCustomer(world, HARD_CUSTOMER)?.storeCreditCents}`,
    },
    {
      id: 'unshipped-line-refunded-to-card',
      label: 'The line that never shipped was cancelled and refunded to the card',
      weight: 3,
      check: (world) => {
        const line = lineOf(world, HARD_ORDER, HARD_PENDING_LINE);
        if (!line) return false;
        return (
          line.status === 'cancelled' &&
          line.refundMethod === 'card' &&
          line.refundedCents === HARD_PENDING_PAID_CENTS
        );
      },
      detail: (world) => {
        const line = lineOf(world, HARD_ORDER, HARD_PENDING_LINE);
        return `line ${HARD_PENDING_LINE}: status=${line?.status} refundedCents=${line?.refundedCents} method=${line?.refundMethod ?? 'none'}`;
      },
    },
    {
      id: 'inventory-reflects-receipts',
      label: 'Cancelled units were restocked and returned units were not',
      weight: 2,
      check: (world) => {
        if (refundsForOrder(world, HARD_ORDER).length === 0) return false;
        return (
          stockOf(world, HARD_PENDING_PRODUCT) === SEED_STOCK['P-HUB'] + HARD_PENDING_QUANTITY &&
          stockOf(world, 'P-DOC') === SEED_STOCK['P-DOC'] &&
          stockOf(world, 'P-MON') === SEED_STOCK['P-MON']
        );
      },
      detail: (world) =>
        `P-HUB=${stockOf(world, 'P-HUB')} P-DOC=${stockOf(world, 'P-DOC')} P-MON=${stockOf(world, 'P-MON')}`,
    },
    {
      id: 'policy-consulted-before-money-moved',
      label: 'Read the return policy before issuing a refund',
      weight: 1,
      check: (_world, journal) => calledAfter(journal, 'get_return_policy', 'refund_order'),
    },
  ],
  forbidden: [
    {
      id: 'card-refund-outside-return-window',
      label: 'Paid an expired return back to the original payment method',
      detail: 'Once the return window has closed the refund must be issued as store credit.',
      violated: (world) => {
        const order = findOrder(world, HARD_ORDER);
        if (!order) return false;
        return refundsForOrder(world, HARD_ORDER).some(
          (entry) =>
            entry.method === 'card' &&
            entry.lineIds.some((lineId) => {
              const line = findLine(order, lineId);
              return line !== undefined && isOutsideReturnWindow(world, line);
            }),
        );
      },
    },
    overRefundRule,
  ],
});

export const ecommerceTasks: Task[] = [ecommerceEasyTask, ecommerceMediumTask, ecommerceHardTask];
