import type { Task } from '@arena/core';
import {
  defineToolUseTask,
  type AssertionSpec,
  type ToolUseTaskSpec,
} from '../../../defineToolUseTask';
import { createRng, type Rng } from '../../../rng';
import { addedTo, anyOf, blastRadiusRule, type ChangeFilter } from '../../../worldDiff';
import { emptyOps, feeRefundedCents, tierOn, type AirlineOpsWorld, type TierChange } from '../ops';
import {
  ADDITIONAL_CHARGEABLE_BAG_CENTS,
  FIRST_CHARGEABLE_BAG_CENTS,
  freeCheckedBags,
  type AuditOutcome,
  type CabinClass,
  type Flight,
  type LedgerEntry,
  type Passenger,
  type Reservation,
  type Tier,
} from '../world';
import { AIRLINE_EXPERT_BASE, OPS_DIFF, flight, passenger, reservation } from './common';

/**
 * airline-baggage-audit: audit a week of baggage fees, generated from a seed.
 *
 * Fourteen charges over two pages of ledger, each an independent check:
 * re-derive the allowance from the cabin and the tier the passenger held on
 * the day of the charge (not today's tier), price the chargeable bags at the
 * fees in force that day (a bulletin raised the first-bag price mid-week),
 * then refund exactly the overcharge, or nothing, and record the outcome.
 *
 * The world is generated from a seed so the same audit can be re-instantiated
 * with different passengers, dates and amounts while every expectation is
 * still computed from the world. Each kind of error is planted a fixed number
 * of times whatever the seed, so a variant is never easier than the original.
 */

export const AUDIT_FROM = '2026-07-20';
export const AUDIT_TO = '2026-07-26';
const TODAY = '2026-07-28';
/** Bulletin PB-2026-13: from this date the first chargeable bag costs more. */
const PRICE_CHANGE_ON = '2026-07-23';
const NEW_FIRST_BAG_CENTS = 5000;
export const DEFAULT_AUDIT_SEED = 20260728;

/** First-bag price on a date, per the base fee table and bulletin PB-2026-13. */
export function firstBagCentsOn(date: string): number {
  return date >= PRICE_CHANGE_ON ? NEW_FIRST_BAG_CENTS : FIRST_CHARGEABLE_BAG_CENTS;
}

/** The correct fee for `bags` on a reservation, under the rules in force on `date`. */
export function baggageFeeOn(date: string, cabin: CabinClass, tier: Tier, bags: number): number {
  const chargeable = Math.max(0, bags - freeCheckedBags(cabin, tier));
  if (chargeable === 0) return 0;
  return firstBagCentsOn(date) + (chargeable - 1) * ADDITIONAL_CHARGEABLE_BAG_CENTS;
}

/**
 * The ways a charge in this ledger can be wrong (or tempting to "fix"). Each
 * appears a fixed number of times; the seed only decides who, when and how much.
 */
type CaseKind =
  | 'correct'
  | 'correct-after-price-change'
  | 'tier-rose-later'
  | 'tier-ignored'
  | 'tier-lapsed-later'
  | 'first-bag-overpriced'
  | 'duplicate'
  | 'second-bag-underpriced'
  | 'old-price-after-change';

const CASE_MIX: CaseKind[] = [
  'correct',
  'correct',
  'correct-after-price-change',
  'correct-after-price-change',
  'tier-rose-later',
  'tier-rose-later',
  'tier-ignored',
  'tier-ignored',
  'tier-lapsed-later',
  'first-bag-overpriced',
  'duplicate',
  'second-bag-underpriced',
  'old-price-after-change',
];

const NAMES = [
  'Aaron Blake', 'Bianca Rossi', 'Carlos Mendes', 'Dana Kowal', 'Elif Aydin', 'Femi Adebayo',
  'Greta Lind', 'Hiro Tanaka', 'Isla Murray', 'Jakob Weiss', 'Kavya Rao', 'Liam Doyle',
  'Mona Haddad', 'Nils Berg', 'Olga Petrov', 'Pedro Alves', 'Quinn Harper', 'Rosa Vidal',
];

