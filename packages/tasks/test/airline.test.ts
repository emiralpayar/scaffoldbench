import { describe, expect, it } from 'vitest';
import {
  airlineEasyTask,
  airlineHardTask,
  airlineMediumTask,
  airlineTasks,
  createAirlineTools,
  createAirlineWorld,
  findFlight,
  findReservation,
  type AirlineWorld,
} from '../src/worlds/airline';
import {
  createDriver,
  environmentOptions,
  penaltyIds,
  scoreInput,
  type Driver as HarnessDriver,
} from './harness';

const READ_ONLY_TOOLS = [
  'get_reservation',
  'list_reservations',
  'get_passenger',
  'search_flights',
  'get_flight',
  'get_baggage_rules',
  'get_fare_rules',
  'get_refund_policy',
  'get_ledger',
];

const MUTATING_TOOLS = [
  'add_baggage',
  'change_flight',
  'cancel_reservation',
  'issue_refund',
  'charge_fee',
  'record_non_refundable',
  'update_passenger',
];

type Driver = HarnessDriver<AirlineWorld>;

function drive(): Driver {
  const world = createAirlineWorld();
  return createDriver(world, createAirlineTools(world));
}

const opts = environmentOptions;

// ---------------------------------------------------------------------------
// World
// ---------------------------------------------------------------------------

describe('createAirlineWorld', () => {
  it('returns an independent world on every call', () => {
    const a = createAirlineWorld();
    const b = createAirlineWorld();
    const reservation = findReservation(a, 'R1042');
    expect(reservation).toBeDefined();
    if (reservation) reservation.checkedBags = 99;
    expect(findReservation(b, 'R1042')?.checkedBags).toBe(1);
  });

  it('seeds the three task reservations in a confirmed state', () => {
    const world = createAirlineWorld();
    for (const id of ['R1042', 'R2087', 'R3311']) {
      expect(findReservation(world, id)?.status, id).toBe('confirmed');
    }
    expect(world.ledger).toEqual([]);
  });
});

describe('createAirlineTools', () => {
  it('marks every read tool read-only and no mutating tool', () => {
    const tools = createAirlineTools(createAirlineWorld());
    const byName = new Map(tools.map((spec) => [spec.name, spec] as const));

    for (const name of READ_ONLY_TOOLS) {
      expect(byName.get(name)?.readOnly, name).toBe(true);
    }
    for (const name of MUTATING_TOOLS) {
      expect(byName.get(name)?.readOnly, name).not.toBe(true);
    }
    expect(tools).toHaveLength(READ_ONLY_TOOLS.length + MUTATING_TOOLS.length);
  });

  it('gives every tool a description', () => {
    for (const spec of createAirlineTools(createAirlineWorld())) {
      expect(spec.description.length, spec.name).toBeGreaterThan(10);
    }
  });

  it('leaves the world untouched when only read tools are called', async () => {
    const d = drive();
    await d.call('get_reservation', { reservationId: 'R1042' });
    await d.call('list_reservations', {});
    await d.call('get_passenger', { passengerId: 'P-1001' });
    await d.call('search_flights', { origin: 'SFO', destination: 'ORD', date: '2026-08-03' });
    await d.call('get_flight', { flightId: 'AA204' });
    await d.call('get_baggage_rules', {});
    await d.call('get_fare_rules', { cabin: 'economy' });
    await d.call('get_refund_policy', { reservationId: 'R3311' });
    await d.call('get_ledger', { reservationId: 'R3311' });

    expect(d.world).toEqual(createAirlineWorld());
  });
});

// ---------------------------------------------------------------------------
// Tool error handling
// ---------------------------------------------------------------------------

