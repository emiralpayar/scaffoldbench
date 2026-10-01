import type { Task, ToolCall } from '@arena/core';
import {
  defineToolUseTask,
  type AssertionSpec,
  type ToolUseTaskSpec,
} from '../../../defineToolUseTask';
import { actedBeforeConsulting, findCalls } from '../../../journal';
import { anyOf, blastRadiusRule, within } from '../../../worldDiff';
import {
  addBusinessMinutes,
  coveringEngineer,
  dayNightRota,
  emptySupportOps,
  onLeave,
  type SupportOpsWorld,
} from '../ops';
import {
  canonicalIso,
  impactRank,
  matrixSeverity,
  parseIso,
  rotationForService,
  sameInstant,
  severityPolicyFor,
  type AssignableSeverity,
  type Ticket,
} from '../world';
import {
  SERVICE_OWNERS,
  SEVERITY_MATRIX,
  SEVERITY_POLICY,
  SUPPORT_EXPERT_BASE,
  article,
  auditTrail,
  person,
  ticket,
  ticketOrThrow,
} from './common';

/**
 * support-monday-triage: the weekend's queue, fourteen new tickets on two
 * pages, triaged on Monday morning before the desk opens.
 *
 * Each ticket is its own chain of lookups (matrix, business calendar, rota,
 * leave) ending in arithmetic, so the batch splits, but not cleanly: two
 * duplicate groups cut across the queue, one of them into a ticket that is not
 * in the new queue at all. And three handbook rules override what an agent
 * does by habit: sev3 and sev4 count business hours (the desk opens at 09:00,
 * and Wednesday is a company holiday), an engineer on leave is covered by the
 * backup rotation, and a phishing report is a security incident whatever
 * service it came in on.
 */

export const TRIAGE_NOW = '2026-03-23T08:10:00Z';
const SECURITY_ROTATION = 'security-oncall';

const SECURITY_TICKET = 'T-2007';
const NOT_REQUESTS = ['T-2010', 'T-2014'];
/** Duplicate groups: survivor first. */
const DUPLICATE_GROUPS: readonly (readonly string[])[] = [
  ['T-2003', 'T-2012', 'T-1999'],
  ['T-2004', 'T-2005'],
];
const NEW_QUEUE = Array.from({ length: 14 }, (_, index) => `T-${2001 + index}`);
const MERGED = DUPLICATE_GROUPS.flatMap((group) => group.slice(1));
const TRIAGED = NEW_QUEUE.filter((id) => !NOT_REQUESTS.includes(id) && !MERGED.includes(id));
const IN_SCOPE = [...NEW_QUEUE, 'T-1999'];

