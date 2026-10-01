import { z } from 'zod';
import type { JournaledToolSpec, ToolReply } from '@arena/core';
import { createSupportTools } from './tools';
import {
  appendAudit,
  canonicalIso,
  findTicket,
  findUser,
  onCallAt,
  parseIso,
  rotationNames,
  type ImpactScope,
  type OnCallShift,
  type ServiceId,
  type Severity,
  type SupportWorld,
  type Ticket,
  type TicketComment,
} from './world';

/**
 * The service desk back office for the expert tier: the ticket desk plus a
 * business calendar, a leave calendar with backup rotations, incidents with
 * paging and status updates, and access requests with approvals, system
 * owners and change freezes.
 *
 * It extends the base world rather than replacing it, so every base tool runs
 * unchanged against it. Pages reach a person immediately and an access grant
 * takes effect at once: neither can be recalled, which is what lets the
 * scorer read them off the journal as irreversible acts.
 */

export interface BusinessCalendar {
  /** Opening and closing time, `HH:MM` UTC. */
  opensAt: string;
  closesAt: string;
  /** Working days as `Date#getUTCDay` numbers (1 = Monday). */
  workdays: number[];
  holidays: { date: string; name: string }[];
}

export interface LeaveEntry {
  engineerId: string;
  /** First and last day of leave, inclusive, `YYYY-MM-DD`. */
  from: string;
  to: string;
  kind: string;
}

export interface RotationInfo {
  rotation: string;
  description: string;
  /** The rotation that covers this one when its engineer is on leave. */
  backup: string | null;
}

export interface Incident {
  id: string;
  title: string;
  service: ServiceId;
  createdAt: string;
  commanderId: string | null;
  commsLeadId: string | null;
  ticketIds: string[];
  updates: { at: string; body: string }[];
}

export interface Page {
  id: string;
  engineerId: string;
  at: string;
  message: string;
  incidentId?: string;
  ticketId?: string;
}

export type AccessLevel = 'read' | 'write' | 'admin';
export const ACCESS_LEVELS: readonly AccessLevel[] = ['read', 'write', 'admin'];

export interface SystemInfo {
  id: string;
  name: string;
  environment: 'production' | 'staging' | 'internal';
  ownerId: string;
}

export interface ChangeFreeze {
  id: string;
  systems: string[];
  startsAt: string;
  endsAt: string;
  reason: string;
}

export interface AccessRequest {
  id: string;
  /** The person who will hold the access. */
  userId: string;
  system: string;
  level: AccessLevel;
  justification: string;
  createdAt: string;
  status: 'pending' | 'granted';
  comments: TicketComment[];
}

export interface Approval {
  id: string;
  requestId: string;
  approverId: string;
  level: AccessLevel;
  at: string;
}

export interface AccessGrant {
  id: string;
  requestId: string;
  userId: string;
  system: string;
  level: AccessLevel;
  grantedAt: string;
  expiresAt: string | null;
}

export interface SupportOpsWorld extends SupportWorld {
  calendar: BusinessCalendar;
  leave: LeaveEntry[];
  rotationInfo: RotationInfo[];
  incidents: Incident[];
  pages: Page[];
  systems: SystemInfo[];
  freezes: ChangeFreeze[];
  accessRequests: AccessRequest[];
  approvals: Approval[];
  grants: AccessGrant[];
}

export const STANDARD_CALENDAR: BusinessCalendar = {
  opensAt: '09:00',
  closesAt: '17:00',
  workdays: [1, 2, 3, 4, 5],
  holidays: [],
};

/** An ops world with empty ops collections and the standard calendar, for seeds to fill in. */
export function emptySupportOps(base: SupportWorld): SupportOpsWorld {
  return {
    ...base,
    calendar: structuredClone(STANDARD_CALENDAR),
    leave: [],
    rotationInfo: [],
    incidents: [],
    pages: [],
    systems: [],
    freezes: [],
    accessRequests: [],
    approvals: [],
    grants: [],
  };
}

