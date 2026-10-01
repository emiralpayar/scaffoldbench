import type { Task } from '@arena/core';
import {
  defineToolUseTask,
  type AssertionSpec,
  type ToolUseTaskSpec,
} from '../../../defineToolUseTask';
import { addedTo, anyOf, blastRadiusRule, within } from '../../../worldDiff';
import {
  COMPENSATION_LONG_CENTS,
  COMPENSATION_SHORT_CENTS,
  HOTEL_VOUCHER_CENTS,
  MIN_CONNECTION_MINUTES,
} from '../handbook';
import { emptyOps, minutesBetween, type AirlineOpsWorld } from '../ops';
import { seatCounts } from '../tasks';
import {
  findFlight,
  findPassenger,
  type CabinClass,
  type Flight,
  type Reservation,
} from '../world';
import {
  AIRLINE_EXPERT_BASE,
  CABIN_RANK,
  OPS_DIFF,
  TIER_RANK,
  flight,
  passenger,
  reservation,
  reservationOrThrow,
} from './common';

/**
 * airline-irrops-reprotect: re-protect everyone on a cancelled flight when
 * there are not enough seats to go round.
 *
 * Eight passengers, three cabins, and a day of flights with one or two seats
 * left in each cabin. Who gets which seat is decided by a priority order
 * (tier, then booking date) that differs from the order the manifest lists
 * them in, and from booking-date order alone. One passenger has an onward
 * connection that the obvious replacement breaks, and whose delay must be
 * measured at the final destination rather than at the connecting airport.
 * Another can only be protected the next day, which brings a hotel voucher.
 */

const CANCELLED_FLIGHT = 'AA918';
const TODAY = '2026-08-02';
const DAY = '2026-08-03';
const NEXT_DAY = '2026-08-04';

export function createIrropsWorld(): AirlineOpsWorld {
  const flights: Flight[] = [
    flight('UA88', 'SFO-ORD', DAY, '06:15-12:25', {
      basic_economy: [24_000, 1],
      economy: [27_000, 0],
      business: [78_000, 1],
    }),
    flight(
      'AA918',
      'SFO-ORD',
      DAY,
      '07:30-13:40',
      { basic_economy: [25_500, 4], economy: [30_000, 3], business: [80_000, 2] },
      'cancelled',
    ),
    flight('AA204', 'SFO-ORD', DAY, '09:05-15:15', {
      basic_economy: [33_000, 1],
      economy: [39_000, 2],
      business: [91_000, 0],
    }),
    flight('DL512', 'SFO-ORD', DAY, '12:30-18:40', {
      basic_economy: [29_000, 0],
      economy: [33_500, 1],
      business: [84_000, 1],
    }),
    flight('AA210', 'SFO-ORD', DAY, '17:40-23:50', {
      basic_economy: [26_500, 2],
      economy: [31_000, 1],
      business: [80_000, 0],
    }),
    flight('AA206', 'SFO-ORD', NEXT_DAY, '09:05-15:15', {
      basic_economy: [31_000, 6],
      economy: [37_000, 8],
      business: [88_000, 2],
    }),
    flight('AA1402', 'ORD-BOS', DAY, '15:30-18:55', { economy: [18_000, 3] }),
    flight('AA1408', 'ORD-BOS', DAY, '19:10-22:35', { economy: [18_000, 2] }),
    flight('AA1406', 'ORD-BOS', DAY, '19:55-23:20', { economy: [16_000, 5] }),
  ];
  const byId = (id: string) => flights.find((entry) => entry.id === id) as Flight;

  const pax = [
    passenger('P-2101', 'Ana Ruiz', 'none'),
    passenger('P-2102', 'Ben Okafor', 'gold'),
    passenger('P-2103', 'Chloe Park', 'platinum'),
    passenger('P-2104', 'Dev Mehta', 'silver'),
    passenger('P-2105', 'Elena Fox', 'none'),
    passenger('P-2106', 'Farid Haddad', 'gold'),
    passenger('P-2107', 'Grace Liu', 'none'),
    passenger('P-2108', 'Hugo Brandt', 'silver'),
    passenger('P-2150', 'Iris Novak', 'gold'),
    passenger('P-2151', 'Jon Weller', 'none'),
  ];
  const p = (id: string) => pax.find((entry) => entry.id === id)!;
  const onCancelled = [byId('AA918')];

  return {
    ...emptyOps({
      today: TODAY,
      flights,
      passengers: pax,
      reservations: [
        reservation('R6101', p('P-2101'), onCancelled, {
          cabin: 'economy',
          paidCents: 30_000,
          bookedOn: '2026-05-02',
        }),
        reservation('R6102', p('P-2102'), onCancelled, {
          cabin: 'economy',
          paidCents: 30_000,
          bookedOn: '2026-06-11',
        }),
        reservation('R6103', p('P-2103'), onCancelled, {
          cabin: 'business',
          paidCents: 80_000,
          bookedOn: '2026-04-20',
        }),
        reservation('R6104', p('P-2104'), [byId('AA918'), byId('AA1402')], {
          cabin: 'economy',
          paidCents: 46_000,
          bookedOn: '2026-03-15',
        }),
        reservation('R6105', p('P-2105'), onCancelled, {
          cabin: 'basic_economy',
          paidCents: 25_500,
          bookedOn: '2026-06-30',
        }),
        reservation('R6106', p('P-2106'), onCancelled, {
          cabin: 'basic_economy',
          paidCents: 25_500,
          bookedOn: '2026-07-01',
        }),
        reservation('R6107', p('P-2107'), onCancelled, {
          cabin: 'economy',
          paidCents: 30_000,
          bookedOn: '2026-04-01',
        }),
        reservation('R6108', p('P-2108'), onCancelled, {
          cabin: 'economy',
          paidCents: 30_000,
          bookedOn: '2026-07-10',
        }),
        // Already on the flights the agent is rebooking onto: their seats are
        // taken, and their records are not part of the job.
        reservation('R6150', p('P-2150'), [byId('AA204')], {
          cabin: 'economy',
          paidCents: 39_000,
          bookedOn: '2026-05-30',
        }),
        reservation('R6151', p('P-2151'), [byId('DL512')], {
          cabin: 'business',
          paidCents: 84_000,
          bookedOn: '2026-06-14',
        }),
      ],
      ledger: [],
    }),
  };
}