export function createTriageWorld(): SupportOpsWorld {
  const days = 5;
  const first = '2026-03-23';
  return {
    ...emptySupportOps({
      nowIso: TRIAGE_NOW,
      severityMatrix: structuredClone(SEVERITY_MATRIX),
      severityPolicy: structuredClone(SEVERITY_POLICY),
      serviceOwners: structuredClone(SERVICE_OWNERS),
      users: [
        person('U-701', 'Hannah Weiss', 'Sales'),
        person('U-702', 'Marco Ferrer', 'Revenue Ops', { seniority: 'junior' }),
        person('U-703', 'Aiko Tanaka', 'Payments'),
        person('U-704', 'Peter Novak', 'Sales'),
        person('U-705', 'Grace Adeyemi', 'Sales', { seniority: 'director' }),
        person('U-706', 'Lina Haddad', 'Warehouse'),
        person('U-707', 'Omar Siddiqui', 'Finance', { seniority: 'junior' }),
        person('U-708', 'Clara Jensen', 'Legal'),
        person('U-709', 'Viktor Orban', 'Mobile'),
        person('U-710', 'SyncFlow Marketing', 'External'),
        person('U-711', 'Tessa Moreau', 'Warehouse'),
        person('U-712', 'Ben Carter', 'Payments'),
        person('U-713', 'Joana Silva', 'Lisbon Office'),
        person('U-714', 'Rafael Costa', 'Sales'),
        person('U-790', 'CI Monitoring', 'Platform'),
        person('E-101', 'Dana Whitfield', 'Platform', { seniority: 'staff' }),
        person('E-102', 'Ravi Menon', 'Platform'),
        person('E-103', 'Lea Fontaine', 'Platform'),
        person('E-104', 'Jonas Weber', 'Platform', { seniority: 'junior' }),
        person('E-201', 'Ines Kovac', 'Business Apps'),
        person('E-202', 'Tomas Lindqvist', 'Business Apps', { seniority: 'junior' }),
        person('E-203', 'Amara Osei', 'Business Apps'),
        person('E-204', 'Pieter de Vries', 'Business Apps'),
        person('E-301', 'Yuki Sato', 'Network'),
        person('E-302', 'Marcus Feld', 'Network', { seniority: 'junior' }),
        person('E-303', 'Sanna Virtanen', 'Network'),
        person('E-304', 'Diego Alvarez', 'Network'),
        person('E-401', 'Priya Raman', 'Incident Command', { seniority: 'principal' }),
        person('E-402', 'Ola Berg', 'Incident Command', { seniority: 'principal' }),
        person('E-601', 'Noor Haddad', 'Security'),
        person('E-602', 'Felix Braun', 'Security'),
      ],
      rotations: [
        ...dayNightRota('network-primary', first, days, ['E-301', 'E-302'], ['E-302', 'E-301']),
        ...dayNightRota('network-secondary', first, days, ['E-303'], ['E-304']),
        ...dayNightRota('business-apps', first, days, ['E-201', 'E-202'], ['E-202', 'E-201']),
        ...dayNightRota('business-apps-secondary', first, days, ['E-203'], ['E-204']),
        ...dayNightRota('platform-primary', first, days, ['E-101', 'E-102'], ['E-102', 'E-101']),
        ...dayNightRota('platform-secondary', first, days, ['E-103'], ['E-104']),
        ...dayNightRota('security-oncall', first, days, ['E-601'], ['E-602']),
        ...dayNightRota('incident-command', first, days, ['E-401'], ['E-402']),
      ],
      kb: [
        article(
          'KB-11',
          'VPN client fails to connect from the Berlin office',
          ['vpn', 'connectivity', 'berlin'],
          'After a firewall change the Berlin egress range can drop off the VPN allow list. Affected users see "gateway unreachable" on connect. Network owns the fix.',
        ),
        article(
          'KB-23',
          'CRM account search returns errors after index corruption',
          ['crm', 'search', '500', 'index'],
          'Any account search fails while the search index is corrupt. All reports of failing CRM search are the same incident. This is unrelated to the CSV export defect in KB-24.',
        ),
        article(
          'KB-24',
          'CRM CSV export produces an empty or partial file',
          ['crm', 'export', 'csv'],
          'The export worker drops rows or columns when the report template has no default date range. Search is unaffected. Do not fold export reports into search incidents.',
        ),
        article(
          'KB-52',
          'Phishing: what to do if you entered your password',
          ['security', 'phishing', 'password'],
          'Report it to the service desk at once. The security team resets the credentials and checks the account for misuse.',
        ),
      ],
      tickets: [
        ticket('T-1990', '2026-03-19T11:20:00Z', 'U-702', 'crm', 'single-user', 'CSV export produces an empty file', 'The pipeline CSV export downloads with only the header row.', {
          status: 'open',
          severity: 'sev4',
          assignee: 'E-201',
          slaDueAt: '2026-03-23T11:20:00Z',
        }),
        ticket('T-1995', '2026-03-18T09:30:00Z', 'U-701', 'vpn', 'team', 'Berlin VPN gateway unreachable', 'Nobody in Berlin can connect since the firewall change.', {
          status: 'closed',
          severity: 'sev3',
          assignee: 'E-301',
          slaDueAt: '2026-03-18T17:30:00Z',
          closedAt: '2026-03-19T10:05:00Z',
        }),
        ticket('T-1997', '2026-03-20T15:10:00Z', 'U-707', 'payroll', 'department', 'Payroll export to the bank delayed', 'The bank file for supplier payments has not been generated.', {
          status: 'open',
          severity: 'sev1',
          assignee: 'E-201',
          slaDueAt: '2026-03-20T16:10:00Z',
        }),
        ticket('T-1999', '2026-03-23T06:30:00Z', 'U-790', 'build-pipeline', 'team', 'CI alert: payments-service pipeline failure rate above 50%', 'Automated alert. Failure rate on payments-service pipelines has been above threshold since Saturday night.', {
          status: 'open',
          severity: 'sev2',
          assignee: 'E-101',
          slaDueAt: '2026-03-23T10:30:00Z',
        }),
        ticket('T-2001', '2026-03-20T18:40:00Z', 'U-701', 'vpn', 'team', 'Berlin VPN drops every few minutes', 'Since this afternoon the VPN keeps dropping for the whole Berlin sales team, about ten people.'),
        ticket('T-2002', '2026-03-21T10:12:00Z', 'U-702', 'crm', 'single-user', 'Pipeline export missing columns', 'My weekly pipeline export is missing the stage and owner columns.'),
        ticket('T-2003', '2026-03-21T22:30:00Z', 'U-703', 'build-pipeline', 'department', 'Payments builds failing for everyone', 'Every build in the payments repositories fails at the test stage. The whole Payments department is blocked.'),
        ticket('T-2004', '2026-03-22T09:05:00Z', 'U-704', 'crm', 'department', 'CRM search errors across Sales', 'Account search in the CRM fails with a server error for the whole Sales department.'),
        ticket('T-2005', '2026-03-22T11:40:00Z', 'U-705', 'crm', 'team', 'CRM search broken', 'Search in the CRM just errors out. My team cannot find any accounts.'),
        ticket('T-2006', '2026-03-22T20:15:00Z', 'U-706', 'payroll', 'single-user', 'Payslip shows the wrong tax code', 'My March payslip preview shows last year\'s tax code.'),
        ticket('T-2007', '2026-03-23T06:50:00Z', 'U-707', 'vpn', 'single-user', 'VPN login page asked for my password again', 'I got an email saying my VPN session expired, clicked the link and typed my password into the page. Afterwards I noticed the address was not ours.'),
        ticket('T-2008', '2026-03-23T07:20:00Z', 'U-708', 'vpn', 'single-user', 'VPN client update fails', 'The VPN client update stops at 80% with "installer error 1603".'),
        ticket('T-2009', '2026-03-23T07:45:00Z', 'U-709', 'build-pipeline', 'single-user', 'Build logs page is slow', 'Opening the logs of a finished build takes over a minute.'),
        ticket('T-2010', '2026-03-23T07:58:00Z', 'U-710', 'crm', 'single-user', 'Boost your team\'s productivity with SyncFlow - 30% off', 'Book a demo this week and save 30% on SyncFlow for your whole service desk!'),
        ticket('T-2011', '2026-03-21T14:00:00Z', 'U-711', 'payroll', 'team', 'Overtime not imported for the warehouse team', 'Overtime hours for the warehouse team are missing from this month\'s payroll run.'),
        ticket('T-2012', '2026-03-22T16:30:00Z', 'U-712', 'build-pipeline', 'team', 'Payments builds red since Saturday', 'All our payments-service builds have been red since Saturday night.'),
        ticket('T-2013', '2026-03-23T08:05:00Z', 'U-713', 'vpn', 'department', 'Lisbon office cannot reach the VPN', 'Nobody in the Lisbon office can connect to the VPN this morning.'),
        ticket('T-2014', '2026-03-22T13:00:00Z', 'U-714', 'crm', 'single-user', 'Automatic reply: Out of office', 'I am out of the office until 30 March with limited access to email.'),
      ],
      auditLog: [],
    }),
    calendar: {
      opensAt: '09:00',
      closesAt: '17:00',
      workdays: [1, 2, 3, 4, 5],
      holidays: [
        { date: '2026-03-25', name: 'Company spring day' },
        { date: '2026-04-03', name: 'Good Friday' },
        { date: '2026-04-06', name: 'Easter Monday' },
      ],
    },
    leave: [
      { engineerId: 'E-102', from: '2026-03-19', to: '2026-03-20', kind: 'annual leave' },
      { engineerId: 'E-301', from: '2026-03-23', to: '2026-03-23', kind: 'annual leave' },
      { engineerId: 'E-202', from: '2026-03-26', to: '2026-03-27', kind: 'annual leave' },
      { engineerId: 'E-303', from: '2026-03-30', to: '2026-04-03', kind: 'annual leave' },
    ],
    rotationInfo: [
      { rotation: 'network-primary', description: 'VPN and office networks', backup: 'network-secondary' },
      { rotation: 'network-secondary', description: 'backup for network-primary', backup: null },
      { rotation: 'business-apps', description: 'CRM and payroll', backup: 'business-apps-secondary' },
      { rotation: 'business-apps-secondary', description: 'backup for business-apps', backup: null },
      { rotation: 'platform-primary', description: 'build pipeline and developer platform', backup: 'platform-secondary' },
      { rotation: 'platform-secondary', description: 'backup for platform-primary', backup: null },
      { rotation: SECURITY_ROTATION, description: 'security incidents', backup: null },
      { rotation: 'incident-command', description: 'major incidents', backup: null },
    ],
  };
}