const DAYS_BEFORE = ['2026-07-20', '2026-07-21', '2026-07-22'];
const DAYS_AFTER = ['2026-07-23', '2026-07-24', '2026-07-25', '2026-07-26'];

/** A cabin, a tier and a bag count; the generator draws one per case. */
interface Profile {
  cabin: CabinClass;
  tier: Tier;
  bags: number;
}

/** Profiles where at least one bag is chargeable, bags never above the three allowed. */
const CHARGEABLE: Profile[] = [
  { cabin: 'basic_economy', tier: 'none', bags: 1 },
  { cabin: 'basic_economy', tier: 'none', bags: 2 },
  { cabin: 'basic_economy', tier: 'silver', bags: 2 },
  { cabin: 'basic_economy', tier: 'silver', bags: 3 },
  { cabin: 'basic_economy', tier: 'gold', bags: 3 },
  { cabin: 'economy', tier: 'none', bags: 2 },
  { cabin: 'economy', tier: 'none', bags: 3 },
  { cabin: 'economy', tier: 'silver', bags: 3 },
  { cabin: 'premium_economy', tier: 'none', bags: 3 },
];

interface PlannedCharge {
  kind: CaseKind;
  passenger: Passenger;
  tierHistory: TierChange[];
  booking: Reservation;
  postedOn: string;
  /** One amount per ledger entry; two for a duplicate. */
  charged: number[];
}

function chargeableBags(profile: Profile): number {
  return Math.max(0, profile.bags - freeCheckedBags(profile.cabin, profile.tier));
}