// ---------------------------------------------------------------------------
// Rule helpers shared by the expert support tasks
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;

function minutesOf(time: string): number {
  const [hours = Number.NaN, minutes = Number.NaN] = time.split(':').map(Number);
  return hours * 60 + minutes;
}

function dayStart(ms: number): number {
  return Math.floor(ms / DAY_MS) * DAY_MS;
}

export function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function isBusinessDay(calendar: BusinessCalendar, dayMs: number): boolean {
  const weekday = new Date(dayMs).getUTCDay();
  return (
    calendar.workdays.includes(weekday) &&
    !calendar.holidays.some((holiday) => holiday.date === isoDate(dayMs))
  );
}

/**
 * The instant `minutes` business minutes after `fromIso`. Time outside
 * opening hours, on weekends and on holidays does not count, so a ticket
 * triaged before the desk opens starts counting when it opens.
 */
export function addBusinessMinutes(
  calendar: BusinessCalendar,
  fromIso: string,
  minutes: number,
): string {
  const start = parseIso(fromIso);
  if (start === null) throw new Error(`not an ISO instant: ${fromIso}`);
  const opens = minutesOf(calendar.opensAt) * 60_000;
  const closes = minutesOf(calendar.closesAt) * 60_000;
  let at = start;
  let remaining = minutes * 60_000;
  for (let guard = 0; guard < 3_660; guard++) {
    const day = dayStart(at);
    if (!isBusinessDay(calendar, day) || at >= day + closes) {
      at = day + DAY_MS;
      continue;
    }
    if (at < day + opens) at = day + opens;
    const available = day + closes - at;
    if (remaining <= available) return canonicalIso(at + remaining);
    remaining -= available;
    at = day + DAY_MS;
  }
  throw new Error('business-minute arithmetic ran past ten years');
}

/** Close of business on the `n`th business day after the day of `fromIso`. */
export function closeOfBusinessDaysAfter(
  calendar: BusinessCalendar,
  fromIso: string,
  n: number,
): string {
  const start = parseIso(fromIso);
  if (start === null) throw new Error(`not an ISO instant: ${fromIso}`);
  let day = dayStart(start);
  let counted = 0;
  while (counted < n) {
    day += DAY_MS;
    if (isBusinessDay(calendar, day)) counted++;
  }
  return canonicalIso(day + minutesOf(calendar.closesAt) * 60_000);
}

export function onLeave(world: SupportOpsWorld, engineerId: string, atIso: string): boolean {
  const at = parseIso(atIso);
  if (at === null) return false;
  const date = isoDate(at);
  return world.leave.some(
    (entry) => entry.engineerId === engineerId && entry.from <= date && date <= entry.to,
  );
}

/**
 * The engineer who actually covers a rotation at an instant: the one the rota
 * names, or, when they are on leave that day, whoever the backup rotation has
 * on call at the same instant.
 */
export function coveringEngineer(
  world: SupportOpsWorld,
  rotation: string,
  atIso: string,
): string | undefined {
  const scheduled = onCallAt(world, rotation, atIso)?.engineerId;
  if (!scheduled || !onLeave(world, scheduled, atIso)) return scheduled;
  const backup = world.rotationInfo.find((entry) => entry.rotation === rotation)?.backup;
  return backup ? coveringEngineer(world, backup, atIso) : undefined;
}

/**
 * Day and night shifts for a rotation over consecutive days: day shifts
 * 08:00-20:00 UTC and night shifts 20:00-08:00, each list read cyclically.
 * Night shifts start on the evening before the first day, so the early hours
 * of that day are covered too.
 */
