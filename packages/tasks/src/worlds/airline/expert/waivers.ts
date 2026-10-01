import type { Task } from '@arena/core';
import {
  defineToolUseTask,
  type AssertionSpec,
  type ToolUseTaskSpec,
} from '../../../defineToolUseTask';
import { addedTo, anyOf, blastRadiusRule, within } from '../../../worldDiff';
import { emptyOps, type AirlineOpsWorld, type Bulletin, type ServiceRequest } from '../ops';
import { seatCounts } from '../tasks';
import {
  CHANGE_FEE_BY_CABIN,
  CHANGE_FEE_EXEMPT_TIERS,
  findCabin,
  findFlight,
  findPassenger,
  type Flight,
  type Reservation,
} from '../world';
import {
  AIRLINE_EXPERT_BASE,
  OPS_DIFF,
  addedEntries,
  flight,
  passenger,
  reservation,
  reservationOrThrow,
} from './common';

/**
 * airline-waiver-desk: ten voluntary change requests, one of them arriving
 * mid-run, settled under dated bulletins that exist only in the bulletin
 * tool.
 *
 * The handbook says bulletins override it within their dates and scope, and
 * nothing more. What each bulletin says is only available by reading it: a
 * Chicago weather waiver with a ticketing cutoff, a travel window and a
 * basic-economy carve-out, and an amendment that widens the window for top
 * tiers; an expired Boston waiver one customer still cites; a standing
 * bulletin that raises the basic economy change fee above what the fare-rules
 * tool prints; and a same-day change policy that competes with the waiver.
 * When two bulletins cover a change the customer gets the cheaper outcome.
 * Customers name waivers that do not cover them, and some who are covered
 * name none. One request changes only the second leg of a connection, and one
 * booking has already had the single move the waiver allows, which only its
 * history shows.
 */

const TODAY = '2026-07-28';

/** PB-2026-14, the Chicago weather waiver, as its text defines it. */
const CHICAGO_WAIVER = {
  id: 'PB-2026-14',
  effectiveFrom: '2026-07-25',
  effectiveTo: '2026-08-31',
  ticketedBy: '2026-07-24',
  travelFrom: '2026-08-02',
  travelTo: '2026-08-04',
  moveBy: '2026-08-10',
  airport: 'ORD',
} as const;

/** PB-2026-14A: widens the Chicago travel window for gold and platinum members. */
const CHICAGO_AMENDMENT = { travelTo: '2026-08-05', tiers: ['gold', 'platinum'] } as const;

/** PB-2026-16: the basic economy change fee, superseding the fare-rules table. */
const BASIC_CHANGE_FEE = { id: 'PB-2026-16', effectiveFrom: '2026-07-01', cents: 15_000 } as const;

/** PB-2026-12: a flat fee for moving to another flight the same day, no fare difference. */
const SAME_DAY = { effectiveFrom: '2026-07-01', cents: 7500, exemptTiers: ['gold', 'platinum'] } as const;

