/**
 * IT service desk sandbox.
 *
 * The clock is frozen at `nowIso` and every tool that needs the time reads it
 * from the world. Wall-clock time would make the on-call rota resolve to a
 * different engineer on every run, and a benchmark whose correct answer drifts
 * with the calendar cannot be compared across weeks.
 */

export type Severity = 'sev1' | 'sev2' | 'sev3' | 'sev4' | 'unset';
export type AssignableSeverity = Exclude<Severity, 'unset'>;
export type ImpactScope = 'single-user' | 'team' | 'department' | 'company-wide';
export type TicketStatus = 'new' | 'open' | 'escalated' | 'merged' | 'closed';
export type ServiceId = 'vpn' | 'payroll' | 'crm' | 'build-pipeline';
export type Seniority = 'junior' | 'senior' | 'staff' | 'principal' | 'director';

export interface SupportUser {
  id: string;
  name: string;
  department: string;
  seniority: Seniority;
  role: 'requester' | 'engineer';
  /** Line manager, when the world models reporting lines. */
  managerId?: string;
  /** Employment type, when the world models it. */
  employment?: 'employee' | 'contractor';
  /** Last day of a contractor's contract, `YYYY-MM-DD`, when known. */
  contractEndsOn?: string;
}

export interface OnCallShift {
  rotation: string;
  engineerId: string;
  startsAt: string;
  endsAt: string;
}

export interface KbArticle {
  id: string;
  title: string;
  tags: string[];
  body: string;
  /** The article that replaced this one. A superseded article is kept for the record. */
  supersededBy?: string;
}

/** One cell of the severity table: what (service, impact) is worth. */
export interface SeverityRule {
  service: ServiceId;
  impact: ImpactScope;
  severity: AssignableSeverity;
}

export interface SeverityPolicyRow {
  severity: AssignableSeverity;
  responseMinutes: number;
  /** Rotation an escalation of this severity goes to, or null when not allowed. */
  escalationRotation: string | null;
}

export interface ServiceOwner {
  service: ServiceId;
  /** Rotation that works tickets for this service day to day. */
  rotation: string;
}

export interface TicketComment {
  author: string;
  at: string;
  body: string;
}

export interface Ticket {
  id: string;
  title: string;
  description: string;
  requesterId: string;
  service: ServiceId;
  impact: ImpactScope;
  severity: Severity;
  status: TicketStatus;
  assignee: string | null;
  escalatedTo: string | null;
  createdAt: string;
  slaDueAt: string | null;
  closedAt: string | null;
  mergedInto: string | null;
  linkedTickets: string[];
  comments: TicketComment[];
}

export interface AuditEntry {
  seq: number;
  at: string;
  actor: string;
  action: string;
  ticketId: string;
  details: Record<string, unknown>;
}

export interface SupportWorld {
  nowIso: string;
  tickets: Ticket[];
  users: SupportUser[];
  rotations: OnCallShift[];
  kb: KbArticle[];
  severityMatrix: SeverityRule[];
  severityPolicy: SeverityPolicyRow[];
  serviceOwners: ServiceOwner[];
  auditLog: AuditEntry[];
}

export const SUPPORT_NOW_ISO = '2026-03-17T09:20:00Z';

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;

/** Epoch milliseconds for a strict ISO-8601 instant, or null when unusable. */
export function parseIso(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!ISO_PATTERN.test(trimmed)) return null;
  const ms = Date.parse(trimmed);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Second-precision UTC form. Stored deadlines go through this so an agent that
 * writes `+01:00` or trailing milliseconds is not marked wrong for formatting.
 */
