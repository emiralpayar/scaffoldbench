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
 * airline-waiver-desk: five voluntary change requests, settled under dated
 * bulletins that exist only in the bulletin tool.
 *
 * The handbook says bulletins override it within their dates and scope, and
 * nothing more. What each bulletin says is only available by reading it:
 * a weather waiver for Chicago with a ticketing cutoff, a travel window and a
 * basic-economy carve-out; an expired hurricane waiver for Boston that one
 * customer still cites; and a standing bulletin that raises the basic economy
 * change fee above what the fare-rules tool still prints. Customers name
 * waivers that do not cover them, and one who is covered names none.
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

/** PB-2026-16: the basic economy change fee, superseding the fare-rules table. */
const BASIC_CHANGE_FEE = { id: 'PB-2026-16', effectiveFrom: '2026-07-01', cents: 15_000 } as const;

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
}

const REQUESTS: ChangeRequest[] = [
  { requestId: 'Q-301', reservationId: 'R5201', newFlightId: 'DL542' },
  { requestId: 'Q-302', reservationId: 'R5202', newFlightId: 'AA664' },
  { requestId: 'Q-303', reservationId: 'R5203', newFlightId: 'AA664' },
  { requestId: 'Q-304', reservationId: 'R5204', newFlightId: 'UA90' },
  { requestId: 'Q-305', reservationId: 'R5205', newFlightId: 'AA216' },
];

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
  ];
  const byId = (id: string) => flights.find((entry) => entry.id === id) as Flight;
  const pax = [
    passenger('P-2201', 'Ines Duarte', 'none'),
    passenger('P-2202', 'Jonah Pike', 'none'),
    passenger('P-2203', 'Kim Seo', 'silver'),
    passenger('P-2204', 'Lena Ortiz', 'gold'),
    passenger('P-2205', 'Max Weber', 'none'),
    passenger('P-2206', 'Nadia Kim', 'silver'),
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
      ],
      ledger: [],
    }),
    bulletins: structuredClone(BULLETINS),
    requests,
  };
}

// ---------------------------------------------------------------------------
// Oracle
// ---------------------------------------------------------------------------

type Waiver = 'full' | 'change-fee-only' | 'none';

/** What PB-2026-14 grants a move, read literally from its text. */
function chicagoWaiver(world: AirlineOpsWorld, booking: Reservation, target: Flight): Waiver {
  const original = booking.segments[0];
  if (!original) return 'none';
  const inForce =
    world.today >= CHICAGO_WAIVER.effectiveFrom && world.today <= CHICAGO_WAIVER.effectiveTo;
  const touchesOrd =
    original.origin === CHICAGO_WAIVER.airport || original.destination === CHICAGO_WAIVER.airport;
  const covered =
    inForce &&
    touchesOrd &&
    booking.bookedOn <= CHICAGO_WAIVER.ticketedBy &&
    original.date >= CHICAGO_WAIVER.travelFrom &&
    original.date <= CHICAGO_WAIVER.travelTo &&
    target.origin === original.origin &&
    target.destination === original.destination &&
    target.date <= CHICAGO_WAIVER.moveBy;
  if (!covered) return 'none';
  return booking.cabin === 'basic_economy' ? 'change-fee-only' : 'full';
}

export interface ExpectedFees {
  change_fee: number;
  fare_difference: number;
}

/** The fees a request owes, from the seed: base fare rules, then bulletins in force. */
export function expectedFees(seed: AirlineOpsWorld, request: ChangeRequest): ExpectedFees {
  const booking = reservationOrThrow(seed, request.reservationId);
  const target = findFlight(seed, request.newFlightId);
  const tier = findPassenger(seed, booking.passengerId)?.tier ?? 'none';
  if (!target) throw new Error(`no flight ${request.newFlightId} in the seed`);
  const waiver = chicagoWaiver(seed, booking, target);

  const baseChangeFee =
    booking.cabin === 'basic_economy' && seed.today >= BASIC_CHANGE_FEE.effectiveFrom
      ? BASIC_CHANGE_FEE.cents
      : CHANGE_FEE_BY_CABIN[booking.cabin];
  const changeFee = waiver !== 'none' || CHANGE_FEE_EXEMPT_TIERS.includes(tier) ? 0 : baseChangeFee;

  const newFare = findCabin(target, booking.cabin)?.fareCents ?? Number.NaN;
  const difference = Math.max(0, newFare - booking.paidCents);
  return { change_fee: changeFee, fare_difference: waiver === 'full' ? 0 : difference };
}

// ---------------------------------------------------------------------------
// Task
// ---------------------------------------------------------------------------

const RESERVATIONS = REQUESTS.map((request) => request.reservationId);

function perRequest(request: ChangeRequest): AssertionSpec<AirlineOpsWorld>[] {
  const { requestId, reservationId, newFlightId } = request;
  return [
    {
      id: `moved:${reservationId}`,
      label: `${reservationId} moved to ${newFlightId} in the same cabin`,
      weight: 1,
      check: (world) => {
        const booking = reservationOrThrow(world, reservationId);
        const original = reservationOrThrow(createWaiverWorld(), reservationId);
        return (
          booking.status === 'confirmed' &&
          booking.segments[0]?.flightId === newFlightId &&
          booking.cabin === original.cabin
        );
      },
    },
    {
      id: `settled:${reservationId}`,
      label: `${reservationId} charged exactly the change fee and fare difference owed`,
      weight: 2,
      check: (world) => {
        // Settling a change that never happened earns nothing, even when nothing was owed.
        if (reservationOrThrow(world, reservationId).segments[0]?.flightId !== newFlightId) {
          return false;
        }
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
  maxTurns: 70,
  prompt: [
    'The service queue has open flight-change requests from yesterday.',
    'Work all of them: make each change the customer asked for and settle it correctly.',
  ].join(' '),
  hypothesis:
    "plan-execute-verify > single > plan-execute. Every settlement turns on a dated bulletin reachable only through tools, and customers cite waivers that do not cover them. A state-grounded verifier that re-reads the bulletins against the ledger can catch a misapplied waiver and charge the remainder; a plan written before any bulletin is read inherits the customers' framing. The five requests are independent, so orchestrator-workers should match single on score at lower latency.",
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
      ),
      label: 'Changed a booking or request outside the change requests',
    }),
  ],
};

export const airlineWaiversTask: Task = defineToolUseTask(airlineWaiversSpec);

export { REQUESTS as WAIVER_REQUESTS };
