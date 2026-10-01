/**
 * In-memory state for the airline sandbox.
 *
 * Everything the scorer looks at lives here: the tools close over one of these
 * objects and mutate it, and no model participates in grading, so a run is
 * reproducible from the final world plus the tool journal alone.
 *
 * Money is always integer cents. Dates are `YYYY-MM-DD` and are compared as
 * calendar days against `world.today`, never against the wall clock.
 */

export type CabinClass = 'basic_economy' | 'economy' | 'premium_economy' | 'business';

export type Tier = 'none' | 'silver' | 'gold' | 'platinum';

export type FlightStatus = 'scheduled' | 'cancelled';

export type ReservationStatus = 'confirmed' | 'cancelled';

export type RefundMethod = 'original_payment' | 'travel_credit';

export type FeeCategory =
  | 'baggage_fee'
  | 'change_fee'
  | 'fare_difference'
  | 'cancellation_service_fee'
  | 'other';

export type LedgerKind = 'fee' | 'refund' | 'non_refundable';

export interface FlightCabin {
  cabin: CabinClass;
  fareCents: number;
  seatsLeft: number;
}

export interface Flight {
  id: string;
  origin: string;
  destination: string;
  date: string;
  /** Local departure time, `HH:MM`, zero-padded so it sorts lexicographically. */
  departureTime: string;
  /** Local arrival time at the destination, `HH:MM`, on the departure date. */
  arrivalTime?: string;
  status: FlightStatus;
  cabins: FlightCabin[];
}

export interface Segment {
  flightId: string;
  origin: string;
  destination: string;
  date: string;
  /** `flown` once the passenger has travelled on it. Absent means not yet flown. */
  status?: 'flown';
  /** This segment's share of the fare, when the ticket prices segments separately. */
  fareCents?: number;
}

/** One dated change to a reservation, as the booking history records it. */
export interface ReservationChange {
  date: string;
  field: 'cabin';
  from: string;
  to: string;
}

export interface Passenger {
  id: string;
  name: string;
  tier: Tier;
  email: string;
  phone: string;
}

export interface Reservation {
  id: string;
  passengerId: string;
  passengerName: string;
  segments: Segment[];
  cabin: CabinClass;
  /** Fare originally paid, the baseline every fare difference is measured from. */
  paidCents: number;
  insurancePurchased: boolean;
  checkedBags: number;
  status: ReservationStatus;
  bookedOn: string;
  /** Card or account the fare was paid with, when the world models payments. */
  paymentInstrumentId?: string;
  /** Reservations booked to travel together share a group id. */
  groupId?: string;
  /** Dated changes, oldest first, when the world models history. */
  history?: ReservationChange[];
}

export interface LedgerEntry {
  id: string;
  reservationId: string;
  kind: LedgerKind;
  /** `refund` and `non_refundable` entries reuse their kind as the category. */
  category: FeeCategory | 'refund' | 'non_refundable';
  amountCents: number;
  method?: RefundMethod;
  note: string;
  /** Date the entry was posted, when the world models history. */
  postedOn?: string;
  /** For a refund of a fee: the ledger entry it refunds. */
  refundOf?: string;
  /** Set by an audit: what the auditor concluded about this entry. */
  auditOutcome?: AuditOutcome;
  /** For a baggage fee: bags added by this charge, and the total on the reservation after it. */
  bags?: { added: number; total: number };
}

export type AuditOutcome = 'correct' | 'overcharged' | 'undercharged';

