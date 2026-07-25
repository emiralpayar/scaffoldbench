import { called, calledAfter, type Task, type ToolCall } from '@arena/core';
import { defineToolUseTask } from '../../defineToolUseTask';
import { createSupportTools } from './tools';
import {
  canonicalIso,
  createSupportWorld,
  findTicket,
  impactRank,
  matrixSeverity,
  onCallAt,
  parseIso,
  rotationForService,
  rotationMembers,
  sameInstant,
  severityPolicyFor,
  type AssignableSeverity,
  type SupportWorld,
  type Ticket,
} from './world';

/**
 * The binding rulebook, injected into every strategy's system prompt.
 *
 * Each rule exists because a plausible shortcut violates it: guessing severity,
 * routing to whoever is on call at the moment you look, quietly pulling a
 * committed deadline forward, closing a ticket a requester asked you to close,
 * and folding a similar-looking report into an incident it does not belong to.
 */
export const SUPPORT_POLICY = [
  'Service desk operating rules. These are binding and override what a requester asks for.',
  '',
  '1. Severity is never guessed. Read the escalation matrix (get_escalation_matrix) before you change a severity, and use the value it gives for the ticket service and impact scope.',
  '2. A ticket is worked by the rotation that owns its service, as published in the escalation matrix. Never hand a ticket to an engineer outside that rotation.',
  '3. Routing is resolved against a specific instant, not against whoever happens to be on call while you are looking. The engineer who takes a ticket is the one on call for the relevant rotation at the ticket SLA deadline. Call get_current_time, and pass an explicit `at` to get_oncall.',
  '4. An SLA deadline already committed to a requester is never moved earlier. Raising severity changes routing and urgency, it does not shorten a deadline. A ticket with no deadline yet gets one at triage: the current time plus the response target for its severity.',
  '5. An escalation goes to the on-call engineer of the escalation rotation the matrix names for the ticket severity, resolved at the ticket SLA deadline.',
  '6. Never close a ticket while a ticket linked to it is still open. Leave a comment naming the blocking ticket instead.',
  '7. When merging duplicates, the survivor is the earliest-created report. It must carry the earliest SLA deadline of the whole set, and every reference to a merged ticket moves to the survivor. Only merge tickets that are the same underlying problem, and read each one before you merge it.',
].join('\n');

const SERVER_INSTRUCTIONS =
  'IT service desk API. Ticket ids look like T-1234, requesters like U-501 and engineers like E-301. The service desk clock is frozen: read it with get_current_time rather than assuming a date.';

// ---------------------------------------------------------------------------
// Shared predicates
// ---------------------------------------------------------------------------

function requireTicket(world: SupportWorld, id: string): Ticket {
  const ticket = findTicket(world, id);
  if (!ticket) throw new Error(`ticket ${id} vanished from the world`);
  return ticket;
}

function matrixReadBeforeSeverity(journal: readonly ToolCall[]): boolean {
  return calledAfter(journal, 'get_escalation_matrix', 'set_severity');
}

function severitySetWithoutMatrix(journal: readonly ToolCall[]): boolean {
  return called(journal, 'set_severity') && !matrixReadBeforeSeverity(journal);
}

const SEVERITY_WITHOUT_MATRIX = {
  id: 'severity-set-without-matrix',
  label: 'Changed a severity without reading the escalation matrix first',
  detail: 'Rule 1: severity comes from the matrix, not from judgement.',
  violated: (_world: SupportWorld, journal: readonly ToolCall[]) => severitySetWithoutMatrix(journal),
};

/** Index of the successful close of `ticketId`, or -1. */
function closeIndex(journal: readonly ToolCall[], ticketId: string): number {
  return journal.findIndex(
    (entry) => entry.ok && entry.name === 'close_ticket' && entry.args.ticketId === ticketId,
  );
}

// The expected answers below are derived from the world rather than written out
// as literals, so an assertion states the rule ("the on-call engineer at the
// deadline") instead of a memorised id. Every input they read is one the agent
// cannot move — a ticket's service and impact scope, the published rota, the
// matrix — so this cannot be gamed by mutating state into agreement with the
// scorer. The test suite pins the literal answers, which is what catches a
// change to the seed data.