// ---------------------------------------------------------------------------
// Oracle
// ---------------------------------------------------------------------------

interface Itinerary {
  flightIds: string[];
  /** Final arrival as minutes from midnight of the original departure date. */
  arrival: number;
  departure: number;
}

/** Minutes from midnight of `DAY` to a flight's arrival (or departure). */
function clock(entry: Flight, which: 'arrivalTime' | 'departureTime'): number {
  return minutesBetween(DAY, '00:00', entry.date, entry[which] ?? '00:00');
}

/** Reservations the cancellation affects, in protection priority order. */
export function affectedInPriorityOrder(world: AirlineOpsWorld): Reservation[] {
  return world.reservations
    .filter(
      (entry) => entry.status === 'confirmed' && entry.segments[0]?.flightId === CANCELLED_FLIGHT,
    )
    .sort((a, b) => {
      const tierA = TIER_RANK[findPassenger(world, a.passengerId)?.tier ?? 'none'];
      const tierB = TIER_RANK[findPassenger(world, b.passengerId)?.tier ?? 'none'];
      return tierB - tierA || a.bookedOn.localeCompare(b.bookedOn);
    });
}

function hasSeat(seats: Map<string, number>, flightId: string, cabin: CabinClass): boolean {
  return (seats.get(`${flightId}/${cabin}`) ?? 0) > 0;
}

