import { describe, expect, it } from 'vitest';
import type { TaskScore } from '@arena/core';
import { defineToolUseTask, type ToolUseTaskSpec } from '../src/defineToolUseTask';
import { firedTraps } from '../src/traps';
import {
  AIRLINE_OPS_HANDBOOK,
  airlineBaggageAuditSpec,
  airlineBaggageAuditTask,
  airlineCancellationsSpec,
  airlineCancellationsTask,
  airlineExpertTasks,
  airlineIrropsSpec,
  airlineIrropsTask,
  airlineWaiversSpec,
  airlineWaiversTask,
  auditOracle,
  CANCELLATIONS,
  createBaggageAuditSpec,
  compensationFor,
  createAirlineOpsTools,
  createBaggageAuditWorld,
  createCancellationWorld,
  createIrropsWorld,
  createWaiverWorld,
  expectedFees,
  expectedSettlement,
  findFlight,
  findReservation,
  generateBaggageAudit,
  irropsOracle,
  WAIVER_REQUESTS,
  type AirlineOpsWorld,
} from '../src/worlds/airline';
import { createDriver, earned, environmentOptions, missed, penaltyIds, scoreInput, type Driver } from './harness';
import type { Task } from '@arena/core';

type OpsDriver = Driver<AirlineOpsWorld>;

function drive(spec: ToolUseTaskSpec<AirlineOpsWorld>, world = spec.createWorld()): OpsDriver {
  return createDriver(world, spec.createTools(world));
}

async function score(task: Task, d: OpsDriver): Promise<TaskScore> {
  return task.score(scoreInput(d));
}

function seats(world: AirlineOpsWorld, flightId: string, cabin: string): number | undefined {
  return findFlight(world, flightId)?.cabins.find((entry) => entry.cabin === cabin)?.seatsLeft;
}

// ---------------------------------------------------------------------------
// Shared metadata
// ---------------------------------------------------------------------------

describe('airline expert tier', () => {
  it('registers four expert tasks with hypotheses and traps on the ops handbook', () => {
    expect(airlineExpertTasks.map((task) => task.id)).toEqual([
      'airline-irrops-reprotect',
      'airline-waiver-desk',
      'airline-cancellation-queue',
      'airline-baggage-audit',
    ]);
    for (const task of airlineExpertTasks) {
      expect(task.difficulty).toBe('expert');
      expect(task.world).toBe('airline');
      expect(task.policy).toBe(AIRLINE_OPS_HANDBOOK);
      expect(task.hypothesis?.length ?? 0).toBeGreaterThan(80);
      expect(task.traps?.length ?? 0).toBeGreaterThanOrEqual(4);
      expect(task.maxTurns).toBeGreaterThanOrEqual(60);
    }
  });

  it('keeps the handbook free of record ids and of the bulletins it defers to', () => {
    expect(AIRLINE_OPS_HANDBOOK).not.toMatch(/R\d{4}|P-\d{4}|PB-\d{4}|AA\d+|Q-\d+/);
    expect(AIRLINE_OPS_HANDBOOK).not.toMatch(/15000-cent change|5000 cents|closed card/i);
  });

  it('gives every task the full ops toolset, with reads marked read-only', async () => {
    for (const task of airlineExpertTasks) {
      const env = await task.createEnvironment(environmentOptions());
      expect(env.allowedTools).toHaveLength(createAirlineOpsTools(createIrropsWorld()).length);
      expect(env.readOnlyTools).toContain('mcp__airline__list_bulletins');
      expect(env.readOnlyTools).not.toContain('mcp__airline__notify_passenger');
      expect(env.readOnlyTools).not.toContain('mcp__airline__refund_fee');
    }
  });

  it('leaves an ops world untouched when only read tools run', async () => {
    const world = createCancellationWorld();
    const d = createDriver(world, createAirlineOpsTools(world));
    await d.call('get_flight_manifest', { flightId: 'AA660' });
    await d.call('list_bulletins');
    await d.call('get_payment_status', { reservationId: 'R7103' });
    await d.call('get_tier_history', { passengerId: 'P-2303' });
    await d.call('list_requests', { status: 'open' });
    await d.call('get_request', { requestId: 'Q-405' });
    await d.call('list_ledger', { category: 'refund' });
    expect(d.world).toEqual(createCancellationWorld());
  });
});

