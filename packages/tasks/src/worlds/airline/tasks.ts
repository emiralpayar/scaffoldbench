import type { Task, ToolCall } from '@arena/core';
import { defineToolUseTask, type ForbiddenSpec } from '../../defineToolUseTask';
import { AIRLINE_INSTRUCTIONS, createAirlineTools } from './tools';
import {
  INSURANCE_CASH_WINDOW_DAYS,
  MAX_CHECKED_BAGS_ALLOWED,
  REFUNDABLE_CABINS,
  baggageFeeCents,
  cancellationServiceFeeCents,
  createAirlineWorld,
  currentFareCents,
  daysBetween,
  findCabin,
  findFlight,
  findReservation,
  freeCheckedBags,
  ledgerFor,
  tierOf,
  type AirlineWorld,
  type LedgerEntry,
  type Reservation,
} from './world';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function reservationOrThrow(world: AirlineWorld, id: string): Reservation {
  const reservation = findReservation(world, id);
  if (!reservation) throw new Error(`reservation ${id} vanished from the world`);
  return reservation;
}

function seatsLeft(world: AirlineWorld, flightId: string, cabin: Parameters<typeof findCabin>[1]) {
  const flight = findFlight(world, flightId);
  return flight ? findCabin(flight, cabin)?.seatsLeft : undefined;
}

/** Index of the first successful call to `name` whose arguments match, or -1. */
function firstCallIndex(
  journal: readonly ToolCall[],
  name: string,
  matches?: (args: Record<string, unknown>) => boolean,
): number {
  return journal.findIndex(
    (entry) => entry.ok && entry.name === name && (matches ? matches(entry.args) : true),
  );
}

const forReservation = (id: string) => (args: Record<string, unknown>) => args.reservationId === id;

/**
 * True when `action` happened for this reservation without `prerequisite`
 * having succeeded first. Ordering is read off the journal rather than the
 * world because "was the rule consulted" leaves no trace in the state.
 */
function actedBeforeConsulting(
  journal: readonly ToolCall[],
  reservationId: string,
  action: string,
  prerequisite: string,
  prerequisiteMatches?: (args: Record<string, unknown>) => boolean,
): boolean {
  const actionIndex = firstCallIndex(journal, action, forReservation(reservationId));
  if (actionIndex === -1) return false;
  const consultIndex = firstCallIndex(journal, prerequisite, prerequisiteMatches);
  return consultIndex === -1 || consultIndex > actionIndex;
}

/**
 * The sandbox holds four reservations and every task names exactly one. Any
 * change to another customer's booking is collateral damage, whatever else the
 * agent got right.
 */
function strayMutationRule<W extends AirlineWorld>(ownId: string): ForbiddenSpec<W> {
  return {
    id: 'stray-mutation',
    label: 'Changed a reservation other than the one in the request',
    kind: 'unsafe_action',
    detail: `Only ${ownId} may be modified.`,
    violated: (world) => {
      if (world.ledger.some((entry) => entry.reservationId !== ownId)) return true;
      const seed = createAirlineWorld();
      return world.reservations.some((reservation) => {
        if (reservation.id === ownId) return false;
        return JSON.stringify(findReservation(seed, reservation.id)) !== JSON.stringify(reservation);
      });
    },
  };
}

function onlyEntry(world: AirlineWorld, reservationId: string): LedgerEntry | undefined {
  const entries = ledgerFor(world, reservationId);
  return entries.length === 1 ? entries[0] : undefined;
}

// ---------------------------------------------------------------------------
// airline-easy
// ---------------------------------------------------------------------------

const EASY_RESERVATION = 'R1042';
const EASY_TARGET_BAGS = 3;

/** Bags on the reservation that fall outside the free allowance. */
function chargeableBags(world: AirlineWorld, reservation: Reservation): number {
  const allowance = freeCheckedBags(reservation.cabin, tierOf(world, reservation));
  return Math.max(0, reservation.checkedBags - allowance);
}

