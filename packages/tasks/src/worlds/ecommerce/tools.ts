import { z } from 'zod';
import type { JournaledToolSpec, ToolReply } from '@arena/core';
import {
  daysSinceShipped,
  findCustomer,
  findLine,
  findOrder,
  findProduct,
  ordersOfCustomer,
  recomputeOrderStatus,
  refundedTotal,
  refundsForOrder,
  type EcommerceWorld,
  type Order,
  type OrderLine,
  type RefundLedgerEntry,
  type RefundMethod,
} from './world';

export const ECOMMERCE_INSTRUCTIONS = [
  'Back-office order management for an online store.',
  'All money is in integer cents. Ids are exact and case-sensitive.',
  'Nothing cascades: cancelling a line does not restock it, and refunding store credit does not',
  'add it to the customer balance. Each step is its own call.',
].join(' ');

/**
 * The store's tool surface.
 *
 * The handlers refuse what a real API would refuse — unknown ids, refunding a
 * line that is still pending, refunding an order twice over — but they do not
 * refuse a *policy* mistake. Editing a shipped order's address, refunding a
 * line for more than it was paid and paying an expired return back to the card
 * are all allowed here on purpose: the point of the benchmark is to see which
 * architectures avoid them, which cannot be measured if the API blocks them.
 */