const BULLETINS: Bulletin[] = [
  {
    id: 'PB-2026-09',
    title: 'Hurricane Elsa travel waiver (Boston)',
    publishedOn: '2026-06-19',
    effectiveFrom: '2026-06-20',
    effectiveTo: '2026-07-15',
    body: [
      'Scope: reservations with travel to or from BOS between 2026-07-01 and 2026-07-20.',
      'Covered reservations may move once to a flight in the same cabin on the same route departing no later than 2026-07-31. The change fee and the fare difference are waived.',
      'Requests made after the bulletin expires fall under the normal fare rules.',
    ].join('\n'),
  },
  {
    id: 'PB-2026-14',
    title: 'Chicago weather waiver',
    publishedOn: '2026-07-25',
    effectiveFrom: CHICAGO_WAIVER.effectiveFrom,
    effectiveTo: CHICAGO_WAIVER.effectiveTo,
    body: [
      `Scope: reservations ticketed on or before ${CHICAGO_WAIVER.ticketedBy} with travel to or from ORD between ${CHICAGO_WAIVER.travelFrom} and ${CHICAGO_WAIVER.travelTo}.`,
      `Covered reservations may move once to a flight in the same cabin on the same route departing no later than ${CHICAGO_WAIVER.moveBy}.`,
      'The change fee is waived. The fare difference is waived as well, except on basic economy fares, where any fare difference is still collected.',
      'Moves outside these limits fall under the normal fare rules.',
    ].join('\n'),
  },
  {
    id: 'PB-2026-12',
    title: 'Same-day flight changes',
    publishedOn: '2026-06-24',
    effectiveFrom: SAME_DAY.effectiveFrom,
    effectiveTo: null,
    body: [
      `A move to another flight on the same route and the same date as the flight being replaced costs a flat ${SAME_DAY.cents} cents, charged as the change fee, and no fare difference is charged either way.`,
      'Gold and platinum members pay no same-day fee. Applies to any cabin, including basic economy, and to any single segment of a connecting trip.',
    ].join('\n'),
  },
  {
    id: 'PB-2026-14A',
    title: 'Amendment to PB-2026-14 (Chicago weather waiver)',
    publishedOn: '2026-07-27',
    effectiveFrom: '2026-07-27',
    effectiveTo: '2026-08-31',
    body: [
      `For passengers holding ${CHICAGO_AMENDMENT.tiers.join(' or ')} status, the PB-2026-14 travel window runs from ${CHICAGO_WAIVER.travelFrom} through ${CHICAGO_AMENDMENT.travelTo}.`,
      'All other terms of PB-2026-14 are unchanged.',
    ].join('\n'),
  },
  {
    id: 'PB-2026-17',
    title: 'Overlapping bulletins',
    publishedOn: '2026-07-01',
    effectiveFrom: '2026-07-01',
    effectiveTo: null,
    body: 'When more than one bulletin in effect covers the same change, apply whichever one costs the customer least. Bulletins are never combined into a single settlement.',
  },
  {
    id: 'PB-2026-15',
    title: 'In-cabin pet carrier fee',
    publishedOn: '2026-07-08',
    effectiveFrom: '2026-07-10',
    effectiveTo: '2026-12-31',
    body: 'The in-cabin pet carrier fee is 12500 cents per segment. Pets are not permitted in basic economy.',
  },
  {
    id: 'PB-2026-16',
    title: 'Basic economy change fee',
    publishedOn: '2026-06-28',
    effectiveFrom: BASIC_CHANGE_FEE.effectiveFrom,
    effectiveTo: null,
    body: [
      `Supersedes the basic economy change fee in the published fare rules: from ${BASIC_CHANGE_FEE.effectiveFrom} the change fee for a basic economy fare is ${BASIC_CHANGE_FEE.cents} cents.`,
      'Tier exemptions from the change fee are unchanged. The fare rules tool will be updated in the next publication cycle.',
    ].join('\n'),
  },
];

interface ChangeRequest {
  requestId: string;
  reservationId: string;
  newFlightId: string;
  /** Which segment moves; the first unless the request says otherwise. */
  segmentIndex: number;
}

const REQUESTS: ChangeRequest[] = [
  { requestId: 'Q-301', reservationId: 'R5201', newFlightId: 'DL542', segmentIndex: 0 },
  { requestId: 'Q-302', reservationId: 'R5202', newFlightId: 'AA664', segmentIndex: 0 },
  { requestId: 'Q-303', reservationId: 'R5203', newFlightId: 'AA664', segmentIndex: 0 },
  { requestId: 'Q-304', reservationId: 'R5204', newFlightId: 'UA90', segmentIndex: 0 },
  { requestId: 'Q-305', reservationId: 'R5205', newFlightId: 'AA216', segmentIndex: 0 },
  { requestId: 'Q-307', reservationId: 'R5207', newFlightId: 'AA218', segmentIndex: 0 },
  { requestId: 'Q-308', reservationId: 'R5208', newFlightId: 'AA662', segmentIndex: 0 },
  { requestId: 'Q-309', reservationId: 'R5209', newFlightId: 'AA1406', segmentIndex: 1 },
  { requestId: 'Q-310', reservationId: 'R5210', newFlightId: 'AA216', segmentIndex: 0 },
  // Arrives in the queue once four requests have been resolved.
  { requestId: 'Q-311', reservationId: 'R5211', newFlightId: 'AA216', segmentIndex: 0 },
];

/** Resolving this many requests brings the late change request into the queue. */
const LATE_ARRIVAL_AFTER = 4;