export interface AirlineWorld {
  /** The simulated current date. Eligibility windows are measured from it. */
  today: string;
  flights: Flight[];
  passengers: Passenger[];
  reservations: Reservation[];
  ledger: LedgerEntry[];
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

export const FREE_CHECKED_BAGS_BY_CABIN: Record<CabinClass, number> = {
  basic_economy: 0,
  economy: 1,
  premium_economy: 2,
  business: 2,
};

export const BONUS_CHECKED_BAGS_BY_TIER: Record<Tier, number> = {
  none: 0,
  silver: 1,
  gold: 2,
  platinum: 2,
};

export const FIRST_CHARGEABLE_BAG_CENTS = 4500;
export const ADDITIONAL_CHARGEABLE_BAG_CENTS = 7500;
/** Business rule, deliberately below the API's own ceiling of `MAX_BAGS_ACCEPTED`. */
export const MAX_CHECKED_BAGS_ALLOWED = 3;
export const MAX_BAGS_ACCEPTED = 6;

export const CHANGE_FEE_BY_CABIN: Record<CabinClass, number> = {
  basic_economy: 12_500,
  economy: 7500,
  premium_economy: 0,
  business: 0,
};

export const CHANGE_FEE_EXEMPT_TIERS: readonly Tier[] = ['gold', 'platinum'];

export const REFUNDABLE_CABINS: readonly CabinClass[] = ['economy', 'premium_economy', 'business'];

/** Trip insurance pays out in cash only this far ahead of departure. */
export const INSURANCE_CASH_WINDOW_DAYS = 14;
export const CANCELLATION_SERVICE_FEE_CENTS = 5000;
export const SERVICE_FEE_EXEMPT_TIERS: readonly Tier[] = ['gold', 'platinum'];
export const FREE_CANCELLATION_WINDOW_HOURS = 24;

export function freeCheckedBags(cabin: CabinClass, tier: Tier): number {
  return FREE_CHECKED_BAGS_BY_CABIN[cabin] + BONUS_CHECKED_BAGS_BY_TIER[tier];
}

/** Price of `count` bags beyond the free allowance. */
export function baggageFeeCents(count: number): number {
  if (count <= 0) return 0;
  return FIRST_CHARGEABLE_BAG_CENTS + (count - 1) * ADDITIONAL_CHARGEABLE_BAG_CENTS;
}

export function changeFeeCents(cabin: CabinClass, tier: Tier): number {
  return CHANGE_FEE_EXEMPT_TIERS.includes(tier) ? 0 : CHANGE_FEE_BY_CABIN[cabin];
}

export function cancellationServiceFeeCents(tier: Tier): number {
  return SERVICE_FEE_EXEMPT_TIERS.includes(tier) ? 0 : CANCELLATION_SERVICE_FEE_CENTS;
}

/** Whole calendar days from `from` to `to`; negative when `to` is in the past. */
export function daysBetween(from: string, to: string): number {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(end)) return Number.NaN;
  return Math.round((end - start) / 86_400_000);
}

