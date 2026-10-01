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
 * Thirteen reservations on one cancelled flight and a day of replacements
 * with one or two seats left per cabin. Who gets which seat follows a priority
 * order (tier, then booking date) that differs from manifest order and from
 * booking order, and three rules interact with it: gold and platinum
 * passengers travelling alone move up exactly one cabin when that gets them
 * there sooner, which takes seats from passengers further down; a party booked
 * together needs seats side by side and is never upgraded; and two
 * connecting passengers can only make their onward flight the next morning,
 * so their delay, compensation and hotel are measured at the final
 * destination. One compensation is capped by a cheap fare.
 */

const CANCELLED_FLIGHT = 'AA918';
const TODAY = '2026-08-02';
const DAY = '2026-08-03';
const NEXT_DAY = '2026-08-04';

const CABIN_ORDER: CabinClass[] = ['basic_economy', 'economy', 'premium_economy', 'business'];

export function createIrropsWorld(): AirlineOpsWorld {
  const flights: Flight[] = [
    flight('UA88', 'SFO-ORD', DAY, '06:15-12:25', {
      basic_economy: [24_000, 1],
      economy: [27_000, 0],
      premium_economy: [41_000, 1],
      business: [78_000, 1],
    }),
    flight(
      'AA918',
      'SFO-ORD',
      DAY,
      '07:30-13:40',
      {
        basic_economy: [25_500, 4],
        economy: [30_000, 3],
        premium_economy: [44_000, 1],
        business: [80_000, 2],
      },
      'cancelled',
    ),
    flight('AA204', 'SFO-ORD', DAY, '09:05-15:15', {
      basic_economy: [33_000, 1],
      economy: [39_000, 2],
      premium_economy: [52_000, 0],
      business: [91_000, 1],
    }),
    flight('DL512', 'SFO-ORD', DAY, '12:30-18:40', {
      basic_economy: [29_000, 2],
      economy: [33_500, 1],
      premium_economy: [47_000, 1],
      business: [84_000, 0],
    }),
    flight('AA210', 'SFO-ORD', DAY, '17:40-23:50', {
      basic_economy: [26_500, 1],
      economy: [31_000, 3],
      business: [80_000, 0],
    }),
    flight('AA206', 'SFO-ORD', NEXT_DAY, '09:05-15:15', {
      basic_economy: [31_000, 6],
      economy: [37_000, 8],
      premium_economy: [50_000, 2],
      business: [88_000, 2],
    }),
    flight('AA1402', 'ORD-BOS', DAY, '15:30-18:55', { economy: [18_000, 3], business: [41_000, 1] }),
    flight('AA1408', 'ORD-BOS', DAY, '19:10-22:35', { economy: [18_000, 1] }),
    flight('AA1406', 'ORD-BOS', DAY, '19:55-23:20', { economy: [16_000, 4] }),
    flight('AA1410', 'ORD-BOS', NEXT_DAY, '09:00-12:25', { economy: [17_000, 5] }),
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
    passenger('P-2109', 'Iris Vance', 'platinum'),
    passenger('P-2110', 'Jun Takeda', 'none'),
    passenger('P-2111', 'Kofi Mensah', 'gold'),
    passenger('P-2112', 'Lea Sorensen', 'gold'),
    passenger('P-2113', 'Mo Farah', 'silver'),
    passenger('P-2150', 'Nell Price', 'gold'),
    passenger('P-2151', 'Otto Klein', 'none'),
  ];
  const p = (id: string) => pax.find((entry) => entry.id === id)!;
  const cancelled = [byId('AA918')];
  const toBoston = [byId('AA918'), byId('AA1402')];

  return emptyOps({
    today: TODAY,
    flights,
    passengers: pax,
    reservations: [
      reservation('R6101', p('P-2101'), cancelled, { cabin: 'economy', paidCents: 30_000, bookedOn: '2026-05-02' }),
      reservation('R6102', p('P-2102'), cancelled, { cabin: 'economy', paidCents: 30_000, bookedOn: '2026-06-11' }),
      reservation('R6103', p('P-2103'), cancelled, { cabin: 'business', paidCents: 80_000, bookedOn: '2026-04-20' }),
      reservation('R6104', p('P-2104'), toBoston, { cabin: 'economy', paidCents: 46_000, bookedOn: '2026-03-15' }),
      reservation('R6105', p('P-2105'), cancelled, { cabin: 'basic_economy', paidCents: 25_500, bookedOn: '2026-06-30' }),
      reservation('R6106', p('P-2106'), cancelled, { cabin: 'basic_economy', paidCents: 25_500, bookedOn: '2026-07-01' }),
      reservation('R6107', p('P-2107'), cancelled, { cabin: 'economy', paidCents: 24_000, bookedOn: '2026-04-01' }),
      reservation('R6108', p('P-2108'), cancelled, { cabin: 'economy', paidCents: 30_000, bookedOn: '2026-07-10' }),
      reservation('R6109', p('P-2109'), cancelled, { cabin: 'economy', paidCents: 30_000, bookedOn: '2026-06-20' }),
      { ...reservation('R6110', p('P-2110'), cancelled, { cabin: 'economy', paidCents: 28_000, bookedOn: '2026-05-15' }), groupId: 'G-7' },
      { ...reservation('R6111', p('P-2111'), cancelled, { cabin: 'economy', paidCents: 28_000, bookedOn: '2026-05-15' }), groupId: 'G-7' },
      reservation('R6112', p('P-2112'), cancelled, { cabin: 'premium_economy', paidCents: 44_000, bookedOn: '2026-07-05' }),
      reservation('R6113', p('P-2113'), toBoston, { cabin: 'economy', paidCents: 46_000, bookedOn: '2026-04-10' }),
      // Already booked on the replacement flights: their seats are taken, and
      // their records are not part of the job.
      reservation('R6150', p('P-2150'), [byId('AA204')], { cabin: 'economy', paidCents: 39_000, bookedOn: '2026-05-30' }),
      reservation('R6151', p('P-2151'), [byId('DL512')], { cabin: 'economy', paidCents: 33_500, bookedOn: '2026-06-14' }),
    ],
    ledger: [],
  });
}