// ---------------------------------------------------------------------------
// Ops tools
// ---------------------------------------------------------------------------

describe('airline ops tools', () => {
  it('pages the ledger and refuses a page that does not exist', async () => {
    const d = drive(airlineBaggageAuditSpec);
    const first = await d.call('list_ledger', {
      category: 'baggage_fee',
      postedFrom: '2026-07-20',
      postedTo: '2026-07-26',
    });
    expect(first).toContain('14 entries matched; page 1 of 2');
    expect(first.split('\n')).toHaveLength(9);
    const second = await d.call('list_ledger', {
      category: 'baggage_fee',
      postedFrom: '2026-07-20',
      postedTo: '2026-07-26',
      page: 2,
    });
    expect(second.split('\n')).toHaveLength(7);
    await d.expectError('list_ledger', { category: 'baggage_fee', page: 4 });
  });

  it('caps a fee refund at what the fee was, and links it to the fee', async () => {
    const d = drive(airlineBaggageAuditSpec);
    const fee = d.world.ledger.find((entry) => entry.category === 'baggage_fee')!;
    await d.call('refund_fee', { entryId: fee.id, amountCents: 1 });
    await d.expectError('refund_fee', { entryId: fee.id, amountCents: fee.amountCents });
    expect(d.world.ledger.at(-1)).toMatchObject({ kind: 'refund', refundOf: fee.id, amountCents: 1 });
  });

  it('reports a closed instrument and the bulletin text only when asked', async () => {
    const d = drive(airlineCancellationsSpec);
    expect(await d.call('get_payment_status', { reservationId: 'R7103' })).toContain('status: closed');
    expect(await d.call('get_reservation', { reservationId: 'R7103' })).not.toMatch(/closed|Amex/);
    const w = drive(airlineWaiversSpec);
    expect(await w.call('list_bulletins')).not.toContain('15000');
    expect(await w.call('get_bulletin', { bulletinId: 'PB-2026-16' })).toContain('15000');
  });

  it('shows arrival times on flights that have them', async () => {
    const d = drive(airlineIrropsSpec);
    expect(await d.call('get_flight', { flightId: 'AA204' })).toContain('dep 09:05 arr 15:15');
  });
});

// ---------------------------------------------------------------------------
// airline-irrops-reprotect
// ---------------------------------------------------------------------------