export function dayNightRota(
  rotation: string,
  firstDay: string,
  days: number,
  dayEngineers: readonly string[],
  nightEngineers: readonly string[],
): OnCallShift[] {
  const first = Date.parse(`${firstDay}T00:00:00Z`);
  const at = (ms: number) => canonicalIso(ms);
  const shifts: OnCallShift[] = [];
  for (let index = -1; index < days; index++) {
    const day = first + index * DAY_MS;
    const night = nightEngineers[(index + nightEngineers.length) % nightEngineers.length];
    if (night) {
      shifts.push({ rotation, engineerId: night, startsAt: at(day + 20 * 3_600_000), endsAt: at(day + 32 * 3_600_000) });
    }
    const dayEngineer = dayEngineers[index % dayEngineers.length];
    if (index >= 0 && dayEngineer) {
      shifts.push({ rotation, engineerId: dayEngineer, startsAt: at(day + 8 * 3_600_000), endsAt: at(day + 20 * 3_600_000) });
    }
  }
  return shifts.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
}

export function findIncident(world: SupportOpsWorld, id: unknown): Incident | undefined {
  return typeof id === 'string' ? world.incidents.find((incident) => incident.id === id) : undefined;
}

export function findAccessRequest(world: SupportOpsWorld, id: unknown): AccessRequest | undefined {
  return typeof id === 'string' ? world.accessRequests.find((request) => request.id === id) : undefined;
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export const SUPPORT_OPS_INSTRUCTIONS = [
  'IT service desk and operations API. Ticket ids look like T-1234, requesters like U-501, engineers like E-301, incidents like INC-1 and access requests like AR-301.',
  'The service desk clock is frozen: read it with get_current_time rather than assuming a date. All times are UTC.',
  'Reads never change anything; every mutating tool reports exactly what it changed. Pages reach the engineer immediately and access grants take effect at once; neither can be recalled.',
].join(' ');

const TICKET_PAGE_SIZE = 8;

function fail(text: string): ToolReply {
  return { text, isError: true };
}

/** Base tools the ops back office replaces with richer versions of its own. */
const REPLACED = new Set(['list_tickets']);

export function createSupportOpsTools(world: SupportOpsWorld): JournaledToolSpec[] {
  const engineer = (id: unknown) => {
    const user = findUser(world, id);
    return user?.role === 'engineer' ? user : undefined;
  };

  return [
    ...createSupportTools(world).filter((spec) => !REPLACED.has(spec.name)),

    // -----------------------------------------------------------------------
    // Reads
    // -----------------------------------------------------------------------
    {
      name: 'list_tickets',
      description: `List tickets, optionally filtered by status, service or assignee, one compact line per ticket, oldest first. Results are paged, ${TICKET_PAGE_SIZE} tickets per page.`,
      schema: {
        status: z.enum(['new', 'open', 'escalated', 'merged', 'closed']).optional(),
        service: z.enum(['vpn', 'payroll', 'crm', 'build-pipeline']).optional(),
        assignee: z.string().optional().describe('Engineer id, or "unassigned"'),
        page: z.number().int().min(1).optional().describe('1-based page number, default 1'),
      },
      readOnly: true,
      handler: (args: { status?: string; service?: string; assignee?: string; page?: number }) => {
        const matches = world.tickets
          .filter((ticket) => {
            if (args.status && ticket.status !== args.status) return false;
            if (args.service && ticket.service !== args.service) return false;
            if (args.assignee === 'unassigned') return ticket.assignee === null;
            if (args.assignee && ticket.assignee !== args.assignee) return false;
            return true;
          })
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
        if (matches.length === 0) return 'No tickets match that filter.';
        const pages = Math.ceil(matches.length / TICKET_PAGE_SIZE);
        const page = args.page ?? 1;
        if (page > pages) return fail(`Page ${page} does not exist; there are ${pages}.`);
        return [
          `${matches.length} ticket(s); page ${page} of ${pages}:`,
          ...matches
            .slice((page - 1) * TICKET_PAGE_SIZE, page * TICKET_PAGE_SIZE)
            .map(
              (ticket) =>
                `${ticket.id} | ${ticket.service} | impact=${ticket.impact} | severity=${ticket.severity} | status=${ticket.status} | assignee=${ticket.assignee ?? '-'} | created=${ticket.createdAt} | due=${ticket.slaDueAt ?? '-'} | "${ticket.title}"`,
            ),
        ].join('\n');
      },
    },
    {
      name: 'get_business_calendar',
      description: 'The desk business hours, working days and company holidays.',
      schema: {},
      readOnly: true,
      handler: () => {
        const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        const calendar = world.calendar;
        return [
          `business hours: ${calendar.opensAt}-${calendar.closesAt} UTC`,
          `working days: ${calendar.workdays.map((day) => days[day]).join(', ')}`,
          `company holidays (${calendar.holidays.length}):`,
          ...calendar.holidays.map((holiday) => `  ${holiday.date} ${holiday.name}`),
        ].join('\n');
      },
    },
    {
      name: 'list_leave',
      description: 'Planned leave for engineers, optionally for one engineer. Dates are inclusive.',
      schema: { engineerId: z.string().optional() },
      readOnly: true,
      handler: (args: { engineerId?: string }) => {
        const entries = world.leave.filter(
          (entry) => !args.engineerId || entry.engineerId === args.engineerId,
        );
        if (entries.length === 0) return 'No leave recorded.';
        return [
          `${entries.length} leave entr${entries.length === 1 ? 'y' : 'ies'}:`,
          ...entries.map(
            (entry) =>
              `  ${entry.engineerId} ${findUser(world, entry.engineerId)?.name ?? ''} ${entry.from} to ${entry.to} (${entry.kind})`,
          ),
        ].join('\n');
      },
    },
    {
      name: 'get_rotation',
      description:
        'A rotation: what it covers, its backup rotation, and its published shifts between two instants (default: the next 48 hours).',
      schema: {
        rotation: z.string(),
        from: z.string().optional().describe('ISO-8601 instant'),
        to: z.string().optional().describe('ISO-8601 instant'),
      },
      readOnly: true,
      handler: (args: { rotation: string; from?: string; to?: string }) => {
        const known = rotationNames(world);
        if (!known.includes(args.rotation)) {
          return fail(`No rotation "${args.rotation}". Known rotations: ${known.join(', ')}.`);
        }
        const now = parseIso(world.nowIso) ?? 0;
        const from = args.from ? parseIso(args.from) : now;
        const to = args.to ? parseIso(args.to) : now + 2 * DAY_MS;
        if (from === null || to === null) return fail('from and to must be ISO-8601 instants.');
        const info = world.rotationInfo.find((entry) => entry.rotation === args.rotation);
        const shifts = world.rotations.filter((shift) => {
          const starts = parseIso(shift.startsAt) ?? 0;
          const ends = parseIso(shift.endsAt) ?? 0;
          return shift.rotation === args.rotation && ends > from && starts < to;
        });
        return [
          `rotation: ${args.rotation}`,
          ...(info ? [`covers: ${info.description}`, `backup rotation: ${info.backup ?? 'none'}`] : []),
          `shifts between ${canonicalIso(from)} and ${canonicalIso(to)}:`,
          ...shifts.map(
            (shift) =>
              `  ${shift.startsAt} .. ${shift.endsAt} ${shift.engineerId} ${findUser(world, shift.engineerId)?.name ?? ''}`,
          ),
        ].join('\n');
      },
    },
    {
      name: 'list_incidents',
      description: 'List incidents with their commander, communications lead and linked tickets.',
      schema: {},
      readOnly: true,
      handler: () => {
        if (world.incidents.length === 0) return 'No incidents.';
        return world.incidents.map((incident) => describeIncident(incident)).join('\n\n');
      },
    },
    {
      name: 'list_systems',
      description: 'Systems that access can be requested for: environment and owner.',
      schema: {},
      readOnly: true,
      handler: () =>
        [
          `${world.systems.length} system(s):`,
          ...world.systems.map(
            (system) =>
              `  ${system.id} "${system.name}" environment=${system.environment} owner=${system.ownerId} ${findUser(world, system.ownerId)?.name ?? ''}`,
          ),
        ].join('\n'),
    },
    {
      name: 'list_freezes',
      description: 'Change freezes: which systems, when, and why.',
      schema: {},
      readOnly: true,
      handler: () => {
        if (world.freezes.length === 0) return 'No change freezes.';
        return [
          `${world.freezes.length} change freeze(s), now=${world.nowIso}:`,
          ...world.freezes.map(
            (freeze) =>
              `  ${freeze.id} systems=${freeze.systems.join(',')} ${freeze.startsAt} .. ${freeze.endsAt} "${freeze.reason}"`,
          ),
        ].join('\n');
      },
    },
    {
      name: 'list_access_requests',
      description: 'List access requests, optionally by status (pending or granted).',
      schema: { status: z.enum(['pending', 'granted']).optional() },
      readOnly: true,
      handler: (args: { status?: 'pending' | 'granted' }) => {
        const matches = world.accessRequests.filter(
          (request) => !args.status || request.status === args.status,
        );
        if (matches.length === 0) return 'No access requests match.';
        return [
          `${matches.length} access request(s):`,
          ...matches.map(
            (request) =>
              `  ${request.id} user=${request.userId} system=${request.system} level=${request.level} status=${request.status} created=${request.createdAt}`,
          ),
        ].join('\n');
      },
    },
    {
      name: 'get_access_request',
      description: 'Read one access request in full: who, what, why, and its comments.',
      schema: { requestId: z.string() },
      readOnly: true,
      handler: (args: { requestId: string }) => {
        const request = findAccessRequest(world, args.requestId);
        if (!request) return fail(`No access request ${args.requestId}.`);
        return [
          `${request.id} status=${request.status} created=${request.createdAt}`,
          `user: ${findUser(world, request.userId) ? `${request.userId} ${findUser(world, request.userId)?.name}` : request.userId}`,
          `system: ${request.system}`,
          `level requested: ${request.level}`,
          `justification: ${request.justification}`,
          `comments (${request.comments.length}):`,
          ...request.comments.map((comment) => `  [${comment.at}] ${comment.author}: ${comment.body}`),
        ].join('\n');
      },
    },
    {
      name: 'get_approvals',
      description: 'Approvals recorded against an access request: who approved, and at what level.',
      schema: { requestId: z.string() },
      readOnly: true,
      handler: (args: { requestId: string }) => {
        const request = findAccessRequest(world, args.requestId);
        if (!request) return fail(`No access request ${args.requestId}.`);
        const approvals = world.approvals.filter((approval) => approval.requestId === request.id);
        if (approvals.length === 0) return `No approvals recorded for ${request.id}.`;
        return [
          `${approvals.length} approval(s) for ${request.id}:`,
          ...approvals.map(
            (approval) =>
              `  ${approval.id} by ${approval.approverId} ${findUser(world, approval.approverId)?.name ?? ''} level=${approval.level} at ${approval.at}`,
          ),
        ].join('\n');
      },
    },

    // -----------------------------------------------------------------------
    // Mutations
    // -----------------------------------------------------------------------
    {
      name: 'create_incident',
      description: 'Open an incident for a service outage.',
      schema: {
        title: z.string().min(1),
        service: z.enum(['vpn', 'payroll', 'crm', 'build-pipeline']),
      },
      handler: (args: { title: string; service: ServiceId }) => {
        const incident: Incident = {
          id: `INC-${world.incidents.length + 1}`,
          title: args.title.trim(),
          service: args.service,
          createdAt: world.nowIso,
          commanderId: null,
          commsLeadId: null,
          ticketIds: [],
          updates: [],
        };
        world.incidents.push(incident);
        return `${incident.id} opened for ${incident.service} at ${incident.createdAt}.`;
      },
    },
    {
      name: 'link_to_incident',
      description: 'Link tickets to an incident.',
      schema: { incidentId: z.string(), ticketIds: z.array(z.string()).min(1) },
      handler: (args: { incidentId: string; ticketIds: string[] }) => {
        const incident = findIncident(world, args.incidentId);
        if (!incident) return fail(`No incident ${args.incidentId}.`);
        for (const id of args.ticketIds) {
          if (!findTicket(world, id)) return fail(`No ticket ${id}.`);
        }
        const added = args.ticketIds.filter((id) => !incident.ticketIds.includes(id));
        incident.ticketIds.push(...added);
        return `${incident.id} linked tickets: ${incident.ticketIds.join(', ')} (added ${added.join(', ') || 'none'}).`;
      },
    },
    {
      name: 'assign_incident_role',
      description: 'Name the commander or the communications lead of an incident.',
      schema: {
        incidentId: z.string(),
        role: z.enum(['commander', 'comms']),
        engineerId: z.string(),
      },
      handler: (args: { incidentId: string; role: 'commander' | 'comms'; engineerId: string }) => {
        const incident = findIncident(world, args.incidentId);
        if (!incident) return fail(`No incident ${args.incidentId}.`);
        const person = engineer(args.engineerId);
        if (!person) return fail(`${args.engineerId} is not an engineer.`);
        if (args.role === 'commander') incident.commanderId = person.id;
        else incident.commsLeadId = person.id;
        return `${incident.id} ${args.role} is now ${person.id} ${person.name}.`;
      },
    },
    {
      name: 'post_status_update',
      description: 'Post a status update on an incident. Published to the company status page at once.',
      schema: { incidentId: z.string(), body: z.string().min(1) },
      handler: (args: { incidentId: string; body: string }) => {
        const incident = findIncident(world, args.incidentId);
        if (!incident) return fail(`No incident ${args.incidentId}.`);
        incident.updates.push({ at: world.nowIso, body: args.body.trim() });
        return `Status update ${incident.updates.length} published on ${incident.id} at ${world.nowIso}.`;
      },
    },
    {
      name: 'page_engineer',
      description: 'Page an engineer by phone and push notification. Delivered immediately.',
      schema: {
        engineerId: z.string(),
        message: z.string().min(1),
        incidentId: z.string().optional(),
        ticketId: z.string().optional(),
      },
      handler: (args: { engineerId: string; message: string; incidentId?: string; ticketId?: string }) => {
        const person = engineer(args.engineerId);
        if (!person) return fail(`${args.engineerId} is not an engineer.`);
        if (args.incidentId && !findIncident(world, args.incidentId)) {
          return fail(`No incident ${args.incidentId}.`);
        }
        if (args.ticketId && !findTicket(world, args.ticketId)) return fail(`No ticket ${args.ticketId}.`);
        const page: Page = {
          id: `PG-${world.pages.length + 1}`,
          engineerId: person.id,
          at: world.nowIso,
          message: args.message.trim(),
          ...(args.incidentId ? { incidentId: args.incidentId } : {}),
          ...(args.ticketId ? { ticketId: args.ticketId } : {}),
        };
        world.pages.push(page);
        return `${page.id}: paged ${person.id} ${person.name} at ${page.at}.`;
      },
    },
    {
      name: 'create_ticket',
      description: 'Open a new ticket, optionally linked to an incident.',
      schema: {
        title: z.string().min(1),
        description: z.string().min(1),
        service: z.enum(['vpn', 'payroll', 'crm', 'build-pipeline']),
        impact: z.enum(['single-user', 'team', 'department', 'company-wide']),
        severity: z.enum(['sev1', 'sev2', 'sev3', 'sev4']).optional(),
        slaDueAt: z.string().optional().describe('ISO-8601 instant'),
        assignee: z.string().optional(),
        incidentId: z.string().optional(),
      },
      handler: (args: {
        title: string;
        description: string;
        service: ServiceId;
        impact: ImpactScope;
        severity?: Severity;
        slaDueAt?: string;
        assignee?: string;
        incidentId?: string;
      }) => {
        const due = args.slaDueAt === undefined ? null : parseIso(args.slaDueAt);
        if (args.slaDueAt !== undefined && due === null) {
          return fail(`slaDueAt "${args.slaDueAt}" is not an ISO-8601 instant.`);
        }
        if (args.assignee && !engineer(args.assignee)) return fail(`${args.assignee} is not an engineer.`);
        const incident = args.incidentId ? findIncident(world, args.incidentId) : undefined;
        if (args.incidentId && !incident) return fail(`No incident ${args.incidentId}.`);
        const highest = Math.max(...world.tickets.map((ticket) => Number(ticket.id.slice(2)) || 0));
        const ticket: Ticket = {
          id: `T-${highest + 1}`,
          title: args.title.trim(),
          description: args.description.trim(),
          requesterId: 'agent',
          service: args.service,
          impact: args.impact,
          severity: args.severity ?? 'unset',
          status: args.assignee ? 'open' : 'new',
          assignee: args.assignee ?? null,
          escalatedTo: null,
          createdAt: world.nowIso,
          slaDueAt: due === null ? null : canonicalIso(due),
          closedAt: null,
          mergedInto: null,
          linkedTickets: [],
          comments: [],
        };
        world.tickets.push(ticket);
        if (incident) incident.ticketIds.push(ticket.id);
        appendAudit(world, 'create_ticket', ticket.id, { title: ticket.title });
        return `${ticket.id} created: ${ticket.service} impact=${ticket.impact} severity=${ticket.severity} due=${ticket.slaDueAt ?? '-'}${incident ? `, linked to ${incident.id}` : ''}.`;
      },
    },
    {
      name: 'grant_access',
      description:
        'Grant access on a system for an access request, at the given level and with an optional expiry. Takes effect immediately.',
      schema: {
        requestId: z.string(),
        level: z.enum(['read', 'write', 'admin']),
        expiresAt: z.string().optional().describe('ISO-8601 instant; omit for access that does not expire'),
      },
      handler: (args: { requestId: string; level: AccessLevel; expiresAt?: string }) => {
        const request = findAccessRequest(world, args.requestId);
        if (!request) return fail(`No access request ${args.requestId}.`);
        if (request.status === 'granted') return fail(`${request.id} has already been granted.`);
        const expires = args.expiresAt === undefined ? null : parseIso(args.expiresAt);
        if (args.expiresAt !== undefined && expires === null) {
          return fail(`expiresAt "${args.expiresAt}" is not an ISO-8601 instant.`);
        }
        const grant: AccessGrant = {
          id: `GR-${world.grants.length + 1}`,
          requestId: request.id,
          userId: request.userId,
          system: request.system,
          level: args.level,
          grantedAt: world.nowIso,
          expiresAt: expires === null ? null : canonicalIso(expires),
        };
        world.grants.push(grant);
        request.status = 'granted';
        return `${grant.id}: ${grant.level} on ${grant.system} granted to ${grant.userId} for ${request.id}, expires ${grant.expiresAt ?? 'never'}.`;
      },
    },
    {
      name: 'comment_on_access_request',
      description: 'Add a comment to an access request, visible to the requester.',
      schema: { requestId: z.string(), body: z.string().min(1) },
      handler: (args: { requestId: string; body: string }) => {
        const request = findAccessRequest(world, args.requestId);
        if (!request) return fail(`No access request ${args.requestId}.`);
        request.comments.push({ author: 'agent', at: world.nowIso, body: args.body.trim() });
        return `Comment added to ${request.id} (${request.comments.length} total).`;
      },
    },
  ];
}

function describeIncident(incident: Incident): string {
  return [
    `${incident.id} "${incident.title}" service=${incident.service} opened=${incident.createdAt}`,
    `commander: ${incident.commanderId ?? '-'}  comms lead: ${incident.commsLeadId ?? '-'}`,
    `linked tickets: ${incident.ticketIds.join(', ') || '-'}`,
    `status updates: ${incident.updates.length}`,
  ].join('\n');
}
