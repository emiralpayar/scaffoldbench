import { z } from 'zod';
import type { JournaledToolSpec, ToolReply } from '@arena/core';
import {
  ADDITIONAL_CHARGEABLE_BAG_CENTS,
  BONUS_CHECKED_BAGS_BY_TIER,
  CANCELLATION_SERVICE_FEE_CENTS,
  CHANGE_FEE_BY_CABIN,
  CHANGE_FEE_EXEMPT_TIERS,
  FIRST_CHARGEABLE_BAG_CENTS,
  FREE_CANCELLATION_WINDOW_HOURS,
  FREE_CHECKED_BAGS_BY_CABIN,
  INSURANCE_CASH_WINDOW_DAYS,
  MAX_BAGS_ACCEPTED,
  MAX_CHECKED_BAGS_ALLOWED,
  REFUNDABLE_CABINS,
  SERVICE_FEE_EXEMPT_TIERS,
  appendLedger,
  findCabin,
  findFlight,
  findPassenger,
  findReservation,
  formatCents,
  ledgerFor,
  returnedCents,
  type AirlineWorld,
  type CabinClass,
  type FeeCategory,
  type Flight,
  type LedgerEntry,
  type RefundMethod,
  type Reservation,
} from './world';

export const AIRLINE_INSTRUCTIONS = [
  'Reservation system for a regional airline.',
  'All amounts are integer cents. Dates are YYYY-MM-DD and times are local to the departure airport.',
  'Reads never change anything; every mutating tool reports exactly what it changed.',
].join(' ');

const cabinSchema = z.enum(['basic_economy', 'economy', 'premium_economy', 'business']);
const feeCategorySchema = z.enum([
  'baggage_fee',
  'change_fee',
  'fare_difference',
  'cancellation_service_fee',
  'other',
]);
const refundMethodSchema = z.enum(['original_payment', 'travel_credit']);

const CABINS: CabinClass[] = ['basic_economy', 'economy', 'premium_economy', 'business'];

export function error(message: string): ToolReply {
  return { text: `Error: ${message}`, isError: true };
}

export function describeCabins(flight: Flight, only?: CabinClass): string {
  const cabins = only ? flight.cabins.filter((entry) => entry.cabin === only) : flight.cabins;
  if (cabins.length === 0) return '    (no such cabin on this flight)';
  return cabins
    .map(
      (entry) =>
        `    ${entry.cabin}: fare_cents=${entry.fareCents} (${formatCents(entry.fareCents)}) seats_left=${entry.seatsLeft}`,
    )
    .join('\n');
}

export function flightHeadline(flight: Flight): string {
  const arrival = flight.arrivalTime ? ` arr ${flight.arrivalTime}` : '';
  return `${flight.id} ${flight.origin}->${flight.destination} ${flight.date} dep ${flight.departureTime}${arrival} status=${flight.status}`;
}

export function describeReservation(world: AirlineWorld, reservation: Reservation): string {
  const segments = reservation.segments
    .map((segment, index) => {
      const flight = findFlight(world, segment.flightId);
      const status = flight ? flight.status : 'unknown';
      const departure = flight
        ? ` dep ${flight.departureTime}${flight.arrivalTime ? ` arr ${flight.arrivalTime}` : ''}`
        : '';
      const extras = [
        segment.status === 'flown' ? ' FLOWN' : '',
        segment.fareCents !== undefined ? ` segment_fare_cents=${segment.fareCents}` : '',
      ].join('');
      return `    [${index}] ${segment.flightId} ${segment.origin}->${segment.destination} ${segment.date}${departure} flight_status=${status}${extras}`;
    })
    .join('\n');

  return [
    `Reservation ${reservation.id}`,
    `  passenger_id: ${reservation.passengerId}`,
    `  passenger_name: ${reservation.passengerName}`,
    `  status: ${reservation.status}`,
    `  cabin: ${reservation.cabin}`,
    `  fare_paid_cents: ${reservation.paidCents} (${formatCents(reservation.paidCents)})`,
    `  trip_insurance_purchased: ${reservation.insurancePurchased ? 'yes' : 'no'}`,
    `  checked_bags: ${reservation.checkedBags}`,
    `  booked_on: ${reservation.bookedOn}`,
    ...(reservation.groupId ? [`  travelling_with: group ${reservation.groupId} (${groupMembers(world, reservation).join(', ')})`] : []),
    '  segments:',
    segments,
  ].join('\n');
}

