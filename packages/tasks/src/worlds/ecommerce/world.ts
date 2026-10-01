/**
 * The ecommerce sandbox: an online store's order management back office.
 *
 * The world is a plain object that tool handlers mutate in place. Nothing here
 * reads the clock or the network, and `today` is a fixed date, so a run is
 * reproducible down to the last cent no matter when it executes.
 */

export type LoyaltyTier = 'standard' | 'gold' | 'platinum';
export type RefundMethod = 'card' | 'store_credit';
/** `backordered`: paid for, waiting for stock, nothing reserved for it yet. */
export type OrderLineStatus = 'pending' | 'backordered' | 'shipped' | 'cancelled' | 'returned';
export type OrderStatus = 'pending' | 'partially_shipped' | 'shipped' | 'returned' | 'cancelled';

export interface Product {
  id: string;
  name: string;
  /** Current list price. An order line may have been paid at a different price. */
  priceCents: number;
  stock: number;
  /** Units back from customers that cannot be sold again, when the world tracks them. */
  damagedStock?: number;
}

export interface OrderLine {
  id: string;
  productId: string;
  quantity: number;
  unitPriceCents: number;
  /**
   * What the customer actually paid for this line, after any discount. This is
   * the only defensible basis for a refund, and it is deliberately not always
   * `quantity * unitPriceCents`.
   */
  paidCents: number;
  status: OrderLineStatus;
  shippedAt?: string;
  refundedCents: number;
  refundMethod?: RefundMethod;
  /** When a backordered line is expected to ship, once the store has promised a date. */
  promisedDate?: string;
}

export interface Order {
  id: string;
  customerId: string;
  status: OrderStatus;
  placedAt: string;
  shippingAddress: string;
  paidCents: number;
  lines: OrderLine[];
  discountCode?: string;
  /** Ship only when every line can ship at once. */
  shipComplete?: boolean;
  /** Held by the risk team: no stock, no shipment, no contact. */
  riskHold?: boolean;
}

export interface Customer {
  id: string;
  name: string;
  tier: LoyaltyTier;
  storeCreditCents: number;
  /** The address the account holder writes from, when the world models email. */
  email?: string;
  /** Every store-credit movement, oldest first, when the world keeps one. */
  creditHistory?: { at: string; amountCents: number; reason: string }[];
}

export interface InventoryMovement {
  productId: string;
  deltaUnits: number;
  reason: string;
  orderId?: string;
  at: string;
}

export interface RefundLedgerEntry {
  id: string;
  orderId: string;
  lineIds: string[];
  amountCents: number;
  method: RefundMethod;
  at: string;
  reason?: string;
}

export interface ReturnPolicy {
  returnWindowDays: number;
  /** Refund method mandated once the window has closed. */
  outOfWindowMethod: RefundMethod;
  /** Returned goods re-enter stock only when the warehouse receives them. */
  restockOnReceiptOnly: boolean;
  /**
   * Percentage of what was paid for returned units that a change-of-mind
   * return forfeits, when the store charges one. Absent means no fee.
   */
  restockingFeePercent?: number;
}

export interface EcommerceWorld {
  today: string;
  returnPolicy: ReturnPolicy;
  products: Product[];
  customers: Customer[];
  orders: Order[];
  inventoryMovements: InventoryMovement[];
  refunds: RefundLedgerEntry[];
}

/** Fixed "now" for the whole world, so date arithmetic is deterministic. */
export const ECOMMERCE_TODAY = '2026-07-25';

export function createEcommerceWorld(): EcommerceWorld {
  return {
    today: ECOMMERCE_TODAY,
    returnPolicy: {
      returnWindowDays: 30,
      outOfWindowMethod: 'store_credit',
      restockOnReceiptOnly: true,
    },
    products: [
      { id: 'P-KEY', name: 'Mechanical Keyboard', priceCents: 12_900, stock: 14 },
      { id: 'P-MOU', name: 'Wireless Mouse', priceCents: 4_900, stock: 30 },
      { id: 'P-HUB', name: 'USB-C Hub', priceCents: 6_900, stock: 8 },
      { id: 'P-MON', name: '27-inch Monitor', priceCents: 32_900, stock: 5 },
      { id: 'P-CAB', name: 'Braided USB Cable', priceCents: 1_900, stock: 60 },
      { id: 'P-DOC', name: 'Laptop Dock', priceCents: 21_900, stock: 3 },
    ],
    customers: [
      { id: 'C-100', name: 'Dana Whitfield', tier: 'gold', storeCreditCents: 0 },
      { id: 'C-200', name: 'Marcus Ade', tier: 'standard', storeCreditCents: 0 },
      { id: 'C-300', name: 'Priya Raman', tier: 'platinum', storeCreditCents: 500 },
    ],
    orders: [
      {
        id: 'O-1001',
        customerId: 'C-100',
        status: 'pending',
        placedAt: '2026-07-20',
        shippingAddress: '12 Alder Lane, Bristol BS1 4TR, UK',
        paidCents: 16_700,
        lines: [
          line('L1', 'P-KEY', 1, 12_900, 12_900),
          line('L2', 'P-CAB', 2, 1_900, 3_800),
        ],
      },
      {
        id: 'O-1002',
        customerId: 'C-100',
        status: 'shipped',
        placedAt: '2026-07-05',
        shippingAddress: '88 Old Mill Road, Bristol BS3 2QQ, UK',
        paidCents: 32_900,
        lines: [shippedLine('L1', 'P-MON', 1, 32_900, 32_900, '2026-07-07')],
      },
      {
        id: 'O-2001',
        customerId: 'C-200',
        status: 'shipped',
        placedAt: '2026-07-16',
        shippingAddress: '5 Kingfisher Court, Leeds LS2 7EE, UK',
        paidCents: 1_900,
        lines: [shippedLine('L1', 'P-CAB', 1, 1_900, 1_900, '2026-07-18')],
      },
      {
        id: 'O-2003',
        customerId: 'C-200',
        status: 'pending',
        placedAt: '2026-07-22',
        shippingAddress: '5 Kingfisher Court, Leeds LS2 7EE, UK',
        paidCents: 19_950,
        discountCode: 'MOUSE25',
        lines: [
          // 25% off this line only: the list price is a trap for anyone who
          // refunds without reading the order.
          line('L1', 'P-MOU', 2, 4_900, 7_350),
          line('L2', 'P-HUB', 1, 6_900, 6_900),
          line('L3', 'P-CAB', 3, 1_900, 5_700),
        ],
      },
      {
        id: 'O-3001',
        customerId: 'C-300',
        status: 'partially_shipped',
        placedAt: '2026-05-02',
        shippingAddress: '4 Harbour View, Cardiff CF10 5AB, UK',
        paidCents: 68_600,
        lines: [
          shippedLine('L1', 'P-DOC', 1, 21_900, 21_900, '2026-05-04'),
          shippedLine('L2', 'P-MON', 1, 32_900, 32_900, '2026-05-04'),
          line('L3', 'P-HUB', 2, 6_900, 13_800),
        ],
      },
    ],
    inventoryMovements: [
      { productId: 'P-HUB', deltaUnits: 12, reason: 'supplier delivery', at: '2026-06-30' },
      { productId: 'P-DOC', deltaUnits: 3, reason: 'supplier delivery', at: '2026-07-02' },
    ],
    refunds: [],
  };
}