export function createEcommerceTools(world: EcommerceWorld): JournaledToolSpec[] {
  return [
    {
      name: 'get_order',
      description:
        'Read one order: status, shipping address, what was paid, and every line with its quantity, the amount actually paid for it, its shipping date and any refund already issued.',
      schema: { orderId: z.string() },
      readOnly: true,
      handler: (args: { orderId?: unknown }) => {
        const orderId = readString(args.orderId);
        if (!orderId) return fail('orderId is required');
        const order = findOrder(world, orderId);
        if (!order) return fail(unknownOrder(world, orderId));
        return formatOrder(world, order);
      },
    },
    {
      name: 'list_orders',
      description:
        'List orders, optionally filtered by customerId and/or status (pending, partially_shipped, shipped, returned, cancelled). Use it to find which of a customer orders is still open.',
      schema: { customerId: z.string().optional(), status: z.string().optional() },
      readOnly: true,
      handler: (args: { customerId?: unknown; status?: unknown }) => {
        const customerId = readString(args.customerId);
        const status = readString(args.status);
        if (customerId && !findCustomer(world, customerId)) {
          return fail(unknownCustomer(world, customerId));
        }
        if (status && !ORDER_STATUSES.includes(status)) {
          return fail(`unknown status "${status}". Valid statuses: ${ORDER_STATUSES.join(', ')}`);
        }

        const matches = world.orders.filter(
          (order) =>
            (!customerId || order.customerId === customerId) && (!status || order.status === status),
        );
        if (matches.length === 0) return 'no orders match this filter';

        return [
          `${matches.length} order(s), today=${world.today}`,
          ...matches.map(
            (order) =>
              `${order.id} customer=${order.customerId} status=${order.status} placedAt=${order.placedAt} lines=${order.lines.length} paidCents=${order.paidCents} refundedCents=${refundedTotal(world, order.id)}`,
          ),
        ].join('\n');
      },
    },
    {
      name: 'get_product',
      description: 'Read a product: its current list price and how many units are in stock.',
      schema: { productId: z.string() },
      readOnly: true,
      handler: (args: { productId?: unknown }) => {
        const productId = readString(args.productId);
        if (!productId) return fail('productId is required');
        const product = findProduct(world, productId);
        if (!product) return fail(unknownProduct(world, productId));
        return `product ${product.id} name="${product.name}" priceCents=${product.priceCents} stock=${product.stock}`;
      },
    },
    {
      name: 'get_customer',
      description:
        'Read a customer: loyalty tier, current store credit balance in cents, and the ids of their orders.',
      schema: { customerId: z.string() },
      readOnly: true,
      handler: (args: { customerId?: unknown }) => {
        const customerId = readString(args.customerId);
        if (!customerId) return fail('customerId is required');
        const customer = findCustomer(world, customerId);
        if (!customer) return fail(unknownCustomer(world, customerId));
        const orders = ordersOfCustomer(world, customer.id).map((order) => order.id);
        return `customer ${customer.id} name="${customer.name}" tier=${customer.tier} storeCreditCents=${customer.storeCreditCents} orders=${orders.join(',') || 'none'}`;
      },
    },
    {
      name: 'get_return_policy',
      description:
        'Read the return policy: how long the return window is, how it is measured, and how refunds must be paid out once it has closed.',
      schema: {},
      readOnly: true,
      handler: () => {
        const policy = world.returnPolicy;
        return [
          `today=${world.today}`,
          `returnWindowDays=${policy.returnWindowDays}`,
          'The window is measured from the date a line shipped, not from the order date.',
          `A return requested more than ${policy.returnWindowDays} days after the line shipped must be paid out as ${policy.outOfWindowMethod}, never back to the original payment method.`,
          'A line that never shipped is a cancellation, not a return: it is refunded to the original payment method (method=card) whatever the age of the order.',
          'A refund for a line may never exceed the amount actually paid for that line.',
          policy.restockOnReceiptOnly
            ? 'Returned goods re-enter stock only once the warehouse receives them. Cancelled goods never left, so they are restocked immediately.'
            : 'Returned goods re-enter stock as soon as the refund is issued.',
        ].join('\n');
      },
    },
    {
      name: 'get_inventory',
      description:
        'Read stock levels and recent inventory movements, for one product or for all of them.',
      schema: { productId: z.string().optional() },
      readOnly: true,
      handler: (args: { productId?: unknown }) => {
        const productId = readString(args.productId);
        if (productId && !findProduct(world, productId)) {
          return fail(unknownProduct(world, productId));
        }
        const products = productId
          ? world.products.filter((product) => product.id === productId)
          : world.products;
        const movements = world.inventoryMovements.filter(
          (movement) => !productId || movement.productId === productId,
        );
        return [
          'stock:',
          ...products.map((product) => `  ${product.id} name="${product.name}" stock=${product.stock}`),
          `movements (${movements.length}):`,
          ...movements.map(
            (movement) =>
              `  ${movement.at} ${movement.productId} delta=${movement.deltaUnits >= 0 ? '+' : ''}${movement.deltaUnits} reason="${movement.reason}"${movement.orderId ? ` order=${movement.orderId}` : ''}`,
          ),
        ].join('\n');
      },
    },

    // -----------------------------------------------------------------------
    // Mutations
    // -----------------------------------------------------------------------

    {
      name: 'cancel_order',
      description:
        'Cancel lines that have not shipped. Give lineIds to cancel specific lines, or omit it to cancel every line on the order. Does not refund and does not restock: those are separate calls.',
      schema: {
        orderId: z.string(),
        lineIds: z.array(z.string()).optional(),
        reason: z.string().optional(),
      },
      handler: (args: { orderId?: unknown; lineIds?: unknown; reason?: unknown }) => {
        const orderId = readString(args.orderId);
        if (!orderId) return fail('orderId is required');
        const order = findOrder(world, orderId);
        if (!order) return fail(unknownOrder(world, orderId));

        const namesLines = args.lineIds !== undefined && args.lineIds !== null;
        const lineIds = readStringArray(args.lineIds);
        if (namesLines && lineIds.length === 0) {
          return fail(
            'lineIds must name at least one line id, or be omitted to cancel the whole order',
          );
        }

        let targets: OrderLine[];
        if (namesLines) {
          const resolved: OrderLine[] = [];
          for (const lineId of lineIds) {
            const line = findLine(order, lineId);
            if (!line) return fail(unknownLine(order, lineId));
            resolved.push(line);
          }
          targets = resolved;
        } else {
          const dispatched = order.lines.filter(
            (line) => line.status === 'shipped' || line.status === 'returned',
          );
          if (dispatched.length > 0) {
            return fail(
              `order ${order.id} has lines that already shipped (${dispatched.map((line) => line.id).join(', ')}). Shipped goods cannot be cancelled, only returned. Name the lines that have not shipped in lineIds.`,
            );
          }
          targets = order.lines.filter((line) => line.status === 'pending');
        }

        for (const line of targets) {
          if (line.status !== 'pending') {
            return fail(
              `line ${line.id} on order ${order.id} has status ${line.status} and cannot be cancelled. Shipped goods can only be returned.`,
            );
          }
        }
        if (targets.length === 0) return fail(`order ${order.id} has no line left to cancel`);

        for (const line of targets) line.status = 'cancelled';
        order.status = recomputeOrderStatus(order);

        const released = new Map<string, number>();
        for (const line of targets) {
          released.set(line.productId, (released.get(line.productId) ?? 0) + line.quantity);
        }
        const paid = targets.reduce((acc, line) => acc + line.paidCents, 0);

        return [
          `cancelled ${targets.length} line(s) on order ${order.id}${readString(args.reason) ? ` (reason: ${readString(args.reason)})` : ''}`,
          ...targets.map(
            (line) =>
              `  ${line.id} product=${line.productId} qty=${line.quantity} paidCents=${line.paidCents}`,
          ),
          `order ${order.id} status is now ${order.status}`,
          `released, awaiting restock: ${[...released].map(([productId, qty]) => `${productId} x${qty}`).join(', ')} — call restock_item for each`,
          `no money moved: use refund_order for the amount actually paid for these lines (${paid} cents in total)`,
        ].join('\n');
      },
    },
    {
      name: 'refund_order',
      description:
        'Refund named lines of an order. amountCents is the total for those lines and is split across them in proportion to what each one paid. method=card returns the money to the original payment method, method=store_credit only records the ledger entry — apply_store_credit still has to add it to the balance. A line must be cancelled or shipped before it can be refunded.',
      schema: {
        orderId: z.string(),
        lineIds: z.array(z.string()).min(1),
        amountCents: z.number().int().positive(),
        method: z.enum(['card', 'store_credit']),
        reason: z.string().optional(),
      },
      handler: (args: {
        orderId?: unknown;
        lineIds?: unknown;
        amountCents?: unknown;
        method?: unknown;
        reason?: unknown;
      }) => {
        const orderId = readString(args.orderId);
        if (!orderId) return fail('orderId is required');
        const order = findOrder(world, orderId);
        if (!order) return fail(unknownOrder(world, orderId));

        const lineIds = readStringArray(args.lineIds);
        if (lineIds.length === 0) return fail('lineIds must name at least one line id');

        const rawMethod = readString(args.method);
        if (rawMethod !== 'card' && rawMethod !== 'store_credit') {
          return fail('method must be either "card" or "store_credit"');
        }
        const method: RefundMethod = rawMethod;

        const amountCents = readInt(args.amountCents);
        if (amountCents === undefined || amountCents <= 0) {
          return fail('amountCents must be a positive whole number of cents');
        }

        const targets: OrderLine[] = [];
        for (const lineId of lineIds) {
          const line = findLine(order, lineId);
          if (!line) return fail(unknownLine(order, lineId));
          if (line.status === 'pending') {
            return fail(
              `line ${line.id} on order ${order.id} is still pending. Cancel it with cancel_order before refunding it.`,
            );
          }
          if (line.refundedCents > 0) {
            return fail(
              `line ${line.id} on order ${order.id} has already been refunded (${line.refundedCents} cents via ${line.refundMethod}).`,
            );
          }
          targets.push(line);
        }

        const alreadyRefunded = refundedTotal(world, order.id);
        if (alreadyRefunded + amountCents > order.paidCents) {
          return fail(
            `refusing to refund ${amountCents} cents: order ${order.id} was paid ${order.paidCents} cents and ${alreadyRefunded} has already been refunded.`,
          );
        }

        allocateRefund(targets, amountCents, method);
        for (const line of targets) {
          if (line.status === 'shipped') line.status = 'returned';
        }

        const entry: RefundLedgerEntry = {
          id: `RF-${world.refunds.length + 1}`,
          orderId: order.id,
          lineIds: targets.map((line) => line.id),
          amountCents,
          method,
          at: world.today,
          ...(readString(args.reason) ? { reason: readString(args.reason) } : {}),
        };
        world.refunds.push(entry);
        order.status = recomputeOrderStatus(order);

        const lines = [
          `refund ${entry.id} recorded on order ${order.id}: lines=${entry.lineIds.join(',')} amountCents=${amountCents} method=${method}`,
          ...targets.map(
            (line) =>
              `  ${line.id} paidCents=${line.paidCents} refundedCents=${line.refundedCents} status=${line.status}`,
          ),
          `order ${order.id} refunded ${refundedTotal(world, order.id)} of ${order.paidCents} cents paid, status is now ${order.status}`,
        ];
        if (method === 'store_credit') {
          lines.push(
            `store credit is recorded in the ledger only — customer ${order.customerId} balance is unchanged. Call apply_store_credit for ${amountCents} cents to complete it.`,
          );
        }
        return lines.join('\n');
      },
    },
    {
      name: 'restock_item',
      description:
        'Put units of a product back into stock and record an inventory movement. Use it for goods that never left the warehouse, or for a return the warehouse has actually received.',
      schema: {
        productId: z.string(),
        quantity: z.number().int().positive(),
        orderId: z.string().optional(),
        reason: z.string().optional(),
      },
      handler: (args: {
        productId?: unknown;
        quantity?: unknown;
        orderId?: unknown;
        reason?: unknown;
      }) => {
        const productId = readString(args.productId);
        if (!productId) return fail('productId is required');
        const product = findProduct(world, productId);
        if (!product) return fail(unknownProduct(world, productId));

        const quantity = readInt(args.quantity);
        if (quantity === undefined || quantity <= 0) {
          return fail('quantity must be a positive whole number of units');
        }

        const orderId = readString(args.orderId);
        if (orderId && !findOrder(world, orderId)) return fail(unknownOrder(world, orderId));

        const before = product.stock;
        product.stock += quantity;
        const reason = readString(args.reason) || 'restock';
        world.inventoryMovements.push({
          productId: product.id,
          deltaUnits: quantity,
          reason,
          ...(orderId ? { orderId } : {}),
          at: world.today,
        });

        return `product ${product.id} stock ${before} -> ${product.stock} (+${quantity}), movement recorded (reason="${reason}"${orderId ? `, order=${orderId}` : ''})`;
      },
    },
    {
      name: 'update_shipping_address',
      description:
        'Overwrite the shipping address of an order. The reply states the order status so you can tell whether the parcel has already left.',
      schema: { orderId: z.string(), address: z.string() },
      handler: (args: { orderId?: unknown; address?: unknown }) => {
        const orderId = readString(args.orderId);
        if (!orderId) return fail('orderId is required');
        const order = findOrder(world, orderId);
        if (!order) return fail(unknownOrder(world, orderId));

        const address = readString(args.address);
        if (!address) return fail('address is required and cannot be empty');

        const before = order.shippingAddress;
        order.shippingAddress = address;
        return [
          `order ${order.id} shippingAddress updated`,
          `  from: ${before}`,
          `  to:   ${order.shippingAddress}`,
          `order status=${order.status}`,
        ].join('\n');
      },
    },
    {
      name: 'split_shipment',
      description:
        'Dispatch part of an order now: marks the named lines as shipped today and leaves the rest of the order pending. Only lines that have not shipped can be dispatched.',
      schema: { orderId: z.string(), lineIds: z.array(z.string()).min(1) },
      handler: (args: { orderId?: unknown; lineIds?: unknown }) => {
        const orderId = readString(args.orderId);
        if (!orderId) return fail('orderId is required');
        const order = findOrder(world, orderId);
        if (!order) return fail(unknownOrder(world, orderId));

        const lineIds = readStringArray(args.lineIds);
        if (lineIds.length === 0) return fail('lineIds must name at least one line id');

        const targets: OrderLine[] = [];
        for (const lineId of lineIds) {
          const line = findLine(order, lineId);
          if (!line) return fail(unknownLine(order, lineId));
          if (line.status !== 'pending') {
            return fail(
              `line ${line.id} on order ${order.id} has status ${line.status} and cannot be dispatched`,
            );
          }
          targets.push(line);
        }

        for (const line of targets) {
          line.status = 'shipped';
          line.shippedAt = world.today;
        }
        order.status = recomputeOrderStatus(order);

        const remaining = order.lines.filter((line) => line.status === 'pending');
        return [
          `order ${order.id}: dispatched ${targets.length} line(s) on ${world.today} — ${targets.map((line) => `${line.id} (${line.productId} x${line.quantity})`).join(', ')}`,
          `still pending: ${remaining.map((line) => line.id).join(', ') || 'none'}`,
          `order ${order.id} status is now ${order.status}`,
        ].join('\n');
      },
    },
    {
      name: 'apply_store_credit',
      description:
        'Add store credit to a customer balance. This is the step that actually gives the customer the money after a store-credit refund has been recorded with refund_order.',
      schema: {
        customerId: z.string(),
        amountCents: z.number().int().positive(),
        orderId: z.string().optional(),
        reason: z.string().optional(),
      },
      handler: (args: { customerId?: unknown; amountCents?: unknown; orderId?: unknown }) => {
        const customerId = readString(args.customerId);
        if (!customerId) return fail('customerId is required');
        const customer = findCustomer(world, customerId);
        if (!customer) return fail(unknownCustomer(world, customerId));

        const amountCents = readInt(args.amountCents);
        if (amountCents === undefined || amountCents <= 0) {
          return fail('amountCents must be a positive whole number of cents');
        }

        const orderId = readString(args.orderId);
        if (orderId && !findOrder(world, orderId)) return fail(unknownOrder(world, orderId));

        const before = customer.storeCreditCents;
        customer.storeCreditCents += amountCents;
        return `customer ${customer.id} storeCreditCents ${before} -> ${customer.storeCreditCents} (+${amountCents})`;
      },
    },
  ];
}