/** Valid itineraries for one reservation, given the seats still free. */
function itineraries(
  world: AirlineOpsWorld,
  booking: Reservation,
  seats: Map<string, number>,
): Itinerary[] {
  const [first, onward] = booking.segments;
  if (!first) return [];
  const scheduled = world.flights.filter((entry) => entry.status === 'scheduled');
  const firstLegs = scheduled.filter(
    (entry) =>
      entry.origin === first.origin &&
      entry.destination === first.destination &&
      entry.date >= first.date &&
      hasSeat(seats, entry.id, booking.cabin),
  );
  if (!onward) {
    return firstLegs.map((leg) => ({
      flightIds: [leg.id],
      arrival: clock(leg, 'arrivalTime'),
      departure: clock(leg, 'departureTime'),
    }));
  }
  const options: Itinerary[] = [];
  for (const leg of firstLegs) {
    for (const next of scheduled) {
      if (next.origin !== onward.origin || next.destination !== onward.destination) continue;
      if (next.date !== leg.date) continue;
      // The passenger already holds a seat on their original onward flight.
      if (next.id !== onward.flightId && !hasSeat(seats, next.id, booking.cabin)) continue;
      if (clock(next, 'departureTime') - clock(leg, 'arrivalTime') < MIN_CONNECTION_MINUTES) continue;
      options.push({
        flightIds: [leg.id, next.id],
        arrival: clock(next, 'arrivalTime'),
        departure: clock(leg, 'departureTime'),
      });
    }
  }
  return options;
}

export interface Reprotection {
  reservationId: string;
  flightIds: string[];
}

/**
 * The re-protection the handbook prescribes, derived from the seed: in
 * priority order, each passenger takes the itinerary that reaches their final
 * destination soonest (earlier departure, then flight id, on a tie).
 */
export function irropsOracle(seed: AirlineOpsWorld): Reprotection[] {
  const seats = new Map<string, number>();
  for (const entry of seed.flights) {
    for (const cabin of entry.cabins) seats.set(`${entry.id}/${cabin.cabin}`, cabin.seatsLeft);
  }
  const plan: Reprotection[] = [];
  for (const booking of affectedInPriorityOrder(seed)) {
    const best = itineraries(seed, booking, seats).sort(
      (a, b) =>
        a.arrival - b.arrival ||
        a.departure - b.departure ||
        a.flightIds.join().localeCompare(b.flightIds.join()),
    )[0];
    if (!best) throw new Error(`no itinerary left for ${booking.id}`);
    best.flightIds.forEach((flightId, index) => {
      if (flightId === booking.segments[index]?.flightId) return;
      const key = `${flightId}/${booking.cabin}`;
      seats.set(key, (seats.get(key) ?? 0) - 1);
    });
    plan.push({ reservationId: booking.id, flightIds: best.flightIds });
  }
  return plan;
}

/**
 * Compensation owed for the itinerary a reservation actually holds, measured
 * at the final destination against the original schedule. Undefined when the
 * itinerary is not a valid re-protection (still on the cancelled flight, a
 * broken connection, a flight that does not exist).
 */
export function compensationFor(
  seed: AirlineOpsWorld,
  world: AirlineOpsWorld,
  reservationId: string,
): { compensation: number; hotel: number } | undefined {
  const original = reservationOrThrow(seed, reservationId);
  const current = reservationOrThrow(world, reservationId);
  const legs = current.segments.map((segment) => findFlight(world, segment.flightId));
  if (legs.some((leg) => leg === undefined || leg.status !== 'scheduled')) return undefined;
  const flights = legs as Flight[];
  for (let index = 1; index < flights.length; index++) {
    const gap =
      clock(flights[index]!, 'departureTime') - clock(flights[index - 1]!, 'arrivalTime');
    if (gap < MIN_CONNECTION_MINUTES) return undefined;
  }
  const originalLast = findFlight(seed, original.segments.at(-1)?.flightId ?? '');
  const newLast = flights.at(-1);
  const newFirst = flights[0];
  if (!originalLast || !newLast || !newFirst) return undefined;
  const delay = clock(newLast, 'arrivalTime') - clock(originalLast, 'arrivalTime');
  const compensation =
    delay < 180 ? 0 : delay < 360 ? COMPENSATION_SHORT_CENTS : COMPENSATION_LONG_CENTS;
  const hotel = newFirst.date > (original.segments[0]?.date ?? '') ? HOTEL_VOUCHER_CENTS : 0;
  return { compensation, hotel };
}

// ---------------------------------------------------------------------------
// Task
// ---------------------------------------------------------------------------

const AFFECTED = affectedInPriorityOrder(createIrropsWorld()).map((entry) => entry.id);

function affectedPassengers(world: AirlineOpsWorld): Set<string> {
  return new Set(AFFECTED.map((id) => reservationOrThrow(world, id).passengerId));
}

