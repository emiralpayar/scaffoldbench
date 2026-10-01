import { z } from 'zod';
import type { JournaledToolSpec } from '@arena/core';
import {
  allocateRefund,
  createEcommerceTools,
  fail,
  readInt,
  readString,
  readStringArray,
  unknownCustomer,
  unknownLine,
  unknownOrder,
  unknownProduct,
} from './tools';
import {
  findCustomer,
  findLine,
  findOrder,
  findProduct,
  recomputeOrderStatus,
  refundedTotal,
  type Customer,
  type EcommerceWorld,
  type OrderLine,
  type RefundLedgerEntry,
  type RefundMethod,
} from './world';

/**
 * The store's operations back office for the expert tier: the order desk plus
 * purchase orders and backorder allocation, returns with warehouse receipts,
 * customer notices and a customer inbox.
 *
 * It extends the base world rather than replacing it, so every base rule
 * helper still applies. Four base tools are replaced by richer versions:
 * refunds may be issued against a line more than once (part of a return now,
 * the rest when it arrives), restocking chooses between sellable and damaged
 * stock, store credit keeps a history, and the customer record shows that
 * history and the account email.
 */

export interface PurchaseOrder {
  id: string;
  productId: string;
  quantity: number;
  status: 'received' | 'in_transit';
  receivedOn?: string;
  /** Expected arrival of a purchase order still in transit. */
  eta?: string;
}

export type ReturnReason = 'changed_mind' | 'defective' | 'damaged_in_transit';

export interface ReturnAuthorization {
  id: string;
  orderId: string;
  lineId: string;
  /** Units of the line the customer is sending back. */
  quantity: number;
  requestedOn: string;
  reason: ReturnReason;
  status: 'open' | 'investigating' | 'closed';
  /** What the customer wrote when they asked for the return. */
  customerNote?: string;
  /** The desk's closing note. */
  note?: string;
}

export interface ReturnReceipt {
  rmaId: string;
  receivedOn: string;
  quantity: number;
  grade: 'resellable' | 'damaged' | 'wrong_item';
  /** What actually arrived, which is not always what the return covers. */
  productReceived: string;
}

export interface Investigation {
  id: string;
  rmaId: string;
  note: string;
}

export interface CustomerNotice {
  id: string;
  orderId: string;
  customerId: string;
  message: string;
}

export interface InboxMessage {
  id: string;
  receivedAt: string;
  fromAddress: string;
  fromName: string;
  subject: string;
  body: string;
  status: 'open' | 'answered';
}

export interface Reply {
  id: string;
  messageId: string;
  body: string;
}

/**
 * A message that lands in the inbox once `afterReplies` replies have been
 * sent. An inbox does not stand still while someone works it, and an agent
 * that lists it once and never looks again leaves the newcomer unanswered.
 */
export interface ScheduledMessage {
  afterReplies: number;
  message: InboxMessage;
}

export interface EcommerceOpsWorld extends EcommerceWorld {
  purchaseOrders: PurchaseOrder[];
  returns: ReturnAuthorization[];
  receipts: ReturnReceipt[];
  investigations: Investigation[];
  notices: CustomerNotice[];
  inbox: InboxMessage[];
  replies: Reply[];
  scheduledMessages: ScheduledMessage[];
}

/** An ops world with nothing in any of the ops collections, for seeds to fill in. */
export function emptyStoreOps(base: EcommerceWorld): EcommerceOpsWorld {
  return {
    ...base,
    purchaseOrders: [],
    returns: [],
    receipts: [],
    investigations: [],
    notices: [],
    inbox: [],
    replies: [],
    scheduledMessages: [],
  };
}

export const ECOMMERCE_OPS_INSTRUCTIONS = [
  'Back-office operations for an online store: orders, purchase orders, returns, customer notices and the customer inbox.',
  'All money is in integer cents. Dates are YYYY-MM-DD. Ids are exact and case-sensitive.',
  'Reads never change anything; every mutating tool reports exactly what it changed. Notices and replies reach the customer immediately and cannot be recalled.',
].join(' ');

