import { z } from 'zod';
import type { JournaledToolSpec } from '@arena/core';
import {
  createAirlineTools,
  describeLedgerEntry,
  error,
  flightHeadline,
  requireWholeAmount,
} from './tools';
import {
  appendLedger,
  findFlight,
  findPassenger,
  findReservation,
  formatCents,
  type AirlineWorld,
  type AuditOutcome,
  type LedgerEntry,
  type Tier,
} from './world';

/**
 * The airline back office for the expert tier: the reservations desk plus the
 * systems an operations agent works with — a request queue, operational
 * bulletins, vouchers and passenger notifications, payment instruments, tier
 * history and a searchable ledger.
 *
 * It extends the base world rather than replacing it, so every base tool runs
 * unchanged against it and every base rule helper still applies.
 */

export type VoucherKind = 'compensation' | 'hotel';

export interface Voucher {
  id: string;
  reservationId: string;
  passengerId: string;
  kind: VoucherKind;
  amountCents: number;
  note: string;
}

export interface PassengerNotification {
  id: string;
  passengerId: string;
  message: string;
}

export interface Bulletin {
  id: string;
  title: string;
  publishedOn: string;
  /** First and last day the bulletin is in force, inclusive. `null` means open-ended. */
  effectiveFrom: string;
  effectiveTo: string | null;
  body: string;
}

export interface PaymentInstrument {
  id: string;
  passengerId: string;
  description: string;
  status: 'active' | 'closed';
}

export interface TierChange {
  passengerId: string;
  tier: Tier;
  effectiveFrom: string;
}

export type RequestKind = 'cancellation' | 'change' | 'baggage' | 'other';

export interface ServiceRequest {
  id: string;
  receivedAt: string;
  passengerId: string;
  reservationId: string;
  kind: RequestKind;
  subject: string;
  message: string;
  status: 'open' | 'resolved';
  resolution?: string;
}

export interface AirlineOpsWorld extends AirlineWorld {
  vouchers: Voucher[];
  notifications: PassengerNotification[];
  bulletins: Bulletin[];
  paymentInstruments: PaymentInstrument[];
  tierHistory: TierChange[];
  requests: ServiceRequest[];
}

/** An ops world with nothing in any of the ops collections, for seeds to fill in. */
export function emptyOps(base: AirlineWorld): AirlineOpsWorld {
  return {
    ...base,
    vouchers: [],
    notifications: [],
    bulletins: [],
    paymentInstruments: [],
    tierHistory: [],
    requests: [],
  };
}

// ---------------------------------------------------------------------------
// Rule helpers shared by the expert airline tasks
// ---------------------------------------------------------------------------

/** Minutes since midnight for an `HH:MM` local time. */
export function minutesOf(time: string): number {
  const [hours, minutes] = time.split(':').map(Number);
  return (hours ?? Number.NaN) * 60 + (minutes ?? Number.NaN);
}

/** Minutes from one local date-time to another, both in the same time zone. */
export function minutesBetween(fromDate: string, fromTime: string, toDate: string, toTime: string) {
  const days = Math.round(
    (Date.parse(`${toDate}T00:00:00Z`) - Date.parse(`${fromDate}T00:00:00Z`)) / 86_400_000,
  );
  return days * 24 * 60 + minutesOf(toTime) - minutesOf(fromTime);
}

/** The tier a passenger held on a date, from the tier history; `none` before any entry. */
export function tierOn(world: AirlineOpsWorld, passengerId: string, date: string): Tier {
  const history = world.tierHistory
    .filter((entry) => entry.passengerId === passengerId && entry.effectiveFrom <= date)
    .sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
  return history.at(-1)?.tier ?? 'none';
}

export function instrumentFor(world: AirlineOpsWorld, reservationId: string) {
  const reservation = findReservation(world, reservationId);
  return reservation?.paymentInstrumentId
    ? world.paymentInstruments.find((entry) => entry.id === reservation.paymentInstrumentId)
    : undefined;
}