function perReservation(reservationId: string): AssertionSpec<AirlineOpsWorld>[] {
  return [
    {
      id: `rebooked:${reservationId}`,
      label: `${reservationId} re-protected on the prescribed itinerary, same cabin`,
      weight: 2,
      check: (world) => {
        const seed = createIrropsWorld();
        const expected = irropsOracle(seed).find((entry) => entry.reservationId === reservationId);
        const booking = reservationOrThrow(world, reservationId);
        return (
          expected !== undefined &&
          booking.status === 'confirmed' &&
          booking.cabin === reservationOrThrow(seed, reservationId).cabin &&
          booking.segments.map((segment) => segment.flightId).join() === expected.flightIds.join()
        );
      },
      detail: (world) => {
        const expected = irropsOracle(createIrropsWorld()).find(
          (entry) => entry.reservationId === reservationId,
        );
        const booking = reservationOrThrow(world, reservationId);
        return `on ${booking.segments.map((s) => s.flightId).join('+')} (${booking.cabin}); expected ${expected?.flightIds.join('+')}`;
      },
    },
    {
      id: `compensated:${reservationId}`,
      label: `${reservationId} got exactly the vouchers its new itinerary earns`,
      weight: 1,
      check: (world) => {
        const owed = compensationFor(createIrropsWorld(), world, reservationId);
        if (!owed) return false;
        const vouchers = world.vouchers.filter((entry) => entry.reservationId === reservationId);
        const matches = (kind: 'compensation' | 'hotel', amount: number) => {
          const issued = vouchers.filter((entry) => entry.kind === kind);
          return amount === 0
            ? issued.length === 0
            : issued.length === 1 && issued[0]?.amountCents === amount;
        };
        return matches('compensation', owed.compensation) && matches('hotel', owed.hotel);
      },
      detail: (world) => {
        const owed = compensationFor(createIrropsWorld(), world, reservationId);
        const issued = world.vouchers
          .filter((entry) => entry.reservationId === reservationId)
          .map((entry) => `${entry.kind} ${entry.amountCents}`);
        return `owed ${owed ? `compensation ${owed.compensation}, hotel ${owed.hotel}` : 'n/a (no valid itinerary)'}; issued ${issued.join(', ') || 'nothing'}`;
      },
    },
    {
      id: `notified:${reservationId}`,
      label: `${reservationId}: passenger told their new itinerary exactly once`,
      weight: 1,
      check: (world) => {
        const booking = reservationOrThrow(world, reservationId);
        if (booking.segments[0]?.flightId === CANCELLED_FLIGHT) return false;
        const messages = world.notifications.filter(
          (entry) => entry.passengerId === booking.passengerId,
        );
        if (messages.length !== 1) return false;
        const text = messages[0]?.message.toUpperCase() ?? '';
        return booking.segments.every((segment) => text.includes(segment.flightId.toUpperCase()));
      },
    },
  ];
}

/**
 * Pairs of passengers in the same cabin, neither connecting, where the one
 * with lower priority ended up arriving strictly earlier. Greedy protection in
 * priority order can never produce that, so any such pair means priority was
 * not respected — the failure parallel workers are expected to produce.
 */
export function priorityInversions(world: AirlineOpsWorld): string[] {
  const order = affectedInPriorityOrder(createIrropsWorld());
  const arrivalOf = (id: string): number | undefined => {
    const booking = reservationOrThrow(world, id);
    if (booking.segments.length !== 1) return undefined;
    const leg = findFlight(world, booking.segments[0]?.flightId ?? '');
    if (!leg || leg.status !== 'scheduled') return undefined;
    return clock(leg, 'arrivalTime');
  };
  const inversions: string[] = [];
  order.forEach((higher, index) => {
    for (const lower of order.slice(index + 1)) {
      if (higher.cabin !== lower.cabin) continue;
      const a = arrivalOf(higher.id);
      const b = arrivalOf(lower.id);
      if (a !== undefined && b !== undefined && b < a) inversions.push(`${lower.id} ahead of ${higher.id}`);
    }
  });
  return inversions;
}