const ORDER_STATUSES = ['pending', 'partially_shipped', 'shipped', 'returned', 'cancelled'];

/**
 * Spread a refund total over the lines it covers, weighted by what each line
 * paid. With a correct total this reproduces the per-line amounts exactly; the
 * last line absorbs the rounding remainder so the parts always sum to the whole.
 */
function allocateRefund(lines: OrderLine[], amountCents: number, method: RefundMethod): void {
  const basis = lines.reduce((acc, line) => acc + line.paidCents, 0);
  let allocated = 0;
  lines.forEach((line, index) => {
    const isLast = index === lines.length - 1;
    const share = isLast
      ? amountCents - allocated
      : basis === 0
        ? Math.floor(amountCents / lines.length)
        : Math.round((amountCents * line.paidCents) / basis);
    allocated += share;
    line.refundedCents += share;
    line.refundMethod = method;
  });
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function formatOrder(world: EcommerceWorld, order: Order): string {
  return [
    `order ${order.id} customer=${order.customerId} status=${order.status} placedAt=${order.placedAt} today=${world.today}`,
    `paidCents=${order.paidCents} refundedCents=${refundedTotal(world, order.id)} discountCode=${order.discountCode ?? 'none'}`,
    `shippingAddress=${order.shippingAddress}`,
    'lines (paidCents is what the customer was actually charged for the line):',
    ...order.lines.map((line) => `  ${formatLine(world, line)}`),
    `refunds: ${
      refundsForOrder(world, order.id)
        .map((entry) => `${entry.id} lines=${entry.lineIds.join('+')} ${entry.amountCents} ${entry.method}`)
        .join('; ') || 'none'
    }`,
  ].join('\n');
}

function formatLine(world: EcommerceWorld, line: OrderLine): string {
  const parts = [
    line.id,
    `product=${line.productId}`,
    `qty=${line.quantity}`,
    `unitPriceCents=${line.unitPriceCents}`,
    `paidCents=${line.paidCents}`,
    `status=${line.status}`,
  ];
  const elapsed = daysSinceShipped(world, line);
  if (line.shippedAt && elapsed !== undefined) {
    parts.push(`shippedAt=${line.shippedAt}`, `daysSinceShipped=${elapsed}`);
  }
  parts.push(`refundedCents=${line.refundedCents}`);
  if (line.refundMethod) parts.push(`refundMethod=${line.refundMethod}`);
  return parts.join(' ');
}

// ---------------------------------------------------------------------------
// Argument reading and errors
// ---------------------------------------------------------------------------

function fail(text: string): ToolReply {
  return { text: `Error: ${text}`, isError: true };
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item !== '');
}

function readInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}

function unknownOrder(world: EcommerceWorld, orderId: string): string {
  return `unknown order id "${orderId}". Known order ids: ${world.orders.map((order) => order.id).join(', ')}`;
}

function unknownProduct(world: EcommerceWorld, productId: string): string {
  return `unknown product id "${productId}". Known product ids: ${world.products.map((product) => product.id).join(', ')}`;
}

function unknownCustomer(world: EcommerceWorld, customerId: string): string {
  return `unknown customer id "${customerId}". Known customer ids: ${world.customers.map((customer) => customer.id).join(', ')}`;
}

function unknownLine(order: Order, lineId: string): string {
  return `unknown line id "${lineId}" on order ${order.id}. Known line ids: ${order.lines.map((line) => line.id).join(', ')}`;
}