/** Base tools the ops back office replaces with richer versions of its own. */
const REPLACED = new Set(['refund_order', 'restock_item', 'apply_store_credit', 'get_customer']);

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function createEcommerceOpsTools(world: EcommerceOpsWorld): JournaledToolSpec[] {
  const findReturn = (id: unknown) => world.returns.find((rma) => rma.id === readString(id));
  const findMessage = (id: unknown) => world.inbox.find((entry) => entry.id === readString(id));

  return [
    ...createEcommerceTools(world).filter((spec) => !REPLACED.has(spec.name)),

    // -----------------------------------------------------------------------
    // Reads
    // -----------------------------------------------------------------------
    {
      name: 'get_customer',
      description:
        'Read a customer: loyalty tier, account email, store credit balance with its history, and the ids of their orders.',
      schema: { customerId: z.string() },
      readOnly: true,
      handler: (args: { customerId?: unknown }) => {
        const customerId = readString(args.customerId);
        const customer = findCustomer(world, customerId);
        if (!customer) return fail(unknownCustomer(world, customerId));
        const orders = world.orders.filter((order) => order.customerId === customer.id);
        const history = customer.creditHistory ?? [];
        return [
          `customer ${customer.id} name="${customer.name}" tier=${customer.tier} email=${customer.email ?? 'none'}`,
          `storeCreditCents=${customer.storeCreditCents}`,
          `credit history (${history.length}):`,
          ...history.map(
            (entry) =>
              `  ${entry.at} ${entry.amountCents >= 0 ? '+' : ''}${entry.amountCents} "${entry.reason}"`,
          ),
          `orders=${orders.map((order) => order.id).join(',') || 'none'}`,
        ].join('\n');
      },
    },
    {
      name: 'list_purchase_orders',
      description:
        'List purchase orders from suppliers: product, quantity, and whether received or still in transit with its expected arrival.',
      schema: { productId: z.string().optional() },
      readOnly: true,
      handler: (args: { productId?: unknown }) => {
        const productId = readString(args.productId);
        const matches = world.purchaseOrders.filter((po) => !productId || po.productId === productId);
        if (matches.length === 0) return 'no purchase orders match';
        return [
          `${matches.length} purchase order(s), today=${world.today}:`,
          ...matches.map(
            (po) =>
              `  ${po.id} product=${po.productId} qty=${po.quantity} status=${po.status}${po.receivedOn ? ` receivedOn=${po.receivedOn}` : ''}${po.eta ? ` eta=${po.eta}` : ''}`,
          ),
        ].join('\n');
      },
    },
    {
      name: 'list_backorders',
      description:
        'List every order line waiting for stock (status backordered), with its order, customer and the date the order was placed.',
      schema: { productId: z.string().optional() },
      readOnly: true,
      handler: (args: { productId?: unknown }) => {
        const productId = readString(args.productId);
        const rows = world.orders.flatMap((order) =>
          order.lines
            .filter(
              (line) =>
                line.status === 'backordered' && (!productId || line.productId === productId),
            )
            .map(
              (line) =>
                `  ${order.id} ${line.id} product=${line.productId} qty=${line.quantity} customer=${order.customerId} placedAt=${order.placedAt}`,
            ),
        );
        if (rows.length === 0) return 'no backordered lines';
        return [`${rows.length} backordered line(s):`, ...rows].join('\n');
      },
    },
    {
      name: 'list_returns',
      description:
        'List return authorizations (RMAs), optionally by status (open, investigating, closed).',
      schema: { status: z.enum(['open', 'investigating', 'closed']).optional() },
      readOnly: true,
      handler: (args: { status?: unknown }) => {
        const status = readString(args.status);
        const matches = world.returns.filter((rma) => !status || rma.status === status);
        if (matches.length === 0) return 'no returns match';
        return [
          `${matches.length} return(s), today=${world.today}:`,
          ...matches.map(
            (rma) =>
              `  ${rma.id} order=${rma.orderId} line=${rma.lineId} qty=${rma.quantity} requestedOn=${rma.requestedOn} reason=${rma.reason} status=${rma.status}`,
          ),
        ].join('\n');
      },
    },
    {
      name: 'get_return',
      description: 'Read one return authorization in full, including what the customer wrote.',
      schema: { rmaId: z.string() },
      readOnly: true,
      handler: (args: { rmaId?: unknown }) => {
        const rma = findReturn(args.rmaId);
        if (!rma) return fail(`unknown RMA "${readString(args.rmaId)}"`);
        return [
          `${rma.id} order=${rma.orderId} line=${rma.lineId} qty=${rma.quantity}`,
          `requestedOn=${rma.requestedOn} reason=${rma.reason} status=${rma.status}`,
          `customer note: ${rma.customerNote ?? '(none)'}`,
          ...(rma.note ? [`desk note: ${rma.note}`] : []),
        ].join('\n');
      },
    },
    {
      name: 'list_return_receipts',
      description:
        'List what the warehouse has received against return authorizations, with the grade it gave the goods.',
      schema: { rmaId: z.string().optional() },
      readOnly: true,
      handler: (args: { rmaId?: unknown }) => {
        const rmaId = readString(args.rmaId);
        const matches = world.receipts.filter((receipt) => !rmaId || receipt.rmaId === rmaId);
        if (matches.length === 0) return rmaId ? `nothing received against ${rmaId}` : 'no receipts';
        return [
          `${matches.length} receipt(s):`,
          ...matches.map(
            (receipt) =>
              `  ${receipt.rmaId} receivedOn=${receipt.receivedOn} qty=${receipt.quantity} grade=${receipt.grade} productReceived=${receipt.productReceived}`,
          ),
        ].join('\n');
      },
    },
    {
      name: 'list_inbox',
      description: 'List messages in the customer inbox, optionally by status (open or answered).',
      schema: { status: z.enum(['open', 'answered']).optional() },
      readOnly: true,
      handler: (args: { status?: unknown }) => {
        const status = readString(args.status);
        const matches = world.inbox.filter((message) => !status || message.status === status);
        if (matches.length === 0) return 'no messages match';
        return [
          `${matches.length} message(s):`,
          ...matches.map(
            (message) =>
              `  ${message.id} ${message.receivedAt} from="${message.fromName} <${message.fromAddress}>" status=${message.status} subject="${message.subject}"`,
          ),
        ].join('\n');
      },
    },
    {
      name: 'get_message',
      description: 'Read one inbox message in full.',
      schema: { messageId: z.string() },
      readOnly: true,
      handler: (args: { messageId?: unknown }) => {
        const message = findMessage(args.messageId);
        if (!message) return fail(`unknown message id "${readString(args.messageId)}"`);
        return [
          `${message.id} received ${message.receivedAt} status=${message.status}`,
          `from: ${message.fromName} <${message.fromAddress}>`,
          `subject: ${message.subject}`,
          '',
          message.body,
        ].join('\n');
      },
    },

    // -----------------------------------------------------------------------
    // Mutations
    // -----------------------------------------------------------------------
    {
      name: 'allocate_stock',
      description:
        'Allocate on-hand stock to backordered lines of an order. Each named line is allocated in full from current stock and becomes pending, ready for the warehouse to ship; refused if stock is short for any of them.',
      schema: { orderId: z.string(), lineIds: z.array(z.string()).min(1) },
      handler: (args: { orderId?: unknown; lineIds?: unknown }) => {
        const order = findOrder(world, readString(args.orderId));
        if (!order) return fail(unknownOrder(world, readString(args.orderId)));
        const lines: OrderLine[] = [];
        for (const lineId of readStringArray(args.lineIds)) {
          const line = findLine(order, lineId);
          if (!line) return fail(unknownLine(order, lineId));
          if (line.status !== 'backordered') {
            return fail(`line ${line.id} on order ${order.id} is ${line.status}, not backordered`);
          }
          if (!lines.includes(line)) lines.push(line);
        }
        const needed = new Map<string, number>();
        for (const line of lines) {
          needed.set(line.productId, (needed.get(line.productId) ?? 0) + line.quantity);
        }
        for (const [productId, quantity] of needed) {
          const product = findProduct(world, productId);
          if (!product || product.stock < quantity) {
            return fail(
              `not enough ${productId} in stock: need ${quantity}, have ${product?.stock ?? 0}`,
            );
          }
        }
        for (const [productId, quantity] of needed) {
          const product = findProduct(world, productId);
          if (product) product.stock -= quantity;
        }
        for (const line of lines) line.status = 'pending';
        order.status = recomputeOrderStatus(order);
        return [
          `allocated on order ${order.id}: ${lines.map((line) => `${line.id} (${line.productId} x${line.quantity})`).join(', ')}`,
          ...[...needed.keys()].map(
            (productId) => `  ${productId} stock now ${findProduct(world, productId)?.stock}`,
          ),
        ].join('\n');
      },
    },
    {
      name: 'set_promise_date',
      description: 'Record the date a backordered line is promised to ship.',
      schema: { orderId: z.string(), lineId: z.string(), date: z.string().describe('YYYY-MM-DD') },
      handler: (args: { orderId?: unknown; lineId?: unknown; date?: unknown }) => {
        const order = findOrder(world, readString(args.orderId));
        if (!order) return fail(unknownOrder(world, readString(args.orderId)));
        const line = findLine(order, readString(args.lineId));
        if (!line) return fail(unknownLine(order, readString(args.lineId)));
        if (line.status !== 'backordered') {
          return fail(`line ${line.id} on order ${order.id} is ${line.status}, not backordered`);
        }
        const date = readString(args.date);
        if (!ISO_DATE.test(date) || Number.isNaN(Date.parse(date))) {
          return fail(`"${date}" is not a YYYY-MM-DD date`);
        }
        const before = line.promisedDate;
        line.promisedDate = date;
        return `order ${order.id} line ${line.id} promisedDate ${before ?? 'none'} -> ${date}`;
      },
    },
    {
      name: 'notify_customer',
      description: 'Send the customer on an order a notice by email. Delivered immediately.',
      schema: { orderId: z.string(), message: z.string().min(1) },
      handler: (args: { orderId?: unknown; message?: unknown }) => {
        const order = findOrder(world, readString(args.orderId));
        if (!order) return fail(unknownOrder(world, readString(args.orderId)));
        const notice: CustomerNotice = {
          id: `N-${world.notices.length + 1}`,
          orderId: order.id,
          customerId: order.customerId,
          message: readString(args.message),
        };
        world.notices.push(notice);
        return `notice ${notice.id} sent to customer ${order.customerId} about order ${order.id}`;
      },
    },
    {
      name: 'refund_order',
      description:
        'Refund named lines of an order. amountCents is the total for those lines and is split across them in proportion to what each one paid. method=card returns the money to the original payment method; method=store_credit records the refund against the order but does not change the customer store-credit balance. A line must be cancelled or shipped before it can be refunded, and may be refunded more than once (for example part of a return now and the rest later).',
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
        const order = findOrder(world, readString(args.orderId));
        if (!order) return fail(unknownOrder(world, readString(args.orderId)));
        const method = readString(args.method) as RefundMethod;
        const amountCents = readInt(args.amountCents);
        if (amountCents === undefined || amountCents <= 0) {
          return fail('amountCents must be a positive whole number of cents');
        }
        const targets: OrderLine[] = [];
        for (const lineId of readStringArray(args.lineIds)) {
          const line = findLine(order, lineId);
          if (!line) return fail(unknownLine(order, lineId));
          if (line.status === 'pending' || line.status === 'backordered') {
            return fail(
              `line ${line.id} on order ${order.id} is still ${line.status}. Cancel it with cancel_order before refunding it.`,
            );
          }
          if (!targets.includes(line)) targets.push(line);
        }
        const already = refundedTotal(world, order.id);
        if (already + amountCents > order.paidCents) {
          return fail(
            `refusing to refund ${amountCents} cents: order ${order.id} was paid ${order.paidCents} cents and ${already} has already been refunded.`,
          );
        }
        allocateRefund(targets, amountCents, method);
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
        return [
          `refund ${entry.id} recorded on order ${order.id}: lines=${entry.lineIds.join(',')} amountCents=${amountCents} method=${method}`,
          ...targets.map(
            (line) =>
              `  ${line.id} paidCents=${line.paidCents} refundedCents=${line.refundedCents} status=${line.status}`,
          ),
          ...(method === 'store_credit'
            ? [`customer ${order.customerId} store-credit balance is unchanged`]
            : []),
        ].join('\n');
      },
    },
    {
      name: 'restock_item',
      description:
        'Put units of a product back into stock and record an inventory movement: into sellable stock, or into the damaged bucket for goods that cannot be sold again.',
      schema: {
        productId: z.string(),
        quantity: z.number().int().positive(),
        bucket: z.enum(['sellable', 'damaged']).optional().describe('Defaults to sellable'),
        orderId: z.string().optional(),
        reason: z.string().optional(),
      },
      handler: (args: {
        productId?: unknown;
        quantity?: unknown;
        bucket?: unknown;
        orderId?: unknown;
        reason?: unknown;
      }) => {
        const productId = readString(args.productId);
        const product = findProduct(world, productId);
        if (!product) return fail(unknownProduct(world, productId));
        const quantity = readInt(args.quantity);
        if (quantity === undefined || quantity <= 0) {
          return fail('quantity must be a positive whole number of units');
        }
        const orderId = readString(args.orderId);
        if (orderId && !findOrder(world, orderId)) return fail(unknownOrder(world, orderId));
        const damaged = readString(args.bucket) === 'damaged';
        const reason = readString(args.reason) || 'restock';
        world.inventoryMovements.push({
          productId,
          deltaUnits: quantity,
          reason: damaged ? `damaged: ${reason}` : reason,
          ...(orderId ? { orderId } : {}),
          at: world.today,
        });
        if (damaged) {
          const before = product.damagedStock ?? 0;
          product.damagedStock = before + quantity;
          return `product ${productId} damagedStock ${before} -> ${product.damagedStock} (+${quantity})`;
        }
        const before = product.stock;
        product.stock += quantity;
        return `product ${productId} stock ${before} -> ${product.stock} (+${quantity})`;
      },
    },
    {
      name: 'apply_store_credit',
      description: "Add store credit to a customer's balance, recorded in their credit history.",
      schema: {
        customerId: z.string(),
        amountCents: z.number().int().positive(),
        reason: z.string().min(1),
        orderId: z.string().optional(),
      },
      handler: (args: {
        customerId?: unknown;
        amountCents?: unknown;
        reason?: unknown;
        orderId?: unknown;
      }) => {
        const customer = findCustomer(world, readString(args.customerId));
        if (!customer) return fail(unknownCustomer(world, readString(args.customerId)));
        const amountCents = readInt(args.amountCents);
        if (amountCents === undefined || amountCents <= 0) {
          return fail('amountCents must be a positive whole number of cents');
        }
        const orderId = readString(args.orderId);
        if (orderId && !findOrder(world, orderId)) return fail(unknownOrder(world, orderId));
        const before = customer.storeCreditCents;
        moveCredit(world, customer, amountCents, readString(args.reason));
        return `customer ${customer.id} storeCreditCents ${before} -> ${customer.storeCreditCents} (+${amountCents})`;
      },
    },
    {
      name: 'transfer_store_credit',
      description: "Move store credit from one customer's balance to another's.",
      schema: {
        fromCustomerId: z.string(),
        toCustomerId: z.string(),
        amountCents: z.number().int().positive(),
        reason: z.string().min(1),
      },
      handler: (args: {
        fromCustomerId?: unknown;
        toCustomerId?: unknown;
        amountCents?: unknown;
        reason?: unknown;
      }) => {
        const from = findCustomer(world, readString(args.fromCustomerId));
        if (!from) return fail(unknownCustomer(world, readString(args.fromCustomerId)));
        const to = findCustomer(world, readString(args.toCustomerId));
        if (!to) return fail(unknownCustomer(world, readString(args.toCustomerId)));
        if (from.id === to.id) return fail('cannot transfer store credit to the same customer');
        const amountCents = readInt(args.amountCents);
        if (amountCents === undefined || amountCents <= 0) {
          return fail('amountCents must be a positive whole number of cents');
        }
        if (from.storeCreditCents < amountCents) {
          return fail(
            `customer ${from.id} has ${from.storeCreditCents} cents of store credit, less than ${amountCents}`,
          );
        }
        const reason = readString(args.reason);
        moveCredit(world, from, -amountCents, `transfer to ${to.id}: ${reason}`);
        moveCredit(world, to, amountCents, `transfer from ${from.id}: ${reason}`);
        return `moved ${amountCents} cents of store credit from ${from.id} (now ${from.storeCreditCents}) to ${to.id} (now ${to.storeCreditCents})`;
      },
    },
    {
      name: 'open_investigation',
      description: 'Open an investigation on a return authorization. Its status becomes investigating.',
      schema: { rmaId: z.string(), note: z.string().min(1) },
      handler: (args: { rmaId?: unknown; note?: unknown }) => {
        const rma = findReturn(args.rmaId);
        if (!rma) return fail(`unknown RMA "${readString(args.rmaId)}"`);
        if (rma.status === 'closed') return fail(`${rma.id} is closed`);
        const investigation: Investigation = {
          id: `INV-${world.investigations.length + 1}`,
          rmaId: rma.id,
          note: readString(args.note),
        };
        world.investigations.push(investigation);
        rma.status = 'investigating';
        return `${investigation.id} opened on ${rma.id}; status=investigating`;
      },
    },
    {
      name: 'close_return',
      description: 'Close a return authorization with a note.',
      schema: { rmaId: z.string(), note: z.string().min(1) },
      handler: (args: { rmaId?: unknown; note?: unknown }) => {
        const rma = findReturn(args.rmaId);
        if (!rma) return fail(`unknown RMA "${readString(args.rmaId)}"`);
        if (rma.status === 'closed') return fail(`${rma.id} is already closed`);
        rma.status = 'closed';
        rma.note = readString(args.note);
        return `${rma.id} closed`;
      },
    },
    {
      name: 'reply_to_message',
      description:
        'Reply to an inbox message by email. Delivered immediately; the message is marked answered.',
      schema: { messageId: z.string(), body: z.string().min(1) },
      handler: (args: { messageId?: unknown; body?: unknown }) => {
        const message = findMessage(args.messageId);
        if (!message) return fail(`unknown message id "${readString(args.messageId)}"`);
        const reply: Reply = {
          id: `RE-${world.replies.length + 1}`,
          messageId: message.id,
          body: readString(args.body),
        };
        world.replies.push(reply);
        message.status = 'answered';
        deliverScheduledMessages(world);
        return `reply ${reply.id} sent to ${message.fromAddress}; ${message.id} marked answered`;
      },
    },
  ];
}

function moveCredit(
  world: EcommerceOpsWorld,
  customer: Customer,
  amountCents: number,
  reason: string,
): void {
  customer.storeCreditCents += amountCents;
  customer.creditHistory = [
    ...(customer.creditHistory ?? []),
    { at: world.today, amountCents, reason },
  ];
}

/** Move scheduled messages whose moment has come into the inbox. Says nothing about it. */
function deliverScheduledMessages(world: EcommerceOpsWorld): void {
  const due = world.scheduledMessages.filter((entry) => entry.afterReplies <= world.replies.length);
  if (due.length === 0) return;
  world.scheduledMessages = world.scheduledMessages.filter((entry) => !due.includes(entry));
  world.inbox.push(...due.map((entry) => entry.message));
}