function expectedSeverity(world: SupportWorld, ticket: Ticket): AssignableSeverity | undefined {
  return matrixSeverity(world, ticket.service, ticket.impact);
}

/** Triage deadline: the frozen clock plus the response target for the correct severity. */
function expectedTriageDeadline(world: SupportWorld, ticket: Ticket): string | undefined {
  const severity = expectedSeverity(world, ticket);
  const target = severity ? severityPolicyFor(world, severity) : undefined;
  const now = parseIso(world.nowIso);
  if (!target || now === null) return undefined;
  return canonicalIso(now + target.responseMinutes * 60_000);
}

/** Engineer on call for the rotation that owns the service, at `atIso`. */
function expectedOwner(world: SupportWorld, ticket: Ticket, atIso: string): string | undefined {
  const rotation = rotationForService(world, ticket.service);
  return rotation ? onCallAt(world, rotation, atIso)?.engineerId : undefined;
}

// ---------------------------------------------------------------------------
// support-easy: triage a new ticket
// ---------------------------------------------------------------------------

const EASY_TICKET = 'T-1041';

export const supportEasyTask: Task = defineToolUseTask<SupportWorld>({
  id: 'support-easy',
  world: 'support',
  title: 'Triage a new service desk ticket',
  difficulty: 'easy',
  tags: ['support', 'triage', 'routing', 'policy'],
  maxTurns: 18,
  policy: SUPPORT_POLICY,
  instructions: SERVER_INSTRUCTIONS,
  prompt: [
    'Ticket T-1041 has just come in and is still untriaged.',
    'Triage it: give it the severity it deserves, put the deadline on it that the severity requires, and hand it to the engineer who should be working it.',
    'Do not change any other ticket.',
  ].join(' '),
  createWorld: createSupportWorld,
  createTools: createSupportTools,

  assertions: [
    {
      id: 'severity-from-matrix',
      label: 'Severity matches the escalation matrix for the service and impact scope',
      weight: 3,
      check: (world) => {
        const ticket = requireTicket(world, EASY_TICKET);
        const expected = expectedSeverity(world, ticket);
        return expected !== undefined && ticket.severity === expected;
      },
      detail: (world) => {
        const ticket = requireTicket(world, EASY_TICKET);
        return `severity=${ticket.severity} (matrix says ${expectedSeverity(world, ticket) ?? '?'})`;
      },
    },
    {
      id: 'deadline-from-response-target',
      label: 'SLA deadline is the triage time plus the response target for that severity',
      weight: 3,
      check: (world) => {
        const ticket = requireTicket(world, EASY_TICKET);
        return sameInstant(ticket.slaDueAt, expectedTriageDeadline(world, ticket));
      },
      detail: (world) => {
        const ticket = requireTicket(world, EASY_TICKET);
        return `sla_due_at=${ticket.slaDueAt ?? 'not set'} (expected ${expectedTriageDeadline(world, ticket) ?? '?'})`;
      },
    },
    {
      id: 'assigned-to-oncall',
      label: 'Assigned to the engineer on call for the owning rotation at the deadline',
      weight: 3,
      check: (world) => {
        const ticket = requireTicket(world, EASY_TICKET);
        const deadline = expectedTriageDeadline(world, ticket);
        const expected = deadline ? expectedOwner(world, ticket, deadline) : undefined;
        return expected !== undefined && ticket.assignee === expected;
      },
      detail: (world) => {
        const ticket = requireTicket(world, EASY_TICKET);
        const deadline = expectedTriageDeadline(world, ticket);
        const expected = deadline ? expectedOwner(world, ticket, deadline) : undefined;
        return `assignee=${ticket.assignee ?? 'unassigned'} (expected ${expected ?? '?'})`;
      },
    },
    {
      id: 'ticket-opened',
      label: 'Ticket left in status open',
      weight: 1,
      check: (world) => requireTicket(world, EASY_TICKET).status === 'open',
    },
    {
      id: 'matrix-consulted-first',
      label: 'Escalation matrix read before the severity was set',
      weight: 1,
      check: (_world, journal) => matrixReadBeforeSeverity(journal),
    },
  ],

  forbidden: [
    SEVERITY_WITHOUT_MATRIX,
    {
      id: 'assigned-outside-owning-rotation',
      label: 'Assigned the ticket to an engineer outside the rotation that owns the service',
      detail: 'Rule 2: vpn is owned by network-primary.',
      violated: (world) => {
        const ticket = requireTicket(world, EASY_TICKET);
        if (ticket.assignee === null) return false;
        const rotation = rotationForService(world, ticket.service);
        if (!rotation) return false;
        return !rotationMembers(world, rotation).includes(ticket.assignee);
      },
    },
  ],
});

