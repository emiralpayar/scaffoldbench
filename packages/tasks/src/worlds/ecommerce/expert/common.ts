import type { JournaledToolSpec } from '@scaffoldbench/core';
import type { ToolUseTaskSpec } from '../../../defineToolUseTask';
import type { ChangeFilter } from '../../../worldDiff';
import { ECOMMERCE_OPS_HANDBOOK } from '../handbook';
import {
  ECOMMERCE_OPS_INSTRUCTIONS,
  createEcommerceOpsTools,
  type EcommerceOpsWorld,
} from '../ops';
import {
  findOrder,
  recomputeOrderStatus,
  type Customer,
  type LoyaltyTier,
  type Order,
  type OrderLine,
  type OrderLineStatus,
  type Product,
  type RefundLedgerEntry,
} from '../world';

/**
 * What every expert ecommerce task shares: the world name, the operations
 * handbook and the full operations toolset. Each task brings its own seed,
 * prompt and scorer. Every task sees every ops tool, including the ones it
 * does not need, so the tool list itself never hints at the answer.
 */
export const ECOMMERCE_EXPERT_BASE = {
  world: 'ecommerce',
  difficulty: 'expert',
  policy: ECOMMERCE_OPS_HANDBOOK,
  instructions: ECOMMERCE_OPS_INSTRUCTIONS,
  createTools: (world: EcommerceOpsWorld): JournaledToolSpec[] => createEcommerceOpsTools(world),
} satisfies Partial<ToolUseTaskSpec<EcommerceOpsWorld>>;

export const TIER_RANK: Record<LoyaltyTier, number> = { standard: 0, gold: 1, platinum: 2 };

export function orderOrThrow(world: EcommerceOpsWorld, id: string): Order {
  const order = findOrder(world, id);
  if (!order) throw new Error(`order ${id} vanished from the world`);
  return order;
}

export function lineOrThrow(world: EcommerceOpsWorld, orderId: string, lineId: string): OrderLine {
  const line = orderOrThrow(world, orderId).lines.find((entry) => entry.id === lineId);
  if (!line) throw new Error(`line ${orderId}/${lineId} vanished from the world`);
  return line;
}

/** Refunds the run added for an order: everything not present in the seed. */
export function addedRefunds(
  seed: EcommerceOpsWorld,
  world: EcommerceOpsWorld,
  orderId: string,
): RefundLedgerEntry[] {
  const before = new Set(seed.refunds.map((entry) => entry.id));
  return world.refunds.filter((entry) => entry.orderId === orderId && !before.has(entry.id));
}

/** Units moved into a product's sellable or damaged stock by the run, from the movement log. */
export function restockedUnits(
  seed: EcommerceOpsWorld,
  world: EcommerceOpsWorld,
  productId: string,
  bucket: 'sellable' | 'damaged',
  orderId?: string,
): number {
  return world.inventoryMovements
    .slice(seed.inventoryMovements.length)
    .filter(
      (movement) =>
        movement.productId === productId &&
        movement.deltaUnits > 0 &&
        (orderId === undefined || movement.orderId === undefined || movement.orderId === orderId) &&
        movement.reason.startsWith('damaged:') === (bucket === 'damaged'),
    )
    .reduce((total, movement) => total + movement.deltaUnits, 0);
}

/** Rounding a percentage fee down to the cent, as the return policy states. */
export function feeCents(paidCents: number, percent: number): number {
  return Math.floor((paidCents * percent) / 100);
}

/**
 * Allows changes to a product's stock counters (sellable and damaged), which
 * every stock-moving tool touches, without allowing a rename or a repricing.
 */
export function stockOf(...productIds: string[]): ChangeFilter {
  return (change) =>
    change.path[0] === 'products' &&
    productIds.includes(change.path[1] ?? '') &&
    (change.path[2] === 'stock' || change.path[2] === 'damagedStock');
}

// ---------------------------------------------------------------------------
// Seed builders: keep the seed tables readable
// ---------------------------------------------------------------------------

export function product(id: string, name: string, priceCents: number, stock: number): Product {
  return { id, name, priceCents, stock };
}

export function customer(
  id: string,
  name: string,
  tier: LoyaltyTier,
  fields: Partial<Pick<Customer, 'storeCreditCents' | 'creditHistory' | 'email'>> = {},
): Customer {
  const email = fields.email ?? `${name.toLowerCase().replace(/[^a-z]+/g, '.')}@example.com`;
  return {
    id,
    name,
    tier,
    storeCreditCents: fields.storeCreditCents ?? 0,
    email,
    ...(fields.creditHistory ? { creditHistory: fields.creditHistory } : {}),
  };
}

/**
 * One order line. `paid` defaults to list price times quantity; pass it when
 * a discount means the customer paid less.
 */
export function line(
  id: string,
  productId: string,
  quantity: number,
  unitPriceCents: number,
  fields: { paid?: number; status?: OrderLineStatus; shippedAt?: string; refunded?: number } = {},
): OrderLine {
  return {
    id,
    productId,
    quantity,
    unitPriceCents,
    paidCents: fields.paid ?? quantity * unitPriceCents,
    status: fields.status ?? 'pending',
    ...(fields.shippedAt ? { shippedAt: fields.shippedAt } : {}),
    refundedCents: fields.refunded ?? 0,
  };
}

export function order(
  id: string,
  customerId: string,
  placedAt: string,
  lines: OrderLine[],
  fields: Partial<Pick<Order, 'shipComplete' | 'riskHold' | 'discountCode' | 'shippingAddress' | 'status'>> = {},
): Order {
  const built: Order = {
    id,
    customerId,
    status: 'pending',
    placedAt,
    shippingAddress: fields.shippingAddress ?? `${id.slice(2)} Station Road, Leeds LS1 4AP, UK`,
    paidCents: lines.reduce((total, entry) => total + entry.paidCents, 0),
    lines,
    ...(fields.discountCode ? { discountCode: fields.discountCode } : {}),
    ...(fields.shipComplete ? { shipComplete: true } : {}),
    ...(fields.riskHold ? { riskHold: true } : {}),
  };
  built.status = fields.status ?? recomputeOrderStatus(built);
  return built;
}