// ---------------------------------------------------------------------------
// Oracle
// ---------------------------------------------------------------------------

export interface TriageOutcome {
  ticketId: string;
  severity: AssignableSeverity;
  deadline: string;
  assignee: string;
}

function isSecurity(ticketId: string): boolean {
  return ticketId === SECURITY_TICKET;
}

/**
 * The triage the handbook produces for every ticket that stays open, from the
 * seed: severity from the matrix at the widest impact in its duplicate group
 * (or sev2 for a security report), a deadline from the response target on the
 * clock or in business hours (or, for a merged group, the earliest deadline
 * already committed in it), and the engineer covering the owning rotation
 * when that deadline falls.
 */
export function triageOracle(seed: SupportOpsWorld): TriageOutcome[] {
  return TRIAGED.map((ticketId) => {
    const group = DUPLICATE_GROUPS.find((members) => members[0] === ticketId) ?? [ticketId];
    const members = group.map((id) => ticketOrThrow(seed, id));
    const base = ticketOrThrow(seed, ticketId);
    const widest = members.reduce((wide, entry) =>
      impactRank(entry.impact) > impactRank(wide.impact) ? entry : wide,
    ).impact;
    const severity = isSecurity(ticketId)
      ? 'sev2'
      : (matrixSeverity(seed, base.service, widest) as AssignableSeverity);
    const minutes = severityPolicyFor(seed, severity)?.responseMinutes ?? 0;
    const triageDeadline =
      severity === 'sev1' || severity === 'sev2'
        ? canonicalIso((parseIso(seed.nowIso) ?? 0) + minutes * 60_000)
        : addBusinessMinutes(seed.calendar, seed.nowIso, minutes);
    const committed = members
      .map((entry) => entry.slaDueAt)
      .filter((due): due is string => due !== null)
      .sort((a, b) => (parseIso(a) ?? 0) - (parseIso(b) ?? 0));
    const deadline = committed[0] && (parseIso(committed[0]) ?? 0) < (parseIso(triageDeadline) ?? 0)
      ? canonicalIso(parseIso(committed[0]) ?? 0)
      : triageDeadline;
    const rotation = isSecurity(ticketId) ? SECURITY_ROTATION : rotationForService(seed, base.service);
    const assignee = rotation ? coveringEngineer(seed, rotation, deadline) : undefined;
    if (!assignee) throw new Error(`no engineer covers ${ticketId} at ${deadline}`);
    return { ticketId, severity, deadline, assignee };
  });
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

const ORACLE = triageOracle(createTriageWorld());

function perTicket(expected: TriageOutcome): AssertionSpec<SupportOpsWorld>[] {
  const { ticketId } = expected;
  return [
    {
      id: `severity:${ticketId}`,
      label: `${ticketId} graded ${expected.severity}`,
      weight: 1,
      check: (world) => ticketOrThrow(world, ticketId).severity === expected.severity,
      detail: (world) => `severity=${ticketOrThrow(world, ticketId).severity}`,
    },
    {
      id: `deadline:${ticketId}`,
      label: `${ticketId} due ${expected.deadline}`,
      weight: 1,
      check: (world) => sameInstant(ticketOrThrow(world, ticketId).slaDueAt, expected.deadline),
      detail: (world) => `sla_due_at=${ticketOrThrow(world, ticketId).slaDueAt ?? 'not set'}`,
    },
    {
      id: `assignee:${ticketId}`,
      label: `${ticketId} assigned to ${expected.assignee}`,
      weight: 1,
      check: (world) => ticketOrThrow(world, ticketId).assignee === expected.assignee,
      detail: (world) => `assignee=${ticketOrThrow(world, ticketId).assignee ?? 'unassigned'}`,
    },
  ];
}

/** Queue tickets left with an engineer who is on leave on the day the ticket falls due. */
export function assignedOnLeave(world: SupportOpsWorld): string[] {
  return IN_SCOPE.map((id) => ticketOrThrow(world, id))
    .filter(
      (entry: Ticket) =>
        entry.status !== 'merged' &&
        entry.assignee !== null &&
        entry.slaDueAt !== null &&
        onLeave(world, entry.assignee, entry.slaDueAt),
    )
    .map((entry) => `${entry.id} -> ${entry.assignee}`);
}

function closedServiceRequests(journal: readonly ToolCall[]): string[] {
  return findCalls(journal, { name: 'close_ticket' })
    .map((entry) => String(entry.args.ticketId))
    .filter((id) => !NOT_REQUESTS.includes(id));
}

/** Tickets merged that belong to no duplicate group, or into the wrong survivor. */
function wrongMerges(world: SupportOpsWorld): string[] {
  return world.tickets
    .filter((entry) => entry.status === 'merged')
    .filter((entry) => {
      const group = DUPLICATE_GROUPS.find((members) => members.includes(entry.id));
      return !group || entry.mergedInto !== group[0];
    })
    .map((entry) => `${entry.id} into ${entry.mergedInto}`);
}

export const supportTriageSpec: ToolUseTaskSpec<SupportOpsWorld> = {
  ...SUPPORT_EXPERT_BASE,
  id: 'support-monday-triage',
  title: "Triage the weekend's queue on Monday morning",
  tags: ['support', 'triage', 'batch', 'business-hours', 'on-call', 'duplicates', 'long-horizon'],
  maxTurns: 140,
  prompt: [
    "It is Monday morning and the weekend's tickets are waiting in the new queue.",
    'Triage every one of them under the handbook.',
  ].join(' '),
  hypothesis:
    'plan-execute-verify > single; orchestrator-workers ≈ single on accuracy at lower latency. Fourteen tickets over two pages, each a chain of lookups (matrix, business calendar, rota, leave calendar) ending in arithmetic that a state-grounded verifier can recompute. Two duplicate groups couple tickets across the queue, one reaching a monitoring ticket outside the new queue, which per-ticket workers handle inconsistently, and three handbook rules (business hours with a mid-week holiday, cover for an engineer on leave, security reports) override the defaults an agent applies by habit.',
  traps: [
    {
      id: 'business-hours',
      description:
        'Counts sev3 and sev4 targets on the clock, from before the desk opens, or straight through the Wednesday holiday.',
      caughtBy: ['deadline:T-2006', 'deadline:T-2008'],
    },
    {
      id: 'on-leave',
      description: 'Hands a ticket to the engineer the rota names although they are on leave that day.',
      caughtBy: ['assigned-on-leave', 'assignee:T-2001', 'assignee:T-2002'],
    },
    {
      id: 'owner-now',
      description: 'Assigns by who is on call now rather than when the ticket falls due.',
      caughtBy: ['assignee:T-2008', 'assignee:T-2009'],
    },
    {
      id: 'security-report',
      description: 'Grades a phishing report by its service and impact and routes it to the network team.',
      caughtBy: ['severity:T-2007', 'assignee:T-2007'],
    },
    {
      id: 'not-a-request',
      description: 'Triages the marketing email or the out-of-office reply instead of closing them.',
      caughtBy: ['closed:T-2010', 'closed:T-2014'],
    },
    {
      id: 'duplicate-outside-queue',
      description:
        "Misses that the monitoring alert outside the new queue is the same problem, losing its earlier committed deadline.",
      caughtBy: ['merged:T-1999', 'deadline:T-2003'],
    },
    {
      id: 'closes-real-ticket',
      description: 'Closes a genuine service request during triage.',
      caughtBy: ['closed-a-service-request'],
    },
  ],
  createWorld: createTriageWorld,
  assertions: [
    ...ORACLE.flatMap(perTicket),
    ...MERGED.map((ticketId): AssertionSpec<SupportOpsWorld> => {
      const survivor = DUPLICATE_GROUPS.find((group) => group.includes(ticketId))?.[0] ?? '';
      return {
        id: `merged:${ticketId}`,
        label: `${ticketId} merged into ${survivor}`,
        weight: 1,
        check: (world) => {
          const entry = ticketOrThrow(world, ticketId);
          return entry.status === 'merged' && entry.mergedInto === survivor;
        },
      };
    }),
    ...NOT_REQUESTS.map(
      (ticketId): AssertionSpec<SupportOpsWorld> => ({
        id: `closed:${ticketId}`,
        label: `${ticketId} closed as not a service request`,
        weight: 1,
        check: (world) => ticketOrThrow(world, ticketId).status === 'closed',
      }),
    ),
  ],
  forbidden: [
    {
      id: 'severity-set-without-matrix',
      label: 'Changed a severity before reading the escalation matrix',
      multiplier: 0.8,
      violated: (_world, journal) =>
        actedBeforeConsulting(journal, { name: 'set_severity' }, { name: 'get_escalation_matrix' }),
    },
    {
      id: 'closed-a-service-request',
      label: 'Closed a genuine service request during triage',
      violated: (_world, journal) => closedServiceRequests(journal).length > 0,
      detail: (_world, journal) => `Closed: ${closedServiceRequests(journal).join(', ')}.`,
    },
    {
      id: 'assigned-on-leave',
      label: 'Left a ticket with an engineer who is on leave when it falls due',
      multiplier: 0.8,
      violated: (world) => assignedOnLeave(world).length > 0,
      detail: (world) => assignedOnLeave(world).join('; ') || undefined,
    },
    {
      id: 'merged-different-problem',
      label: 'Merged a ticket that is a different problem, or into the wrong survivor',
      multiplier: 0.5,
      violated: (world) => wrongMerges(world).length > 0,
      detail: (world) => wrongMerges(world).join('; ') || undefined,
    },
    blastRadiusRule<SupportOpsWorld>({
      seed: createTriageWorld,
      allow: anyOf(auditTrail, ...IN_SCOPE.map((id) => within('tickets', id))),
      label: 'Changed a ticket outside the weekend queue and its duplicates',
    }),
  ],
};

export const supportTriageTask: Task = defineToolUseTask(supportTriageSpec);

export { NEW_QUEUE as TRIAGE_QUEUE, DUPLICATE_GROUPS as TRIAGE_DUPLICATES };
