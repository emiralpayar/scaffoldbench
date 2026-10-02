import { z } from 'zod';
import type { JournaledToolSpec, ToolReply } from '@arena/core';
import {
  appendAudit,
  canonicalIso,
  findTicket,
  findUser,
  impactRank,
  onCallAt,
  parseIso,
  rotationNames,
  rotationsFor,
  type ServiceId,
  type SupportWorld,
  type Ticket,
} from './world';

const SERVICES: ServiceId[] = ['vpn', 'payroll', 'crm', 'build-pipeline'];

function fail(text: string): ToolReply {
  return { text, isError: true };
}

function userLabel(world: SupportWorld, id: string | null): string {
  if (!id) return '-';
  const user = findUser(world, id);
  return user ? `${user.id} ${user.name}` : `${id} (unknown user)`;
}

function ticketLine(ticket: Ticket): string {
  return [
    ticket.id,
    ticket.service,
    `impact=${ticket.impact}`,
    `severity=${ticket.severity}`,
    `status=${ticket.status}`,
    `assignee=${ticket.assignee ?? '-'}`,
    `due=${ticket.slaDueAt ?? '-'}`,
    `"${ticket.title}"`,
  ].join(' | ');
}

function ticketDetail(world: SupportWorld, ticket: Ticket): string {
  const requester = findUser(world, ticket.requesterId);
  const links = ticket.linkedTickets.length
    ? ticket.linkedTickets
        .map((id) => {
          const linked = findTicket(world, id);
          return linked ? `${id} (status=${linked.status})` : `${id} (missing)`;
        })
        .join(', ')
    : '-';

  const lines = [
    `${ticket.id} | ${ticket.service} | impact=${ticket.impact} | severity=${ticket.severity} | status=${ticket.status}`,
    `title: ${ticket.title}`,
    `requester: ${userLabel(world, ticket.requesterId)}${
      requester ? ` (${requester.department}, ${requester.seniority})` : ''
    }`,
    `assignee: ${userLabel(world, ticket.assignee)}`,
    `escalated_to: ${userLabel(world, ticket.escalatedTo)}`,
    `created_at: ${ticket.createdAt}`,
    `sla_due_at: ${ticket.slaDueAt ?? '- (not set)'}`,
    `closed_at: ${ticket.closedAt ?? '-'}`,
    `merged_into: ${ticket.mergedInto ?? '-'}`,
    `linked_tickets: ${links}`,
    `description: ${ticket.description}`,
    `comments (${ticket.comments.length}):`,
  ];

  for (const comment of ticket.comments) {
    lines.push(`  [${comment.at}] ${comment.author}: ${comment.body}`);
  }
  if (ticket.comments.length === 0) lines.push('  (none)');

  return lines.join('\n');
}