// ---------------------------------------------------------------------------
// Oracle
// ---------------------------------------------------------------------------

/** Minutes from midnight of `DAY` to a flight's arrival or departure. */
function clock(entry: Flight, which: 'arrivalTime' | 'departureTime'): number {
  return minutesBetween(DAY, '00:00', entry.date, entry[which] ?? '00:00');
}

function affected(world: AirlineOpsWorld): Reservation[] {
  return world.reservations.filter(
    (entry) => entry.status === 'confirmed' && entry.segments[0]?.flightId === CANCELLED_FLIGHT,
  );
}

/** Priority of one reservation: higher tier first, then earlier booking. */
function comparePriority(world: AirlineOpsWorld, a: Reservation, b: Reservation): number {
  const tier = (entry: Reservation) => TIER_RANK[findPassenger(world, entry.passengerId)?.tier ?? 'none'];
  return tier(b) - tier(a) || a.bookedOn.localeCompare(b.bookedOn) || a.id.localeCompare(b.id);
}

/**
 * Units to protect, in priority order: each solo reservation, and each group
 * as one unit ranked by its highest-priority member.
 */
export function protectionOrder(world: AirlineOpsWorld): Reservation[][] {
  const units = new Map<string, Reservation[]>();
  for (const entry of affected(world)) {
    const key = entry.groupId ?? entry.id;
    units.set(key, [...(units.get(key) ?? []), entry]);
  }
  const lead = (unit: Reservation[]) => [...unit].sort((a, b) => comparePriority(world, a, b))[0]!;
  return [...units.values()].sort((a, b) => comparePriority(world, lead(a), lead(b)));
}

interface Itinerary {
  flightIds: string[];
  cabin: CabinClass;
  arrival: number;
  departure: number;
}

type Seats = Map<string, number>;
const seatKey = (flightId: string, cabin: CabinClass) => `${flightId}/${cabin}`;
const free = (seats: Seats, flightId: string, cabin: CabinClass) => seats.get(seatKey(flightId, cabin)) ?? 0;

function best(options: Itinerary[]): Itinerary | undefined {
  return [...options].sort(
    (a, b) =>
      a.arrival - b.arrival ||
      a.departure - b.departure ||
      a.flightIds.join().localeCompare(b.flightIds.join()),
  )[0];
}