export function createWaiverWorld(): AirlineOpsWorld {
  const flights: Flight[] = [
    flight('UA88', 'SFO-ORD', '2026-08-03', '06:15-12:25', {
      basic_economy: [24_000, 3],
      economy: [27_000, 2],
    }),
    flight('AA210', 'SFO-ORD', '2026-08-03', '17:40-23:50', {
      basic_economy: [26_500, 9],
      economy: [31_000, 12],
    }),
    flight('AA214', 'SFO-ORD', '2026-08-04', '10:30-16:40', { economy: [33_000, 6] }),
    flight('DL542', 'SFO-ORD', '2026-08-06', '11:15-17:25', {
      basic_economy: [29_500, 4],
      economy: [36_000, 5],
    }),
    flight('AA216', 'SFO-ORD', '2026-08-08', '10:30-16:40', { economy: [34_000, 4] }),
    flight('UA90', 'SFO-ORD', '2026-08-09', '06:15-12:25', {
      basic_economy: [27_500, 3],
      economy: [30_500, 5],
    }),
    flight('AA660', 'SFO-BOS', '2026-08-05', '06:45-15:20', {
      basic_economy: [24_800, 8],
      economy: [31_900, 10],
    }),
    flight('AA662', 'SFO-BOS', '2026-08-05', '15:10-23:40', {
      basic_economy: [26_400, 5],
      economy: [33_200, 7],
    }),
    flight('AA664', 'SFO-BOS', '2026-08-07', '08:20-16:55', {
      basic_economy: [28_900, 4],
      economy: [35_400, 6],
    }),
    flight('AA640', 'SFO-BOS', '2026-08-09', '07:00-15:35', { economy: [30_900, 9] }),
    flight('AA212', 'SFO-ORD', '2026-08-05', '08:00-14:10', { economy: [32_000, 7] }),
    flight('AA218', 'SFO-ORD', '2026-08-08', '14:00-20:10', { economy: [38_500, 5] }),
    flight('AA1402', 'ORD-BOS', '2026-08-03', '15:30-18:55', { economy: [18_000, 4] }),
    flight('AA1406', 'ORD-BOS', '2026-08-03', '19:55-23:20', { economy: [21_000, 6] }),
  ];
  const byId = (id: string) => flights.find((entry) => entry.id === id) as Flight;
  const pax = [
    passenger('P-2201', 'Ines Duarte', 'none'),
    passenger('P-2202', 'Jonah Pike', 'none'),
    passenger('P-2203', 'Kim Seo', 'silver'),
    passenger('P-2204', 'Lena Ortiz', 'gold'),
    passenger('P-2205', 'Max Weber', 'none'),
    passenger('P-2206', 'Nadia Kim', 'silver'),
    passenger('P-2207', 'Oscar Lund', 'platinum'),
    passenger('P-2208', 'Petra Novak', 'none'),
    passenger('P-2209', 'Quinn Adler', 'none'),
    passenger('P-2210', 'Ravi Shah', 'none'),
    passenger('P-2211', 'Sara Holt', 'none'),
  ];
  const p = (id: string) => pax.find((entry) => entry.id === id)!;

  const requests: ServiceRequest[] = [
    {
      id: 'Q-301',
      receivedAt: '2026-07-27T08:12',
      passengerId: 'P-2201',
      reservationId: 'R5201',
      kind: 'change',
      subject: 'Move my Chicago flight',
      message:
        "Hi, with the storms forecast for Chicago I'd rather not fly on the 3rd. Could you move me to DL542 on 6 August instead? Same cabin is fine. Thanks, Ines",
      status: 'open',
    },
    {
      id: 'Q-302',
      receivedAt: '2026-07-27T09:40',
      passengerId: 'P-2202',
      reservationId: 'R5202',
      kind: 'change',
      subject: 'Weather waiver change',
      message:
        "Please move me from AA660 on 08-05 to AA664 on 08-07. I saw there's a weather waiver at the moment, so I assume there's no charge. Jonah",
      status: 'open',
    },
    {
      id: 'Q-303',
      receivedAt: '2026-07-27T11:05',
      passengerId: 'P-2203',
      reservationId: 'R5203',
      kind: 'change',
      subject: 'Change under PB-2026-09',
      message:
        "I'd like to move my Boston flight (AA662 on 08-05) to AA664 on 08-07, basic economy as now. This is covered by the hurricane waiver PB-2026-09, so please don't charge me anything. Kim Seo",
      status: 'open',
    },
    {
      id: 'Q-304',
      receivedAt: '2026-07-27T14:30',
      passengerId: 'P-2204',
      reservationId: 'R5204',
      kind: 'change',
      subject: 'Chicago weather',
      message:
        "Because of the Chicago weather I need to move from UA88 on 08-03 to UA90 on 08-09, same basic fare. I'm a gold member. Lena Ortiz",
      status: 'open',
    },
    {
      id: 'Q-305',
      receivedAt: '2026-07-27T16:52',
      passengerId: 'P-2205',
      reservationId: 'R5205',
      kind: 'change',
      subject: 'Weather waiver please',
      message: 'Weather waiver please: move me from AA214 on 08-04 to AA216 on 08-08. Thanks, Max',
      status: 'open',
    },
    {
      id: 'Q-307',
      receivedAt: '2026-07-27T17:05',
      passengerId: 'P-2207',
      reservationId: 'R5207',
      kind: 'change',
      subject: 'Chicago trip on the 5th',
      message:
        "Please move me from AA212 on 5 August to AA218 on the 8th. I know the 5th isn't one of the storm days, so I'm prepared to pay whatever the difference is. Oscar",
      status: 'open',
    },
    {
      id: 'Q-308',
      receivedAt: '2026-07-27T17:40',
      passengerId: 'P-2208',
      reservationId: 'R5208',
      kind: 'change',
      subject: 'Later flight same day',
      message:
        'My meeting in Boston moved to the evening. Can you put me on AA662 instead of AA660, same day (5 August)? Petra',
      status: 'open',
    },
    {
      id: 'Q-309',
      receivedAt: '2026-07-27T18:15',
      passengerId: 'P-2209',
      reservationId: 'R5209',
      kind: 'change',
      subject: 'More time in Chicago',
      message:
        'I fly SFO to Chicago to Boston on the 3rd. I need a few more hours in Chicago, so please move only my Chicago to Boston flight to the 19:55 one (AA1406). Keep the first flight as it is. Quinn',
      status: 'open',
    },
    {
      id: 'Q-310',
      receivedAt: '2026-07-27T18:40',
      passengerId: 'P-2210',
      reservationId: 'R5210',
      kind: 'change',
      subject: 'Chicago waiver - new date',
      message:
        'Please move me from AA210 on 3 August to AA216 on the 8th, under the Chicago weather waiver. Ravi',
      status: 'open',
    },
    {
      id: 'Q-306',
      receivedAt: '2026-07-27T17:20',
      passengerId: 'P-2206',
      reservationId: 'R5206',
      kind: 'cancellation',
      subject: 'Cancel my Boston trip',
      message: "I won't be travelling to Boston on the 9th after all. Please cancel R5206. Nadia",
      status: 'open',
    },
  ];

  return {
    ...emptyOps({
      today: TODAY,
      flights,
      passengers: pax,
      reservations: [
        reservation('R5201', p('P-2201'), [byId('AA210')], {
          cabin: 'economy',
          paidCents: 31_000,
          bookedOn: '2026-07-10',
        }),
        reservation('R5202', p('P-2202'), [byId('AA660')], {
          cabin: 'economy',
          paidCents: 31_900,
          bookedOn: '2026-06-20',
        }),
        reservation('R5203', p('P-2203'), [byId('AA662')], {
          cabin: 'basic_economy',
          paidCents: 26_400,
          bookedOn: '2026-06-05',
        }),
        reservation('R5204', p('P-2204'), [byId('UA88')], {
          cabin: 'basic_economy',
          paidCents: 24_000,
          bookedOn: '2026-06-02',
        }),
        reservation('R5205', p('P-2205'), [byId('AA214')], {
          cabin: 'economy',
          paidCents: 33_000,
          bookedOn: '2026-07-26',
        }),
        reservation('R5206', p('P-2206'), [byId('AA640')], {
          cabin: 'economy',
          paidCents: 30_900,
          bookedOn: '2026-05-11',
        }),
        reservation('R5207', p('P-2207'), [byId('AA212')], {
          cabin: 'economy',
          paidCents: 32_000,
          bookedOn: '2026-06-28',
        }),
        reservation('R5208', p('P-2208'), [byId('AA660')], {
          cabin: 'economy',
          paidCents: 31_900,
          bookedOn: '2026-06-12',
        }),
        {
          ...reservation('R5209', p('P-2209'), [byId('UA88'), byId('AA1402')], {
            cabin: 'economy',
            paidCents: 45_000,
            bookedOn: '2026-07-01',
          }),
          segments: [
            { flightId: 'UA88', origin: 'SFO', destination: 'ORD', date: '2026-08-03', fareCents: 27_000 },
            { flightId: 'AA1402', origin: 'ORD', destination: 'BOS', date: '2026-08-03', fareCents: 18_000 },
          ],
        },
        {
          ...reservation('R5210', p('P-2210'), [byId('AA210')], {
            cabin: 'economy',
            paidCents: 31_000,
            bookedOn: '2026-07-12',
          }),
          // A colleague already used this booking's one waiver move.
          history: [
            {
              date: '2026-07-26',
              field: 'flight',
              from: 'AA214',
              to: 'AA210',
              note: `moved free of charge under ${CHICAGO_WAIVER.id}`,
            },
          ],
        },
        reservation('R5211', p('P-2211'), [byId('AA214')], {
          cabin: 'economy',
          paidCents: 33_000,
          bookedOn: '2026-07-15',
        }),
      ],
      ledger: [],
    }),
    bulletins: structuredClone(BULLETINS),
    requests,
    arrivals: [
      {
        afterResolved: LATE_ARRIVAL_AFTER,
        request: {
          id: 'Q-311',
          receivedAt: '2026-07-28T08:55',
          passengerId: 'P-2211',
          reservationId: 'R5211',
          kind: 'change',
          subject: 'Chicago flight on the 4th',
          message: 'Hello, please move me from AA214 on 4 August to AA216 on the 8th. Thank you, Sara',
          status: 'open',
        },
      },
    ],
  };
}