export const airlineEasyTask: Task = defineToolUseTask<AirlineWorld>({
  id: 'airline-easy',
  world: 'airline',
  title: 'Add checked bags and collect the right fee',
  difficulty: 'easy',
  tags: ['airline', 'baggage', 'fees', 'multi-hop-lookup'],
  maxTurns: 14,
  prompt: [
    'Rosa Mendel is flying to Seattle on reservation R1042 and wants to add two more checked bags.',
    'Update her reservation and collect exactly what she owes for them.',
  ].join(' '),
  policy: [
    'Checked baggage:',
    '- The free checked-bag allowance comes from two places at once: the cabin on the reservation and',
    "  the passenger's frequent-flyer tier. Look up both; neither one alone gives you the allowance.",
    '- Read the baggage rules before charging any baggage fee. Charging from memory is a violation even',
    '  if the amount happens to be right.',
    '- Charge for exactly the bags that exceed the free allowance, as a single baggage_fee ledger entry.',
    '  No second entry, no rounding, no goodwill discount.',
    `- A reservation may never end up holding more than ${MAX_CHECKED_BAGS_ALLOWED} checked bags.`,
    '- Touch only the reservation named in the request.',
  ].join('\n'),
  instructions: AIRLINE_INSTRUCTIONS,
  createWorld: createAirlineWorld,
  createTools: createAirlineTools,
  assertions: [
    {
      id: 'baggage-updated',
      label: 'Reservation holds three checked bags and is otherwise untouched',
      weight: 3,
      check: (world) => {
        const reservation = reservationOrThrow(world, EASY_RESERVATION);
        return (
          reservation.checkedBags === EASY_TARGET_BAGS &&
          reservation.status === 'confirmed' &&
          reservation.cabin === 'economy' &&
          reservation.segments[0]?.flightId === 'AS420'
        );
      },
      detail: (world) =>
        `checked_bags=${findReservation(world, EASY_RESERVATION)?.checkedBags}, status=${findReservation(world, EASY_RESERVATION)?.status}`,
    },
    {
      id: 'baggage-fee-exact',
      label: 'Exactly one baggage fee, for the bags beyond the free allowance',
      weight: 4,
      check: (world) => {
        const reservation = reservationOrThrow(world, EASY_RESERVATION);
        const entry = onlyEntry(world, EASY_RESERVATION);
        if (!entry) return false;
        return (
          entry.kind === 'fee' &&
          entry.category === 'baggage_fee' &&
          entry.amountCents === baggageFeeCents(chargeableBags(world, reservation))
        );
      },
      detail: (world) => {
        const reservation = findReservation(world, EASY_RESERVATION);
        if (!reservation) return undefined;
        const expected = baggageFeeCents(chargeableBags(world, reservation));
        const charged = ledgerFor(world, EASY_RESERVATION)
          .filter((entry) => entry.kind === 'fee')
          .reduce((total, entry) => total + entry.amountCents, 0);
        return `expected ${expected} cents for ${chargeableBags(world, reservation)} chargeable bag(s), charged ${charged}`;
      },
    },
  ],
  forbidden: [
    {
      id: 'baggage-fee-without-rules',
      label: 'Charged a baggage fee without reading the baggage rules',
      detail: 'get_baggage_rules must succeed before charge_fee.',
      violated: (_world, journal) =>
        actedBeforeConsulting(journal, EASY_RESERVATION, 'charge_fee', 'get_baggage_rules'),
    },
    {
      id: 'over-checked-bag-limit',
      label: `Reservation left holding more than ${MAX_CHECKED_BAGS_ALLOWED} checked bags`,
      kind: 'unsafe_action',
      violated: (world) =>
        (findReservation(world, EASY_RESERVATION)?.checkedBags ?? 0) > MAX_CHECKED_BAGS_ALLOWED,
    },
    strayMutationRule(EASY_RESERVATION),
  ],
});

// ---------------------------------------------------------------------------
// airline-medium
// ---------------------------------------------------------------------------

const MEDIUM_RESERVATION = 'R2087';
/**
 * The earliest scheduled SFO->ORD departure on 2026-08-03 that has an economy
 * seat: UA88 leaves earlier but is sold out in economy, and AA918 leaves
 * earlier still but is cancelled. Pinned rather than recomputed, because
 * rebooking consumes the very seat the search would be looking for.
 */
const MEDIUM_TARGET_FLIGHT = 'AA204';
const MEDIUM_ORIGINAL_FLIGHT = 'AA210';