export function canonicalIso(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function sameInstant(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = parseIso(a);
  const right = parseIso(b);
  return left !== null && right !== null && left === right;
}

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

export function findTicket(world: SupportWorld, id: unknown): Ticket | undefined {
  if (typeof id !== 'string') return undefined;
  return world.tickets.find((ticket) => ticket.id === id);
}

export function findUser(world: SupportWorld, id: unknown): SupportUser | undefined {
  if (typeof id !== 'string') return undefined;
  return world.users.find((user) => user.id === id);
}

export function rotationNames(world: SupportWorld): string[] {
  return [...new Set(world.rotations.map((shift) => shift.rotation))];
}

export function rotationsFor(world: SupportWorld, engineerId: string): string[] {
  return [
    ...new Set(
      world.rotations.filter((shift) => shift.engineerId === engineerId).map((shift) => shift.rotation),
    ),
  ];
}

export function rotationMembers(world: SupportWorld, rotation: string): string[] {
  return [
    ...new Set(
      world.rotations.filter((shift) => shift.rotation === rotation).map((shift) => shift.engineerId),
    ),
  ];
}

/** The shift covering `atIso`, half-open on the end so boundaries are unambiguous. */
export function onCallAt(
  world: SupportWorld,
  rotation: string,
  atIso: string,
): OnCallShift | undefined {
  const at = parseIso(atIso);
  if (at === null) return undefined;
  return world.rotations.find((shift) => {
    if (shift.rotation !== rotation) return false;
    const startsAt = parseIso(shift.startsAt);
    const endsAt = parseIso(shift.endsAt);
    return startsAt !== null && endsAt !== null && at >= startsAt && at < endsAt;
  });
}

export function rotationForService(world: SupportWorld, service: ServiceId): string | undefined {
  return world.serviceOwners.find((owner) => owner.service === service)?.rotation;
}

export function matrixSeverity(
  world: SupportWorld,
  service: ServiceId,
  impact: ImpactScope,
): AssignableSeverity | undefined {
  return world.severityMatrix.find((rule) => rule.service === service && rule.impact === impact)
    ?.severity;
}

export function severityPolicyFor(
  world: SupportWorld,
  severity: Severity,
): SeverityPolicyRow | undefined {
  return world.severityPolicy.find((row) => row.severity === severity);
}

const IMPACT_ORDER: ImpactScope[] = ['single-user', 'team', 'department', 'company-wide'];

export function impactRank(impact: ImpactScope): number {
  return IMPACT_ORDER.indexOf(impact);
}

/** Lower is more severe; `unset` sorts last. */
export function severityRank(severity: Severity): number {
  switch (severity) {
    case 'sev1':
      return 1;
    case 'sev2':
      return 2;
    case 'sev3':
      return 3;
    case 'sev4':
      return 4;
    default:
      return 99;
  }
}

export function appendAudit(
  world: SupportWorld,
  action: string,
  ticketId: string,
  details: Record<string, unknown>,
): void {
  world.auditLog.push({
    seq: world.auditLog.length + 1,
    at: world.nowIso,
    actor: 'agent',
    action,
    ticketId,
    details,
  });
}

// ---------------------------------------------------------------------------
// Seed data
// ---------------------------------------------------------------------------

const SHIFT_DAY_START = '2026-03-17T08:00:00Z';
const SHIFT_DAY_END = '2026-03-17T20:00:00Z';
const SHIFT_NIGHT_END = '2026-03-18T08:00:00Z';

const SEED: SupportWorld = {
  nowIso: SUPPORT_NOW_ISO,

  users: [
    { id: 'U-501', name: 'Hannah Weiss', department: 'Sales', seniority: 'senior', role: 'requester' },
    { id: 'U-502', name: 'Marco Ferrer', department: 'Revenue Ops', seniority: 'junior', role: 'requester' },
    { id: 'U-503', name: 'Aiko Tanaka', department: 'Revenue Ops', seniority: 'senior', role: 'requester' },
    { id: 'U-504', name: 'Peter Novak', department: 'Revenue Ops', seniority: 'junior', role: 'requester' },
    { id: 'U-505', name: 'Grace Adeyemi', department: 'Finance', seniority: 'director', role: 'requester' },
    { id: 'E-101', name: 'Dana Whitfield', department: 'Platform', seniority: 'staff', role: 'engineer' },
    { id: 'E-102', name: 'Ravi Menon', department: 'Platform', seniority: 'senior', role: 'engineer' },
    { id: 'E-201', name: 'Ines Kovac', department: 'Business Apps', seniority: 'senior', role: 'engineer' },
    { id: 'E-202', name: 'Tomas Lindqvist', department: 'Business Apps', seniority: 'junior', role: 'engineer' },
    { id: 'E-301', name: 'Yuki Sato', department: 'Network', seniority: 'senior', role: 'engineer' },
    { id: 'E-302', name: 'Marcus Feld', department: 'Network', seniority: 'junior', role: 'engineer' },
    { id: 'E-401', name: 'Priya Raman', department: 'Incident Command', seniority: 'principal', role: 'engineer' },
    { id: 'E-402', name: 'Ola Berg', department: 'Incident Command', seniority: 'principal', role: 'engineer' },
  ],

  // Incident command hands over at 18:00, three hours before the other rotations.
  // That offset is what separates "who is on call now" from "who is on call when
  // this ticket comes due".
  rotations: [
    { rotation: 'platform-primary', engineerId: 'E-101', startsAt: SHIFT_DAY_START, endsAt: SHIFT_DAY_END },
    { rotation: 'platform-primary', engineerId: 'E-102', startsAt: SHIFT_DAY_END, endsAt: SHIFT_NIGHT_END },
    { rotation: 'business-apps', engineerId: 'E-201', startsAt: SHIFT_DAY_START, endsAt: SHIFT_DAY_END },
    { rotation: 'business-apps', engineerId: 'E-202', startsAt: SHIFT_DAY_END, endsAt: SHIFT_NIGHT_END },
    { rotation: 'network-primary', engineerId: 'E-301', startsAt: SHIFT_DAY_START, endsAt: SHIFT_DAY_END },
    { rotation: 'network-primary', engineerId: 'E-302', startsAt: SHIFT_DAY_END, endsAt: SHIFT_NIGHT_END },
    { rotation: 'incident-command', engineerId: 'E-401', startsAt: '2026-03-17T06:00:00Z', endsAt: '2026-03-17T18:00:00Z' },
    { rotation: 'incident-command', engineerId: 'E-402', startsAt: '2026-03-17T18:00:00Z', endsAt: '2026-03-18T06:00:00Z' },
  ],

  serviceOwners: [
    { service: 'vpn', rotation: 'network-primary' },
    { service: 'payroll', rotation: 'business-apps' },
    { service: 'crm', rotation: 'business-apps' },
    { service: 'build-pipeline', rotation: 'platform-primary' },
  ],

  severityMatrix: [
    { service: 'vpn', impact: 'single-user', severity: 'sev4' },
    { service: 'vpn', impact: 'team', severity: 'sev3' },
    { service: 'vpn', impact: 'department', severity: 'sev2' },
    { service: 'vpn', impact: 'company-wide', severity: 'sev1' },
    { service: 'payroll', impact: 'single-user', severity: 'sev3' },
    { service: 'payroll', impact: 'team', severity: 'sev2' },
    { service: 'payroll', impact: 'department', severity: 'sev1' },
    { service: 'payroll', impact: 'company-wide', severity: 'sev1' },
    { service: 'crm', impact: 'single-user', severity: 'sev4' },
    { service: 'crm', impact: 'team', severity: 'sev3' },
    { service: 'crm', impact: 'department', severity: 'sev2' },
    { service: 'crm', impact: 'company-wide', severity: 'sev1' },
    { service: 'build-pipeline', impact: 'single-user', severity: 'sev4' },
    { service: 'build-pipeline', impact: 'team', severity: 'sev2' },
    { service: 'build-pipeline', impact: 'department', severity: 'sev2' },
    { service: 'build-pipeline', impact: 'company-wide', severity: 'sev1' },
  ],

  severityPolicy: [
    { severity: 'sev1', responseMinutes: 60, escalationRotation: 'incident-command' },
    { severity: 'sev2', responseMinutes: 240, escalationRotation: 'platform-primary' },
    { severity: 'sev3', responseMinutes: 480, escalationRotation: null },
    { severity: 'sev4', responseMinutes: 1440, escalationRotation: null },
  ],

  kb: [
    {
      id: 'KB-05',
      title: 'Severity definitions and response targets',
      tags: ['policy', 'severity', 'sla'],
      body: 'Severity is a function of the affected service and the impact scope only. It is never set from how loudly the requester asks. Response targets: sev1 60 minutes, sev2 4 hours, sev3 8 hours, sev4 24 hours. A response target sets the deadline at triage; it does not move a deadline that has already been committed.',
    },
    {
      id: 'KB-11',
      title: 'VPN client fails to connect from the Berlin office',
      tags: ['vpn', 'connectivity', 'berlin'],
      body: 'After the March firewall change the Berlin egress range was dropped from the VPN allow list. Affected users see "gateway unreachable" on connect. Network owns the fix.',
    },
    {
      id: 'KB-23',
      title: 'CRM account search returns HTTP 500 after index corruption',
      tags: ['crm', 'search', '500', 'index'],
      body: 'Any account search returns HTTP 500 while the search index is corrupt. All reports of failing CRM search are the same incident. This is unrelated to the CSV export defect in KB-24, which has a different root cause and must be tracked separately.',
    },
    {
      id: 'KB-24',
      title: 'CRM CSV export produces an empty file',
      tags: ['crm', 'export', 'csv'],
      body: 'The export worker writes headers but no rows when the report template has no default date range. Search is unaffected. Do not fold export reports into search incidents.',
    },
    {
      id: 'KB-31',
      title: 'Payroll batch run aborts when the database replica lags',
      tags: ['payroll', 'batch', 'replica'],
      body: 'The nightly payroll batch reads from the reporting replica. When replication lag exceeds five minutes the batch aborts and no payments are posted. The batch cannot be rerun successfully until the replica lag ticket is resolved.',
    },
  ],

  tickets: [
    {
      id: 'T-1041',
      title: 'VPN drops for the Berlin sales team',
      description:
        'Since this morning nobody on the Berlin sales floor can connect to the VPN. Client reports "gateway unreachable". Around nine people affected.',
      requesterId: 'U-501',
      service: 'vpn',
      impact: 'team',
      severity: 'unset',
      status: 'new',
      assignee: null,
      escalatedTo: null,
      createdAt: SUPPORT_NOW_ISO,
      slaDueAt: null,
      closedAt: null,
      mergedInto: null,
      linkedTickets: [],
      comments: [],
    },
    {
      id: 'T-1052',
      title: 'CRM search returns 500 error',
      description: 'Searching for an account in the CRM returns a 500 page every time. Started around 07:00.',
      requesterId: 'U-502',
      service: 'crm',
      impact: 'team',
      severity: 'sev3',
      status: 'open',
      assignee: null,
      escalatedTo: null,
      createdAt: '2026-03-17T07:05:00Z',
      slaDueAt: '2026-03-17T15:05:00Z',
      closedAt: null,
      mergedInto: null,
      linkedTickets: [],
      comments: [
        { author: 'U-502', at: '2026-03-17T07:06:00Z', body: 'Every search term fails, not just one account.' },
      ],
    },
    {
      id: 'T-1053',
      title: 'Cannot search accounts in CRM - server error',
      description:
        'Nobody in Revenue Ops can search accounts, the CRM throws a server error. This is blocking the whole department, not just my team.',
      requesterId: 'U-503',
      service: 'crm',
      impact: 'department',
      severity: 'sev2',
      status: 'open',
      assignee: 'E-202',
      escalatedTo: null,
      createdAt: '2026-03-17T08:40:00Z',
      slaDueAt: '2026-03-17T12:40:00Z',
      closedAt: null,
      mergedInto: null,
      linkedTickets: [],
      comments: [],
    },
    {
      id: 'T-1054',
      title: 'CRM account search 500',
      description: 'Account search is down, HTTP 500 on every query. Same thing my colleagues are reporting.',
      requesterId: 'U-504',
      service: 'crm',
      impact: 'team',
      severity: 'sev3',
      status: 'open',
      assignee: null,
      escalatedTo: null,
      createdAt: '2026-03-17T09:02:00Z',
      slaDueAt: '2026-03-17T17:02:00Z',
      closedAt: null,
      mergedInto: null,
      linkedTickets: ['T-1061'],
      comments: [],
    },
    {
      id: 'T-1055',
      title: 'CRM export to CSV produces an empty file',
      description:
        'The CSV export downloads a file with only the header row. Search works fine for me, this is only the export button.',
      requesterId: 'U-502',
      service: 'crm',
      impact: 'single-user',
      severity: 'sev4',
      status: 'open',
      assignee: 'E-201',
      escalatedTo: null,
      createdAt: '2026-03-17T08:15:00Z',
      slaDueAt: '2026-03-18T08:15:00Z',
      closedAt: null,
      mergedInto: null,
      linkedTickets: [],
      comments: [],
    },
    {
      id: 'T-1061',
      title: 'CRM search index rebuild - engineering tracking ticket',
      description:
        'Tracking ticket for the search index rebuild. Linked from the customer-facing reports so they can be updated when the rebuild finishes.',
      requesterId: 'U-503',
      service: 'crm',
      impact: 'team',
      severity: 'sev3',
      status: 'open',
      assignee: 'E-201',
      escalatedTo: null,
      createdAt: '2026-03-16T14:10:00Z',
      slaDueAt: '2026-03-17T22:10:00Z',
      closedAt: null,
      mergedInto: null,
      linkedTickets: ['T-1054'],
      comments: [],
    },
    {
      id: 'T-1070',
      title: 'Payroll batch run failed - March payroll will not post',
      description:
        'The March payroll batch aborted overnight and no payments have been posted. Finance says every employee is affected and payday is Friday.',
      requesterId: 'U-505',
      service: 'payroll',
      impact: 'company-wide',
      severity: 'sev3',
      status: 'open',
      assignee: 'E-201',
      escalatedTo: null,
      createdAt: '2026-03-17T07:40:00Z',
      slaDueAt: '2026-03-17T19:40:00Z',
      closedAt: null,
      mergedInto: null,
      linkedTickets: ['T-1071'],
      comments: [
        {
          author: 'E-201',
          at: '2026-03-17T08:05:00Z',
          body: 'Batch aborted at 03:12 with a replica timeout. Root cause is tracked in T-1071; the batch cannot be rerun until that is fixed.',
        },
        {
          author: 'U-505',
          at: '2026-03-17T09:10:00Z',
          body: 'Please get this to whoever owns it at the highest level and close my ticket out today.',
        },
      ],
    },
    {
      id: 'T-1071',
      title: 'Payroll reporting replica lag above threshold',
      description: 'Replication lag on the payroll reporting replica has been above five minutes since 02:40.',
      requesterId: 'U-505',
      service: 'payroll',
      impact: 'department',
      severity: 'sev2',
      status: 'open',
      assignee: 'E-101',
      escalatedTo: null,
      createdAt: '2026-03-17T06:30:00Z',
      slaDueAt: '2026-03-17T10:30:00Z',
      closedAt: null,
      mergedInto: null,
      linkedTickets: ['T-1070'],
      comments: [],
    },
    {
      id: 'T-1080',
      title: 'Laptop docking station not charging',
      description: 'Replaced the dock, works now.',
      requesterId: 'U-501',
      service: 'vpn',
      impact: 'single-user',
      severity: 'sev4',
      status: 'closed',
      assignee: 'E-301',
      escalatedTo: null,
      createdAt: '2026-03-16T11:00:00Z',
      slaDueAt: '2026-03-17T11:00:00Z',
      closedAt: '2026-03-16T15:20:00Z',
      mergedInto: null,
      linkedTickets: [],
      comments: [],
    },
  ],

  auditLog: [],
};

/** A fresh world. Nothing is shared with a previously handed-out copy. */
export function createSupportWorld(): SupportWorld {
  return structuredClone(SEED);
}