/** True when the booking has already had its one move under the Chicago waiver. */
function usedChicagoWaiver(booking: Reservation): boolean {
  return (booking.history ?? []).some(
    (change) => change.field === 'flight' && (change.note ?? '').includes(CHICAGO_WAIVER.id),
  );
}

// ---------------------------------------------------------------------------
// Oracle
// ---------------------------------------------------------------------------

export interface ExpectedFees {
  change_fee: number;
  fare_difference: number;
}

const total = (fees: ExpectedFees) => fees.change_fee + fees.fare_difference;
const inForce = (today: string, from: string, to: string | null) =>
  today >= from && (to === null || today <= to);

/**
 * The fees a request owes, from the seed: the fare rules (with the bulletin
 * that supersedes the basic economy fee), then every bulletin that covers the
 * move, and the cheapest of those outcomes, never a blend of them.
 */
export function expectedFees(seed: AirlineOpsWorld, request: ChangeRequest): ExpectedFees {
  const booking = reservationOrThrow(seed, request.reservationId);
  const segment = booking.segments[request.segmentIndex];
  const target = findFlight(seed, request.newFlightId);
  if (!segment || !target) throw new Error(`request ${request.requestId} does not resolve in the seed`);
  const tier = findPassenger(seed, booking.passengerId)?.tier ?? 'none';
  const sameRoute = target.origin === segment.origin && target.destination === segment.destination;

  const segmentFare = segment.fareCents ?? booking.paidCents;
  const newFare = findCabin(target, booking.cabin)?.fareCents ?? Number.NaN;
  const difference = Math.max(0, newFare - segmentFare);
  const baseChangeFee =
    booking.cabin === 'basic_economy' && seed.today >= BASIC_CHANGE_FEE.effectiveFrom
      ? BASIC_CHANGE_FEE.cents
      : CHANGE_FEE_BY_CABIN[booking.cabin];
  const outcomes: ExpectedFees[] = [
    {
      change_fee: CHANGE_FEE_EXEMPT_TIERS.includes(tier) ? 0 : baseChangeFee,
      fare_difference: difference,
    },
  ];

  // PB-2026-14, as amended by PB-2026-14A.
  const travelTo = (CHICAGO_AMENDMENT.tiers as readonly string[]).includes(tier)
    ? CHICAGO_AMENDMENT.travelTo
    : CHICAGO_WAIVER.travelTo;
  const touchesOrd =
    segment.origin === CHICAGO_WAIVER.airport || segment.destination === CHICAGO_WAIVER.airport;
  if (
    inForce(seed.today, CHICAGO_WAIVER.effectiveFrom, CHICAGO_WAIVER.effectiveTo) &&
    touchesOrd &&
    sameRoute &&
    booking.bookedOn <= CHICAGO_WAIVER.ticketedBy &&
    segment.date >= CHICAGO_WAIVER.travelFrom &&
    segment.date <= travelTo &&
    target.date <= CHICAGO_WAIVER.moveBy &&
    !usedChicagoWaiver(booking)
  ) {
    outcomes.push({
      change_fee: 0,
      fare_difference: booking.cabin === 'basic_economy' ? difference : 0,
    });
  }

  // PB-2026-12, same-day changes.
  if (inForce(seed.today, SAME_DAY.effectiveFrom, null) && sameRoute && target.date === segment.date) {
    outcomes.push({
      change_fee: (SAME_DAY.exemptTiers as readonly string[]).includes(tier) ? 0 : SAME_DAY.cents,
      fare_difference: 0,
    });
  }

  return outcomes.sort((a, b) => total(a) - total(b))[0]!;
}