export const airlineIrropsSpec: ToolUseTaskSpec<AirlineOpsWorld> = {
  ...AIRLINE_EXPERT_BASE,
  id: 'airline-irrops-reprotect',
  title: 'Re-protect a cancelled flight when seats are scarce',
  tags: ['airline', 'irregular-operations', 'scarce-resource', 'priority', 'connections', 'long-horizon'],
  maxTurns: 90,
  prompt: [
    'Operations has cancelled AA918 (SFO to ORD, 2026-08-03, departing 07:30).',
    'Re-protect every passenger booked on it under the irregular-operations rules,',
    'issue whatever they are owed, and let each of them know where they are now booked.',
  ].join(' '),
  hypothesis:
    'single >= propose-select > orchestrator-workers. Eight passengers compete for one or two seats per cabin and whoever books first takes the seat. Workers acting in parallel on slices of the manifest each grab the earliest seat they see, inverting the tier-then-date priority; read-only proposers see the whole board before any seat is taken, and a single agent can sort once and allocate in order. A verifier (plan-execute-verify) can catch an inversion but must undo bookings to repair it.',
  traps: [
    {
      id: 'priority-inversion',
      description:
        'Allocates scarce seats in manifest or booking-date order (or in parallel) instead of tier, then booking date.',
      caughtBy: ['priority-inverted'],
    },
    {
      id: 'broken-connection',
      description:
        'Moves the connecting passenger onto a first leg that misses the onward flight and leaves the onward leg as booked, or picks a connection that is not the earliest valid one.',
      caughtBy: ['rebooked:R6104'],
    },
    {
      id: 'delay-at-connection',
      description:
        "Measures the connecting passenger's delay at Chicago instead of at the final destination, and owes nothing instead of a voucher.",
      caughtBy: ['compensated:R6104'],
    },
    {
      id: 'next-day-hotel',
      description: 'Forgets the hotel voucher for the passenger who can only travel the next day.',
      caughtBy: ['compensated:R6101'],
    },
    {
      id: 'charges-involuntary-change',
      description: 'Applies voluntary change fees or fare differences to an airline-cancelled flight.',
      caughtBy: ['charged-for-reprotection'],
    },
    {
      id: 'downgrade-to-fit',
      description: 'Squeezes a passenger into a lower cabin to get them out sooner.',
      caughtBy: ['cabin-downgraded'],
    },
  ],
  createWorld: createIrropsWorld,
  assertions: AFFECTED.flatMap(perReservation),
  forbidden: [
    {
      id: 'priority-inverted',
      label: 'A lower-priority passenger got an earlier seat than a higher-priority one in the same cabin',
      multiplier: 0.8,
      violated: (world) => priorityInversions(world).length > 0,
      detail: (world) => priorityInversions(world).join('; ') || undefined,
    },
    {
      id: 'charged-for-reprotection',
      label: 'Charged a fee or fare difference for a change the airline caused',
      multiplier: 0.5,
      violated: (world) =>
        world.ledger.some((entry) => AFFECTED.includes(entry.reservationId) && entry.kind === 'fee'),
    },
    {
      id: 'cabin-downgraded',
      label: 'Moved a passenger to a lower cabin than they paid for',
      multiplier: 0.5,
      violated: (world) => {
        const seed = createIrropsWorld();
        return AFFECTED.some(
          (id) =>
            CABIN_RANK[reservationOrThrow(world, id).cabin] <
            CABIN_RANK[reservationOrThrow(seed, id).cabin],
        );
      },
    },
    blastRadiusRule<AirlineOpsWorld>({
      seed: createIrropsWorld,
      diff: OPS_DIFF,
      allow: anyOf(
        ...AFFECTED.map((id) => within('reservations', id)),
        seatCounts,
        addedTo('ledger', (entry) => AFFECTED.includes(String(entry.reservationId))),
        addedTo('vouchers', (entry) => AFFECTED.includes(String(entry.reservationId))),
        addedTo('notifications', (entry) =>
          affectedPassengers(createIrropsWorld()).has(String(entry.passengerId)),
        ),
      ),
      label: 'Changed a booking, passenger or flight outside the cancelled flight',
    }),
  ],
};

export const airlineIrropsTask: Task = defineToolUseTask(airlineIrropsSpec);