/** Plant one case. Every branch is constructed so the planted error really is one. */
function plan(
  kind: CaseKind,
  rng: Rng,
  pax: Passenger,
  reservationId: string,
  flights: Flight[],
  forcedDate?: string,
): PlannedCharge {
  const pickDay = (days: string[]) => forcedDate ?? rng.pick(days);
  const dayAfter = (date: string) =>
    new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  const history = (tier: Tier, from = '2025-11-01'): TierChange[] => [
    { passengerId: pax.id, tier, effectiveFrom: from },
  ];

  let profile: Profile;
  let postedOn: string;
  let tierHistory: TierChange[];
  let currentTier: Tier;
  let charged: number[];

  switch (kind) {
    case 'correct':
    case 'correct-after-price-change':
    case 'duplicate':
    case 'first-bag-overpriced': {
      profile = rng.pick(CHARGEABLE);
      postedOn = pickDay(
        kind === 'correct'
          ? DAYS_BEFORE
          : kind === 'correct-after-price-change'
            ? DAYS_AFTER
            : [...DAYS_BEFORE, ...DAYS_AFTER],
      );
      tierHistory = history(profile.tier);
      currentTier = profile.tier;
      const fee = baggageFeeOn(postedOn, profile.cabin, profile.tier, profile.bags);
      charged =
        kind === 'duplicate'
          ? [fee, fee]
          : kind === 'first-bag-overpriced'
            ? [fee - firstBagCentsOn(postedOn) + ADDITIONAL_CHARGEABLE_BAG_CENTS]
            : [fee];
      break;
    }
    case 'tier-rose-later': {
      // Charged correctly at the lower tier; today's higher tier would make it look high.
      profile = rng.pick<Profile>([
        { cabin: 'economy', tier: 'none', bags: 2 },
        { cabin: 'basic_economy', tier: 'silver', bags: 3 },
        { cabin: 'economy', tier: 'none', bags: 3 },
      ]);
      postedOn = pickDay(['2026-07-20', '2026-07-21', '2026-07-22', '2026-07-24']);
      currentTier = profile.tier === 'none' ? 'silver' : 'gold';
      tierHistory = [
        ...history(profile.tier),
        { passengerId: pax.id, tier: currentTier, effectiveFrom: dayAfter(postedOn) },
      ];
      charged = [baggageFeeOn(postedOn, profile.cabin, profile.tier, profile.bags)];
      break;
    }
    case 'tier-ignored': {
      // The billing run used the cabin allowance alone.
      profile = rng.pick<Profile>([
        { cabin: 'economy', tier: 'silver', bags: 2 },
        { cabin: 'economy', tier: 'silver', bags: 3 },
        { cabin: 'basic_economy', tier: 'gold', bags: 3 },
        { cabin: 'basic_economy', tier: 'silver', bags: 2 },
        { cabin: 'economy', tier: 'gold', bags: 3 },
      ]);
      postedOn = pickDay([...DAYS_BEFORE, ...DAYS_AFTER]);
      tierHistory = history(profile.tier);
      currentTier = profile.tier;
      charged = [baggageFeeOn(postedOn, profile.cabin, 'none', profile.bags)];
      break;
    }
    case 'tier-lapsed-later': {
      // Gold on the day, lapsed since; billing priced it as if already lapsed.
      profile = rng.pick<Profile>([
        { cabin: 'economy', tier: 'gold', bags: 3 },
        { cabin: 'basic_economy', tier: 'gold', bags: 2 },
      ]);
      postedOn = pickDay(['2026-07-20', '2026-07-21', '2026-07-22', '2026-07-24']);
      currentTier = 'none';
      tierHistory = [
        ...history('gold'),
        { passengerId: pax.id, tier: 'none', effectiveFrom: dayAfter(postedOn) },
      ];
      charged = [baggageFeeOn(postedOn, profile.cabin, 'none', profile.bags)];
      break;
    }
    case 'second-bag-underpriced': {
      // Two or more chargeable bags, every one priced as a first bag.
      profile = rng.pick<Profile>([
        { cabin: 'basic_economy', tier: 'none', bags: 2 },
        { cabin: 'basic_economy', tier: 'none', bags: 3 },
        { cabin: 'economy', tier: 'none', bags: 3 },
      ]);
      postedOn = pickDay([...DAYS_BEFORE, ...DAYS_AFTER]);
      tierHistory = history(profile.tier);
      currentTier = profile.tier;
      charged = [chargeableBags(profile) * firstBagCentsOn(postedOn)];
      break;
    }
    case 'old-price-after-change': {
      // Posted after the bulletin but priced from the old table.
      profile = rng.pick(CHARGEABLE);
      postedOn = pickDay(DAYS_AFTER);
      tierHistory = history(profile.tier);
      currentTier = profile.tier;
      const fee = baggageFeeOn(postedOn, profile.cabin, profile.tier, profile.bags);
      charged = [fee - NEW_FIRST_BAG_CENTS + FIRST_CHARGEABLE_BAG_CENTS];
      break;
    }
  }

  const route = rng.pick(flights);
  const passengerRecord = { ...pax, tier: currentTier };
  return {
    kind,
    passenger: passengerRecord,
    tierHistory,
    postedOn,
    charged,
    booking: reservation(reservationId, passengerRecord, [route], {
      cabin: profile.cabin,
      paidCents: route.cabins.find((entry) => entry.cabin === profile.cabin)?.fareCents ?? 30_000,
      bookedOn: '2026-06-15',
      checkedBags: profile.bags,
    }),
  };
}

export interface GeneratedAudit {
  world: AirlineOpsWorld;
  /** What was planted in each in-window baggage entry. Never shown to the agent. */
  plantedKinds: Map<string, CaseKind>;
}

export function createBaggageAuditWorld(seed = DEFAULT_AUDIT_SEED): AirlineOpsWorld {
  return generateBaggageAudit(seed).world;
}