// ---------------------------------------------------------------------------
// Task
// ---------------------------------------------------------------------------

const RESERVATIONS = REQUESTS.map((request) => request.reservationId);
const REQUESTERS = RESERVATIONS.map((id) => reservationOrThrow(createWaiverWorld(), id).passengerId);

/** Flight ids the reservation should hold once the request is done. */
function expectedSegments(request: ChangeRequest): string[] {
  const original = reservationOrThrow(createWaiverWorld(), request.reservationId);
  return original.segments.map((segment, index) =>
    index === request.segmentIndex ? request.newFlightId : segment.flightId,
  );
}

function perRequest(request: ChangeRequest): AssertionSpec<AirlineOpsWorld>[] {
  const { requestId, reservationId, newFlightId } = request;
  const moved = (world: AirlineOpsWorld) =>
    reservationOrThrow(world, reservationId).segments.map((segment) => segment.flightId).join() ===
    expectedSegments(request).join();
  return [
    {
      id: `moved:${reservationId}`,
      label: `${reservationId}: ${newFlightId} replaces the requested segment, the rest unchanged, same cabin`,
      weight: 1,
      check: (world) => {
        const booking = reservationOrThrow(world, reservationId);
        const original = reservationOrThrow(createWaiverWorld(), reservationId);
        return booking.status === 'confirmed' && moved(world) && booking.cabin === original.cabin;
      },
    },
    {
      id: `settled:${reservationId}`,
      label: `${reservationId} charged exactly the change fee and fare difference owed`,
      weight: 2,
      check: (world) => {
        // Settling a change that never happened earns nothing, even when nothing was owed.
        if (!moved(world)) return false;
        const seed = createWaiverWorld();
        const expected = expectedFees(seed, request);
        const added = addedEntries(seed, world, reservationId);
        const owed = (['change_fee', 'fare_difference'] as const).filter(
          (category) => expected[category] > 0,
        );
        // Exactly one fee entry per amount owed, nothing else.
        return (
          added.length === owed.length &&
          owed.every((category) => {
            const charged = added.filter(
              (entry) => entry.kind === 'fee' && entry.category === category,
            );
            return charged.length === 1 && charged[0]?.amountCents === expected[category];
          })
        );
      },
      detail: (world) => {
        const seed = createWaiverWorld();
        const expected = expectedFees(seed, request);
        const added = addedEntries(seed, world, reservationId).map(
          (entry) => `${entry.category} ${entry.amountCents}`,
        );
        return `owed change_fee ${expected.change_fee}, fare_difference ${expected.fare_difference}; ledger got ${added.join(', ') || 'nothing'}`;
      },
    },
    {
      id: `resolved:${requestId}`,
      label: `${requestId} resolved with a note to the customer`,
      weight: 0.5,
      check: (world) => world.requests.find((entry) => entry.id === requestId)?.status === 'resolved',
    },
  ];
}