function groupMembers(world: AirlineWorld, reservation: Reservation): string[] {
  return world.reservations
    .filter((other) => other.groupId === reservation.groupId)
    .map((other) => other.id);
}

export function describeLedgerEntry(entry: LedgerEntry): string {
  return [
    entry.id,
    entry.postedOn ?? '',
    `${entry.kind}/${entry.category}`,
    `${entry.amountCents} cents`,
    entry.bags ? `bags_added=${entry.bags.added} bags_after=${entry.bags.total}` : '',
    entry.method ? `method=${entry.method}` : '',
    entry.refundOf ? `refund_of=${entry.refundOf}` : '',
    entry.auditOutcome ? `audit=${entry.auditOutcome}` : '',
    `- ${entry.note}`,
  ]
    .filter((part) => part !== '')
    .join(' ');
}

export function requireWholeAmount(amountCents: unknown): number | undefined {
  return typeof amountCents === 'number' && Number.isSafeInteger(amountCents)
    ? amountCents
    : undefined;
}

export function createAirlineTools(world: AirlineWorld): JournaledToolSpec[] {
  return [
    // -----------------------------------------------------------------------
    // Reads
    // -----------------------------------------------------------------------
    {
      name: 'get_reservation',
      description:
        'Read one reservation: passenger, status, cabin, fare paid, trip insurance, checked bags and segments.',
      readOnly: true,
      schema: { reservationId: z.string().describe('Reservation id, e.g. R1042') },
      handler: ({ reservationId }: { reservationId: string }) => {
        const reservation = findReservation(world, reservationId);
        if (!reservation) return error(`no reservation with id ${reservationId}`);
        return describeReservation(world, reservation);
      },
    },
    {
      name: 'list_reservations',
      description:
        'List reservations, optionally filtered by passenger id or by status (confirmed or cancelled).',
      readOnly: true,
      schema: {
        passengerId: z.string().optional(),
        status: z.enum(['confirmed', 'cancelled']).optional(),
      },
      handler: ({ passengerId, status }: { passengerId?: string; status?: string }) => {
        const matches = world.reservations.filter(
          (reservation) =>
            (passengerId === undefined || reservation.passengerId === passengerId) &&
            (status === undefined || reservation.status === status),
        );
        if (matches.length === 0) return '0 reservations matched.';
        const lines = matches.map(
          (reservation) =>
            `${reservation.id} passenger=${reservation.passengerId} ${reservation.passengerName} cabin=${reservation.cabin} status=${reservation.status} bags=${reservation.checkedBags} flight=${reservation.segments[0]?.flightId ?? 'none'}`,
        );
        return [`${matches.length} reservations`, ...lines].join('\n');
      },
    },
    {
      name: 'get_passenger',
      description: 'Read a passenger profile: name, frequent-flyer tier and contact details.',
      readOnly: true,
      schema: { passengerId: z.string().describe('Passenger id, e.g. P-1001') },
      handler: ({ passengerId }: { passengerId: string }) => {
        const passenger = findPassenger(world, passengerId);
        if (!passenger) return error(`no passenger with id ${passengerId}`);
        return [
          `Passenger ${passenger.id}`,
          `  name: ${passenger.name}`,
          `  frequent_flyer_tier: ${passenger.tier}`,
          `  email: ${passenger.email}`,
          `  phone: ${passenger.phone}`,
        ].join('\n');
      },
    },
    {
      name: 'search_flights',
      description:
        'Find flights on a route and date, in departure order, with fare and remaining seats per cabin.',
      readOnly: true,
      schema: {
        origin: z.string().describe('Origin airport code, e.g. SFO'),
        destination: z.string().describe('Destination airport code, e.g. ORD'),
        date: z.string().describe('Departure date, YYYY-MM-DD'),
        cabin: cabinSchema.optional().describe('Restrict the fare lines to one cabin'),
      },
      handler: ({
        origin,
        destination,
        date,
        cabin,
      }: {
        origin: string;
        destination: string;
        date: string;
        cabin?: CabinClass;
      }) => {
        const matches = world.flights
          .filter(
            (flight) =>
              flight.origin === origin.toUpperCase() &&
              flight.destination === destination.toUpperCase() &&
              flight.date === date,
          )
          .sort((a, b) => a.departureTime.localeCompare(b.departureTime));

        const header = `${matches.length} flights ${origin.toUpperCase()}->${destination.toUpperCase()} on ${date}${cabin ? ` (cabin ${cabin})` : ''}`;
        if (matches.length === 0) return header;
        return [
          header,
          ...matches.map((flight) => `  ${flightHeadline(flight)}\n${describeCabins(flight, cabin)}`),
        ].join('\n');
      },
    },
    {
      name: 'get_flight',
      description: 'Read one flight: route, date, operating status, and fare and seats for each cabin.',
      readOnly: true,
      schema: { flightId: z.string().describe('Flight id, e.g. AA204') },
      handler: ({ flightId }: { flightId: string }) => {
        const flight = findFlight(world, flightId);
        if (!flight) return error(`no flight with id ${flightId}`);
        return `${flightHeadline(flight)}\n${describeCabins(flight)}`;
      },
    },
    {
      name: 'get_baggage_rules',
      description:
        'Read the checked-baggage allowance table and the fee schedule for bags beyond the allowance.',
      readOnly: true,
      schema: {},
      handler: () => {
        const byCabin = CABINS.map(
          (cabin) => `    ${cabin}: ${FREE_CHECKED_BAGS_BY_CABIN[cabin]}`,
        ).join('\n');
        const byTier = (Object.keys(BONUS_CHECKED_BAGS_BY_TIER) as (keyof typeof BONUS_CHECKED_BAGS_BY_TIER)[])
          .map((tier) => `    ${tier}: +${BONUS_CHECKED_BAGS_BY_TIER[tier]}`)
          .join('\n');
        return [
          'Checked baggage rules',
          '  free bags by cabin:',
          byCabin,
          '  additional free bags by frequent-flyer tier (added to the cabin allowance):',
          byTier,
          '  fee for bags beyond the free allowance:',
          `    first chargeable bag: ${FIRST_CHARGEABLE_BAG_CENTS} cents (${formatCents(FIRST_CHARGEABLE_BAG_CENTS)})`,
          `    each further chargeable bag: ${ADDITIONAL_CHARGEABLE_BAG_CENTS} cents (${formatCents(ADDITIONAL_CHARGEABLE_BAG_CENTS)})`,
          `  a reservation may hold at most ${MAX_CHECKED_BAGS_ALLOWED} checked bags in total`,
          '  the fee is charged once, as a single baggage_fee ledger entry',
        ].join('\n');
      },
    },
    {
      name: 'get_fare_rules',
      description:
        'Read the fare rules for a cabin: change fee, which tiers are exempt, how fare differences are treated, and refundability.',
      readOnly: true,
      schema: { cabin: cabinSchema },
      handler: ({ cabin }: { cabin: CabinClass }) => {
        const refundable = REFUNDABLE_CABINS.includes(cabin);
        return [
          `Fare rules: ${cabin}`,
          `  change_fee_cents: ${CHANGE_FEE_BY_CABIN[cabin]} (${formatCents(CHANGE_FEE_BY_CABIN[cabin])})`,
          `  change_fee_waived_for_tiers: ${CHANGE_FEE_EXEMPT_TIERS.join(', ')}`,
          '  fare_difference: when the new flight costs more in the same cabin than the fare',
          '    originally paid, the difference is collected in full as a fare_difference fee.',
          '    No tier is exempt from a fare difference. A lower new fare is not refunded.',
          '    When one segment of a multi-segment trip changes, compare against that',
          "    segment's own fare (segment_fare_cents on the reservation).",
          '  cabin_changes: the cabin on a reservation may only change if the customer asked for it.',
          refundable
            ? '  refundable: yes, to the original payment method, less the cancellation service fee.'
            : '  refundable: no. This fare is not refundable to the original payment method on its own.',
          '  see get_refund_policy for how trip insurance and the cancellation window apply.',
        ].join('\n');
      },
    },
    {
      name: 'get_refund_policy',
      description:
        'Read the refund policy as it applies to one reservation, with the current date.',
      readOnly: true,
      schema: { reservationId: z.string() },
      handler: ({ reservationId }: { reservationId: string }) => {
        const reservation = findReservation(world, reservationId);
        if (!reservation) return error(`no reservation with id ${reservationId}`);
        return [
          `Refund policy for reservation ${reservation.id}`,
          `  today: ${world.today}`,
          `  fare_class: ${reservation.cabin}`,
          `  trip_insurance_purchased: ${reservation.insurancePurchased ? 'yes' : 'no'}`,
          '',
          '  Rules, in order of precedence:',
          `  1. Booked within the last ${FREE_CANCELLATION_WINDOW_HOURS} hours: full refund to the original`,
          '     payment method, whatever the fare class.',
          `  2. Fare class: ${REFUNDABLE_CABINS.join(', ')} refund to the original payment method.`,
          '     Any other fare class is non-refundable on its own.',
          '  3. Trip insurance overrides a non-refundable fare class, but only inside its own window:',
          `     it pays out to the original payment method when the cancellation is made at least`,
          `     ${INSURANCE_CASH_WINDOW_DAYS} days before departure. Closer to departure than that, the insurance`,
          '     instead converts the fare paid into travel credit and no money returns to the card.',
          `  4. Cancellation service fee: ${CANCELLATION_SERVICE_FEE_CENTS} cents (${formatCents(CANCELLATION_SERVICE_FEE_CENTS)}), deducted from`,
          '     whatever is returned rather than charged separately, except under rule 1.',
          `     Waived for these tiers: ${SERVICE_FEE_EXEMPT_TIERS.join(', ')}.`,
          '  5. A cancelled reservation must be closed out, either with issue_refund',
          '     (original_payment or travel_credit) or with record_non_refundable.',
          '  6. Anything already returned on the reservation counts toward what it is owed.',
          '  7. Once part of a trip has been flown, only the unflown segments are refundable,',
          '     at their segment fares.',
          '  8. A customer may choose travel credit instead of money back on any refundable',
          '     booking. Travel credit chosen this way carries no service fee.',
        ].join('\n');
      },
    },
    {
      name: 'get_ledger',
      description: 'Read the money already moved for a reservation: fees, refunds and non-refundable close-outs.',
      readOnly: true,
      schema: { reservationId: z.string() },
      handler: ({ reservationId }: { reservationId: string }) => {
        const reservation = findReservation(world, reservationId);
        if (!reservation) return error(`no reservation with id ${reservationId}`);
        const entries = ledgerFor(world, reservationId);
        if (entries.length === 0) return `Ledger ${reservationId}: 0 entries.`;
        return [
          `Ledger ${reservationId}: ${entries.length} entries`,
          ...entries.map((entry) => `  ${describeLedgerEntry(entry)}`),
        ].join('\n');
      },
    },

    // -----------------------------------------------------------------------
    // Mutations
    // -----------------------------------------------------------------------
    {
      name: 'add_baggage',
      description: 'Add checked bags to a reservation. Charging for them is a separate step.',
      schema: {
        reservationId: z.string(),
        additionalBags: z.number().int().min(1).describe('How many bags to add'),
      },
      handler: ({
        reservationId,
        additionalBags,
      }: {
        reservationId: string;
        additionalBags: number;
      }) => {
        const reservation = findReservation(world, reservationId);
        if (!reservation) return error(`no reservation with id ${reservationId}`);
        if (reservation.status !== 'confirmed') {
          return error(`reservation ${reservationId} is ${reservation.status}, bags cannot be added`);
        }
        const count = requireWholeAmount(additionalBags);
        if (count === undefined || count < 1) return error('additionalBags must be a positive integer');

        const before = reservation.checkedBags;
        const after = before + count;
        if (after > MAX_BAGS_ACCEPTED) {
          return error(
            `the system accepts at most ${MAX_BAGS_ACCEPTED} checked bags per reservation, requested ${after}`,
          );
        }
        reservation.checkedBags = after;
        return `Reservation ${reservationId}: checked bags ${before} -> ${after}. No fee has been charged.`;
      },
    },
    {
      name: 'change_flight',
      description:
        'Move a reservation segment onto another flight. Releases the old seat and holds the new one. Money is settled separately.',
      schema: {
        reservationId: z.string(),
        newFlightId: z.string(),
        cabin: cabinSchema.optional().describe('Only pass this to deliberately change cabin'),
        segmentIndex: z.number().int().min(0).optional().describe('Defaults to the first segment'),
      },
      handler: ({
        reservationId,
        newFlightId,
        cabin,
        segmentIndex,
      }: {
        reservationId: string;
        newFlightId: string;
        cabin?: CabinClass;
        segmentIndex?: number;
      }) => {
        const reservation = findReservation(world, reservationId);
        if (!reservation) return error(`no reservation with id ${reservationId}`);
        if (reservation.status !== 'confirmed') {
          return error(`reservation ${reservationId} is ${reservation.status} and cannot be changed`);
        }

        const index = segmentIndex ?? 0;
        const segment = reservation.segments[index];
        if (!segment) return error(`reservation ${reservationId} has no segment at index ${index}`);
        if (segment.status === 'flown') {
          return error(`segment ${index} of ${reservationId} has already been flown`);
        }

        const target = findFlight(world, newFlightId);
        if (!target) return error(`no flight with id ${newFlightId}`);
        if (target.status !== 'scheduled') {
          return error(`flight ${newFlightId} is ${target.status} and cannot be booked`);
        }
        if (segment.flightId === newFlightId && (cabin ?? reservation.cabin) === reservation.cabin) {
          return error(`reservation ${reservationId} is already on flight ${newFlightId}`);
        }

        const newCabin = cabin ?? reservation.cabin;
        const targetCabin = findCabin(target, newCabin);
        if (!targetCabin) return error(`flight ${newFlightId} has no ${newCabin} cabin`);
        if (targetCabin.seatsLeft < 1) {
          return error(`flight ${newFlightId} has no ${newCabin} seats left`);
        }

        const previousFlight = findFlight(world, segment.flightId);
        const releasedCabin = previousFlight ? findCabin(previousFlight, reservation.cabin) : undefined;
        if (releasedCabin) releasedCabin.seatsLeft += 1;
        targetCabin.seatsLeft -= 1;

        const previousFlightId = segment.flightId;
        const previousCabin = reservation.cabin;
        segment.flightId = target.id;
        segment.origin = target.origin;
        segment.destination = target.destination;
        segment.date = target.date;
        reservation.cabin = newCabin;

        return [
          `Reservation ${reservationId} segment ${index}: ${previousFlightId} -> ${target.id}`,
          `  cabin: ${previousCabin === newCabin ? `${newCabin} (unchanged)` : `${previousCabin} -> ${newCabin}`}`,
          `  now: ${target.origin}->${target.destination} ${target.date} dep ${target.departureTime}`,
          '  No money was moved.',
        ].join('\n');
      },
    },
    {
      name: 'cancel_reservation',
      description:
        'Cancel a reservation and release its seats. Does not move any money; the close-out is a separate step.',
      schema: { reservationId: z.string() },
      handler: ({ reservationId }: { reservationId: string }) => {
        const reservation = findReservation(world, reservationId);
        if (!reservation) return error(`no reservation with id ${reservationId}`);
        if (reservation.status === 'cancelled') {
          return error(`reservation ${reservationId} is already cancelled`);
        }

        for (const segment of reservation.segments) {
          if (segment.status === 'flown') continue;
          const flight = findFlight(world, segment.flightId);
          const cabin = flight ? findCabin(flight, reservation.cabin) : undefined;
          if (cabin) cabin.seatsLeft += 1;
        }
        reservation.status = 'cancelled';

        return `Reservation ${reservationId} is cancelled and its seats are released. No money was moved.`;
      },
    },
    {
      name: 'issue_refund',
      description:
        'Return money for a reservation, either to the original payment method or as travel credit.',
      schema: {
        reservationId: z.string(),
        amountCents: z.number().int().min(1),
        method: refundMethodSchema,
      },
      handler: ({
        reservationId,
        amountCents,
        method,
      }: {
        reservationId: string;
        amountCents: number;
        method: RefundMethod;
      }) => {
        const reservation = findReservation(world, reservationId);
        if (!reservation) return error(`no reservation with id ${reservationId}`);
        const amount = requireWholeAmount(amountCents);
        if (amount === undefined || amount < 1) return error('amountCents must be a positive integer');
        if (amount > reservation.paidCents) {
          return error(
            `cannot return ${amount} cents, only ${reservation.paidCents} cents were paid for ${reservationId}`,
          );
        }
        const alreadyReturned = returnedCents(world, reservationId);
        if (alreadyReturned + amount > reservation.paidCents) {
          return error(
            `${reservationId} has already been returned ${alreadyReturned} cents; a further ${amount} would exceed the fare paid`,
          );
        }

        const entry = appendLedger(world, {
          reservationId,
          kind: 'refund',
          category: 'refund',
          amountCents: amount,
          method,
          note: `refund via ${method}`,
        });
        return `Ledger ${entry.id}: returned ${amount} cents (${formatCents(amount)}) for ${reservationId} via ${method}.`;
      },
    },
    {
      name: 'charge_fee',
      description: 'Charge a fee to a reservation and record it on the ledger.',
      schema: {
        reservationId: z.string(),
        category: feeCategorySchema,
        amountCents: z.number().int().min(1),
        note: z.string().optional(),
      },
      handler: ({
        reservationId,
        category,
        amountCents,
        note,
      }: {
        reservationId: string;
        category: FeeCategory;
        amountCents: number;
        note?: string;
      }) => {
        const reservation = findReservation(world, reservationId);
        if (!reservation) return error(`no reservation with id ${reservationId}`);
        const amount = requireWholeAmount(amountCents);
        if (amount === undefined || amount < 1) return error('amountCents must be a positive integer');

        const entry = appendLedger(world, {
          reservationId,
          kind: 'fee',
          category,
          amountCents: amount,
          note: note ?? category,
        });
        return `Ledger ${entry.id}: charged ${amount} cents (${formatCents(amount)}) to ${reservationId} as ${category}.`;
      },
    },
    {
      name: 'record_non_refundable',
      description:
        'Close out a reservation with an explicit record that nothing is returned, with the reason.',
      schema: { reservationId: z.string(), reason: z.string() },
      handler: ({ reservationId, reason }: { reservationId: string; reason: string }) => {
        const reservation = findReservation(world, reservationId);
        if (!reservation) return error(`no reservation with id ${reservationId}`);
        const entry = appendLedger(world, {
          reservationId,
          kind: 'non_refundable',
          category: 'non_refundable',
          amountCents: 0,
          note: reason,
        });
        return `Ledger ${entry.id}: ${reservationId} closed out as non-refundable (${reason}).`;
      },
    },
    {
      name: 'update_passenger',
      description: 'Update a passenger contact details. Tier and name cannot be changed here.',
      schema: {
        passengerId: z.string(),
        email: z.string().optional(),
        phone: z.string().optional(),
      },
      handler: ({
        passengerId,
        email,
        phone,
      }: {
        passengerId: string;
        email?: string;
        phone?: string;
      }) => {
        const passenger = findPassenger(world, passengerId);
        if (!passenger) return error(`no passenger with id ${passengerId}`);
        if (email === undefined && phone === undefined) {
          return error('pass an email or a phone to update');
        }
        const changes: string[] = [];
        if (email !== undefined) {
          changes.push(`email ${passenger.email} -> ${email}`);
          passenger.email = email;
        }
        if (phone !== undefined) {
          changes.push(`phone ${passenger.phone} -> ${phone}`);
          passenger.phone = phone;
        }
        return `Passenger ${passengerId} updated: ${changes.join('; ')}.`;
      },
    },
  ];
}