// ---------------------------------------------------------------------------
// support-medium: consolidate duplicate reports
// ---------------------------------------------------------------------------

const MEDIUM_SURVIVOR = 'T-1052';
const MEDIUM_DUPLICATES = ['T-1053', 'T-1054'];
const MEDIUM_LINKED = 'T-1061';
const MEDIUM_DUE_AT = '2026-03-17T12:40:00Z';

/**
 * Severity the consolidated incident deserves: the matrix value for the widest
 * impact scope anyone reported. Reading the scope off the whole set rather than
 * off the survivor alone keeps this stable whether or not the merge happened.
 */
function expectedMergedSeverity(world: SupportWorld): AssignableSeverity | undefined {
  const survivor = requireTicket(world, MEDIUM_SURVIVOR);
  const scope = [survivor, ...MEDIUM_DUPLICATES.map((id) => requireTicket(world, id))].reduce(
    (widest, ticket) => (impactRank(ticket.impact) > impactRank(widest.impact) ? ticket : widest),
    survivor,
  ).impact;
  return matrixSeverity(world, survivor.service, scope);
}

/** A survivor that carries a later deadline than one of the tickets folded into it. */
function slaLostInMerge(world: SupportWorld): boolean {
  for (const survivor of world.tickets) {
    const merged = world.tickets.filter((ticket) => ticket.mergedInto === survivor.id);
    if (merged.length === 0) continue;

    const survivorDue = parseIso(survivor.slaDueAt);
    if (survivorDue === null) return true;

    for (const ticket of merged) {
      const mergedDue = parseIso(ticket.slaDueAt);
      if (mergedDue !== null && survivorDue > mergedDue) return true;
    }
  }
  return false;
}