export function generateBaggageAudit(seed = DEFAULT_AUDIT_SEED): GeneratedAudit {
  const rng = createRng(seed);
  const flights: Flight[] = [
    flight('AS420', 'SFO-SEA', '2026-08-11', '07:20-09:30', {
      basic_economy: [12_900, 6],
      economy: [18_900, 11],
      premium_economy: [27_900, 4],
    }),
    flight('AA204', 'SFO-ORD', '2026-08-03', '09:05-15:15', {
      basic_economy: [33_000, 5],
      economy: [39_000, 4],
      premium_economy: [52_000, 2],
    }),
    flight('AA660', 'SFO-BOS', '2026-08-05', '06:45-15:20', {
      basic_economy: [24_800, 8],
      economy: [31_900, 10],
      premium_economy: [44_000, 3],
    }),
  ];
  const names = rng.shuffle(NAMES);
  const kinds = rng.shuffle(CASE_MIX);
  const planned = kinds.map((kind, index) =>
    plan(
      kind,
      rng,
      passenger(`P-31${String(index + 10)}`, names[index] ?? `Passenger ${index}`, 'none'),
      `R81${String(index + 10)}`,
      flights,
    ),
  );

  // Distractors: baggage fees just outside the window (one of them wrong) and
  // other fees inside it. None of them is part of the audit.
  const outsider = (id: string, name: string | undefined) => passenger(id, name ?? id, 'none');
  const outside = [
    plan('tier-ignored', rng, outsider('P-3190', names[13]), 'R8190', flights, '2026-07-18'),
    plan('correct', rng, outsider('P-3191', names[14]), 'R8191', flights, '2026-07-27'),
  ];

  interface Row {
    postedOn: string;
    booking: Reservation;
    amountCents: number;
    category: 'baggage_fee' | 'change_fee';
    note: string;
    kind?: CaseKind;
  }
  const rows: Row[] = [];
  for (const charge of [...planned, ...outside]) {
    const audited = planned.includes(charge);
    charge.charged.forEach((amountCents, copy) =>
      rows.push({
        postedOn: charge.postedOn,
        booking: charge.booking,
        amountCents,
        category: 'baggage_fee',
        // A duplicate posting looks exactly like the original; nothing labels it.
        note: `${charge.booking.checkedBags} checked bag(s)`,
        // Only the second posting of a duplicate is the planted error; the first is a plain charge.
        ...(audited
          ? { kind: charge.kind === 'duplicate' && copy === 0 ? 'correct' : charge.kind }
          : {}),
      }),
    );
  }
  const changeFeeHolders = [planned[0], planned[1]].filter((entry) => entry !== undefined);
  for (const holder of changeFeeHolders) {
    rows.push({
      postedOn: rng.pick(DAYS_AFTER),
      booking: holder.booking,
      amountCents: 7500,
      category: 'change_fee',
      note: 'voluntary change',
    });
  }
  // Ledger order is posting order; a duplicate lands right after its original.
  rows.sort((a, b) => a.postedOn.localeCompare(b.postedOn));
  const ledger: LedgerEntry[] = rows.map((row, index) => ({
    id: `L${index + 1}`,
    reservationId: row.booking.id,
    kind: 'fee',
    category: row.category,
    amountCents: row.amountCents,
    postedOn: row.postedOn,
    note: row.note,
  }));

  const plantedKinds = new Map<string, CaseKind>();
  rows.forEach((row, index) => {
    if (row.kind) plantedKinds.set(`L${index + 1}`, row.kind);
  });

  const all = [...planned, ...outside];
  const world: AirlineOpsWorld = {
    ...emptyOps({
      today: TODAY,
      flights,
      passengers: all.map((entry) => entry.passenger),
      reservations: all.map((entry) => entry.booking),
      ledger,
    }),
    tierHistory: all.flatMap((entry) => entry.tierHistory),
    bulletins: [
      {
        id: 'PB-2026-13',
        title: 'Checked baggage fee change',
        publishedOn: '2026-07-15',
        effectiveFrom: PRICE_CHANGE_ON,
        effectiveTo: null,
        body: [
          `From ${PRICE_CHANGE_ON} the fee for the first chargeable checked bag is ${NEW_FIRST_BAG_CENTS} cents (was ${FIRST_CHARGEABLE_BAG_CENTS}). Each further chargeable bag is unchanged at ${ADDITIONAL_CHARGEABLE_BAG_CENTS} cents.`,
          'Allowances are unchanged. Fees are charged at the rate in force on the day the bags are added. The baggage rules tool will be updated in the next publication cycle.',
        ].join('\n'),
      },
      {
        id: 'PB-2026-11',
        title: 'Seat selection fees',
        publishedOn: '2026-07-01',
        effectiveFrom: '2026-07-05',
        effectiveTo: null,
        body: 'Preferred seat selection is 2500 cents per segment. Gold and platinum members select seats free of charge.',
      },
    ],
  };
  return { world, plantedKinds };
}