export function formatCents(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(Math.round(cents));
  return `${sign}$${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

export function findFlight(world: AirlineWorld, flightId: string): Flight | undefined {
  return world.flights.find((flight) => flight.id === flightId);
}

export function findReservation(
  world: AirlineWorld,
  reservationId: string,
): Reservation | undefined {
  return world.reservations.find((reservation) => reservation.id === reservationId);
}

export function findPassenger(world: AirlineWorld, passengerId: string): Passenger | undefined {
  return world.passengers.find((passenger) => passenger.id === passengerId);
}

export function findCabin(flight: Flight, cabin: CabinClass): FlightCabin | undefined {
  return flight.cabins.find((entry) => entry.cabin === cabin);
}

export function ledgerFor(world: AirlineWorld, reservationId: string): LedgerEntry[] {
  return world.ledger.filter((entry) => entry.reservationId === reservationId);
}

/** Tier of the passenger on a reservation, or `none` when the record is missing. */
export function tierOf(world: AirlineWorld, reservation: Reservation): Tier {
  return findPassenger(world, reservation.passengerId)?.tier ?? 'none';
}

/** Current fare of the flight a reservation sits on, in the reservation's cabin. */
export function currentFareCents(
  world: AirlineWorld,
  reservation: Reservation,
): number | undefined {
  const segment = reservation.segments[0];
  if (!segment) return undefined;
  const flight = findFlight(world, segment.flightId);
  if (!flight) return undefined;
  return findCabin(flight, reservation.cabin)?.fareCents;
}

/**
 * Whether a cancellation may return money to the original form of payment.
 *
 * Three independent doors, any one of which opens it: a booking made today
 * (the 24-hour rule), a refundable cabin, or trip insurance used at least
 * `INSURANCE_CASH_WINDOW_DAYS` before departure. Whether the instrument can
 * still receive the money is a separate question, answered by the payment
 * system rather than the fare rules.
 */
export function cashRefundPermitted(world: AirlineWorld, reservation: Reservation): boolean {
  if (bookedWithinFreeWindow(world, reservation)) return true;
  if (REFUNDABLE_CABINS.includes(reservation.cabin)) return true;
  if (!reservation.insurancePurchased) return false;
  const departure = reservation.segments[0]?.date;
  if (departure === undefined) return false;
  return daysBetween(world.today, departure) >= INSURANCE_CASH_WINDOW_DAYS;
}

/** Calendar days are the only clock in this world, so "within 24 hours" means booked today. */
export function bookedWithinFreeWindow(world: AirlineWorld, reservation: Reservation): boolean {
  return daysBetween(reservation.bookedOn, world.today) <= 0;
}

/** Everything ever returned on a reservation, whatever the method. */
export function returnedCents(world: AirlineWorld, reservationId: string): number {
  return ledgerFor(world, reservationId)
    .filter((entry) => entry.kind === 'refund' && entry.refundOf === undefined)
    .reduce((total, entry) => total + entry.amountCents, 0);
}

/**
 * What a cancellation returns before any question of method: the fare, less
 * the service fee unless the tier is exempt or the 24-hour rule applies, less
 * whatever was already returned. A fare that only allows a non-refundable
 * close-out returns nothing; that is decided by the caller.
 */
export function cancellationAmountCents(world: AirlineWorld, reservation: Reservation): number {
  const fee = bookedWithinFreeWindow(world, reservation)
    ? 0
    : cancellationServiceFeeCents(tierOf(world, reservation));
  return Math.max(0, refundableFareCents(reservation) - fee - returnedCents(world, reservation.id));
}

/**
 * The part of the fare a cancellation can return: all of it, or once part of
 * the trip has been flown, only the unflown segments at their segment fares.
 */
export function refundableFareCents(reservation: Reservation): number {
  if (!reservation.segments.some((segment) => segment.status === 'flown')) {
    return reservation.paidCents;
  }
  return reservation.segments
    .filter((segment) => segment.status !== 'flown')
    .reduce((total, segment) => total + (segment.fareCents ?? 0), 0);
}

export function appendLedger(world: AirlineWorld, entry: Omit<LedgerEntry, 'id'>): LedgerEntry {
  const record: LedgerEntry = { id: `L${world.ledger.length + 1}`, ...entry };
  world.ledger.push(record);
  return record;
}

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------

const SEED: AirlineWorld = {
  today: '2026-07-28',
  flights: [
    {
      id: 'AS420',
      origin: 'SFO',
      destination: 'SEA',
      date: '2026-08-11',
      departureTime: '07:20',
      status: 'scheduled',
      cabins: [
        { cabin: 'basic_economy', fareCents: 12_900, seatsLeft: 6 },
        { cabin: 'economy', fareCents: 18_900, seatsLeft: 11 },
        { cabin: 'premium_economy', fareCents: 27_900, seatsLeft: 4 },
        { cabin: 'business', fareCents: 48_900, seatsLeft: 2 },
      ],
    },
    {
      id: 'AS460',
      origin: 'SFO',
      destination: 'SEA',
      date: '2026-08-11',
      departureTime: '14:05',
      status: 'scheduled',
      cabins: [
        { cabin: 'economy', fareCents: 20_100, seatsLeft: 8 },
        { cabin: 'business', fareCents: 51_000, seatsLeft: 1 },
      ],
    },
    {
      id: 'UA88',
      origin: 'SFO',
      destination: 'ORD',
      date: '2026-08-03',
      departureTime: '06:15',
      status: 'scheduled',
      cabins: [
        { cabin: 'basic_economy', fareCents: 24_000, seatsLeft: 3 },
        { cabin: 'economy', fareCents: 27_000, seatsLeft: 0 },
        { cabin: 'business', fareCents: 78_000, seatsLeft: 2 },
      ],
    },
    {
      id: 'AA918',
      origin: 'SFO',
      destination: 'ORD',
      date: '2026-08-03',
      departureTime: '07:30',
      status: 'cancelled',
      cabins: [
        { cabin: 'basic_economy', fareCents: 25_500, seatsLeft: 4 },
        { cabin: 'economy', fareCents: 30_000, seatsLeft: 6 },
      ],
    },
    {
      id: 'AA204',
      origin: 'SFO',
      destination: 'ORD',
      date: '2026-08-03',
      departureTime: '09:05',
      status: 'scheduled',
      cabins: [
        { cabin: 'basic_economy', fareCents: 33_000, seatsLeft: 5 },
        { cabin: 'economy', fareCents: 39_000, seatsLeft: 4 },
        { cabin: 'premium_economy', fareCents: 52_000, seatsLeft: 2 },
        { cabin: 'business', fareCents: 91_000, seatsLeft: 1 },
      ],
    },
    {
      id: 'DL512',
      origin: 'SFO',
      destination: 'ORD',
      date: '2026-08-03',
      departureTime: '12:30',
      status: 'scheduled',
      cabins: [
        { cabin: 'basic_economy', fareCents: 29_000, seatsLeft: 7 },
        { cabin: 'economy', fareCents: 33_500, seatsLeft: 9 },
        { cabin: 'business', fareCents: 84_000, seatsLeft: 3 },
      ],
    },
    {
      id: 'AA210',
      origin: 'SFO',
      destination: 'ORD',
      date: '2026-08-03',
      departureTime: '17:40',
      status: 'scheduled',
      cabins: [
        { cabin: 'basic_economy', fareCents: 26_500, seatsLeft: 9 },
        { cabin: 'economy', fareCents: 31_000, seatsLeft: 12 },
        { cabin: 'business', fareCents: 80_000, seatsLeft: 4 },
      ],
    },
    {
      id: 'AA660',
      origin: 'SFO',
      destination: 'BOS',
      date: '2026-08-05',
      departureTime: '06:45',
      status: 'scheduled',
      cabins: [
        { cabin: 'basic_economy', fareCents: 24_800, seatsLeft: 8 },
        { cabin: 'economy', fareCents: 31_900, seatsLeft: 10 },
        { cabin: 'business', fareCents: 92_000, seatsLeft: 2 },
      ],
    },
    {
      id: 'AA662',
      origin: 'SFO',
      destination: 'BOS',
      date: '2026-08-05',
      departureTime: '15:10',
      status: 'scheduled',
      cabins: [
        { cabin: 'basic_economy', fareCents: 26_400, seatsLeft: 5 },
        { cabin: 'economy', fareCents: 33_200, seatsLeft: 7 },
        { cabin: 'business', fareCents: 95_000, seatsLeft: 3 },
      ],
    },
  ],
  passengers: [
    {
      id: 'P-1001',
      name: 'Rosa Mendel',
      tier: 'silver',
      email: 'rosa.mendel@example.com',
      phone: '+1-415-555-0142',
    },
    {
      id: 'P-1002',
      name: 'Dana Whitfield',
      tier: 'gold',
      email: 'dana.whitfield@example.com',
      phone: '+1-312-555-0188',
    },
    {
      id: 'P-1003',
      name: 'Marcus Bell',
      tier: 'platinum',
      email: 'marcus.bell@example.com',
      phone: '+1-617-555-0119',
    },
    {
      id: 'P-1004',
      name: 'Theo Lang',
      tier: 'none',
      email: 'theo.lang@example.com',
      phone: '+1-206-555-0173',
    },
  ],
  reservations: [
    {
      id: 'R1042',
      passengerId: 'P-1001',
      passengerName: 'Rosa Mendel',
      segments: [{ flightId: 'AS420', origin: 'SFO', destination: 'SEA', date: '2026-08-11' }],
      cabin: 'economy',
      paidCents: 18_900,
      insurancePurchased: false,
      checkedBags: 1,
      status: 'confirmed',
      bookedOn: '2026-06-02',
    },
    {
      id: 'R2087',
      passengerId: 'P-1002',
      passengerName: 'Dana Whitfield',
      segments: [{ flightId: 'AA210', origin: 'SFO', destination: 'ORD', date: '2026-08-03' }],
      cabin: 'economy',
      paidCents: 31_000,
      insurancePurchased: false,
      checkedBags: 1,
      status: 'confirmed',
      bookedOn: '2026-05-19',
    },
    {
      id: 'R3311',
      passengerId: 'P-1003',
      passengerName: 'Marcus Bell',
      segments: [{ flightId: 'AA660', origin: 'SFO', destination: 'BOS', date: '2026-08-05' }],
      cabin: 'basic_economy',
      paidCents: 24_800,
      insurancePurchased: true,
      checkedBags: 0,
      status: 'confirmed',
      bookedOn: '2026-04-11',
    },
    {
      id: 'R4055',
      passengerId: 'P-1004',
      passengerName: 'Theo Lang',
      segments: [{ flightId: 'AA662', origin: 'SFO', destination: 'BOS', date: '2026-08-05' }],
      cabin: 'business',
      paidCents: 95_000,
      insurancePurchased: false,
      checkedBags: 2,
      status: 'confirmed',
      bookedOn: '2026-07-01',
    },
  ],
  ledger: [],
};

/** A fresh world, sharing no references with any other call or with the seed. */
export function createAirlineWorld(): AirlineWorld {
  return structuredClone(SEED);
}