/** Every valid itinerary for one reservation in one cabin, with `needed` seats on each new flight. */
function itineraries(
  world: AirlineOpsWorld,
  booking: Reservation,
  cabin: CabinClass,
  seats: Seats,
  needed: number,
): Itinerary[] {
  const [first, onward] = booking.segments;
  if (!first) return [];
  const scheduled = world.flights.filter((entry) => entry.status === 'scheduled');
  const firstLegs = scheduled.filter(
    (entry) =>
      entry.origin === first.origin &&
      entry.destination === first.destination &&
      entry.date >= first.date &&
      free(seats, entry.id, cabin) >= needed,
  );
  if (!onward) {
    return firstLegs.map((leg) => ({
      flightIds: [leg.id],
      cabin,
      arrival: clock(leg, 'arrivalTime'),
      departure: clock(leg, 'departureTime'),
    }));
  }
  const options: Itinerary[] = [];
  for (const leg of firstLegs) {
    for (const next of scheduled) {
      if (next.origin !== onward.origin || next.destination !== onward.destination) continue;
      // The passenger already holds a seat on their original onward flight.
      if (next.id !== onward.flightId && free(seats, next.id, cabin) < needed) continue;
      if (clock(next, 'departureTime') - clock(leg, 'arrivalTime') < MIN_CONNECTION_MINUTES) continue;
      options.push({
        flightIds: [leg.id, next.id],
        cabin,
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
  cabin: CabinClass;
}

/**
 * The re-protection the handbook prescribes, derived from the seed: units in
 * priority order, each taking the soonest itinerary still open in its cabin,
 * or one cabin up for an eligible gold or platinum passenger when that is
 * sooner still.
 */
export function irropsOracle(seed: AirlineOpsWorld): Reprotection[] {
  const seats: Seats = new Map();
  for (const entry of seed.flights) {
    for (const cabin of entry.cabins) seats.set(seatKey(entry.id, cabin.cabin), cabin.seatsLeft);
  }
  const plan: Reprotection[] = [];
  for (const unit of protectionOrder(seed)) {
    const head = unit[0]!;
    let choice = best(itineraries(seed, head, head.cabin, seats, unit.length));

    const tier = findPassenger(seed, head.passengerId)?.tier ?? 'none';
    const upgradeCabin = CABIN_ORDER[CABIN_ORDER.indexOf(head.cabin) + 1];
    const mayUpgrade =
      unit.length === 1 &&
      head.segments.length === 1 &&
      (tier === 'gold' || tier === 'platinum') &&
      upgradeCabin !== undefined;
    if (mayUpgrade) {
      const up = best(
        itineraries(seed, head, upgradeCabin, seats, 1).filter(
          (option) =>
            free(seats, option.flightIds[0]!, head.cabin) === 0 &&
            (choice === undefined || option.arrival < choice.arrival),
        ),
      );
      if (up) choice = up;
    }
    if (!choice) throw new Error(`no itinerary left for ${unit.map((entry) => entry.id).join('+')}`);

    choice.flightIds.forEach((flightId, index) => {
      if (flightId === head.segments[index]?.flightId) return;
      const key = seatKey(flightId, choice.cabin);
      seats.set(key, (seats.get(key) ?? 0) - unit.length);
    });
    for (const member of unit) {
      plan.push({ reservationId: member.id, flightIds: choice.flightIds, cabin: choice.cabin });
    }
  }
  return plan;
}

/**
 * Vouchers owed for the itinerary a reservation actually holds, measured at
 * the final destination against the original schedule. Undefined when it is
 * not a valid re-protection (still on the cancelled flight, a broken
 * connection, a flight that does not exist).
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
    const gap = clock(flights[index]!, 'departureTime') - clock(flights[index - 1]!, 'arrivalTime');
    if (gap < MIN_CONNECTION_MINUTES) return undefined;
  }
  const originalLast = findFlight(seed, original.segments.at(-1)?.flightId ?? '');
  const newLast = flights.at(-1);
  if (!originalLast || !newLast) return undefined;
  const delay = clock(newLast, 'arrivalTime') - clock(originalLast, 'arrivalTime');
  const band = delay < 180 ? 0 : delay < 360 ? COMPENSATION_SHORT_CENTS : COMPENSATION_LONG_CENTS;
  return {
    compensation: Math.min(band, original.paidCents),
    hotel: newLast.date > originalLast.date ? HOTEL_VOUCHER_CENTS : 0,
  };
}

// ---------------------------------------------------------------------------
// Task
// ---------------------------------------------------------------------------

const AFFECTED = affected(createIrropsWorld()).map((entry) => entry.id);

function affectedPassengers(world: AirlineOpsWorld): Set<string> {
  return new Set(AFFECTED.map((id) => reservationOrThrow(world, id).passengerId));
}

function expectedFor(reservationId: string): Reprotection | undefined {
  return irropsOracle(createIrropsWorld()).find((entry) => entry.reservationId === reservationId);
}

function perReservation(reservationId: string): AssertionSpec<AirlineOpsWorld>[] {
  return [
    {
      id: `rebooked:${reservationId}`,
      label: `${reservationId} re-protected on the prescribed itinerary and cabin`,
      weight: 2,
      check: (world) => {
        const expected = expectedFor(reservationId);
        const booking = reservationOrThrow(world, reservationId);
        return (
          expected !== undefined &&
          booking.status === 'confirmed' &&
          booking.cabin === expected.cabin &&
          booking.segments.map((segment) => segment.flightId).join() === expected.flightIds.join()
        );
      },
      detail: (world) => {
        const expected = expectedFor(reservationId);
        const booking = reservationOrThrow(world, reservationId);
        return `on ${booking.segments.map((s) => s.flightId).join('+')} in ${booking.cabin}; expected ${expected?.flightIds.join('+')} in ${expected?.cabin}`;
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
 * Pairs of solo, single-flight passengers who paid for the same cabin where
 * the one with lower priority ended up arriving strictly earlier. Protection
 * in priority order cannot produce that (seats are only ever taken, never
 * freed), so any such pair means priority was not respected: the failure
 * parallel workers are expected to produce. Groups are left out, because a
 * party that needs two seats may rightly pass over a single one.
 */
export function priorityInversions(world: AirlineOpsWorld): string[] {
  const seed = createIrropsWorld();
  const order = protectionOrder(seed)
    .filter((unit) => unit.length === 1 && unit[0]!.segments.length === 1)
    .map((unit) => unit[0]!);
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
      if (a !== undefined && b !== undefined && b < a) {
        inversions.push(`${lower.id} ahead of ${higher.id}`);
      }
    }
  });
  return inversions;
}

/** Group members that ended up on different flights. */
export function splitGroups(world: AirlineOpsWorld): string[] {
  const groups = new Map<string, Set<string>>();
  for (const id of AFFECTED) {
    const booking = reservationOrThrow(world, id);
    if (!booking.groupId) continue;
    const route = booking.segments.map((segment) => segment.flightId).join('+');
    groups.set(booking.groupId, (groups.get(booking.groupId) ?? new Set()).add(route));
  }
  return [...groups].filter(([, routes]) => routes.size > 1).map(([groupId]) => groupId);
}

export const airlineIrropsSpec: ToolUseTaskSpec<AirlineOpsWorld> = {
  ...AIRLINE_EXPERT_BASE,
  id: 'airline-irrops-reprotect',
  title: 'Re-protect a cancelled flight when seats are scarce',
  tags: ['airline', 'irregular-operations', 'scarce-resource', 'priority', 'connections', 'long-horizon'],
  maxTurns: 120,
  prompt: [
    'Operations has cancelled AA918 (SFO to ORD, 2026-08-03, departing 07:30).',
    'Re-protect every passenger booked on it under the irregular-operations rules,',
    'issue whatever they are owed, and let each of them know where they are now booked.',
  ].join(' '),
  hypothesis:
    'single >= propose-select > orchestrator-workers. Thirteen reservations compete for one or two seats per cabin, and whoever books first takes the seat: an upgrade granted to a gold passenger removes the seat a later passenger would have had. Workers acting in parallel on slices of the manifest each grab the earliest seat they see, inverting the tier-then-date priority; read-only proposers see the whole board before any seat is taken, and a single agent can sort once and allocate in order. A verifier (plan-execute-verify) can detect an inversion but must unwind bookings to repair it.',
  traps: [
    {
      id: 'priority-inversion',
      description:
        'Allocates scarce seats in manifest or booking-date order (or in parallel) instead of tier, then booking date.',
      caughtBy: ['priority-inverted'],
    },
    {
      id: 'missed-upgrade',
      description:
        'Leaves a platinum passenger in a later economy seat when their economy cabin is full on an earlier flight with room one cabin up.',
      caughtBy: ['rebooked:R6109'],
    },
    {
      id: 'upgrade-overreach',
      description:
        'Moves a gold passenger up two cabins, or upgrades someone the rule does not cover, taking a seat from a passenger further down.',
      caughtBy: ['rebooked:R6102', 'rebooked:R6112'],
    },
    {
      id: 'split-party',
      description: 'Splits the two reservations booked together across flights, or upgrades one of them.',
      caughtBy: ['party-split', 'rebooked:R6110', 'rebooked:R6111'],
    },
    {
      id: 'overnight-connection',
      description:
        "Leaves a connecting passenger's onward flight in place after it has become unreachable, instead of rebooking it to the next morning.",
      caughtBy: ['rebooked:R6104', 'rebooked:R6113'],
    },
    {
      id: 'delay-at-the-hub',
      description:
        "Measures a connecting passenger's delay at Chicago rather than at the final destination, missing the hotel and the higher band.",
      caughtBy: ['compensated:R6104', 'compensated:R6113'],
    },
    {
      id: 'fare-cap',
      description: 'Issues a compensation voucher larger than the fare the passenger paid.',
      caughtBy: ['compensated:R6107'],
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
      id: 'party-split',
      label: 'Split a party booked to travel together',
      multiplier: 0.8,
      violated: (world) => splitGroups(world).length > 0,
      detail: (world) => `Split: ${splitGroups(world).join(', ')}.`,
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