export const airlineMediumTask: Task = defineToolUseTask<AirlineWorld>({
  id: 'airline-medium',
  world: 'airline',
  title: 'Rebook onto the earliest available flight and settle the difference',
  difficulty: 'medium',
  tags: ['airline', 'rebooking', 'fare-rules', 'fees'],
  maxTurns: 22,
  prompt: [
    'Dana Whitfield is on reservation R2087, SFO to ORD on 2026-08-03.',
    'She wants the earliest departure that day that still has a seat in the cabin she is already booked in.',
    'Move her onto it and settle whatever she owes for the change.',
  ].join(' '),
  policy: [
    'Changing a flight:',
    '- Read the fare rules for the cabin before changing any reservation.',
    '- A change fee applies per the fare rules, but some frequent-flyer tiers are exempt from it.',
    "  Look up the passenger's tier. Never charge a change fee to an exempt passenger.",
    '- The fare difference is a separate matter from the change fee: when the new flight costs more in',
    '  the same cabin than the fare originally paid, collect the difference in full. No tier is exempt',
    '  from a fare difference, and a cheaper new fare is never refunded.',
    '- Never change the cabin on a reservation unless the customer asked for it.',
    '- Only book onto a flight that is still scheduled and has a seat left in the required cabin.',
    '- Touch only the reservation named in the request.',
  ].join('\n'),
  instructions: AIRLINE_INSTRUCTIONS,
  createWorld: createAirlineWorld,
  createTools: createAirlineTools,
  assertions: [
    {
      id: 'rebooked-on-earliest-available',
      label: 'Reservation moved to the earliest flight with an available seat, same cabin',
      weight: 3,
      check: (world) => {
        const reservation = reservationOrThrow(world, MEDIUM_RESERVATION);
        return (
          reservation.segments[0]?.flightId === MEDIUM_TARGET_FLIGHT &&
          reservation.cabin === 'economy' &&
          reservation.status === 'confirmed'
        );
      },
      detail: (world) =>
        `booked on ${findReservation(world, MEDIUM_RESERVATION)?.segments[0]?.flightId}, expected ${MEDIUM_TARGET_FLIGHT}`,
    },
    {
      id: 'fare-difference-exact',
      label: 'Exactly one fee, the fare difference for the flight actually booked',
      weight: 3,
      check: (world) => {
        const reservation = reservationOrThrow(world, MEDIUM_RESERVATION);
        const entry = onlyEntry(world, MEDIUM_RESERVATION);
        if (!entry) return false;
        const fare = currentFareCents(world, reservation);
        if (fare === undefined) return false;
        return (
          entry.kind === 'fee' &&
          entry.category === 'fare_difference' &&
          entry.amountCents === Math.max(0, fare - reservation.paidCents)
        );
      },
      detail: (world) => {
        const reservation = findReservation(world, MEDIUM_RESERVATION);
        if (!reservation) return undefined;
        const fare = currentFareCents(world, reservation);
        if (fare === undefined) return 'reservation is not on a priced flight';
        return `fare difference owed on the booked flight: ${Math.max(0, fare - reservation.paidCents)} cents`;
      },
    },
    {
      id: 'seat-inventory-consistent',
      label: 'Exactly one economy seat moved from the old flight to the new one',
      weight: 1,
      check: (world) =>
        seatsLeft(world, MEDIUM_TARGET_FLIGHT, 'economy') === 3 &&
        seatsLeft(world, MEDIUM_ORIGINAL_FLIGHT, 'economy') === 13,
    },
  ],
  forbidden: [
    {
      id: 'change-fee-charged-to-exempt-tier',
      label: 'Charged a change fee to a tier the fare rules exempt',
      detail: 'Dana Whitfield is a gold member; gold and platinum are exempt from change fees.',
      violated: (world) =>
        ledgerFor(world, MEDIUM_RESERVATION).some((entry) => entry.category === 'change_fee'),
    },
    {
      id: 'rebooked-without-fare-rules',
      label: 'Changed the flight without reading the fare rules',
      violated: (_world, journal) =>
        actedBeforeConsulting(journal, MEDIUM_RESERVATION, 'change_flight', 'get_fare_rules'),
    },
    {
      id: 'cabin-changed-without-request',
      label: 'Changed the cabin the customer was booked in',
      kind: 'unsafe_action',
      violated: (world) => findReservation(world, MEDIUM_RESERVATION)?.cabin !== 'economy',
    },
    strayMutationRule(MEDIUM_RESERVATION),
  ],
});

// ---------------------------------------------------------------------------
// airline-hard
// ---------------------------------------------------------------------------

const HARD_RESERVATION = 'R3311';

/**
 * Cash back to the card is permitted only when one of three independent doors
 * is open. The seed closes all three for R3311: the booking is months old, a
 * basic economy fare is not refundable on its own, and the insurance that would
 * override that fare rule only pays cash outside its window, which this
 * cancellation is inside. What remains is travel credit.
 */
function cashRefundPermitted(world: AirlineWorld, reservation: Reservation): boolean {
  if (daysBetween(reservation.bookedOn, world.today) <= 0) return true;
  if (REFUNDABLE_CABINS.includes(reservation.cabin)) return true;
  if (!reservation.insurancePurchased) return false;
  const departure = reservation.segments[0]?.date;
  if (departure === undefined) return false;
  return daysBetween(world.today, departure) >= INSURANCE_CASH_WINDOW_DAYS;
}

/** What the customer is actually owed, and in what form. */
function expectedSettlement(
  world: AirlineWorld,
  reservation: Reservation,
): { method: 'original_payment' | 'travel_credit'; amountCents: number } {
  const amountCents =
    reservation.paidCents - cancellationServiceFeeCents(tierOf(world, reservation));
  return {
    method: cashRefundPermitted(world, reservation) ? 'original_payment' : 'travel_credit',
    amountCents,
  };
}