export const airlineWaiversSpec: ToolUseTaskSpec<AirlineOpsWorld> = {
  ...AIRLINE_EXPERT_BASE,
  id: 'airline-waiver-desk',
  title: 'Settle change requests under dated bulletins',
  tags: ['airline', 'bulletins', 'policy-override', 'rules-via-tools', 'batch'],
  maxTurns: 120,
  prompt: [
    'The service queue has open flight-change requests from yesterday.',
    'Work all of them: make each change the customer asked for and settle it correctly.',
  ].join(' '),
  hypothesis:
    "plan-execute-verify > single > plan-execute. Every settlement turns on dated bulletins reachable only through tools, two of which can cover the same move, and customers cite waivers that do not cover them; one booking has already used its single waiver move, which only its history shows. A state-grounded verifier that re-reads the bulletins and the booking against the ledger can catch a misapplied waiver and charge the remainder; a plan written before any bulletin is read inherits the customers' framing. The requests are independent, so orchestrator-workers should match single on score at lower latency, and one arrives mid-run, which only an agent that re-reads the queue will see.",
  traps: [
    {
      id: 'covered-but-silent',
      description:
        'Charges the fare difference to a customer the Chicago waiver covers, because they did not ask for it by name.',
      caughtBy: ['settled:R5201'],
    },
    {
      id: 'waiver-by-assertion',
      description:
        "Waives fees because the customer says a weather waiver applies, though their route is outside the bulletin's scope.",
      caughtBy: ['settled:R5202'],
    },
    {
      id: 'expired-bulletin',
      description: 'Honours a bulletin that expired before the request was made.',
      caughtBy: ['settled:R5203'],
    },
    {
      id: 'stale-fee-table',
      description:
        'Charges the basic economy change fee from the fare-rules table instead of the bulletin that supersedes it.',
      caughtBy: ['settled:R5203'],
    },
    {
      id: 'basic-carve-out',
      description:
        'Waives the fare difference on a basic economy fare that the waiver only relieves of the change fee.',
      caughtBy: ['settled:R5204'],
    },
    {
      id: 'ticketing-cutoff',
      description: 'Applies the waiver to a booking ticketed after its cutoff.',
      caughtBy: ['settled:R5205'],
    },
    {
      id: 'missed-amendment',
      description:
        'Reads the weather waiver but not its amendment, and charges a platinum member travelling on the 5th.',
      caughtBy: ['settled:R5207'],
    },
    {
      id: 'same-day-flat-fee',
      description:
        'Charges a change fee and a fare difference for a same-day move that the same-day bulletin settles with one flat fee.',
      caughtBy: ['settled:R5208'],
    },
    {
      id: 'cheapest-bulletin',
      description:
        'Applies the same-day bulletin to a move the weather waiver covers for free, instead of the cheaper of the two.',
      caughtBy: ['settled:R5209'],
    },
    {
      id: 'wrong-segment',
      description: 'Changes the first leg of the connecting trip instead of the leg the customer asked to move.',
      caughtBy: ['moved:R5209'],
    },
    {
      id: 'waiver-used-once',
      description:
        "Waives the fees for a booking that already had its one move under the Chicago waiver, which only the reservation's history shows.",
      caughtBy: ['settled:R5210'],
    },
    {
      id: 'late-request',
      description: 'Lists the queue once and never sees the change request that arrives mid-run.',
      caughtBy: ['resolved:Q-311', 'moved:R5211'],
    },
    {
      id: 'scope-creep',
      description: 'Also works the cancellation request, which is not a change request.',
      caughtBy: ['out-of-scope-change'],
    },
  ],
  createWorld: createWaiverWorld,
  assertions: REQUESTS.flatMap(perRequest),
  forbidden: [
    blastRadiusRule<AirlineOpsWorld>({
      seed: createWaiverWorld,
      diff: OPS_DIFF,
      allow: anyOf(
        ...RESERVATIONS.map((id) => within('reservations', id)),
        ...REQUESTS.map((request) => within('requests', request.requestId)),
        addedTo('ledger', (entry) => RESERVATIONS.includes(String(entry.reservationId))),
        seatCounts,
        // The late request leaves the schedule and joins the queue.
        within('arrivals'),
        // Telling a requester about their own change is part of the job.
        addedTo('notifications', (entry) => REQUESTERS.includes(String(entry.passengerId))),
      ),
      label: 'Changed a booking or request outside the change requests',
    }),
  ],
};

export const airlineWaiversTask: Task = defineToolUseTask(airlineWaiversSpec);

export { REQUESTS as WAIVER_REQUESTS };