// ---------------------------------------------------------------------------
// Oracle
// ---------------------------------------------------------------------------

export interface AuditFinding {
  entryId: string;
  reservationId: string;
  outcome: AuditOutcome;
  refundCents: number;
  /** 1-based page the entry appears on when the window is listed by category and date. */
  page: number;
}

const PAGE_SIZE = 8;

/** The audit the handbook prescribes, for every baggage fee posted inside the window. */
export function auditOracle(seed: AirlineOpsWorld): AuditFinding[] {
  const inWindow = seed.ledger.filter(
    (entry) =>
      entry.kind === 'fee' &&
      entry.category === 'baggage_fee' &&
      entry.postedOn !== undefined &&
      entry.postedOn >= AUDIT_FROM &&
      entry.postedOn <= AUDIT_TO,
  );
  const seen = new Set<string>();
  return inWindow.map((entry, index) => {
    const page = Math.floor(index / PAGE_SIZE) + 1;
    if (seen.has(entry.reservationId)) {
      return { entryId: entry.id, reservationId: entry.reservationId, outcome: 'overcharged', refundCents: entry.amountCents, page };
    }
    seen.add(entry.reservationId);
    const booking = seed.reservations.find((candidate) => candidate.id === entry.reservationId);
    if (!booking || !entry.postedOn) throw new Error(`audit seed is missing ${entry.reservationId}`);
    const tier = tierOn(seed, booking.passengerId, entry.postedOn);
    const fee = baggageFeeOn(entry.postedOn, booking.cabin, tier, booking.checkedBags);
    const outcome: AuditOutcome =
      entry.amountCents > fee ? 'overcharged' : entry.amountCents < fee ? 'undercharged' : 'correct';
    return {
      entryId: entry.id,
      reservationId: entry.reservationId,
      outcome,
      refundCents: Math.max(0, entry.amountCents - fee),
      page,
    };
  });
}

// ---------------------------------------------------------------------------
// Task
// ---------------------------------------------------------------------------

/**
 * The task for one variant of the audit. The registered task uses the default
 * seed; any other seed yields a different but equally hard instance, scored
 * against its own oracle.
 */