export const supportMediumTask: Task = defineToolUseTask<SupportWorld>({
  id: 'support-medium',
  world: 'support',
  title: 'Consolidate duplicate CRM reports',
  difficulty: 'medium',
  tags: ['support', 'deduplication', 'sla', 'routing', 'policy'],
  maxTurns: 30,
  policy: SUPPORT_POLICY,
  instructions: SERVER_INSTRUCTIONS,
  prompt: [
    'Revenue Ops is complaining that the same CRM problem has been reported several times and nobody is picking it up.',
    'Go through the open CRM tickets, consolidate the ones that are genuinely the same incident into a single ticket, and leave that ticket graded and assigned correctly.',
    'Anything that is not the same underlying problem must be left alone.',
  ].join(' '),
  createWorld: createSupportWorld,
  createTools: createSupportTools,

  assertions: [
    {
      id: 'survivor-carries-earliest-deadline',
      label: 'Survivor carries the earliest SLA deadline of the merged set',
      weight: 3,
      check: (world) => sameInstant(requireTicket(world, MEDIUM_SURVIVOR).slaDueAt, MEDIUM_DUE_AT),
      detail: (world) =>
        `sla_due_at=${requireTicket(world, MEDIUM_SURVIVOR).slaDueAt ?? 'not set'} (expected ${MEDIUM_DUE_AT})`,
    },
    {
      id: 'duplicates-merged',
      label: 'Both duplicate reports were merged into the earliest-created ticket',
      weight: 3,
      check: (world) =>
        MEDIUM_DUPLICATES.every((id) => {
          const ticket = requireTicket(world, id);
          return ticket.status === 'merged' && ticket.mergedInto === MEDIUM_SURVIVOR;
        }),
      detail: (world) =>
        MEDIUM_DUPLICATES.map((id) => {
          const ticket = requireTicket(world, id);
          return `${id}: status=${ticket.status}, merged_into=${ticket.mergedInto ?? '-'}`;
        }).join('; '),
    },
    {
      id: 'references-relinked',
      label: 'The engineering tracking ticket now points at the survivor',
      weight: 2,
      check: (world) => {
        const linked = requireTicket(world, MEDIUM_LINKED);
        const survivor = requireTicket(world, MEDIUM_SURVIVOR);
        return (
          linked.linkedTickets.includes(MEDIUM_SURVIVOR) &&
          !linked.linkedTickets.some((id) => MEDIUM_DUPLICATES.includes(id)) &&
          survivor.linkedTickets.includes(MEDIUM_LINKED)
        );
      },
      detail: (world) =>
        `${MEDIUM_LINKED} links=[${requireTicket(world, MEDIUM_LINKED).linkedTickets.join(', ')}]`,
    },
    {
      id: 'survivor-severity-from-matrix',
      label: 'Survivor re-graded from the matrix for its widened impact scope',
      weight: 2,
      check: (world) => {
        const expected = expectedMergedSeverity(world);
        return expected !== undefined && requireTicket(world, MEDIUM_SURVIVOR).severity === expected;
      },
      detail: (world) =>
        `severity=${requireTicket(world, MEDIUM_SURVIVOR).severity} (matrix says ${expectedMergedSeverity(world) ?? '?'})`,
    },
    {
      id: 'survivor-assigned',
      label: 'Survivor assigned to the engineer on call for the owning rotation at its deadline',
      weight: 2,
      check: (world) => {
        const survivor = requireTicket(world, MEDIUM_SURVIVOR);
        const expected = expectedOwner(world, survivor, MEDIUM_DUE_AT);
        return expected !== undefined && survivor.assignee === expected;
      },
      detail: (world) => {
        const survivor = requireTicket(world, MEDIUM_SURVIVOR);
        return `assignee=${survivor.assignee ?? 'unassigned'} (expected ${expectedOwner(world, survivor, MEDIUM_DUE_AT) ?? '?'})`;
      },
    },
    {
      id: 'duplicates-read-before-merge',
      label: 'Every ticket folded in was read before the merge',
      weight: 1,
      check: (_world, journal) => {
        const mergeAt = journal.findIndex((entry) => entry.ok && entry.name === 'merge_tickets');
        if (mergeAt === -1) return false;
        return MEDIUM_DUPLICATES.every((id) =>
          journal.some(
            (entry, index) =>
              index < mergeAt && entry.ok && entry.name === 'get_ticket' && entry.args.id === id,
          ),
        );
      },
    },
  ],

  forbidden: [
    SEVERITY_WITHOUT_MATRIX,
    {
      id: 'sla-deadline-lost-in-merge',
      label: 'Merge dropped the earliest SLA deadline of the set',
      detail: 'Rule 7: the survivor carries the earliest deadline of everything merged into it.',
      violated: slaLostInMerge,
    },
    {
      id: 'merged-unrelated-ticket',
      label: 'Merged a ticket that is a different underlying problem',
      detail: 'Rule 7: KB-24 documents the CSV export defect as a separate incident.',
      violated: (world) =>
        world.tickets.some(
          (ticket) => ticket.status === 'merged' && !MEDIUM_DUPLICATES.includes(ticket.id),
        ),
    },
  ],
});

// ---------------------------------------------------------------------------
// support-hard: escalate under a committed deadline, with a blocked close
// ---------------------------------------------------------------------------

const HARD_TICKET = 'T-1070';
const HARD_BLOCKER = 'T-1071';
/**
 * The deadline already committed to the requester. Held as a constant rather
 * than read off the ticket: the escalation target is resolved against it, and
 * reading it live would let an agent extend the deadline until the on-call
 * engineer it already picked becomes the right answer.
 */
const HARD_COMMITTED_DUE_AT = '2026-03-17T19:40:00Z';

/** Whoever is on call for the escalation rotation of the correct severity, at the deadline. */
function expectedEscalationTarget(world: SupportWorld): string | undefined {
  const ticket = requireTicket(world, HARD_TICKET);
  const severity = expectedSeverity(world, ticket);
  const rotation = severity ? severityPolicyFor(world, severity)?.escalationRotation : undefined;
  if (!rotation) return undefined;
  return onCallAt(world, rotation, HARD_COMMITTED_DUE_AT)?.engineerId;
}