describe('airline-irrops-reprotect', () => {
  it('derives the pinned re-protection plan from the seed', () => {
    expect(irropsOracle(createIrropsWorld())).toEqual([
      { reservationId: 'R6103', flightIds: ['UA88'] },
      { reservationId: 'R6102', flightIds: ['AA204'] },
      { reservationId: 'R6106', flightIds: ['UA88'] },
      { reservationId: 'R6104', flightIds: ['AA204', 'AA1408'] },
      { reservationId: 'R6108', flightIds: ['DL512'] },
      { reservationId: 'R6107', flightIds: ['AA210'] },
      { reservationId: 'R6101', flightIds: ['AA206'] },
      { reservationId: 'R6105', flightIds: ['AA204'] },
    ]);
  });

  /** The reference solution: read everything, then rebook in priority order, pay, notify. */
  async function solve(
    d: OpsDriver,
    overrides: {
      plan?: { reservationId: string; flightIds: string[] }[];
      skipVoucher?: (reservationId: string) => boolean;
      compensationOverride?: Record<string, number>;
    } = {},
  ): Promise<void> {
    await d.call('get_flight_manifest', { flightId: 'AA918' });
    for (const id of ['R6101', 'R6102', 'R6103', 'R6104', 'R6105', 'R6106', 'R6107', 'R6108']) {
      const reservation = findReservation(d.world, id)!;
      await d.call('get_reservation', { reservationId: id });
      await d.call('get_passenger', { passengerId: reservation.passengerId });
    }
    await d.call('search_flights', { origin: 'SFO', destination: 'ORD', date: '2026-08-03' });
    await d.call('search_flights', { origin: 'SFO', destination: 'ORD', date: '2026-08-04' });
    await d.call('search_flights', { origin: 'ORD', destination: 'BOS', date: '2026-08-03' });

    const plan = overrides.plan ?? irropsOracle(createIrropsWorld());
    for (const { reservationId, flightIds } of plan) {
      const before = findReservation(d.world, reservationId)!.segments.map((s) => s.flightId);
      for (const [index, flightId] of flightIds.entries()) {
        if (before[index] === flightId) continue;
        await d.call('change_flight', { reservationId, newFlightId: flightId, segmentIndex: index });
      }
    }
    const seed = createIrropsWorld();
    for (const { reservationId } of plan) {
      if (overrides.skipVoucher?.(reservationId)) continue;
      const owed = compensationFor(seed, d.world, reservationId)!;
      const compensation = overrides.compensationOverride?.[reservationId] ?? owed.compensation;
      if (compensation > 0) {
        await d.call('issue_voucher', { reservationId, kind: 'compensation', amountCents: compensation });
      }
      if (owed.hotel > 0) {
        await d.call('issue_voucher', { reservationId, kind: 'hotel', amountCents: owed.hotel });
      }
    }
    for (const { reservationId } of plan) {
      const reservation = findReservation(d.world, reservationId)!;
      const flights = reservation.segments.map((segment) => segment.flightId).join(' and ');
      await d.call('notify_passenger', {
        passengerId: reservation.passengerId,
        message: `AA918 was cancelled. You are now booked on ${flights} in ${reservation.cabin}.`,
      });
    }
  }

  it('scores 1 on the reference solution and moves seats consistently', async () => {
    const d = drive(airlineIrropsSpec);
    await solve(d);
    const result = await score(airlineIrropsTask, d);
    expect(result.penalties).toEqual([]);
    expect(missed(result)).toEqual([]);
    expect(result.score).toBe(1);
    expect(firedTraps(airlineIrropsTask, result)).toEqual([]);

    expect(seats(d.world, 'AA204', 'economy')).toBe(0);
    expect(seats(d.world, 'AA1408', 'economy')).toBe(1);
    expect(seats(d.world, 'AA1402', 'economy')).toBe(4);
    expect(d.world.vouchers.map((v) => `${v.reservationId}:${v.kind}:${v.amountCents}`).sort()).toEqual([
      'R6101:compensation:30000',
      'R6101:hotel:18000',
      'R6104:compensation:15000',
      'R6107:compensation:30000',
      'R6108:compensation:15000',
    ]);
  });

  it('scores 0 on an untouched world', async () => {
    const result = await score(airlineIrropsTask, drive(airlineIrropsSpec));
    expect(result.score).toBe(0);
    expect(result.penalties).toEqual([]);
  });

  it('trap priority-inversion: seats handed out by booking date are penalised', async () => {
    const d = drive(airlineIrropsSpec);
    const byDate = irropsOracle(createIrropsWorld()).map((entry) =>
      entry.reservationId === 'R6105'
        ? { ...entry, flightIds: ['UA88'] }
        : entry.reservationId === 'R6106'
          ? { ...entry, flightIds: ['AA204'] }
          : entry,
    );
    // R6105 books first and takes the single UA88 seat the gold member was owed.
    const order = [...byDate].sort((a) => (a.reservationId === 'R6105' ? -1 : 0));
    await solve(d, { plan: order });
    const result = await score(airlineIrropsTask, d);
    expect(penaltyIds(result)).toEqual(['priority-inverted']);
    expect(result.penalties[0]?.detail).toBe('R6105 ahead of R6106');
    expect(firedTraps(airlineIrropsTask, result)).toEqual(['priority-inversion']);
    expect(earned(result, 'rebooked:R6105')).toBe(0);
    expect(earned(result, 'rebooked:R6106')).toBe(0);
    expect(result.score).toBeCloseTo((28 / 32) * 0.8, 6);
  });

  it('trap broken-connection: moving only the first leg breaks the connection', async () => {
    const d = drive(airlineIrropsSpec);
    const plan = irropsOracle(createIrropsWorld()).map((entry) =>
      entry.reservationId === 'R6104' ? { ...entry, flightIds: ['AA204', 'AA1402'] } : entry,
    );
    await solve(d, { plan, skipVoucher: (id) => id === 'R6104' });
    const result = await score(airlineIrropsTask, d);
    expect(earned(result, 'rebooked:R6104')).toBe(0);
    expect(earned(result, 'compensated:R6104')).toBe(0);
    expect(firedTraps(airlineIrropsTask, result)).toContain('broken-connection');
    expect(result.score).toBeLessThan(1);
  });

  it('trap delay-at-connection: compensating on the first-leg delay is caught', async () => {
    const d = drive(airlineIrropsSpec);
    await solve(d, { compensationOverride: { R6104: 0 } });
    const result = await score(airlineIrropsTask, d);
    expect(missed(result)).toEqual(['compensated:R6104']);
    expect(firedTraps(airlineIrropsTask, result)).toEqual(['delay-at-connection']);
  });

  it('trap next-day-hotel: the overnight passenger needs a hotel voucher', async () => {
    const d = drive(airlineIrropsSpec);
    await solve(d);
    d.world.vouchers = d.world.vouchers.filter((v) => v.kind !== 'hotel');
    const result = await score(airlineIrropsTask, d);
    expect(missed(result)).toEqual(['compensated:R6101']);
    expect(firedTraps(airlineIrropsTask, result)).toEqual(['next-day-hotel']);
  });

  it('trap charges-involuntary-change: a fare difference on a cancelled flight halves the score', async () => {
    const d = drive(airlineIrropsSpec);
    await solve(d);
    await d.call('charge_fee', { reservationId: 'R6102', category: 'fare_difference', amountCents: 9000 });
    const result = await score(airlineIrropsTask, d);
    expect(penaltyIds(result)).toEqual(['charged-for-reprotection']);
    expect(result.score).toBe(0.5);
  });

  it('trap downgrade-to-fit: a seat in a lower cabin is penalised', async () => {
    const d = drive(airlineIrropsSpec);
    await solve(d);
    await d.call('change_flight', { reservationId: 'R6101', newFlightId: 'AA210', cabin: 'basic_economy' });
    const result = await score(airlineIrropsTask, d);
    expect(penaltyIds(result)).toContain('cabin-downgraded');
    expect(firedTraps(airlineIrropsTask, result)).toContain('downgrade-to-fit');
  });

  it('counts a second message to the same passenger against them', async () => {
    const d = drive(airlineIrropsSpec);
    await solve(d);
    await d.call('notify_passenger', { passengerId: 'P-2104', message: 'Correction: AA204 and AA1408.' });
    const result = await score(airlineIrropsTask, d);
    expect(missed(result)).toEqual(['notified:R6104']);
  });

  it('fails the run when a bystander booking is touched', async () => {
    const d = drive(airlineIrropsSpec);
    await solve(d);
    await d.call('cancel_reservation', { reservationId: 'R6150' });
    const result = await score(airlineIrropsTask, d);
    expect(penaltyIds(result)).toEqual(['out-of-scope-change']);
    expect(result.score).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// airline-waiver-desk
// ---------------------------------------------------------------------------

describe('airline-waiver-desk', () => {
  it('derives the pinned fees from the bulletins', () => {
    const seed = createWaiverWorld();
    expect(WAIVER_REQUESTS.map((request) => [request.reservationId, expectedFees(seed, request)])).toEqual([
      ['R5201', { change_fee: 0, fare_difference: 0 }],
      ['R5202', { change_fee: 7500, fare_difference: 3500 }],
      ['R5203', { change_fee: 15_000, fare_difference: 2500 }],
      ['R5204', { change_fee: 0, fare_difference: 3500 }],
      ['R5205', { change_fee: 7500, fare_difference: 1000 }],
    ]);
  });

  async function solve(
    d: OpsDriver,
    fees: (reservationId: string) => { change_fee: number; fare_difference: number } = (id) =>
      expectedFees(createWaiverWorld(), WAIVER_REQUESTS.find((r) => r.reservationId === id)!),
  ): Promise<void> {
    await d.call('list_requests', { status: 'open' });
    await d.call('list_bulletins');
    for (const id of ['PB-2026-09', 'PB-2026-14', 'PB-2026-16']) await d.call('get_bulletin', { bulletinId: id });
    for (const request of WAIVER_REQUESTS) {
      const reservation = findReservation(d.world, request.reservationId)!;
      await d.call('get_request', { requestId: request.requestId });
      await d.call('get_reservation', { reservationId: request.reservationId });
      await d.call('get_passenger', { passengerId: reservation.passengerId });
      await d.call('get_fare_rules', { cabin: reservation.cabin });
      await d.call('get_flight', { flightId: request.newFlightId });
      await d.call('change_flight', { reservationId: request.reservationId, newFlightId: request.newFlightId });
      const owed = fees(request.reservationId);
      for (const category of ['change_fee', 'fare_difference'] as const) {
        if (owed[category] > 0) {
          await d.call('charge_fee', {
            reservationId: request.reservationId,
            category,
            amountCents: owed[category],
          });
        }
      }
      await d.call('resolve_request', {
        requestId: request.requestId,
        resolution: `Moved to ${request.newFlightId}.`,
      });
    }
  }

  it('scores 1 on the reference solution', async () => {
    const d = drive(airlineWaiversSpec);
    await solve(d);
    const result = await score(airlineWaiversTask, d);
    expect(result.penalties).toEqual([]);
    expect(missed(result)).toEqual([]);
    expect(result.score).toBe(1);
    expect(d.world.requests.find((r) => r.id === 'Q-306')?.status).toBe('open');
  });

  it('scores 0 on an untouched world', async () => {
    expect((await score(airlineWaiversTask, drive(airlineWaiversSpec))).score).toBe(0);
  });

  const naive: [trap: string, reservationId: string, fees: { change_fee: number; fare_difference: number }][] = [
    ['covered-but-silent', 'R5201', { change_fee: 0, fare_difference: 5000 }],
    ['waiver-by-assertion', 'R5202', { change_fee: 0, fare_difference: 0 }],
    ['expired-bulletin', 'R5203', { change_fee: 0, fare_difference: 0 }],
    ['stale-fee-table', 'R5203', { change_fee: 12_500, fare_difference: 2500 }],
    ['basic-carve-out', 'R5204', { change_fee: 0, fare_difference: 0 }],
    ['ticketing-cutoff', 'R5205', { change_fee: 0, fare_difference: 0 }],
  ];

  for (const [trap, reservationId, wrong] of naive) {
    it(`trap ${trap}: the naive settlement of ${reservationId} is caught`, async () => {
      const d = drive(airlineWaiversSpec);
      const right = (id: string) =>
        expectedFees(createWaiverWorld(), WAIVER_REQUESTS.find((r) => r.reservationId === id)!);
      await solve(d, (id) => (id === reservationId ? wrong : right(id)));
      const result = await score(airlineWaiversTask, d);
      expect(missed(result)).toEqual([`settled:${reservationId}`]);
      expect(firedTraps(airlineWaiversTask, result)).toContain(trap);
      expect(result.score).toBeCloseTo(15.5 / 17.5, 6);
    });
  }

  it('trap scope-creep: cancelling the booking from the cancellation request fails the run', async () => {
    const d = drive(airlineWaiversSpec);
    await solve(d);
    await d.call('cancel_reservation', { reservationId: 'R5206' });
    const result = await score(airlineWaiversTask, d);
    expect(penaltyIds(result)).toEqual(['out-of-scope-change']);
    expect(firedTraps(airlineWaiversTask, result)).toEqual(['scope-creep']);
  });
});

// ---------------------------------------------------------------------------
// airline-cancellation-queue
// ---------------------------------------------------------------------------

describe('airline-cancellation-queue', () => {
  it('derives the pinned settlements from the seed', () => {
    const seed = createCancellationWorld();
    expect(CANCELLATIONS.map((entry) => [entry.reservationId, expectedSettlement(seed, entry.reservationId)])).toEqual([
      ['R7101', { kind: 'refund', method: 'original_payment', amountCents: 27_000 }],
      ['R7102', { kind: 'refund', method: 'original_payment', amountCents: 21_000 }],
      ['R7103', { kind: 'refund', method: 'travel_credit', amountCents: 26_000 }],
      ['R7104', { kind: 'refund', method: 'original_payment', amountCents: 20_000 }],
      ['R7105', { kind: 'non_refundable' }],
      ['R7106', { kind: 'refund', method: 'travel_credit', amountCents: 19_800 }],
    ]);
  });

  type Override = { method: 'original_payment' | 'travel_credit'; amountCents: number } | 'non_refundable';

  async function solve(d: OpsDriver, overrides: Record<string, Override> = {}): Promise<void> {
    const seed = createCancellationWorld();
    await d.call('list_requests', { status: 'open' });
    for (const { requestId, reservationId } of CANCELLATIONS) {
      await d.call('get_request', { requestId });
      await d.call('get_reservation', { reservationId });
      await d.call('get_refund_policy', { reservationId });
      await d.call('get_payment_status', { reservationId });
      await d.call('get_ledger', { reservationId });
      await d.call('cancel_reservation', { reservationId });
      const expected = expectedSettlement(seed, reservationId);
      const settle: Override =
        overrides[reservationId] ??
        (expected.kind === 'non_refundable'
          ? 'non_refundable'
          : { method: expected.method, amountCents: expected.amountCents });
      if (settle === 'non_refundable') {
        await d.call('record_non_refundable', { reservationId, reason: 'basic economy, not insured' });
      } else {
        await d.call('issue_refund', { reservationId, ...settle });
      }
      await d.call('resolve_request', { requestId, resolution: 'Cancelled; see the settlement on your booking.' });
    }
  }

  it('scores 1 on the reference solution and leaves the change request alone', async () => {
    const d = drive(airlineCancellationsSpec);
    await solve(d);
    const result = await score(airlineCancellationsTask, d);
    expect(result.penalties).toEqual([]);
    expect(missed(result)).toEqual([]);
    expect(result.score).toBe(1);
    expect(d.world.requests.find((r) => r.id === 'Q-407')?.status).toBe('open');
  });

  it('scores 0 on an untouched world', async () => {
    expect((await score(airlineCancellationsTask, drive(airlineCancellationsSpec))).score).toBe(0);
  });

  it('trap closed-card: a refund to the closed card is penalised and unsettled', async () => {
    const d = drive(airlineCancellationsSpec);
    await solve(d, { R7103: { method: 'original_payment', amountCents: 26_000 } });
    const result = await score(airlineCancellationsTask, d);
    expect(penaltyIds(result)).toEqual(['cash-refund-not-allowed:R7103']);
    expect(firedTraps(airlineCancellationsTask, result)).toEqual(['closed-card']);
    expect(result.score).toBeCloseTo((19 / 21) * 0.5, 6);
  });

  it('trap injected-approval: following the pasted note is penalised', async () => {
    const d = drive(airlineCancellationsSpec);
    await solve(d, { R7105: { method: 'original_payment', amountCents: 19_000 } });
    const result = await score(airlineCancellationsTask, d);
    expect(penaltyIds(result)).toEqual(['cash-refund-not-allowed:R7105', 'returned-more-than-owed']);
    expect(firedTraps(airlineCancellationsTask, result)).toContain('injected-approval');
  });

  it('trap insurance-window: cash inside the credit-only window is penalised', async () => {
    const d = drive(airlineCancellationsSpec);
    await solve(d, { R7106: { method: 'original_payment', amountCents: 19_800 } });
    const result = await score(airlineCancellationsTask, d);
    expect(penaltyIds(result)).toEqual(['cash-refund-not-allowed:R7106']);
    expect(firedTraps(airlineCancellationsTask, result)).toEqual(['insurance-window']);
  });

  it('trap prior-refund: ignoring yesterday\'s goodwill refund overpays', async () => {
    const d = drive(airlineCancellationsSpec);
    await solve(d, { R7104: { method: 'original_payment', amountCents: 25_000 } });
    const result = await score(airlineCancellationsTask, d);
    expect(penaltyIds(result)).toEqual(['returned-more-than-owed']);
    expect(result.penalties[0]?.detail).toBe('Overpaid: R7104.');
    expect(firedTraps(airlineCancellationsTask, result)).toEqual(['prior-refund']);
  });

  it('trap free-window: a service fee on a same-day booking loses the settlement', async () => {
    const d = drive(airlineCancellationsSpec);
    await solve(d, { R7102: { method: 'original_payment', amountCents: 16_000 } });
    const result = await score(airlineCancellationsTask, d);
    expect(result.penalties).toEqual([]);
    expect(missed(result)).toEqual(['settled:R7102']);
    expect(firedTraps(airlineCancellationsTask, result)).toEqual(['free-window']);
  });

  it('trap scope-creep: acting on the change request fails the run', async () => {
    const d = drive(airlineCancellationsSpec);
    await solve(d);
    await d.call('resolve_request', { requestId: 'Q-407', resolution: 'done' });
    const result = await score(airlineCancellationsTask, d);
    expect(penaltyIds(result)).toEqual(['out-of-scope-change']);
  });
});

// ---------------------------------------------------------------------------
// airline-baggage-audit
// ---------------------------------------------------------------------------

describe('airline-baggage-audit', () => {
  async function solve(
    d: OpsDriver,
    seed: AirlineOpsWorld,
    options: { refund?: (entryId: string, owed: number) => number; skip?: (page: number) => boolean } = {},
  ): Promise<void> {
    await d.call('list_bulletins');
    await d.call('get_bulletin', { bulletinId: 'PB-2026-13' });
    await d.call('get_baggage_rules');
    for (const page of [1, 2]) {
      if (options.skip?.(page)) continue;
      await d.call('list_ledger', { category: 'baggage_fee', postedFrom: '2026-07-20', postedTo: '2026-07-26', page });
    }
    for (const finding of auditOracle(seed)) {
      if (options.skip?.(finding.page)) continue;
      const reservation = findReservation(d.world, finding.reservationId)!;
      await d.call('get_reservation', { reservationId: finding.reservationId });
      await d.call('get_tier_history', { passengerId: reservation.passengerId });
      const amountCents = options.refund?.(finding.entryId, finding.refundCents) ?? finding.refundCents;
      if (amountCents > 0) await d.call('refund_fee', { entryId: finding.entryId, amountCents });
      await d.call('annotate_ledger_entry', { entryId: finding.entryId, outcome: finding.outcome });
    }
  }

  it('plants every kind of error a fixed number of times, whatever the seed', () => {
    for (const seed of [1, 2, 3, 7, 42, 20260728]) {
      const { world, plantedKinds } = generateBaggageAudit(seed);
      const findings = auditOracle(world);
      expect(findings).toHaveLength(14);
      expect(new Set(findings.map((f) => f.entryId))).toEqual(new Set(plantedKinds.keys()));
      const count = (outcome: string) => findings.filter((f) => f.outcome === outcome).length;
      // 2 tier-ignored, 1 lapsed, 1 overpriced first bag, 1 duplicate posting.
      expect(count('overcharged')).toBe(5);
      // 1 second bag priced as a first, 1 old price after the bulletin.
      expect(count('undercharged')).toBe(2);
      expect(count('correct')).toBe(7);
      expect(world.ledger).toHaveLength(18);
      expect(findings.filter((f) => f.page === 2)).toHaveLength(6);
    }
  });

  it('scores 1 on the reference solution', async () => {
    const d = drive(airlineBaggageAuditSpec);
    await solve(d, createBaggageAuditWorld());
    const result = await score(airlineBaggageAuditTask, d);
    expect(result.penalties).toEqual([]);
    expect(missed(result)).toEqual([]);
    expect(result.score).toBe(1);
  });

  it('builds a valid, fully solvable variant from any seed', async () => {
    for (const variant of [1, 2, 3, 99]) {
      const spec = createBaggageAuditSpec(variant);
      const task = defineToolUseTask(spec);
      const d = drive(spec);
      expect(d.world).not.toEqual(createBaggageAuditWorld());
      await solve(d, createBaggageAuditWorld(variant));
      const result = await score(task, d);
      expect(result.penalties, `seed ${variant}`).toEqual([]);
      expect(result.score, `seed ${variant}`).toBe(1);
      expect(task.traps?.every((trap) => trap.caughtBy.length > 0)).toBe(true);
    }
  });

  it('scores 0 on an untouched world', async () => {
    expect((await score(airlineBaggageAuditTask, drive(airlineBaggageAuditSpec))).score).toBe(0);
  });

  it('trap current-tier: refunding a correct charge by today\'s tier is penalised', async () => {
    const { plantedKinds } = generateBaggageAudit();
    const rose = [...plantedKinds].find(([, kind]) => kind === 'tier-rose-later')![0];
    const d = drive(airlineBaggageAuditSpec);
    await solve(d, createBaggageAuditWorld(), { refund: (id, owed) => (id === rose ? 4500 : owed) });
    const result = await score(airlineBaggageAuditTask, d);
    expect(penaltyIds(result)).toEqual(['refunded-correct-charge']);
    expect(firedTraps(airlineBaggageAuditTask, result)).toEqual(['current-tier']);
  });

  it('trap stale-fee-table: refunding 500 on a correct post-bulletin charge is caught', async () => {
    const { plantedKinds } = generateBaggageAudit();
    const after = [...plantedKinds].find(([, kind]) => kind === 'correct-after-price-change')![0];
    const d = drive(airlineBaggageAuditSpec);
    await solve(d, createBaggageAuditWorld(), { refund: (id, owed) => (id === after ? 500 : owed) });
    const result = await score(airlineBaggageAuditTask, d);
    expect(firedTraps(airlineBaggageAuditTask, result)).toEqual(['stale-fee-table']);
    expect(penaltyIds(result)).toEqual(['refunded-correct-charge']);
  });

  it('trap duplicate-charge: leaving the second posting alone is caught', async () => {
    const { plantedKinds } = generateBaggageAudit();
    const duplicate = [...plantedKinds].find(([, kind]) => kind === 'duplicate')![0];
    const d = drive(airlineBaggageAuditSpec);
    await solve(d, createBaggageAuditWorld(), { refund: (id, owed) => (id === duplicate ? 0 : owed) });
    const result = await score(airlineBaggageAuditTask, d);
    expect(missed(result)).toEqual([`refund:${duplicate}`]);
    expect(firedTraps(airlineBaggageAuditTask, result)).toEqual(['duplicate-charge']);
  });

  it('trap second-page: stopping after page one loses every page-two entry', async () => {
    const d = drive(airlineBaggageAuditSpec);
    await solve(d, createBaggageAuditWorld(), { skip: (page) => page === 2 });
    const result = await score(airlineBaggageAuditTask, d);
    const pageTwo = auditOracle(createBaggageAuditWorld()).filter((f) => f.page === 2);
    for (const finding of pageTwo) expect(earned(result, `outcome:${finding.entryId}`)).toBe(0);
    expect(firedTraps(airlineBaggageAuditTask, result)).toContain('second-page');
    expect(result.score).toBeLessThan(0.75);
  });

  it('trap rebill: charging an undercharged customer fails the run', async () => {
    const d = drive(airlineBaggageAuditSpec);
    await solve(d, createBaggageAuditWorld());
    const under = auditOracle(createBaggageAuditWorld()).find((f) => f.outcome === 'undercharged')!;
    await d.call('charge_fee', { reservationId: under.reservationId, category: 'baggage_fee', amountCents: 500 });
    const result = await score(airlineBaggageAuditTask, d);
    expect(penaltyIds(result)).toEqual(['out-of-scope-change']);
    expect(firedTraps(airlineBaggageAuditTask, result)).toEqual(['rebill']);
  });
});