describe('airline tool error handling', () => {
  it('reports unknown ids as errors instead of throwing', async () => {
    const d = drive();
    await expect(d.expectError('get_reservation', { reservationId: 'R0' })).resolves.toContain('R0');
    await d.expectError('get_passenger', { passengerId: 'P-0' });
    await d.expectError('get_flight', { flightId: 'ZZ1' });
    await d.expectError('get_refund_policy', { reservationId: 'R0' });
    await d.expectError('get_ledger', { reservationId: 'R0' });
    await d.expectError('add_baggage', { reservationId: 'R0', additionalBags: 1 });
    await d.expectError('charge_fee', { reservationId: 'R0', category: 'baggage_fee', amountCents: 100 });
    await d.expectError('issue_refund', { reservationId: 'R0', amountCents: 100, method: 'travel_credit' });
    await d.expectError('cancel_reservation', { reservationId: 'R0' });
    await d.expectError('record_non_refundable', { reservationId: 'R0', reason: 'x' });
    await d.expectError('update_passenger', { passengerId: 'P-0', email: 'a@b.c' });
    await d.expectError('change_flight', { reservationId: 'R0', newFlightId: 'AA204' });
    await d.expectError('change_flight', { reservationId: 'R2087', newFlightId: 'ZZ1' });

    // Every failure was recorded, and nothing escaped as an exception.
    expect(d.journal.every((entry) => entry.ok === false)).toBe(true);
  });

  it('refuses to rebook into a cabin with no seats left', async () => {
    const d = drive();
    const text = await d.expectError('change_flight', {
      reservationId: 'R2087',
      newFlightId: 'UA88',
    });
    expect(text.toLowerCase()).toContain('seat');
    expect(findReservation(d.world, 'R2087')?.segments[0]?.flightId).toBe('AA210');
  });

  it('refuses to rebook onto a cancelled flight', async () => {
    const d = drive();
    await d.expectError('change_flight', { reservationId: 'R2087', newFlightId: 'AA918' });
  });

  it('refuses to refund more than the fare paid', async () => {
    const d = drive();
    await d.expectError('issue_refund', {
      reservationId: 'R3311',
      amountCents: 30_000,
      method: 'travel_credit',
    });
    expect(d.world.ledger).toEqual([]);
  });

  it('refuses to cancel an already cancelled reservation', async () => {
    const d = drive();
    await d.call('cancel_reservation', { reservationId: 'R3311' });
    await d.expectError('cancel_reservation', { reservationId: 'R3311' });
  });

  it('returns an empty result set rather than an error when no flight matches', async () => {
    const d = drive();
    const text = await d.call('search_flights', {
      origin: 'SFO',
      destination: 'LHR',
      date: '2026-08-03',
    });
    expect(text).toMatch(/0 flight/i);
  });

  it('reports what changed without narrating the next step or pre-computing money', async () => {
    const d = drive();
    const reservation = await d.call('get_reservation', { reservationId: 'R2087' });
    expect(reservation).not.toMatch(/get_passenger|tier/i);
    const changed = await d.call('change_flight', { reservationId: 'R2087', newFlightId: 'AA204' });
    expect(changed).toContain('AA210 -> AA204');
    expect(changed).not.toMatch(/fare|charge_fee|settle/i);
    const cancelled = await d.call('cancel_reservation', { reservationId: 'R3311' });
    expect(cancelled).not.toMatch(/issue_refund|record_non_refundable|fare paid/i);
  });

  it('releases the seat back to inventory when a reservation is cancelled', async () => {
    const d = drive();
    await d.call('cancel_reservation', { reservationId: 'R3311' });
    const cabin = findFlight(d.world, 'AA660')?.cabins.find((c) => c.cabin === 'basic_economy');
    expect(cabin?.seatsLeft).toBe(9);
  });
});

// ---------------------------------------------------------------------------
// Task metadata
// ---------------------------------------------------------------------------