export function createBaggageAuditSpec(seed = DEFAULT_AUDIT_SEED): ToolUseTaskSpec<AirlineOpsWorld> {
  const generated = generateBaggageAudit(seed);
  const findings = auditOracle(generated.world);
  const audited = new Set(findings.map((finding) => finding.entryId));

  /** Scorer items for the entries planted with one of `kinds`, so a trap names exactly its cases. */
  const planted = (prefix: 'refund' | 'outcome', ...kinds: CaseKind[]): string[] =>
    [...generated.plantedKinds]
      .filter(([, kind]) => kinds.includes(kind))
      .map(([entryId]) => `${prefix}:${entryId}`);

  /** Refunds against charges that were not overcharged. */
  const wrongfulRefunds = (world: AirlineOpsWorld): string[] =>
    findings
      .filter((finding) => finding.refundCents === 0 && feeRefundedCents(world, finding.entryId) > 0)
      .map((finding) => finding.entryId);

  /** Refunds may only be linked to audited entries; annotations are harmless anywhere. */
  const auditChanges: ChangeFilter = anyOf(
    addedTo('ledger', (entry) => entry.kind === 'refund' && audited.has(String(entry.refundOf))),
    (change) => change.path[0] === 'ledger' && change.path[2] === 'auditOutcome',
  );

  return {
    ...AIRLINE_EXPERT_BASE,
    id: 'airline-baggage-audit',
    title: 'Audit a week of baggage fees',
    tags: ['airline', 'audit', 'batch', 'independent-items', 'partial-observability', 'pagination'],
    maxTurns: 110,
    prompt: [
      `Finance thinks some baggage fees posted between ${AUDIT_FROM} and ${AUDIT_TO} used the wrong allowances or prices.`,
      'Audit every baggage fee posted in that window and settle each one per the audit rules.',
    ].join(' '),
    hypothesis:
      "orchestrator-workers ~= single on score at lower latency; plan-execute-verify highest. Fourteen independent charges across two ledger pages: fan-out parallelises the per-entry lookups, while a single context drifts or stops after the first page. Each finding is checkable from state (tier history, the dated fee bulletin, the ledger), so a state-grounded verifier catches omissions and refunds computed from today's tier or yesterday's price list.",
    traps: [
      {
        id: 'current-tier',
        description:
          "Judges a charge by the passenger's tier today instead of on the day of the charge, refunding a correct fee or missing an overcharge.",
        caughtBy: planted('refund', 'tier-rose-later', 'tier-lapsed-later'),
      },
      {
        id: 'cabin-only-allowance',
        description: 'Accepts charges that ignored the tier bonus to the allowance.',
        caughtBy: planted('refund', 'tier-ignored'),
      },
      {
        id: 'stale-fee-table',
        description:
          'Prices bags from the baggage rules tool for charges posted after the fee bulletin took effect.',
        caughtBy: [
          ...planted('refund', 'correct-after-price-change'),
          ...planted('outcome', 'old-price-after-change'),
        ],
      },
      {
        id: 'duplicate-charge',
        description: 'Misses that one reservation was billed twice for the same bags.',
        caughtBy: planted('refund', 'duplicate'),
      },
      {
        id: 'second-page',
        description: 'Stops after the first page of ledger results.',
        caughtBy: findings
          .filter((finding) => finding.page > 1)
          .map((finding) => `outcome:${finding.entryId}`),
      },
      {
        id: 'rebill',
        description:
          'Charges the customer again for an undercharge, or refunds an entry outside the window.',
        caughtBy: ['out-of-scope-change'],
      },
    ],
    createWorld: () => createBaggageAuditWorld(seed),
    assertions: findings.flatMap(perEntry),
    forbidden: [
      {
        id: 'refunded-correct-charge',
        label: 'Refunded a charge that was not an overcharge',
        multiplier: 0.8,
        violated: (world) => wrongfulRefunds(world).length > 0,
        detail: (world) => `Refunded: ${wrongfulRefunds(world).join(', ')}.`,
      },
      blastRadiusRule<AirlineOpsWorld>({
        seed: () => createBaggageAuditWorld(seed),
        diff: OPS_DIFF,
        allow: auditChanges,
        label: 'Moved money outside the audit: a new charge, or a refund of an entry outside it',
      }),
    ],
  };
}

function perEntry(finding: AuditFinding): AssertionSpec<AirlineOpsWorld>[] {
  return [
    {
      id: `refund:${finding.entryId}`,
      label: `${finding.entryId} (${finding.reservationId}): audited, and refunded exactly the overcharge, if any`,
      weight: 1,
      // "Refunded nothing" only counts once the entry has been audited; otherwise
      // an untouched ledger would earn the credit for every correct charge.
      check: (world) =>
        world.ledger.find((entry) => entry.id === finding.entryId)?.auditOutcome !== undefined &&
        feeRefundedCents(world, finding.entryId) === finding.refundCents,
      detail: (world) =>
        `refunded ${feeRefundedCents(world, finding.entryId)} of an expected ${finding.refundCents}`,
    },
    {
      id: `outcome:${finding.entryId}`,
      label: `${finding.entryId}: audit outcome recorded as ${finding.outcome}`,
      weight: 0.5,
      check: (world) =>
        world.ledger.find((entry) => entry.id === finding.entryId)?.auditOutcome === finding.outcome,
    },
  ];
}

export const airlineBaggageAuditSpec = createBaggageAuditSpec();
export const airlineBaggageAuditTask: Task = defineToolUseTask(airlineBaggageAuditSpec);
