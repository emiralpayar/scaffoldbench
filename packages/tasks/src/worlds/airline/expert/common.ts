import type { JournaledToolSpec } from '@arena/core';
import type { ToolUseTaskSpec } from '../../../defineToolUseTask';
import type { DiffOptions } from '../../../worldDiff';
import { AIRLINE_OPS_HANDBOOK } from '../handbook';
import { AIRLINE_OPS_INSTRUCTIONS, createAirlineOpsTools, type AirlineOpsWorld } from '../ops';
import {
  findReservation,
  type CabinClass,
  type Flight,
  type FlightCabin,
  type LedgerEntry,
  type Passenger,
  type Reservation,
  type Tier,
} from '../world';

/**
 * What every expert airline task shares: the world name, the operations
 * handbook and the full operations toolset. Each task brings its own seed,
 * prompt and scorer. Every task sees every ops tool, including the ones it
 * does not need, so the tool list itself never hints at the answer.
 */
export const AIRLINE_EXPERT_BASE = {
  world: 'airline',
  difficulty: 'expert',
  policy: AIRLINE_OPS_HANDBOOK,
  instructions: AIRLINE_OPS_INSTRUCTIONS,
  createTools: (world: AirlineOpsWorld): JournaledToolSpec[] => createAirlineOpsTools(world),
} satisfies Partial<ToolUseTaskSpec<AirlineOpsWorld>>;

export const OPS_DIFF: DiffOptions = { identity: ['id', 'cabin'] };

export const TIER_RANK: Record<Tier, number> = { none: 0, silver: 1, gold: 2, platinum: 3 };

export const CABIN_RANK: Record<CabinClass, number> = {
  basic_economy: 0,
  economy: 1,
  premium_economy: 2,
  business: 3,
};

export function reservationOrThrow(world: AirlineOpsWorld, id: string): Reservation {
  const reservation = findReservation(world, id);
  if (!reservation) throw new Error(`reservation ${id} vanished from the world`);
  return reservation;
}

/** Ledger entries the run added for a reservation: everything not present in the seed. */
export function addedEntries(
  seed: AirlineOpsWorld,
  world: AirlineOpsWorld,
  reservationId: string,
): LedgerEntry[] {
  const before = new Set(seed.ledger.map((entry) => entry.id));
  return world.ledger.filter(
    (entry) => entry.reservationId === reservationId && !before.has(entry.id),
  );
}

// ---------------------------------------------------------------------------
// Seed builders: keep the seed tables readable
// ---------------------------------------------------------------------------

export function flight(
  id: string,
  route: string,
  date: string,
  times: string,
  cabins: Partial<Record<CabinClass, [fareCents: number, seatsLeft: number]>>,
  status: Flight['status'] = 'scheduled',
): Flight {
  const [origin = '', destination = ''] = route.split('-');
  const [departureTime = '', arrivalTime] = times.split('-');
  const cabinList: FlightCabin[] = (Object.keys(cabins) as CabinClass[]).map((cabin) => {
    const [fareCents, seatsLeft] = cabins[cabin] ?? [0, 0];
    return { cabin, fareCents, seatsLeft };
  });
  return {
    id,
    origin,
    destination,
    date,
    departureTime,
    ...(arrivalTime ? { arrivalTime } : {}),
    status,
    cabins: cabinList,
  };
}

export function passenger(id: string, name: string, tier: Tier): Passenger {
  const handle = name.toLowerCase().replace(/[^a-z]+/g, '.');
  return { id, name, tier, email: `${handle}@example.com`, phone: `+1-555-01${id.slice(-2)}` };
}

export function reservation(
  id: string,
  pax: Passenger,
  flights: readonly Flight[],
  fields: Pick<Reservation, 'cabin' | 'paidCents' | 'bookedOn'> &
    Partial<Pick<Reservation, 'insurancePurchased' | 'checkedBags' | 'status' | 'paymentInstrumentId'>>,
): Reservation {
  return {
    id,
    passengerId: pax.id,
    passengerName: pax.name,
    segments: flights.map((entry) => ({
      flightId: entry.id,
      origin: entry.origin,
      destination: entry.destination,
      date: entry.date,
    })),
    cabin: fields.cabin,
    paidCents: fields.paidCents,
    insurancePurchased: fields.insurancePurchased ?? false,
    checkedBags: fields.checkedBags ?? 0,
    status: fields.status ?? 'confirmed',
    bookedOn: fields.bookedOn,
    ...(fields.paymentInstrumentId ? { paymentInstrumentId: fields.paymentInstrumentId } : {}),
  };
}
