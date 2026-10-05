import type { Task } from '@scaffoldbench/core';
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
 * Nineteen charges over three pages of ledger, each an independent check:
 * re-derive the allowance from the cabin the booking had and the tier the
 * passenger held on the day of the charge (not today's), price the bags that
 * charge added at the fees in force that day (a bulletin raised the first-bag
 * price mid-week, and a bag's price depends on how many chargeable bags were
 * already on the booking), tell a second purchase from a duplicate posting,
 * net off anything a colleague already refunded, then refund exactly what is
 * left of the overcharge, or nothing, and record the outcome.
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
const PAGE_SIZE = 8;

/** First-bag price on a date, per the base fee table and bulletin PB-2026-13. */
export function firstBagCentsOn(date: string): number {
  return date >= PRICE_CHANGE_ON ? NEW_FIRST_BAG_CENTS : FIRST_CHARGEABLE_BAG_CENTS;
}

/**
 * The correct fee for a charge that took a booking from `total - added` to
 * `total` bags, under the rules in force on `date`: each newly chargeable bag
 * is priced by its position among the chargeable bags on the booking.
 */
export function chargeFeeOn(
  date: string,
  cabin: CabinClass,
  tier: Tier,
  bags: { added: number; total: number },
): number {
  const allowance = freeCheckedBags(cabin, tier);
  const before = Math.max(0, bags.total - bags.added - allowance);
  const after = Math.max(0, bags.total - allowance);
  let fee = 0;
  for (let position = before + 1; position <= after; position++) {
    fee += position === 1 ? firstBagCentsOn(date) : ADDITIONAL_CHARGEABLE_BAG_CENTS;
  }
  return fee;
}

/** The cabin a booking had on a date, undoing any later recorded change. */
export function cabinOn(booking: Reservation, date: string): CabinClass {
  let cabin = booking.cabin;
  for (const change of [...(booking.history ?? [])].reverse()) {
    if (change.field === 'cabin' && change.date > date) cabin = change.from as CabinClass;
  }
  return cabin;
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
  | 'cabin-upgraded-later'
  | 'first-bag-overpriced'
  | 'duplicate'
  | 'second-bag-underpriced'
  | 'old-price-after-change'
  | 'second-purchase'
  | 'partly-refunded';

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
  'cabin-upgraded-later',
  'cabin-upgraded-later',
  'first-bag-overpriced',
  'duplicate',
  'second-bag-underpriced',
  'old-price-after-change',
  'second-purchase',
  'partly-refunded',
];

const NAMES = [
  'Aaron Blake', 'Bianca Rossi', 'Carlos Mendes', 'Dana Kowal', 'Elif Aydin', 'Femi Adebayo',
  'Greta Lind', 'Hiro Tanaka', 'Isla Murray', 'Jakob Weiss', 'Kavya Rao', 'Liam Doyle',
  'Mona Haddad', 'Nils Berg', 'Olga Petrov', 'Pedro Alves', 'Quinn Harper', 'Rosa Vidal',
  'Sven Holm', 'Tara Singh', 'Ugo Bassi', 'Vera Ilic',
];

const DAYS_BEFORE = ['2026-07-20', '2026-07-21', '2026-07-22'];
const DAYS_AFTER = ['2026-07-23', '2026-07-24', '2026-07-25', '2026-07-26'];
const ANY_DAY = [...DAYS_BEFORE, ...DAYS_AFTER];

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
  postedOn: string;
  bags: { added: number; total: number };
  amountCents: number;
  /** What this posting is; the first posting of a duplicate is a plain charge. */
  kind: CaseKind;
}

interface PlannedCase {
  passenger: Passenger;
  tierHistory: TierChange[];
  booking: Reservation;
  charges: PlannedCharge[];
  /** A colleague's courtesy refund already on the ledger, against the first charge. */
  priorRefundCents?: number;
}

const nextDay = (date: string) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