export function findRequest(world: AirlineOpsWorld, requestId: string) {
  return world.requests.find((request) => request.id === requestId);
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export const AIRLINE_OPS_INSTRUCTIONS = [
  'Reservation and operations system for a regional airline.',
  'All amounts are integer cents. Dates are YYYY-MM-DD. Departure times are local to the origin and arrival times local to the destination.',
  'Reads never change anything; every mutating tool reports exactly what it changed. Messages to passengers are delivered immediately and cannot be recalled.',
].join(' ');

const LEDGER_PAGE_SIZE = 8;

const auditOutcomeSchema = z.enum(['correct', 'overcharged', 'undercharged']);

export function createAirlineOpsTools(world: AirlineOpsWorld): JournaledToolSpec[] {
  return [
    ...createAirlineTools(world),

    // -----------------------------------------------------------------------
    // Reads
    // -----------------------------------------------------------------------
    {
      name: 'get_flight_manifest',
      description:
        'List the reservations booked on a flight: reservation id, passenger, cabin and booking status.',
      readOnly: true,
      schema: { flightId: z.string() },
      handler: ({ flightId }: { flightId: string }) => {
        const flight = findFlight(world, flightId);
        if (!flight) return error(`no flight with id ${flightId}`);
        const booked = world.reservations.filter((reservation) =>
          reservation.segments.some((segment) => segment.flightId === flight.id),
        );
        return [
          `${flightHeadline(flight)}`,
          `${booked.length} reservation(s):`,
          ...booked.map(
            (reservation) =>
              `  ${reservation.id} passenger=${reservation.passengerId} ${reservation.passengerName} cabin=${reservation.cabin} status=${reservation.status}`,
          ),
        ].join('\n');
      },
    },
    {
      name: 'list_bulletins',
      description: 'List operational bulletins with their effective dates.',
      readOnly: true,
      schema: {},
      handler: () => {
        if (world.bulletins.length === 0) return '0 bulletins.';
        return [
          `${world.bulletins.length} bulletin(s), today=${world.today}:`,
          ...world.bulletins.map(
            (bulletin) =>
              `  ${bulletin.id} "${bulletin.title}" published ${bulletin.publishedOn}, in effect ${bulletin.effectiveFrom} to ${bulletin.effectiveTo ?? 'further notice'}`,
          ),
        ].join('\n');
      },
    },
    {
      name: 'get_bulletin',
      description: 'Read the full text of one operational bulletin.',
      readOnly: true,
      schema: { bulletinId: z.string() },
      handler: ({ bulletinId }: { bulletinId: string }) => {
        const bulletin = world.bulletins.find((entry) => entry.id === bulletinId);
        if (!bulletin) return error(`no bulletin with id ${bulletinId}`);
        return [
          `${bulletin.id} - ${bulletin.title}`,
          `published: ${bulletin.publishedOn}`,
          `in effect: ${bulletin.effectiveFrom} to ${bulletin.effectiveTo ?? 'further notice'}`,
          '',
          bulletin.body,
        ].join('\n');
      },
    },
    {
      name: 'get_payment_status',
      description:
        'Read the payment instrument a reservation was paid with and whether it can currently receive funds.',
      readOnly: true,
      schema: { reservationId: z.string() },
      handler: ({ reservationId }: { reservationId: string }) => {
        const reservation = findReservation(world, reservationId);
        if (!reservation) return error(`no reservation with id ${reservationId}`);
        const instrument = instrumentFor(world, reservationId);
        if (!instrument) return `Reservation ${reservationId}: no payment instrument on file.`;
        return [
          `Reservation ${reservationId} was paid with ${instrument.id}`,
          `  instrument: ${instrument.description}`,
          `  status: ${instrument.status}`,
        ].join('\n');
      },
    },
    {
      name: 'get_tier_history',
      description: 'Read the dated history of a passenger frequent-flyer tier.',
      readOnly: true,
      schema: { passengerId: z.string() },
      handler: ({ passengerId }: { passengerId: string }) => {
        const passenger = findPassenger(world, passengerId);
        if (!passenger) return error(`no passenger with id ${passengerId}`);
        const history = world.tierHistory
          .filter((entry) => entry.passengerId === passengerId)
          .sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
        return [
          `Tier history for ${passenger.id} ${passenger.name} (current tier: ${passenger.tier})`,
          ...(history.length === 0
            ? ['  no recorded changes']
            : history.map((entry) => `  from ${entry.effectiveFrom}: ${entry.tier}`)),
        ].join('\n');
      },
    },
    {
      name: 'list_requests',
      description: 'List customer requests in the service queue, optionally by status.',
      readOnly: true,
      schema: { status: z.enum(['open', 'resolved']).optional() },
      handler: ({ status }: { status?: 'open' | 'resolved' }) => {
        const matches = world.requests.filter((request) => !status || request.status === status);
        if (matches.length === 0) return '0 requests matched.';
        return [
          `${matches.length} request(s):`,
          ...matches.map(
            (request) =>
              `  ${request.id} ${request.receivedAt} kind=${request.kind} status=${request.status} reservation=${request.reservationId} passenger=${request.passengerId} "${request.subject}"`,
          ),
        ].join('\n');
      },
    },
    {
      name: 'get_request',
      description: 'Read one customer request in full, including the customer message.',
      readOnly: true,
      schema: { requestId: z.string() },
      handler: ({ requestId }: { requestId: string }) => {
        const request = findRequest(world, requestId);
        if (!request) return error(`no request with id ${requestId}`);
        return [
          `${request.id} (${request.kind}, ${request.status})`,
          `received: ${request.receivedAt}`,
          `passenger: ${request.passengerId}`,
          `reservation: ${request.reservationId}`,
          `subject: ${request.subject}`,
          'message:',
          request.message,
          ...(request.resolution ? ['', `resolution: ${request.resolution}`] : []),
        ].join('\n');
      },
    },
    {
      name: 'list_ledger',
      description: `Search the ledger across all reservations, optionally by category and posting date range (inclusive). Results are paged, ${LEDGER_PAGE_SIZE} entries per page.`,
      readOnly: true,
      schema: {
        category: z.string().optional().describe('e.g. baggage_fee, change_fee, refund'),
        postedFrom: z.string().optional().describe('YYYY-MM-DD'),
        postedTo: z.string().optional().describe('YYYY-MM-DD'),
        page: z.number().int().min(1).optional().describe('1-based page number, default 1'),
      },
      handler: ({
        category,
        postedFrom,
        postedTo,
        page,
      }: {
        category?: string;
        postedFrom?: string;
        postedTo?: string;
        page?: number;
      }) => {
        const matches = world.ledger.filter(
          (entry) =>
            (!category || entry.category === category) &&
            (!postedFrom || (entry.postedOn !== undefined && entry.postedOn >= postedFrom)) &&
            (!postedTo || (entry.postedOn !== undefined && entry.postedOn <= postedTo)),
        );
        const pages = Math.max(1, Math.ceil(matches.length / LEDGER_PAGE_SIZE));
        const current = page ?? 1;
        if (current > pages) return error(`page ${current} does not exist; there are ${pages}`);
        const slice = matches.slice((current - 1) * LEDGER_PAGE_SIZE, current * LEDGER_PAGE_SIZE);
        return [
          `${matches.length} entries matched; page ${current} of ${pages}`,
          ...slice.map((entry) => `  ${entry.reservationId} ${describeLedgerEntry(entry)}`),
        ].join('\n');
      },
    },

    // -----------------------------------------------------------------------
    // Mutations
    // -----------------------------------------------------------------------
    {
      name: 'issue_voucher',
      description:
        'Issue a travel voucher to the passenger on a reservation: compensation, or a hotel night.',
      schema: {
        reservationId: z.string(),
        kind: z.enum(['compensation', 'hotel']),
        amountCents: z.number().int().min(1),
        note: z.string().optional(),
      },
      handler: ({
        reservationId,
        kind,
        amountCents,
        note,
      }: {
        reservationId: string;
        kind: VoucherKind;
        amountCents: number;
        note?: string;
      }) => {
        const reservation = findReservation(world, reservationId);
        if (!reservation) return error(`no reservation with id ${reservationId}`);
        const amount = requireWholeAmount(amountCents);
        if (amount === undefined || amount < 1) return error('amountCents must be a positive integer');
        const voucher: Voucher = {
          id: `V${world.vouchers.length + 1}`,
          reservationId,
          passengerId: reservation.passengerId,
          kind,
          amountCents: amount,
          note: note ?? kind,
        };
        world.vouchers.push(voucher);
        return `Voucher ${voucher.id}: ${kind} ${amount} cents (${formatCents(amount)}) issued to ${reservation.passengerId} on ${reservationId}.`;
      },
    },
    {
      name: 'notify_passenger',
      description: 'Send a message to a passenger by email and text. Delivered immediately.',
      schema: { passengerId: z.string(), message: z.string().min(1) },
      handler: ({ passengerId, message }: { passengerId: string; message: string }) => {
        const passenger = findPassenger(world, passengerId);
        if (!passenger) return error(`no passenger with id ${passengerId}`);
        const notification: PassengerNotification = {
          id: `N${world.notifications.length + 1}`,
          passengerId,
          message: message.trim(),
        };
        world.notifications.push(notification);
        return `Message ${notification.id} delivered to ${passenger.id} ${passenger.name} (${passenger.email}).`;
      },
    },
    {
      name: 'resolve_request',
      description: 'Mark a customer request resolved with a note to the customer.',
      schema: { requestId: z.string(), resolution: z.string().min(1) },
      handler: ({ requestId, resolution }: { requestId: string; resolution: string }) => {
        const request = findRequest(world, requestId);
        if (!request) return error(`no request with id ${requestId}`);
        if (request.status === 'resolved') return error(`request ${requestId} is already resolved`);
        request.status = 'resolved';
        request.resolution = resolution.trim();
        return `Request ${requestId} resolved.`;
      },
    },
    {
      name: 'refund_fee',
      description:
        'Refund part or all of a fee ledger entry to the original payment method. Records a refund entry linked to the fee.',
      schema: { entryId: z.string(), amountCents: z.number().int().min(1), note: z.string().optional() },
      handler: ({
        entryId,
        amountCents,
        note,
      }: {
        entryId: string;
        amountCents: number;
        note?: string;
      }) => {
        const fee = world.ledger.find((entry) => entry.id === entryId);
        if (!fee) return error(`no ledger entry with id ${entryId}`);
        if (fee.kind !== 'fee') return error(`${entryId} is a ${fee.kind} entry, not a fee`);
        const amount = requireWholeAmount(amountCents);
        if (amount === undefined || amount < 1) return error('amountCents must be a positive integer');
        const refunded = feeRefundedCents(world, entryId);
        if (refunded + amount > fee.amountCents) {
          return error(
            `${entryId} was ${fee.amountCents} cents and ${refunded} has already been refunded; ${amount} more would exceed it`,
          );
        }
        const entry = appendLedger(world, {
          reservationId: fee.reservationId,
          kind: 'refund',
          category: 'refund',
          amountCents: amount,
          method: 'original_payment',
          refundOf: entryId,
          postedOn: world.today,
          note: note ?? `refund of ${entryId}`,
        });
        return `Ledger ${entry.id}: refunded ${amount} cents (${formatCents(amount)}) of fee ${entryId} on ${fee.reservationId} to the original payment method.`;
      },
    },
    {
      name: 'annotate_ledger_entry',
      description: 'Record the outcome of an audit on a ledger entry.',
      schema: {
        entryId: z.string(),
        outcome: auditOutcomeSchema,
      },
      handler: ({ entryId, outcome }: { entryId: string; outcome: AuditOutcome }) => {
        const entry = world.ledger.find((candidate) => candidate.id === entryId);
        if (!entry) return error(`no ledger entry with id ${entryId}`);
        const previous = entry.auditOutcome;
        entry.auditOutcome = outcome;
        return `Ledger ${entryId}: audit outcome ${previous ?? 'none'} -> ${outcome}.`;
      },
    },
  ];
}

/** Total refunded against one fee entry. */
export function feeRefundedCents(world: AirlineWorld, feeEntryId: string): number {
  return world.ledger
    .filter((entry: LedgerEntry) => entry.kind === 'refund' && entry.refundOf === feeEntryId)
    .reduce((total, entry) => total + entry.amountCents, 0);
}