function line(
  id: string,
  productId: string,
  quantity: number,
  unitPriceCents: number,
  paidCents: number,
): OrderLine {
  return { id, productId, quantity, unitPriceCents, paidCents, status: 'pending', refundedCents: 0 };
}

function shippedLine(
  id: string,
  productId: string,
  quantity: number,
  unitPriceCents: number,
  paidCents: number,
  shippedAt: string,
): OrderLine {
  return {
    id,
    productId,
    quantity,
    unitPriceCents,
    paidCents,
    status: 'shipped',
    shippedAt,
    refundedCents: 0,
  };
}

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

export function findOrder(world: EcommerceWorld, orderId: string): Order | undefined {
  return world.orders.find((order) => order.id === orderId);
}

export function findLine(order: Order, lineId: string): OrderLine | undefined {
  return order.lines.find((entry) => entry.id === lineId);
}

export function findProduct(world: EcommerceWorld, productId: string): Product | undefined {
  return world.products.find((product) => product.id === productId);
}

export function findCustomer(world: EcommerceWorld, customerId: string): Customer | undefined {
  return world.customers.find((customer) => customer.id === customerId);
}

export function ordersOfCustomer(world: EcommerceWorld, customerId: string): Order[] {
  return world.orders.filter((order) => order.customerId === customerId);
}

export function refundsForOrder(world: EcommerceWorld, orderId: string): RefundLedgerEntry[] {
  return world.refunds.filter((entry) => entry.orderId === orderId);
}

export function refundedTotal(world: EcommerceWorld, orderId: string): number {
  return refundsForOrder(world, orderId).reduce((acc, entry) => acc + entry.amountCents, 0);
}

// ---------------------------------------------------------------------------
// Derived state
// ---------------------------------------------------------------------------

/** Whole days between two `YYYY-MM-DD` dates. Both are read as UTC midnight. */
export function daysBetween(fromIso: string, toIso: string): number {
  const from = Date.parse(fromIso);
  const to = Date.parse(toIso);
  if (Number.isNaN(from) || Number.isNaN(to)) return 0;
  return Math.round((to - from) / 86_400_000);
}

export function daysSinceShipped(world: EcommerceWorld, line: OrderLine): number | undefined {
  return line.shippedAt ? daysBetween(line.shippedAt, world.today) : undefined;
}

/** True when the line left the warehouse longer ago than the return window allows. */
export function isOutsideReturnWindow(world: EcommerceWorld, line: OrderLine): boolean {
  const elapsed = daysSinceShipped(world, line);
  return elapsed !== undefined && elapsed > world.returnPolicy.returnWindowDays;
}

/**
 * Order status implied by its lines. Cancelled lines drop out of the picture
 * entirely: an order whose remaining lines all shipped is a shipped order,
 * whatever was struck from it along the way.
 */
export function recomputeOrderStatus(order: Order): OrderStatus {
  const active = order.lines.filter((entry) => entry.status !== 'cancelled');
  if (active.length === 0) return 'cancelled';
  if (active.every((entry) => entry.status === 'returned')) return 'returned';

  const anyDispatched = active.some(
    (entry) => entry.status === 'shipped' || entry.status === 'returned',
  );
  // A backordered line has not left either; for the order it counts as pending.
  const anyPending = active.some(
    (entry) => entry.status === 'pending' || entry.status === 'backordered',
  );
  if (anyDispatched && anyPending) return 'partially_shipped';
  if (anyDispatched) return 'shipped';
  return 'pending';
}

/**
 * Compare addresses on content rather than punctuation, so an agent that writes
 * "Sheffield S11 8XZ UK" instead of "Sheffield S11 8XZ, UK" is not marked wrong
 * for formatting.
 */
export function normalizeAddress(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
