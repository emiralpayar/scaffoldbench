import { callsTo, calledAfter, type Task, type ToolCall } from '@scaffoldbench/core';
import { defineToolUseTask } from '../../defineToolUseTask';
import { addedTo, anyOf, blastRadiusRule, within, type ChangeFilter } from '../../worldDiff';
import { ECOMMERCE_HANDBOOK } from './handbook';
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

/** Stock of a product in a fresh world, so an assertion can say "nothing else moved". */
function seedStock(productId: string): number {
  const stock = findProduct(createEcommerceWorld(), productId)?.stock;
  if (stock === undefined) throw new Error(`product ${productId} is not in the seed`);
  return stock;
}

/** Stock of named products, and movements recorded against them. */
function stockOfProducts(...productIds: string[]): ChangeFilter {
  return anyOf(
    (change) =>
      change.path[0] === 'products' &&
      productIds.includes(change.path[1] ?? '') &&
      change.path[2] === 'stock',
    addedToMovements(productIds),
  );
}

/** Inventory movements are a positional list, so appended rows show up by index. */
function addedToMovements(productIds: readonly string[]): ChangeFilter {
  return (change) =>
    change.kind === 'added' &&
    change.path.length === 2 &&
    change.path[0] === 'inventoryMovements' &&
    typeof change.after === 'object' &&
    change.after !== null &&
    productIds.includes(String((change.after as { productId?: unknown }).productId));
}

/**
 * Collateral-damage rule for one order: everything outside `allow` must still
 * match a fresh seed, whatever the agent did to the order it was asked about.
 */
function orderScope(orderId: string, allow: ChangeFilter) {
  return blastRadiusRule<EcommerceWorld>({
    seed: createEcommerceWorld,
    allow,
    label: `Changed something the request about ${orderId} did not cover`,
  });
}

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
  policy: ECOMMERCE_HANDBOOK,
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
    orderScope(EASY_OPEN_ORDER, within('orders', EASY_OPEN_ORDER, 'shippingAddress')),
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
  policy: ECOMMERCE_HANDBOOK,
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
        stockOf(world, MEDIUM_PRODUCT) === seedStock('P-MOU') + MEDIUM_LINE_QUANTITY &&
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
    orderScope(
      MEDIUM_ORDER,
      anyOf(
        within('orders', MEDIUM_ORDER, 'lines', MEDIUM_LINE),
        within('orders', MEDIUM_ORDER, 'status'),
        addedTo('refunds', (entry) => entry.orderId === MEDIUM_ORDER),
        stockOfProducts(MEDIUM_PRODUCT),
      ),
    ),
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
/** What the two shipped lines are: they are on their way back, not yet received. */
const HARD_SHIPPED_PRODUCTS = ['P-DOC', 'P-MON'];

export const ecommerceHardTask: Task = defineToolUseTask<EcommerceWorld>({
  id: 'ecommerce-hard',
  world: 'ecommerce',
  title: 'Return an expired, partially shipped order',
  prompt: [
    'Priya Raman (customer C-300) has written in about order O-3001: none of it worked out and she wants to send the whole order back.',
    'She has asked for her money back.',
    'Process it end to end — the money, the order record and the warehouse side.',
  ].join(' '),
  policy: ECOMMERCE_HANDBOOK,
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
          stockOf(world, HARD_PENDING_PRODUCT) === seedStock('P-HUB') + HARD_PENDING_QUANTITY &&
          HARD_SHIPPED_PRODUCTS.every((productId) => stockOf(world, productId) === seedStock(productId))
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
    {
      id: 'restocked-unreceived-return',
      label: 'Put returned goods back into stock before the warehouse received them',
      detail: 'Nothing in the system shows the shipped lines arriving back; restocking them invents stock.',
      multiplier: 0.5,
      violated: (world) =>
        HARD_SHIPPED_PRODUCTS.some((productId) => restockedUnits(world, productId) > 0),
    },
    overRefundRule,
    orderScope(
      HARD_ORDER,
      anyOf(
        within('orders', HARD_ORDER),
        addedTo('refunds', (entry) => entry.orderId === HARD_ORDER),
        within('customers', HARD_CUSTOMER, 'storeCreditCents'),
        stockOfProducts(HARD_PENDING_PRODUCT, ...HARD_SHIPPED_PRODUCTS),
      ),
    ),
  ],
});

export const ecommerceTasks: Task[] = [ecommerceEasyTask, ecommerceMediumTask, ecommerceHardTask];