/** Plant one case. Every branch is constructed so the planted error really is one. */
function plan(
  kind: CaseKind,
  rng: Rng,
  pax: Passenger,
  reservationId: string,
  flights: Flight[],
  forcedDate?: string,
): PlannedCase {
  const pickDay = (days: string[]) => forcedDate ?? rng.pick(days);
  const since = (tier: Tier): TierChange[] => [
    { passengerId: pax.id, tier, effectiveFrom: '2025-11-01' },
  ];
  const all = (profile: Profile) => ({ added: profile.bags, total: profile.bags });

  let profile: Profile;
  let tierHistory: TierChange[];
  let currentTier: Tier;
  let currentCabin: CabinClass | undefined;
  let charges: PlannedCharge[];
  let priorRefundCents: number | undefined;

  switch (kind) {
    case 'correct':
    case 'correct-after-price-change':
    case 'duplicate':
    case 'first-bag-overpriced': {
      profile = rng.pick(CHARGEABLE);
      const postedOn = pickDay(
        kind === 'correct' ? DAYS_BEFORE : kind === 'correct-after-price-change' ? DAYS_AFTER : ANY_DAY,
      );
      tierHistory = since(profile.tier);
      currentTier = profile.tier;
      const fee = chargeFeeOn(postedOn, profile.cabin, profile.tier, all(profile));
      const overpriced = fee - firstBagCentsOn(postedOn) + ADDITIONAL_CHARGEABLE_BAG_CENTS;
      charges =
        kind === 'duplicate'
          ? [
              { postedOn, bags: all(profile), amountCents: fee, kind: 'correct' },
              { postedOn, bags: all(profile), amountCents: fee, kind: 'duplicate' },
            ]
          : [
              {
                postedOn,
                bags: all(profile),
                amountCents: kind === 'first-bag-overpriced' ? overpriced : fee,
                kind,
              },
            ];
      break;
    }
    case 'tier-rose-later': {
      // Charged correctly at the lower tier; today's higher tier would make it look high.
      profile = rng.pick<Profile>([
        { cabin: 'economy', tier: 'none', bags: 2 },
        { cabin: 'basic_economy', tier: 'silver', bags: 3 },
        { cabin: 'economy', tier: 'none', bags: 3 },
      ]);
      const postedOn = pickDay(['2026-07-20', '2026-07-21', '2026-07-22', '2026-07-24']);
      currentTier = profile.tier === 'none' ? 'silver' : 'gold';
      tierHistory = [
        ...since(profile.tier),
        { passengerId: pax.id, tier: currentTier, effectiveFrom: nextDay(postedOn) },
      ];
      charges = [
        { postedOn, bags: all(profile), amountCents: chargeFeeOn(postedOn, profile.cabin, profile.tier, all(profile)), kind },
      ];
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
      const postedOn = pickDay(ANY_DAY);
      tierHistory = since(profile.tier);
      currentTier = profile.tier;
      charges = [
        { postedOn, bags: all(profile), amountCents: chargeFeeOn(postedOn, profile.cabin, 'none', all(profile)), kind },
      ];
      break;
    }
    case 'tier-lapsed-later': {
      // Gold on the day, lapsed since; billing priced it as if already lapsed.
      profile = rng.pick<Profile>([
        { cabin: 'economy', tier: 'gold', bags: 3 },
        { cabin: 'basic_economy', tier: 'gold', bags: 2 },
      ]);
      const postedOn = pickDay(['2026-07-20', '2026-07-21', '2026-07-22', '2026-07-24']);
      currentTier = 'none';
      tierHistory = [
        ...since('gold'),
        { passengerId: pax.id, tier: 'none', effectiveFrom: nextDay(postedOn) },
      ];
      charges = [
        { postedOn, bags: all(profile), amountCents: chargeFeeOn(postedOn, profile.cabin, 'none', all(profile)), kind },
      ];
      break;
    }
    case 'cabin-upgraded-later': {
      // Charged correctly in economy; the booking was upgraded afterwards, so
      // today's cabin would make the charge look too high.
      profile = rng.pick<Profile>([
        { cabin: 'economy', tier: 'none', bags: 2 },
        { cabin: 'economy', tier: 'silver', bags: 3 },
        { cabin: 'economy', tier: 'none', bags: 3 },
      ]);
      const postedOn = pickDay(['2026-07-20', '2026-07-21', '2026-07-22', '2026-07-24', '2026-07-25']);
      tierHistory = since(profile.tier);
      currentTier = profile.tier;
      currentCabin = 'premium_economy';
      charges = [
        { postedOn, bags: all(profile), amountCents: chargeFeeOn(postedOn, profile.cabin, profile.tier, all(profile)), kind },
      ];
      break;
    }
    case 'second-bag-underpriced': {
      // Two or more chargeable bags, every one priced as a first bag.
      profile = rng.pick<Profile>([
        { cabin: 'basic_economy', tier: 'none', bags: 2 },
        { cabin: 'basic_economy', tier: 'none', bags: 3 },
        { cabin: 'economy', tier: 'none', bags: 3 },
      ]);
      const postedOn = pickDay(ANY_DAY);
      tierHistory = since(profile.tier);
      currentTier = profile.tier;
      const chargeable = profile.bags - freeCheckedBags(profile.cabin, profile.tier);
      charges = [{ postedOn, bags: all(profile), amountCents: chargeable * firstBagCentsOn(postedOn), kind }];
      break;
    }
    case 'old-price-after-change': {
      // Posted after the bulletin but priced from the old table.
      profile = rng.pick(CHARGEABLE);
      const postedOn = pickDay(DAYS_AFTER);
      tierHistory = since(profile.tier);
      currentTier = profile.tier;
      const fee = chargeFeeOn(postedOn, profile.cabin, profile.tier, all(profile));
      charges = [
        { postedOn, bags: all(profile), amountCents: fee - NEW_FIRST_BAG_CENTS + FIRST_CHARGEABLE_BAG_CENTS, kind },
      ];
      break;
    }
    case 'second-purchase': {
      // One bag added early in the week and another later: two correct charges,
      // the second priced as the second chargeable bag, not as a first.
      profile = rng.pick<Profile>([
        { cabin: 'economy', tier: 'none', bags: 3 },
        { cabin: 'basic_economy', tier: 'none', bags: 2 },
      ]);
      tierHistory = since(profile.tier);
      currentTier = profile.tier;
      const firstDay = rng.pick(DAYS_BEFORE);
      const secondDay = rng.pick(DAYS_AFTER);
      const early = { added: profile.bags - 1, total: profile.bags - 1 };
      const late = { added: 1, total: profile.bags };
      charges = [
        { postedOn: firstDay, bags: early, amountCents: chargeFeeOn(firstDay, profile.cabin, profile.tier, early), kind: 'correct' },
        { postedOn: secondDay, bags: late, amountCents: chargeFeeOn(secondDay, profile.cabin, profile.tier, late), kind },
      ];
      break;
    }
    case 'partly-refunded': {
      // Overcharged by the tier-ignored error, and a colleague has already
      // refunded part of the difference as a courtesy.
      profile = rng.pick<Profile>([
        { cabin: 'economy', tier: 'silver', bags: 3 },
        { cabin: 'basic_economy', tier: 'gold', bags: 3 },
      ]);
      const postedOn = pickDay(DAYS_BEFORE);
      tierHistory = since(profile.tier);
      currentTier = profile.tier;
      priorRefundCents = 2000;
      charges = [
        { postedOn, bags: all(profile), amountCents: chargeFeeOn(postedOn, profile.cabin, 'none', all(profile)), kind },
      ];
      break;
    }
  }

  const route = rng.pick(flights);
  const passengerRecord = { ...pax, tier: currentTier };
  const booking = reservation(reservationId, passengerRecord, [route], {
    cabin: currentCabin ?? profile.cabin,
    paidCents: route.cabins.find((entry) => entry.cabin === profile.cabin)?.fareCents ?? 30_000,
    bookedOn: '2026-06-15',
    checkedBags: profile.bags,
  });
  if (currentCabin) {
    booking.history = [
      { date: nextDay(charges[0]!.postedOn), field: 'cabin', from: profile.cabin, to: currentCabin },
    ];
  }
  return {
    passenger: passengerRecord,
    tierHistory,
    booking,
    charges,
    ...(priorRefundCents !== undefined ? { priorRefundCents } : {}),
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
    plan('tier-ignored', rng, outsider('P-3190', names[20]), 'R8190', flights, '2026-07-18'),
    plan('correct', rng, outsider('P-3191', names[21]), 'R8191', flights, '2026-07-27'),
  ];

  interface Row {
    postedOn: string;
    reservationId: string;
    category: 'baggage_fee' | 'change_fee';
    amountCents: number;
    bags?: { added: number; total: number };
    kind?: CaseKind;
  }
  const rows: Row[] = [];
  for (const entry of [...planned, ...outside]) {
    const audited = planned.includes(entry);
    for (const charge of entry.charges) {
      rows.push({
        postedOn: charge.postedOn,
        reservationId: entry.booking.id,
        category: 'baggage_fee',
        amountCents: charge.amountCents,
        bags: charge.bags,
        ...(audited ? { kind: charge.kind } : {}),
      });
    }
  }
  for (const holder of planned.slice(0, 2)) {
    rows.push({
      postedOn: rng.pick(DAYS_AFTER),
      reservationId: holder.booking.id,
      category: 'change_fee',
      amountCents: 7500,
    });
  }
  // Ledger order is posting order (stable, so a duplicate stays right after its original).
  rows.sort((a, b) => a.postedOn.localeCompare(b.postedOn));
  const ledger: LedgerEntry[] = rows.map((row, index) => ({
    id: `L${index + 1}`,
    reservationId: row.reservationId,
    kind: 'fee',
    category: row.category,
    amountCents: row.amountCents,
    postedOn: row.postedOn,
    ...(row.bags ? { bags: row.bags } : {}),
    // A duplicate posting looks exactly like the original; nothing labels it.
    note: row.category === 'baggage_fee' ? 'checked baggage' : 'voluntary change',
  }));

  const plantedKinds = new Map<string, CaseKind>();
  rows.forEach((row, index) => {
    if (row.kind) plantedKinds.set(`L${index + 1}`, row.kind);
  });

  // A colleague's courtesy refunds, posted after the window.
  for (const entry of planned) {
    if (entry.priorRefundCents === undefined) continue;
    const fee = ledger.find((row) => row.reservationId === entry.booking.id && row.category === 'baggage_fee');
    if (!fee) continue;
    ledger.push({
      id: `L${ledger.length + 1}`,
      reservationId: entry.booking.id,
      kind: 'refund',
      category: 'refund',
      amountCents: entry.priorRefundCents,
      method: 'original_payment',
      refundOf: fee.id,
      postedOn: '2026-07-27',
      note: 'courtesy refund, customer called about the bag fee (agent-3)',
    });
  }

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
  /** What this audit should refund now: the overcharge, less any refund already made. */
  refundCents: number;
  /** 1-based page the entry appears on when the window is listed by category and date. */
  page: number;
}

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
  return inWindow.map((entry, index) => {
    const page = Math.floor(index / PAGE_SIZE) + 1;
    const booking = seed.reservations.find((candidate) => candidate.id === entry.reservationId);
    if (!booking || !entry.postedOn || !entry.bags) {
      throw new Error(`audit seed is missing data for ${entry.id}`);
    }
    const alreadyRefunded = feeRefundedCents(seed, entry.id);
    const duplicateOf = inWindow
      .slice(0, index)
      .find(
        (earlier) =>
          earlier.reservationId === entry.reservationId &&
          earlier.bags?.added === entry.bags?.added &&
          earlier.bags?.total === entry.bags?.total,
      );
    const fee = duplicateOf
      ? 0
      : chargeFeeOn(
          entry.postedOn,
          cabinOn(booking, entry.postedOn),
          tierOn(seed, booking.passengerId, entry.postedOn),
          entry.bags,
        );
    const outcome: AuditOutcome =
      entry.amountCents > fee ? 'overcharged' : entry.amountCents < fee ? 'undercharged' : 'correct';
    return {
      entryId: entry.id,
      reservationId: entry.reservationId,
      outcome,
      refundCents: Math.max(0, entry.amountCents - fee - alreadyRefunded),
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

  /**
   * The later-page entries that only an unread page gets wrong: those whose
   * kind no other trap names. A planted error on page two also fails its own
   * trap's items, so naming it here would fire this trap for a run that read
   * every page and misjudged one charge. Every seed tried has such entries;
   * the fallback keeps the trap alive for one that does not.
   */
  const plainKinds: readonly CaseKind[] = ['correct', 'first-bag-overpriced', 'second-bag-underpriced'];
  const laterPages = findings.filter((finding) => finding.page > 1);
  const plainLater = laterPages.filter((finding) => {
    const kind = generated.plantedKinds.get(finding.entryId);
    return kind === undefined || plainKinds.includes(kind);
  });
  const laterPageItems = (plainLater.length > 0 ? plainLater : laterPages).map(
    (finding) => `outcome:${finding.entryId}`,
  );

  /**
   * Charges this run refunded beyond what was left of their overcharge: a
   * correct charge refunded at all, or an overcharge refunded whole when part
   * of it was due (or already returned). Either way the money was owed.
   */
  const overRefunds = (world: AirlineOpsWorld): string[] =>
    findings
      .filter((finding) => refundedThisRun(generated.world, world, finding.entryId) > finding.refundCents)
      .map((finding) => finding.entryId);

  /** Passengers whose charges are under audit, who may be told the outcome. */
  const auditedPassengers = new Set(
    findings.flatMap((finding) => {
      const booking = generated.world.reservations.find((entry) => entry.id === finding.reservationId);
      return booking ? [booking.passengerId] : [];
    }),
  );

  /**
   * Refunds may only be linked to audited entries; annotations are harmless
   * anywhere; telling an audited passenger the outcome is part of the job.
   */
  const auditChanges: ChangeFilter = anyOf(
    addedTo('ledger', (entry) => entry.kind === 'refund' && audited.has(String(entry.refundOf))),
    (change) => change.path[0] === 'ledger' && change.path[2] === 'auditOutcome',
    addedTo('notifications', (entry) => auditedPassengers.has(String(entry.passengerId))),
  );

  return {
    ...AIRLINE_EXPERT_BASE,
    id: 'airline-baggage-audit',
    title: 'Audit a week of baggage fees',
    tags: ['airline', 'audit', 'batch', 'independent-items', 'partial-observability', 'pagination'],
    maxTurns: 140,
    prompt: [
      `Finance thinks some baggage fees posted from ${AUDIT_FROM} through ${AUDIT_TO} used the wrong allowances or prices.`,
      'Audit every baggage fee posted in that window and settle each one per the audit rules.',
    ].join(' '),
    hypothesis:
      "orchestrator-workers ≈ single on score at lower latency; plan-execute-verify highest. Nineteen independent charges across three ledger pages: fan-out parallelises the per-entry lookups, while a single context drifts or stops early. Each finding is checkable from state (tier and booking history, the dated fee bulletin, earlier refunds on the ledger), so a state-grounded verifier catches omissions and refunds computed from today's tier, today's cabin or yesterday's price list.",
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
        id: 'later-upgrade',
        description:
          "Judges a charge by the booking's cabin today, after an upgrade, instead of the cabin it had when charged.",
        caughtBy: planted('refund', 'cabin-upgraded-later'),
      },
      {
        id: 'duplicate-charge',
        description: 'Misses that one reservation was billed twice for the same bags.',
        caughtBy: planted('refund', 'duplicate'),
      },
      {
        id: 'second-purchase',
        description:
          'Prices a bag added later in the week as a first chargeable bag, treating a correct charge as an overcharge.',
        caughtBy: planted('refund', 'second-purchase'),
      },
      {
        id: 'prior-courtesy-refund',
        description: "Refunds the whole overcharge without netting off a colleague's earlier courtesy refund.",
        caughtBy: planted('refund', 'partly-refunded'),
      },
      {
        id: 'second-page',
        description: 'Stops after the first page of ledger results.',
        caughtBy: laterPageItems,
      },
      {
        id: 'rebill',
        description:
          'Charges the customer again for an undercharge, or refunds an entry outside the window.',
        caughtBy: ['out-of-scope-change'],
      },
    ],
    createWorld: () => createBaggageAuditWorld(seed),
    assertions: findings.flatMap((finding) => perEntry(finding, () => createBaggageAuditWorld(seed))),
    forbidden: [
      {
        id: 'over-refunded',
        label: 'Refunded more than a charge was overcharged',
        multiplier: 0.8,
        violated: (world) => overRefunds(world).length > 0,
        detail: (world) => `Refunded beyond the overcharge: ${overRefunds(world).join(', ')}.`,
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

/** Refunded against a fee during the run: everything now, less what the seed already held. */
function refundedThisRun(start: AirlineOpsWorld, world: AirlineOpsWorld, entryId: string): number {
  return feeRefundedCents(world, entryId) - feeRefundedCents(start, entryId);
}

function perEntry(finding: AuditFinding, seed: () => AirlineOpsWorld): AssertionSpec<AirlineOpsWorld>[] {
  return [
    {
      id: `refund:${finding.entryId}`,
      label: `${finding.entryId} (${finding.reservationId}): audited, and refunded exactly the overcharge, if any`,
      weight: 1,
      // "Refunded nothing" only counts once the entry has been audited; otherwise
      // an untouched ledger would earn the credit for every correct charge.
      check: (world) =>
        world.ledger.find((entry) => entry.id === finding.entryId)?.auditOutcome !== undefined &&
        refundedThisRun(seed(), world, finding.entryId) === finding.refundCents,
      detail: (world) =>
        `refunded ${refundedThisRun(seed(), world, finding.entryId)} of an expected ${finding.refundCents}`,
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