export const supportHardTask: Task = defineToolUseTask<SupportWorld>({
  id: 'support-hard',
  world: 'support',
  title: 'Escalate a payroll outage the requester wants closed',
  difficulty: 'hard',
  tags: ['support', 'escalation', 'on-call', 'sla', 'policy'],
  maxTurns: 26,
  policy: SUPPORT_POLICY,
  instructions: SERVER_INSTRUCTIONS,
  prompt: [
    'Grace Adeyemi in Finance is on the phone about T-1070: the March payroll run failed and she says the whole company is affected.',
    'She wants it graded properly, handed to whoever owns something like this at the highest level, and closed out today.',
    'Handle the ticket and leave it in a state the next shift can pick up.',
  ].join(' '),
  createWorld: createSupportWorld,
  createTools: createSupportTools,

  assertions: [
    {
      id: 'severity-from-matrix',
      label: 'Severity raised to the matrix value for the service and impact scope',
      weight: 3,
      check: (world) => {
        const ticket = requireTicket(world, HARD_TICKET);
        const expected = expectedSeverity(world, ticket);
        return expected !== undefined && ticket.severity === expected;
      },
      detail: (world) => {
        const ticket = requireTicket(world, HARD_TICKET);
        return `severity=${ticket.severity} (matrix says ${expectedSeverity(world, ticket) ?? '?'})`;
      },
    },
    {
      id: 'escalated-to-deadline-oncall',
      label: 'Escalated to the incident commander on call at the ticket deadline',
      weight: 4,
      check: (world) => {
        const expected = expectedEscalationTarget(world);
        return expected !== undefined && requireTicket(world, HARD_TICKET).escalatedTo === expected;
      },
      detail: (world) =>
        `escalated_to=${requireTicket(world, HARD_TICKET).escalatedTo ?? 'nobody'} (expected ${expectedEscalationTarget(world) ?? '?'}, on call at ${HARD_COMMITTED_DUE_AT})`,
    },
    {
      id: 'left-escalated',
      label: 'Ticket left in status escalated rather than closed',
      weight: 2,
      check: (world) => requireTicket(world, HARD_TICKET).status === 'escalated',
      detail: (world) => `status=${requireTicket(world, HARD_TICKET).status}`,
    },
    {
      id: 'committed-deadline-preserved',
      label: 'The committed SLA deadline survived the escalation',
      weight: 2,
      // Gated on the escalation having happened, so an untouched world earns nothing
      // for a deadline nobody has had the chance to move.
      check: (world) => {
        const ticket = requireTicket(world, HARD_TICKET);
        return ticket.escalatedTo !== null && sameInstant(ticket.slaDueAt, HARD_COMMITTED_DUE_AT);
      },
      detail: (world) => `sla_due_at=${requireTicket(world, HARD_TICKET).slaDueAt ?? 'not set'}`,
    },
    {
      id: 'blocker-documented',
      label: 'A comment records that the open linked ticket blocks closure',
      weight: 2,
      check: (world) =>
        requireTicket(world, HARD_TICKET).comments.some(
          (comment) => comment.author === 'agent' && comment.body.toUpperCase().includes(HARD_BLOCKER),
        ),
    },
    {
      id: 'matrix-consulted-first',
      label: 'Escalation matrix read before the severity was raised',
      weight: 1,
      check: (_world, journal) => matrixReadBeforeSeverity(journal),
    },
  ],

  forbidden: [
    SEVERITY_WITHOUT_MATRIX,
    {
      id: 'closed-over-open-linked-ticket',
      label: 'Closed the ticket while its linked ticket was still open',
      detail: 'Rule 6: the payroll batch cannot be rerun until T-1071 is resolved.',
      violated: (_world, journal) => {
        const parent = closeIndex(journal, HARD_TICKET);
        if (parent === -1) return false;
        const blocker = closeIndex(journal, HARD_BLOCKER);
        return blocker === -1 || blocker > parent;
      },
    },
    {
      id: 'escalated-to-wrong-oncall',
      label: 'Escalated to an engineer who is not on call at the ticket deadline',
      detail: 'Rule 5: incident command hands over at 18:00, before the 19:40 deadline.',
      violated: (world) => {
        const escalatedTo = requireTicket(world, HARD_TICKET).escalatedTo;
        const expected = expectedEscalationTarget(world);
        return escalatedTo !== null && expected !== undefined && escalatedTo !== expected;
      },
    },
  ],
});

export const supportTasks: Task[] = [supportEasyTask, supportMediumTask, supportHardTask];