export function createSupportTools(world: SupportWorld): JournaledToolSpec[] {
  // -------------------------------------------------------------------------
  // Read-only
  // -------------------------------------------------------------------------

  const getCurrentTime: JournaledToolSpec = {
    name: 'get_current_time',
    description:
      'Current service desk time as an ISO-8601 UTC instant. Use this instead of assuming what time it is.',
    schema: {},
    readOnly: true,
    handler: () => `current_time: ${world.nowIso}`,
  };

  const getTicket: JournaledToolSpec = {
    name: 'get_ticket',
    description: 'Full detail for one ticket, including impact scope, SLA deadline, links and comments.',
    schema: { id: z.string().describe('Ticket id, e.g. T-1052') },
    readOnly: true,
    handler: (args: { id: string }) => {
      const ticket = findTicket(world, args.id);
      if (!ticket) return fail(`No ticket ${String(args.id)}. Use list_tickets to see what exists.`);
      return ticketDetail(world, ticket);
    },
  };

  const listTickets: JournaledToolSpec = {
    name: 'list_tickets',
    description:
      'List tickets, optionally filtered by status, service or assignee. Returns one compact line per ticket.',
    schema: {
      status: z
        .enum(['new', 'open', 'escalated', 'merged', 'closed'])
        .optional()
        .describe('Only tickets in this status'),
      service: z.enum(['vpn', 'payroll', 'crm', 'build-pipeline']).optional(),
      assignee: z.string().optional().describe('Engineer id, or "unassigned"'),
    },
    readOnly: true,
    handler: (args: { status?: string; service?: string; assignee?: string }) => {
      const matches = world.tickets.filter((ticket) => {
        if (args.status && ticket.status !== args.status) return false;
        if (args.service && ticket.service !== args.service) return false;
        if (args.assignee === 'unassigned' && ticket.assignee !== null) return false;
        if (args.assignee && args.assignee !== 'unassigned' && ticket.assignee !== args.assignee) {
          return false;
        }
        return true;
      });

      if (matches.length === 0) return 'No tickets match that filter.';
      return [`${matches.length} ticket(s):`, ...matches.map(ticketLine)].join('\n');
    },
  };

  const getUser: JournaledToolSpec = {
    name: 'get_user',
    description: 'Look up a requester or engineer: department, seniority and on-call rotations.',
    schema: { id: z.string().describe('User id, e.g. U-501 or E-301') },
    readOnly: true,
    handler: (args: { id: string }) => {
      const user = findUser(world, args.id);
      if (!user) return fail(`No user ${String(args.id)}.`);
      const rotations = rotationsFor(world, user.id);
      return [
        `${user.id} ${user.name}`,
        `department: ${user.department}`,
        `seniority: ${user.seniority}`,
        `role: ${user.role}`,
        ...(user.employment ? [`employment: ${user.employment}`] : []),
        ...(user.contractEndsOn ? [`contract ends: ${user.contractEndsOn}`] : []),
        ...(user.managerId ? [`manager: ${userLabel(world, user.managerId)}`] : []),
        `rotations: ${rotations.length ? rotations.join(', ') : '-'}`,
      ].join('\n');
    },
  };

  const getOncall: JournaledToolSpec = {
    name: 'get_oncall',
    description:
      'Who is on call for a rotation at a given instant. `at` defaults to the current time.',
    schema: {
      rotation: z.string().describe('Rotation name, e.g. network-primary or incident-command'),
      at: z.string().optional().describe('ISO-8601 UTC instant, e.g. 2026-03-17T19:40:00Z'),
    },
    readOnly: true,
    handler: (args: { rotation: string; at?: string }) => {
      const known = rotationNames(world);
      if (!known.includes(args.rotation)) {
        return fail(`No rotation "${String(args.rotation)}". Known rotations: ${known.join(', ')}.`);
      }

      const atIso = args.at ?? world.nowIso;
      if (parseIso(atIso) === null) {
        return fail(`"${String(args.at)}" is not an ISO-8601 instant, e.g. 2026-03-17T19:40:00Z.`);
      }

      const shift = onCallAt(world, args.rotation, atIso);
      if (!shift) {
        return fail(`No published shift for ${args.rotation} covering ${atIso}.`);
      }

      const engineer = findUser(world, shift.engineerId);
      return [
        `rotation: ${shift.rotation}`,
        `at: ${atIso}${args.at ? '' : ' (current time)'}`,
        `on_call: ${shift.engineerId} ${engineer?.name ?? ''}`.trim(),
        `shift: ${shift.startsAt} .. ${shift.endsAt}`,
      ].join('\n');
    },
  };

  const searchKb: JournaledToolSpec = {
    name: 'search_kb',
    description: 'Keyword search over the knowledge base. Returns matching articles in full.',
    schema: { query: z.string().describe('Free-text query, e.g. "crm search 500"') },
    readOnly: true,
    handler: (args: { query: string }) => {
      const terms = String(args.query ?? '')
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((term) => term.length > 1);
      if (terms.length === 0) return fail('Give at least one search term of two or more characters.');

      const scored = world.kb
        .map((article) => {
          const haystack = `${article.title} ${article.tags.join(' ')} ${article.body}`.toLowerCase();
          const score = terms.filter((term) => haystack.includes(term)).length;
          return { article, score };
        })
        .filter((entry) => entry.score > 0)
        .sort((a, b) => b.score - a.score || a.article.id.localeCompare(b.article.id))
        .slice(0, 3);

      if (scored.length === 0) return `No articles matched "${args.query}".`;

      return scored
        .map((entry) =>
          [
            `${entry.article.id} - ${entry.article.title}`,
            `tags: ${entry.article.tags.join(', ')}`,
            ...(entry.article.supersededBy
              ? [`status: superseded by ${entry.article.supersededBy}`]
              : []),
            entry.article.body,
          ].join('\n'),
        )
        .join('\n\n');
    },
  };

  const getEscalationMatrix: JournaledToolSpec = {
    name: 'get_escalation_matrix',
    description:
      'The severity matrix (severity per service and impact scope), which rotation owns each service, and the response target and escalation rotation per severity.',
    schema: {
      service: z
        .enum(['vpn', 'payroll', 'crm', 'build-pipeline'])
        .optional()
        .describe('Restrict the severity table to one service'),
    },
    readOnly: true,
    handler: (args: { service?: string }) => {
      if (args.service && !SERVICES.includes(args.service as ServiceId)) {
        return fail(`No service "${String(args.service)}". Known services: ${SERVICES.join(', ')}.`);
      }

      const services = args.service ? [args.service as ServiceId] : SERVICES;
      const lines = ['ESCALATION MATRIX', '', 'Severity by service and impact scope:'];

      for (const service of services) {
        const cells = world.severityMatrix
          .filter((rule) => rule.service === service)
          .map((rule) => `${rule.impact}=${rule.severity}`);
        lines.push(`  ${service} | ${cells.join(' | ')}`);
      }

      lines.push('', 'Rotation that owns each service:');
      for (const owner of world.serviceOwners) {
        if (!services.includes(owner.service)) continue;
        lines.push(`  ${owner.service} -> ${owner.rotation}`);
      }

      lines.push('', 'Response target and escalation routing by severity:');
      for (const row of world.severityPolicy) {
        const escalation = row.escalationRotation
          ? `escalates to rotation ${row.escalationRotation}`
          : 'no escalation rotation - raise the severity first';
        lines.push(`  ${row.severity} | response ${row.responseMinutes} min | ${escalation}`);
      }

      return lines.join('\n');
    },
  };

  // -------------------------------------------------------------------------
  // Mutating
  // -------------------------------------------------------------------------

  /** Shared guard: the ticket must exist and still be workable. */
  function workable(id: unknown, action: string): Ticket | ToolReply {
    const ticket = findTicket(world, id);
    if (!ticket) return fail(`No ticket ${String(id)}.`);
    if (ticket.status === 'closed') return fail(`${ticket.id} is closed and cannot be ${action}.`);
    if (ticket.status === 'merged') {
      return fail(`${ticket.id} was merged into ${ticket.mergedInto}; work that ticket instead.`);
    }
    return ticket;
  }

  function isTicket(value: Ticket | ToolReply): value is Ticket {
    return typeof value === 'object' && value !== null && 'id' in value;
  }

  const assignTicket: JournaledToolSpec = {
    name: 'assign_ticket',
    description: 'Assign a ticket to an on-call engineer. A ticket in status new becomes open.',
    schema: {
      ticketId: z.string(),
      engineerId: z.string().describe('Engineer id, e.g. E-301'),
    },
    handler: (args: { ticketId: string; engineerId: string }) => {
      const found = workable(args.ticketId, 'assigned');
      if (!isTicket(found)) return found;

      const engineer = findUser(world, args.engineerId);
      if (!engineer) return fail(`No user ${String(args.engineerId)}.`);
      if (engineer.role !== 'engineer') {
        return fail(`${engineer.id} ${engineer.name} is a requester, not an engineer.`);
      }

      const previous = found.assignee;
      found.assignee = engineer.id;
      if (found.status === 'new') found.status = 'open';
      appendAudit(world, 'assign_ticket', found.id, { from: previous, to: engineer.id });

      return `${found.id} assigned to ${engineer.id} ${engineer.name} (was ${previous ?? 'unassigned'}). status=${found.status}`;
    },
  };

  const setSeverity: JournaledToolSpec = {
    name: 'set_severity',
    description:
      'Set a ticket severity. The value must come from the escalation matrix, not from judgement.',
    schema: {
      ticketId: z.string(),
      severity: z.enum(['sev1', 'sev2', 'sev3', 'sev4']),
    },
    handler: (args: { ticketId: string; severity: 'sev1' | 'sev2' | 'sev3' | 'sev4' }) => {
      const found = workable(args.ticketId, 're-graded');
      if (!isTicket(found)) return found;

      const previous = found.severity;
      found.severity = args.severity;
      appendAudit(world, 'set_severity', found.id, { from: previous, to: args.severity });

      return `${found.id} severity ${previous} -> ${args.severity}.`;
    },
  };

  const escalateTicket: JournaledToolSpec = {
    name: 'escalate_ticket',
    description:
      'Escalate a ticket to a named engineer. The engineer takes over as assignee and the ticket moves to status escalated.',
    schema: {
      ticketId: z.string(),
      engineerId: z.string(),
      reason: z.string().describe('Why this ticket is being escalated, and to whom, in one sentence'),
    },
    handler: (args: { ticketId: string; engineerId: string; reason: string }) => {
      const found = workable(args.ticketId, 'escalated');
      if (!isTicket(found)) return found;

      const engineer = findUser(world, args.engineerId);
      if (!engineer) return fail(`No user ${String(args.engineerId)}.`);
      if (engineer.role !== 'engineer') {
        return fail(`${engineer.id} ${engineer.name} is a requester and cannot take an escalation.`);
      }
      if (typeof args.reason !== 'string' || args.reason.trim() === '') {
        return fail('An escalation needs a reason.');
      }

      found.escalatedTo = engineer.id;
      found.assignee = engineer.id;
      found.status = 'escalated';
      found.comments.push({
        author: 'agent',
        at: world.nowIso,
        body: `Escalated to ${engineer.id}: ${args.reason.trim()}`,
      });
      appendAudit(world, 'escalate_ticket', found.id, {
        to: engineer.id,
        reason: args.reason.trim(),
      });

      return `${found.id} escalated to ${engineer.id} ${engineer.name}. status=escalated, sla_due_at=${found.slaDueAt ?? 'not set'}`;
    },
  };

  const mergeTickets: JournaledToolSpec = {
    name: 'merge_tickets',
    description:
      'Merge duplicate tickets into a survivor. The duplicates move to status merged, their links move to the survivor, every other ticket pointing at a duplicate is re-pointed at the survivor, and the survivor inherits the broadest impact scope of the set. You choose the survivor and the SLA deadline it carries; neither is inferred for you.',
    schema: {
      survivorId: z.string().describe('Ticket that stays open'),
      duplicateIds: z.array(z.string()).min(1).describe('Tickets to fold into the survivor'),
      slaDueAt: z.string().describe('ISO-8601 deadline the survivor carries after the merge'),
    },
    handler: (args: { survivorId: string; duplicateIds: string[]; slaDueAt: string }) => {
      const survivor = findTicket(world, args.survivorId);
      if (!survivor) return fail(`No ticket ${String(args.survivorId)}.`);
      if (survivor.status === 'closed' || survivor.status === 'merged') {
        return fail(`${survivor.id} is ${survivor.status} and cannot be a merge survivor.`);
      }

      const ids = Array.isArray(args.duplicateIds) ? args.duplicateIds : [];
      if (ids.length === 0) return fail('duplicateIds must list at least one ticket.');
      if (ids.includes(survivor.id)) {
        return fail(`${survivor.id} is the survivor and cannot also be listed as a duplicate.`);
      }

      const duplicates: Ticket[] = [];
      for (const id of ids) {
        const duplicate = findTicket(world, id);
        if (!duplicate) return fail(`No ticket ${String(id)}.`);
        if (duplicate.status === 'closed' || duplicate.status === 'merged') {
          return fail(`${duplicate.id} is already ${duplicate.status} and cannot be merged.`);
        }
        if (!duplicates.some((entry) => entry.id === duplicate.id)) duplicates.push(duplicate);
      }

      const dueMs = parseIso(args.slaDueAt);
      if (dueMs === null) {
        return fail(`slaDueAt "${String(args.slaDueAt)}" is not an ISO-8601 instant.`);
      }

      const mergedIds = new Set(duplicates.map((duplicate) => duplicate.id));
      survivor.linkedTickets = survivor.linkedTickets.filter((id) => !mergedIds.has(id));

      for (const duplicate of duplicates) {
        for (const linkedId of duplicate.linkedTickets) {
          if (linkedId === survivor.id || mergedIds.has(linkedId)) continue;
          if (!survivor.linkedTickets.includes(linkedId)) survivor.linkedTickets.push(linkedId);
        }
        duplicate.linkedTickets = [];
        duplicate.status = 'merged';
        duplicate.mergedInto = survivor.id;
        if (impactRank(duplicate.impact) > impactRank(survivor.impact)) {
          survivor.impact = duplicate.impact;
        }
      }

      for (const ticket of world.tickets) {
        if (ticket.id === survivor.id || mergedIds.has(ticket.id)) continue;
        if (!ticket.linkedTickets.some((id) => mergedIds.has(id))) continue;
        const next = ticket.linkedTickets.filter((id) => !mergedIds.has(id));
        if (!next.includes(survivor.id)) next.push(survivor.id);
        ticket.linkedTickets = next;
      }

      const previousDue = survivor.slaDueAt;
      survivor.slaDueAt = canonicalIso(dueMs);
      appendAudit(world, 'merge_tickets', survivor.id, {
        merged: [...mergedIds],
        slaDueAt: survivor.slaDueAt,
        previousSlaDueAt: previousDue,
        impact: survivor.impact,
      });

      return [
        `Merged ${[...mergedIds].join(', ')} into ${survivor.id}.`,
        `${survivor.id}: impact=${survivor.impact}, severity=${survivor.severity}, sla_due_at=${survivor.slaDueAt} (was ${previousDue ?? 'not set'})`,
        `linked_tickets: ${survivor.linkedTickets.length ? survivor.linkedTickets.join(', ') : '-'}`,
      ].join('\n');
    },
  };

  const closeTicket: JournaledToolSpec = {
    name: 'close_ticket',
    description: 'Close a ticket with a resolution note.',
    schema: {
      ticketId: z.string(),
      resolution: z.string().describe('What resolved the ticket'),
    },
    handler: (args: { ticketId: string; resolution: string }) => {
      const ticket = findTicket(world, args.ticketId);
      if (!ticket) return fail(`No ticket ${String(args.ticketId)}.`);
      if (ticket.status === 'closed') return fail(`${ticket.id} is already closed.`);
      if (ticket.status === 'merged') {
        return fail(`${ticket.id} was merged into ${ticket.mergedInto} and cannot be closed on its own.`);
      }
      if (typeof args.resolution !== 'string' || args.resolution.trim() === '') {
        return fail('A resolution note is required to close a ticket.');
      }

      ticket.status = 'closed';
      ticket.closedAt = world.nowIso;
      ticket.comments.push({ author: 'agent', at: world.nowIso, body: `Closed: ${args.resolution.trim()}` });
      appendAudit(world, 'close_ticket', ticket.id, { resolution: args.resolution.trim() });

      const openLinks = ticket.linkedTickets.filter((id) => {
        const linked = findTicket(world, id);
        return linked !== undefined && linked.status !== 'closed' && linked.status !== 'merged';
      });

      const lines = [`${ticket.id} closed at ${ticket.closedAt}.`];
      if (openLinks.length > 0) {
        lines.push(`Linked tickets still open: ${openLinks.join(', ')}.`);
      }
      return lines.join('\n');
    },
  };

  const postComment: JournaledToolSpec = {
    name: 'post_comment',
    description: 'Add a comment to a ticket. Use it to record what you did and anything you could not do.',
    schema: {
      ticketId: z.string(),
      body: z.string(),
    },
    handler: (args: { ticketId: string; body: string }) => {
      const ticket = findTicket(world, args.ticketId);
      if (!ticket) return fail(`No ticket ${String(args.ticketId)}.`);
      if (typeof args.body !== 'string' || args.body.trim() === '') {
        return fail('A comment needs a body.');
      }

      ticket.comments.push({ author: 'agent', at: world.nowIso, body: args.body.trim() });
      appendAudit(world, 'post_comment', ticket.id, { body: args.body.trim() });
      return `Comment added to ${ticket.id} (${ticket.comments.length} total).`;
    },
  };

  const extendSla: JournaledToolSpec = {
    name: 'extend_sla',
    description: 'Set or change the SLA deadline of a ticket.',
    schema: {
      ticketId: z.string(),
      dueAt: z.string().describe('ISO-8601 instant, e.g. 2026-03-17T17:20:00Z'),
      reason: z.string(),
    },
    handler: (args: { ticketId: string; dueAt: string; reason: string }) => {
      const found = workable(args.ticketId, 'rescheduled');
      if (!isTicket(found)) return found;

      const dueMs = parseIso(args.dueAt);
      if (dueMs === null) return fail(`dueAt "${String(args.dueAt)}" is not an ISO-8601 instant.`);
      if (typeof args.reason !== 'string' || args.reason.trim() === '') {
        return fail('Changing an SLA deadline needs a reason.');
      }

      // Moving a deadline earlier is a policy question, not an API one: the
      // tool records it and the scorer decides whether it was allowed.
      const previous = found.slaDueAt;
      found.slaDueAt = canonicalIso(dueMs);
      appendAudit(world, 'extend_sla', found.id, {
        from: previous,
        to: found.slaDueAt,
        reason: args.reason.trim(),
      });

      return `${found.id} sla_due_at ${previous ?? 'not set'} -> ${found.slaDueAt}.`;
    },
  };

  return [
    getCurrentTime,
    getTicket,
    listTickets,
    getUser,
    getOncall,
    searchKb,
    getEscalationMatrix,
    assignTicket,
    setSeverity,
    escalateTicket,
    mergeTickets,
    closeTicket,
    postComment,
    extendSla,
  ];
}