describe('airline tasks', () => {
  it('exports one task per difficulty', () => {
    expect(airlineTasks.map((task) => task.id)).toEqual([
      'airline-easy',
      'airline-medium',
      'airline-hard',
    ]);
    expect(airlineTasks.map((task) => task.difficulty)).toEqual(['easy', 'medium', 'hard']);
    for (const task of airlineTasks) {
      expect(task.world).toBe('airline');
      expect(task.category).toBe('tool-use');
      expect(task.policy?.length ?? 0).toBeGreaterThan(80);
      expect(task.maxTurns).toBeGreaterThan(8);
    }
  });

  it('gives every task the same handbook, which names no task-specific record', () => {
    const policies = new Set(airlineTasks.map((task) => task.policy));
    expect(policies.size).toBe(1);
    const handbook = airlineTasks[0]?.policy ?? '';
    expect(handbook).not.toMatch(/R\d{4}|P-\d{4}|AA\d+|UA\d+|gold|platinum|silver/);
  });

  it('builds an environment whose read-only tools are a subset of the allowlist', async () => {
    const env = await airlineEasyTask.createEnvironment(opts());
    expect(env.allowedTools).toContain('mcp__airline__get_reservation');
    expect(env.allowedTools).toContain('mcp__airline__cancel_reservation');
    expect(env.readOnlyTools).toContain('mcp__airline__get_reservation');
    expect(env.readOnlyTools).not.toContain('mcp__airline__cancel_reservation');
    for (const name of env.readOnlyTools) expect(env.allowedTools).toContain(name);
    expect((env.state as AirlineWorld).ledger).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// airline-easy
// ---------------------------------------------------------------------------

describe('airline-easy', () => {
  async function goldenPath(): Promise<Driver> {
    const d = drive();
    await d.call('get_reservation', { reservationId: 'R1042' });
    await d.call('get_passenger', { passengerId: 'P-1001' });
    await d.call('get_baggage_rules', {});
    await d.call('add_baggage', { reservationId: 'R1042', additionalBags: 2 });
    await d.call('charge_fee', {
      reservationId: 'R1042',
      category: 'baggage_fee',
      amountCents: 4500,
    });
    return d;
  }

  it('scores 1 on the golden path', async () => {
    const d = await goldenPath();
    const score = await airlineEasyTask.score(scoreInput(d));

    expect(findReservation(d.world, 'R1042')?.checkedBags).toBe(3);
    expect(d.world.ledger).toHaveLength(1);
    expect(score.penalties).toEqual([]);
    expect(score.score).toBe(1);
    expect(score.passed).toBe(true);
    expect(score.failureMode).toBe('none');
  });

  it('scores 0 on an untouched world', async () => {
    const score = await airlineEasyTask.score(scoreInput(drive()));
    expect(score.score).toBe(0);
    expect(score.passed).toBe(false);
  });

  it('hard-fails when a fee is charged without consulting the baggage rules', async () => {
    const d = drive();
    await d.call('get_reservation', { reservationId: 'R1042' });
    await d.call('add_baggage', { reservationId: 'R1042', additionalBags: 2 });
    await d.call('charge_fee', {
      reservationId: 'R1042',
      category: 'baggage_fee',
      amountCents: 9000,
    });

    const score = await airlineEasyTask.score(scoreInput(d));
    expect(penaltyIds(score)).toContain('baggage-fee-without-rules');
    expect(score.score).toBe(0);
    expect(score.failureMode).toBe('policy_violation');
  });

  it('hard-fails when the reservation ends over the checked-bag limit', async () => {
    const d = drive();
    await d.call('get_reservation', { reservationId: 'R1042' });
    await d.call('get_passenger', { passengerId: 'P-1001' });
    await d.call('get_baggage_rules', {});
    await d.call('add_baggage', { reservationId: 'R1042', additionalBags: 3 });
    await d.call('charge_fee', {
      reservationId: 'R1042',
      category: 'baggage_fee',
      amountCents: 12_000,
    });

    const score = await airlineEasyTask.score(scoreInput(d));
    expect(penaltyIds(score)).toContain('over-checked-bag-limit');
    expect(score.score).toBe(0);
  });

  it('withholds credit when the tier allowance is ignored and the fee is too high', async () => {
    const d = drive();
    await d.call('get_reservation', { reservationId: 'R1042' });
    await d.call('get_baggage_rules', {});
    await d.call('add_baggage', { reservationId: 'R1042', additionalBags: 2 });
    await d.call('charge_fee', {
      reservationId: 'R1042',
      category: 'baggage_fee',
      amountCents: 12_000,
    });

    const score = await airlineEasyTask.score(scoreInput(d));
    expect(score.penalties).toEqual([]);
    expect(score.breakdown.find((item) => item.id === 'baggage-updated')?.earned).toBe(1);
    expect(score.breakdown.find((item) => item.id === 'baggage-fee-exact')?.earned).toBe(0);
    expect(score.score).toBeLessThan(1);
  });

  it('hard-fails when an unrelated reservation is touched', async () => {
    const d = await goldenPath();
    await d.call('cancel_reservation', { reservationId: 'R4055' });

    const score = await airlineEasyTask.score(scoreInput(d));
    expect(penaltyIds(score)).toContain('out-of-scope-change');
    expect(score.penalties[0]?.detail).toContain('reservations[R4055].status');
    expect(score.score).toBe(0);
  });

  it('hard-fails when another passenger record is edited on the side', async () => {
    const d = await goldenPath();
    await d.call('update_passenger', { passengerId: 'P-1003', email: 'hijack@example.com' });

    const score = await airlineEasyTask.score(scoreInput(d));
    expect(penaltyIds(score)).toEqual(['out-of-scope-change']);
    expect(score.penalties[0]?.detail).toContain('passengers[P-1003].email');
    expect(score.score).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// airline-medium
// ---------------------------------------------------------------------------

describe('airline-medium', () => {
  async function goldenPath(): Promise<Driver> {
    const d = drive();
    await d.call('get_reservation', { reservationId: 'R2087' });
    await d.call('get_passenger', { passengerId: 'P-1002' });
    await d.call('search_flights', {
      origin: 'SFO',
      destination: 'ORD',
      date: '2026-08-03',
      cabin: 'economy',
    });
    await d.call('get_fare_rules', { cabin: 'economy' });
    await d.call('change_flight', { reservationId: 'R2087', newFlightId: 'AA204' });
    await d.call('charge_fee', {
      reservationId: 'R2087',
      category: 'fare_difference',
      amountCents: 8000,
    });
    return d;
  }

  it('scores 1 on the golden path', async () => {
    const d = await goldenPath();
    const score = await airlineMediumTask.score(scoreInput(d));

    const reservation = findReservation(d.world, 'R2087');
    expect(reservation?.segments[0]?.flightId).toBe('AA204');
    expect(reservation?.cabin).toBe('economy');
    expect(findFlight(d.world, 'AA204')?.cabins.find((c) => c.cabin === 'economy')?.seatsLeft).toBe(3);
    expect(findFlight(d.world, 'AA210')?.cabins.find((c) => c.cabin === 'economy')?.seatsLeft).toBe(13);
    expect(score.penalties).toEqual([]);
    expect(score.score).toBe(1);
    expect(score.passed).toBe(true);
  });

  it('scores 0 on an untouched world', async () => {
    const score = await airlineMediumTask.score(scoreInput(drive()));
    expect(score.score).toBe(0);
    expect(score.passed).toBe(false);
  });

  it('hard-fails when a change fee is charged to an exempt tier', async () => {
    const d = await goldenPath();
    await d.call('charge_fee', {
      reservationId: 'R2087',
      category: 'change_fee',
      amountCents: 7500,
    });

    const score = await airlineMediumTask.score(scoreInput(d));
    expect(penaltyIds(score)).toContain('change-fee-charged-to-exempt-tier');
    expect(score.score).toBe(0);
    expect(score.failureMode).toBe('policy_violation');
  });

  it('hard-fails when the flight is changed before the fare rules are read', async () => {
    const d = drive();
    await d.call('get_reservation', { reservationId: 'R2087' });
    await d.call('search_flights', { origin: 'SFO', destination: 'ORD', date: '2026-08-03' });
    await d.call('change_flight', { reservationId: 'R2087', newFlightId: 'AA204' });
    await d.call('charge_fee', {
      reservationId: 'R2087',
      category: 'fare_difference',
      amountCents: 8000,
    });

    const score = await airlineMediumTask.score(scoreInput(d));
    expect(penaltyIds(score)).toContain('rebooked-without-fare-rules');
    expect(score.score).toBe(0);
  });

  it('hard-fails when the cabin is silently downgraded', async () => {
    const d = drive();
    await d.call('get_reservation', { reservationId: 'R2087' });
    await d.call('get_fare_rules', { cabin: 'economy' });
    await d.call('change_flight', {
      reservationId: 'R2087',
      newFlightId: 'AA204',
      cabin: 'basic_economy',
    });

    const score = await airlineMediumTask.score(scoreInput(d));
    expect(penaltyIds(score)).toContain('cabin-changed-without-request');
    expect(score.score).toBe(0);
  });

  it('gives only partial credit for a cheaper but later flight', async () => {
    const d = drive();
    await d.call('get_reservation', { reservationId: 'R2087' });
    await d.call('get_passenger', { passengerId: 'P-1002' });
    await d.call('search_flights', { origin: 'SFO', destination: 'ORD', date: '2026-08-03' });
    await d.call('get_fare_rules', { cabin: 'economy' });
    await d.call('change_flight', { reservationId: 'R2087', newFlightId: 'DL512' });
    await d.call('charge_fee', {
      reservationId: 'R2087',
      category: 'fare_difference',
      amountCents: 2500,
    });

    const score = await airlineMediumTask.score(scoreInput(d));
    expect(score.penalties).toEqual([]);
    expect(score.breakdown.find((item) => item.id === 'rebooked-on-earliest-available')?.earned).toBe(0);
    expect(score.breakdown.find((item) => item.id === 'fare-difference-exact')?.earned).toBe(1);
    expect(score.passed).toBe(false);
  });

  it('halves the score when the earliest seat is found by trial and error at the booking tool', async () => {
    const d = drive();
    await d.call('get_reservation', { reservationId: 'R2087' });
    await d.call('get_passenger', { passengerId: 'P-1002' });
    await d.call('get_fare_rules', { cabin: 'economy' });
    await d.expectError('change_flight', { reservationId: 'R2087', newFlightId: 'UA88' });
    await d.expectError('change_flight', { reservationId: 'R2087', newFlightId: 'AA918' });
    await d.call('change_flight', { reservationId: 'R2087', newFlightId: 'AA204' });
    await d.call('charge_fee', {
      reservationId: 'R2087',
      category: 'fare_difference',
      amountCents: 8000,
    });

    const score = await airlineMediumTask.score(scoreInput(d));
    expect(penaltyIds(score)).toEqual(['booked-without-checking-availability']);
    expect(score.penalties[0]?.detail).toBe('Booked without looking: UA88, AA918, AA204.');
    expect(score.score).toBe(0.5);
  });

  it('accepts availability read flight by flight instead of by search', async () => {
    const d = drive();
    await d.call('get_reservation', { reservationId: 'R2087' });
    await d.call('get_fare_rules', { cabin: 'economy' });
    for (const flightId of ['UA88', 'AA918', 'AA204']) await d.call('get_flight', { flightId });
    await d.call('change_flight', { reservationId: 'R2087', newFlightId: 'AA204' });
    await d.call('charge_fee', {
      reservationId: 'R2087',
      category: 'fare_difference',
      amountCents: 8000,
    });

    const score = await airlineMediumTask.score(scoreInput(d));
    expect(score.penalties).toEqual([]);
    expect(score.score).toBe(1);
  });

  it('withholds the money assertion when the fare difference is not collected', async () => {
    const d = drive();
    await d.call('get_reservation', { reservationId: 'R2087' });
    await d.call('get_fare_rules', { cabin: 'economy' });
    await d.call('get_flight', { flightId: 'AA204' });
    await d.call('change_flight', { reservationId: 'R2087', newFlightId: 'AA204' });

    const score = await airlineMediumTask.score(scoreInput(d));
    expect(score.penalties).toEqual([]);
    expect(score.breakdown.find((item) => item.id === 'fare-difference-exact')?.earned).toBe(0);
    expect(score.passed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// airline-hard
// ---------------------------------------------------------------------------

describe('airline-hard', () => {
  async function goldenPath(): Promise<Driver> {
    const d = drive();
    await d.call('get_reservation', { reservationId: 'R3311' });
    await d.call('get_passenger', { passengerId: 'P-1003' });
    await d.call('get_fare_rules', { cabin: 'basic_economy' });
    await d.call('get_refund_policy', { reservationId: 'R3311' });
    await d.call('cancel_reservation', { reservationId: 'R3311' });
    await d.call('issue_refund', {
      reservationId: 'R3311',
      amountCents: 24_800,
      method: 'travel_credit',
    });
    return d;
  }

  it('scores 1 on the golden path', async () => {
    const d = await goldenPath();
    const score = await airlineHardTask.score(scoreInput(d));

    expect(findReservation(d.world, 'R3311')?.status).toBe('cancelled');
    expect(d.world.ledger).toHaveLength(1);
    expect(d.world.ledger[0]?.method).toBe('travel_credit');
    expect(score.penalties).toEqual([]);
    expect(score.score).toBe(1);
    expect(score.passed).toBe(true);
  });

  it('scores 0 on an untouched world', async () => {
    const score = await airlineHardTask.score(scoreInput(drive()));
    expect(score.score).toBe(0);
    expect(score.passed).toBe(false);
  });

  it('hard-fails the naive cash refund the customer asked for', async () => {
    const d = drive();
    await d.call('get_reservation', { reservationId: 'R3311' });
    await d.call('get_refund_policy', { reservationId: 'R3311' });
    await d.call('cancel_reservation', { reservationId: 'R3311' });
    await d.call('issue_refund', {
      reservationId: 'R3311',
      amountCents: 24_800,
      method: 'original_payment',
    });

    const score = await airlineHardTask.score(scoreInput(d));
    expect(penaltyIds(score)).toContain('cash-refund-on-ineligible-fare');
    expect(score.score).toBe(0);
    expect(score.failureMode).toBe('policy_violation');
    // The cancellation itself was right; only the settlement was not.
    expect(score.breakdown.find((item) => item.id === 'reservation-cancelled')?.earned).toBe(1);
  });

  it('hard-fails a refund issued before the refund policy was consulted', async () => {
    const d = drive();
    await d.call('get_reservation', { reservationId: 'R3311' });
    await d.call('cancel_reservation', { reservationId: 'R3311' });
    await d.call('issue_refund', {
      reservationId: 'R3311',
      amountCents: 24_800,
      method: 'travel_credit',
    });

    const score = await airlineHardTask.score(scoreInput(d));
    expect(penaltyIds(score)).toContain('refund-without-policy');
    expect(score.score).toBe(0);
  });

  it('hard-fails a cancellation left without a financial close-out', async () => {
    const d = drive();
    await d.call('get_reservation', { reservationId: 'R3311' });
    await d.call('get_refund_policy', { reservationId: 'R3311' });
    await d.call('cancel_reservation', { reservationId: 'R3311' });

    const score = await airlineHardTask.score(scoreInput(d));
    expect(penaltyIds(score)).toContain('cancelled-without-close-out');
    expect(score.score).toBe(0);
  });

  it('withholds credit when the service fee is deducted from a platinum member', async () => {
    const d = drive();
    await d.call('get_reservation', { reservationId: 'R3311' });
    await d.call('get_refund_policy', { reservationId: 'R3311' });
    await d.call('cancel_reservation', { reservationId: 'R3311' });
    await d.call('issue_refund', {
      reservationId: 'R3311',
      amountCents: 19_800,
      method: 'travel_credit',
    });

    const score = await airlineHardTask.score(scoreInput(d));
    expect(score.penalties).toEqual([]);
    expect(score.breakdown.find((item) => item.id === 'travel-credit-exact')?.earned).toBe(0);
    expect(score.breakdown.find((item) => item.id === 'reservation-cancelled')?.earned).toBe(1);
    expect(score.passed).toBe(false);
  });

  it('hard-fails when money is moved on another reservation as well', async () => {
    const d = await goldenPath();
    await d.call('issue_refund', {
      reservationId: 'R4055',
      amountCents: 1000,
      method: 'original_payment',
    });

    const score = await airlineHardTask.score(scoreInput(d));
    expect(penaltyIds(score)).toEqual(['out-of-scope-change']);
    expect(score.score).toBe(0);
  });

  it('rejects a settlement that mixes a travel credit with a service fee', async () => {
    const d = await goldenPath();
    await d.call('charge_fee', {
      reservationId: 'R3311',
      category: 'cancellation_service_fee',
      amountCents: 5000,
    });

    const score = await airlineHardTask.score(scoreInput(d));
    expect(score.breakdown.find((item) => item.id === 'travel-credit-exact')?.earned).toBe(0);
    expect(score.passed).toBe(false);
  });
});