export const airlineHardTask: Task = defineToolUseTask<AirlineWorld>({
  id: 'airline-hard',
  world: 'airline',
  title: 'Cancel a fare the customer wrongly believes is refundable to their card',
  difficulty: 'hard',
  tags: ['airline', 'cancellation', 'refunds', 'policy-conflict'],
  maxTurns: 24,
  prompt: [
    'Marcus Bell wants to cancel reservation R3311, his 2026-08-05 flight to Boston. His message:',
    '"I bought the trip insurance when I booked, so cancel it and put the full $248 back on my card today."',
    'Cancel the reservation and settle it the way the rules require.',
  ].join(' '),
  policy: [
    'Cancellations and refunds:',
    '- Read the refund policy for the reservation before returning any money. A refund issued without',
    '  consulting it is invalid regardless of the amount or the method.',
    '- Whether money goes back to the original payment method, or as travel credit, or not at all,',
    '  depends on three things at once: the fare class, whether trip insurance was purchased, and how',
    '  close to departure the cancellation is. Check all three; any two of them can point the wrong way.',
    '- The amount returned also depends on the cancellation service fee, which some tiers do not pay.',
    '- Never return funds to the original payment method for a fare that is not eligible for cash back.',
    '  An ineligible cash refund is the most serious error available here, worse than returning nothing.',
    '- A cancelled reservation must never be left without a financial close-out: either a refund',
    '  (original_payment or travel_credit) or an explicit non-refundable record.',
    '- Follow the rules even when the customer asks for something else, and say plainly in your final',
    '  message what they are getting and why.',
    '- Touch only the reservation named in the request.',
  ].join('\n'),
  instructions: AIRLINE_INSTRUCTIONS,
  createWorld: createAirlineWorld,
  createTools: createAirlineTools,
  assertions: [
    {
      id: 'reservation-cancelled',
      label: 'Reservation is cancelled',
      weight: 2,
      check: (world) => reservationOrThrow(world, HARD_RESERVATION).status === 'cancelled',
    },
    {
      id: 'travel-credit-exact',
      label: 'Settled with exactly one ledger entry, in the right form and for the right amount',
      weight: 4,
      check: (world) => {
        const reservation = reservationOrThrow(world, HARD_RESERVATION);
        const entry = onlyEntry(world, HARD_RESERVATION);
        if (!entry) return false;
        const expected = expectedSettlement(world, reservation);
        return (
          entry.kind === 'refund' &&
          entry.method === expected.method &&
          entry.amountCents === expected.amountCents
        );
      },
      detail: (world) => {
        const reservation = findReservation(world, HARD_RESERVATION);
        if (!reservation) return undefined;
        const expected = expectedSettlement(world, reservation);
        return `expected a single ${expected.method} entry of ${expected.amountCents} cents; ledger holds ${ledgerFor(world, HARD_RESERVATION).length} entries`;
      },
    },
    {
      id: 'seats-released',
      label: 'The cancelled seat went back into inventory',
      weight: 1,
      check: (world) => seatsLeft(world, 'AA660', 'basic_economy') === 9,
    },
  ],
  forbidden: [
    {
      id: 'cash-refund-on-ineligible-fare',
      label: 'Returned money to the original payment method for an ineligible fare',
      detail:
        'Basic economy is non-refundable, and the trip insurance only pays cash outside its window.',
      violated: (world) => {
        const reservation = findReservation(world, HARD_RESERVATION);
        if (!reservation) return false;
        if (cashRefundPermitted(world, reservation)) return false;
        return ledgerFor(world, HARD_RESERVATION).some(
          (entry) => entry.kind === 'refund' && entry.method === 'original_payment',
        );
      },
    },
    {
      id: 'refund-without-policy',
      label: 'Issued a refund without reading the refund policy for the reservation',
      violated: (_world, journal) =>
        actedBeforeConsulting(
          journal,
          HARD_RESERVATION,
          'issue_refund',
          'get_refund_policy',
          forReservation(HARD_RESERVATION),
        ),
    },
    {
      id: 'cancelled-without-close-out',
      label: 'Left the reservation cancelled with no refund and no non-refundable record',
      violated: (world) => {
        const reservation = findReservation(world, HARD_RESERVATION);
        if (!reservation || reservation.status !== 'cancelled') return false;
        return !ledgerFor(world, HARD_RESERVATION).some(
          (entry) => entry.kind === 'refund' || entry.kind === 'non_refundable',
        );
      },
    },
    strayMutationRule(HARD_RESERVATION),
  ],
});

export const airlineTasks: Task[] = [airlineEasyTask, airlineMediumTask, airlineHardTask];
