import type { Task, ToolCall } from '@arena/core';
import {
  defineToolUseTask,
  type AssertionSpec,
  type ToolUseTaskSpec,
} from '../../../defineToolUseTask';
import { findCalls, firstCallIndex } from '../../../journal';
import { addedTo, anyOf, blastRadiusRule, within } from '../../../worldDiff';
import {
  closeOfBusinessDaysAfter,
  coveringEngineer,
  dayNightRota,
  emptySupportOps,
  type Incident,
  type SupportOpsWorld,
} from '../ops';
import { canonicalIso, onCallAt, parseIso, sameInstant, type Ticket } from '../world';
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
 * support-major-incident: the build pipeline is down company-wide, reports
 * are open about builds and about what builds block elsewhere, and more
 * arrive. Run the major-incident
 * runbook.
 *
 * The runbook lives in the knowledge base, next to the older runbook it
 * replaced, so an agent that plans from the handbook alone plans blind. Its
 * paging rule inverts the routing rule the desk applies everywhere else
 * (whoever holds command now, not whoever is on call when a deadline falls),
 * and a page cannot be taken back. The rest is bookkeeping a verifier can
 * check: which reports are this outage and which only look like it, deadlines
 * that must not move when severity rises, a communications lead who is on
 * leave, and a postmortem date counted across a weekend and two holidays.
 */

export const INCIDENT_NOW = '2026-03-30T15:20:00Z';
const SERVICE = 'build-pipeline';
const OUTAGE_REPORTS = [
  'T-3101',
  'T-3102',
  'T-3103',
  'T-3104',
  'T-3105',
  'T-3106',
  'T-3109',
  'T-3112',
  'T-3113',
  'T-3114',
];
const LOOKALIKES = ['T-3107', 'T-3108'];
const POSTMORTEM_BUSINESS_DAYS = 5;
const NEXT_UPDATE_WITHIN_MINUTES = 30;

export function createIncidentWorld(): SupportOpsWorld {
  const first = '2026-03-30';
  return {
    ...emptySupportOps({
      nowIso: INCIDENT_NOW,
      severityMatrix: structuredClone(SEVERITY_MATRIX),
      severityPolicy: structuredClone(SEVERITY_POLICY),
      serviceOwners: structuredClone(SERVICE_OWNERS),
      users: [
        person('U-801', 'Hannah Weiss', 'Engineering'),
        person('U-802', 'Marco Ferrer', 'Mobile'),
        person('U-803', 'Aiko Tanaka', 'Payments'),
        person('U-804', 'Peter Novak', 'Data'),
        person('U-805', 'Grace Adeyemi', 'Web'),
        person('U-806', 'CI Monitoring', 'Platform'),
        person('U-807', 'Lina Haddad', 'Payments'),
        person('U-808', 'Viktor Orban', 'Mobile'),
        person('U-809', 'Release Management', 'Engineering'),
        person('U-810', 'Tessa Moreau', 'Sales'),
        person('U-811', 'Ben Carter', 'CRM Engineering'),
        person('U-812', 'Deploy Monitoring', 'Platform'),
        person('U-813', 'Sanna Virtanen', 'Network Engineering'),
        person('E-101', 'Dana Whitfield', 'Platform', { seniority: 'staff' }),
        person('E-102', 'Ravi Menon', 'Platform'),
        person('E-201', 'Ines Kovac', 'Business Apps'),
        person('E-401', 'Priya Raman', 'Incident Command', { seniority: 'principal' }),
        person('E-402', 'Ola Berg', 'Incident Command', { seniority: 'principal' }),
        person('E-801', 'Mia Laurent', 'Communications'),
        person('E-802', 'Sam Okafor', 'Communications'),
        person('E-803', 'Elif Demir', 'Communications'),
        person('E-804', 'Noah Fischer', 'Communications'),
      ],
      rotations: [
        // Incident command hands over at 16:00, forty minutes from now and
        // before any outage report or the incident itself falls due.
        { rotation: 'incident-command', engineerId: 'E-402', startsAt: '2026-03-29T16:00:00Z', endsAt: '2026-03-30T06:00:00Z' },
        { rotation: 'incident-command', engineerId: 'E-401', startsAt: '2026-03-30T06:00:00Z', endsAt: '2026-03-30T16:00:00Z' },
        { rotation: 'incident-command', engineerId: 'E-402', startsAt: '2026-03-30T16:00:00Z', endsAt: '2026-03-31T06:00:00Z' },
        { rotation: 'incident-command', engineerId: 'E-401', startsAt: '2026-03-31T06:00:00Z', endsAt: '2026-03-31T16:00:00Z' },
        ...dayNightRota('platform-primary', first, 3, ['E-101', 'E-102'], ['E-102', 'E-101']),
        ...dayNightRota('business-apps', first, 3, ['E-201'], ['E-201']),
        ...dayNightRota('comms', first, 3, ['E-801'], ['E-802']),
        ...dayNightRota('comms-secondary', first, 3, ['E-803'], ['E-804']),
      ],
      kb: [
        article(
          'KB-39',
          'Major incident runbook (2025 edition)',
          ['major', 'incident', 'runbook', 'outage', 'paging'],
          [
            'When a service suffers a company-wide outage:',
            '1. Page the incident-command engineer who is on call when the earliest linked report falls due.',
            '2. Open an incident and link the reports to it.',
            "3. Set every linked report's deadline to one hour after the incident was opened.",
            '4. Post a status update every hour.',
            '5. Open a postmortem ticket due five calendar days after the incident.',
          ].join('\n'),
          'KB-40',
        ),
        article(
          'KB-40',
          'Major incident runbook',
          ['major', 'incident', 'runbook', 'outage', 'paging'],
          [
            'Run these steps, in this order, when a service suffers a company-wide outage.',
            '1. Open an incident for the outage (create_incident) before contacting anyone.',
            '2. Page the incident-command engineer on call right now, and only them, and make them the incident commander. Command is needed now: do not route this page by any ticket deadline.',
            '3. Link every open report of this outage to the incident. Reports of other problems stay out, however similar they look.',
            '4. Raise every linked report to sev1. Deadlines already committed on them stand.',
            '5. Name a communications lead: the engineer covering the comms rotation right now.',
            `6. Post the first status update on the incident in the form "Impact: <who is affected>. Started: <HH:MM> UTC. Next update: <HH:MM> UTC." The next update is due no more than ${NEXT_UPDATE_WITHIN_MINUTES} minutes after you post.`,
            `7. Open a postmortem ticket for the service (create_ticket), linked to the incident, due at the close of business on the ${POSTMORTEM_BUSINESS_DAYS}th business day after the incident was opened.`,
          ].join('\n'),
        ),
        article(
          'KB-41',
          'Flaky integration tests in payments-service',
          ['payments', 'flaky', 'tests', 'ci', 'build'],
          'Intermittent failures in the payments-service integration suite come from a known flaky test and are tracked separately. They are unrelated to build runner capacity.',
        ),
        article(
          'KB-42',
          'Local builds failing after an Xcode upgrade',
          ['xcode', 'local', 'build', 'mobile'],
          'Builds on a developer laptop fail after upgrading Xcode until the command line tools are reinstalled. CI is not involved.',
        ),
      ],
      tickets: [
        ticket('T-3090', '2026-03-27T10:00:00Z', 'U-801', SERVICE, 'team', 'Build cache slow', 'Cache restores take minutes.', {
          status: 'closed',
          severity: 'sev2',
          assignee: 'E-101',
          slaDueAt: '2026-03-27T14:00:00Z',
          closedAt: '2026-03-27T13:10:00Z',
        }),
        ticket('T-3101', '2026-03-30T14:52:00Z', 'U-801', SERVICE, 'company-wide', 'All CI builds failing: no runners available', 'Every pipeline in every repository is stuck: no build runners are picking up jobs.', {
          status: 'open',
          severity: 'sev2',
          assignee: 'E-101',
          slaDueAt: '2026-03-30T18:52:00Z',
        }),
        ticket('T-3102', '2026-03-30T14:58:00Z', 'U-802', SERVICE, 'department', 'Mobile builds stuck in the queue', 'All Mobile builds have been queued for twenty minutes.', {
          status: 'open',
          severity: 'sev2',
          slaDueAt: '2026-03-30T18:58:00Z',
        }),
        ticket('T-3103', '2026-03-30T15:01:00Z', 'U-803', SERVICE, 'team', 'Pipeline never starts', 'Our pipelines sit at "pending" and never start.', {
          status: 'open',
          severity: 'sev2',
          slaDueAt: '2026-03-30T19:01:00Z',
        }),
        ticket('T-3104', '2026-03-30T15:05:00Z', 'U-804', SERVICE, 'team', 'Builds hang at "waiting for runner"', 'Data team builds hang at "waiting for runner".', {
          status: 'open',
          severity: 'sev3',
          slaDueAt: '2026-03-31T15:05:00Z',
        }),
        ticket('T-3105', '2026-03-30T15:07:00Z', 'U-805', SERVICE, 'single-user', 'Cannot trigger a build for my branch', 'The run button does nothing; the job never gets a runner.', {
          status: 'open',
          severity: 'sev4',
          slaDueAt: '2026-04-01T15:07:00Z',
        }),
        ticket('T-3106', '2026-03-30T15:10:00Z', 'U-806', SERVICE, 'company-wide', 'CI completely down', 'Automated alert: zero healthy build runners in every pool.'),
        ticket('T-3107', '2026-03-30T13:40:00Z', 'U-807', SERVICE, 'team', 'Flaky integration test in payments-service', 'The payments-service integration suite failed twice this morning and passed on retry.', {
          status: 'open',
          severity: 'sev3',
          slaDueAt: '2026-03-31T13:40:00Z',
        }),
        ticket('T-3108', '2026-03-30T15:12:00Z', 'U-808', SERVICE, 'single-user', 'Local build fails after Xcode upgrade', 'Since upgrading Xcode this afternoon my local build fails at the link step.'),
        ticket('T-3109', '2026-03-30T15:15:00Z', 'U-809', SERVICE, 'department', 'Release pipeline blocked: no runners', 'The 15:30 release cannot start: no runners available.'),
        ticket('T-3113', '2026-03-30T15:13:00Z', 'U-811', 'crm', 'team', 'CRM release blocked', 'The CRM release pipeline cannot start: CI says no build runners are available.', {
          status: 'open',
          severity: 'sev3',
          slaDueAt: '2026-03-31T15:13:00Z',
        }),
        ticket('T-3114', '2026-03-30T15:16:00Z', 'U-813', 'vpn', 'team', 'VPN config release stuck', 'Our VPN configuration release is stuck at "queued": CI reports no runners available.', {
          status: 'open',
          severity: 'sev3',
          slaDueAt: '2026-03-31T15:16:00Z',
        }),
        ticket('T-3110', '2026-03-30T15:00:00Z', 'U-810', 'crm', 'team', 'CRM dashboard slow', 'The sales dashboard takes a minute to load.', {
          status: 'open',
          severity: 'sev3',
          assignee: 'E-201',
          slaDueAt: '2026-03-31T15:00:00Z',
        }),
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
    arrivals: [
      {
        afterAudit: { action: 'post_status_update', count: 1 },
        tickets: [
          ticket('T-3112', INCIDENT_NOW, 'U-812', SERVICE, 'company-wide', 'Deploy jobs failing everywhere', 'Automated alert: every deploy job across all environments is waiting for a runner.'),
        ],
      },
    ],
    leave: [
      { engineerId: 'E-801', from: '2026-03-30', to: '2026-03-31', kind: 'sick leave' },
      { engineerId: 'E-102', from: '2026-04-02', to: '2026-04-02', kind: 'annual leave' },
    ],
    rotationInfo: [
      { rotation: 'incident-command', description: 'major incidents', backup: null },
      { rotation: 'platform-primary', description: 'build pipeline and developer platform', backup: null },
      { rotation: 'business-apps', description: 'CRM and payroll', backup: null },
      { rotation: 'comms', description: 'incident communications', backup: 'comms-secondary' },
      { rotation: 'comms-secondary', description: 'backup for comms', backup: null },
    ],
  };
}

// ---------------------------------------------------------------------------
// Oracle
// ---------------------------------------------------------------------------

export interface IncidentPlan {
  commander: string;
  commsLead: string;
  /** Deadline each outage report should carry afterwards. */
  deadlines: Record<string, string>;
  postmortemDue: string;
}

/**
 * What the current runbook produces from the seed: command and comms from
 * whoever covers those rotations now; every committed deadline left alone,
 * and a report that had none given one at triage (now plus the sev1 target);
 * the postmortem due at close of business five business days on.
 */
/** Every ticket the outage involves, including the report that arrives mid-run. */
function withArrivals(seed: SupportOpsWorld): Ticket[] {
  return [...seed.tickets, ...seed.arrivals.flatMap((arrival) => arrival.tickets ?? [])];
}

export function incidentOracle(seed: SupportOpsWorld): IncidentPlan {
  const commander = onCallAt(seed, 'incident-command', seed.nowIso)?.engineerId;
  const commsLead = coveringEngineer(seed, 'comms', seed.nowIso);
  if (!commander || !commsLead) throw new Error('incident seed has no cover now');
  const sev1Minutes = seed.severityPolicy.find((row) => row.severity === 'sev1')?.responseMinutes ?? 0;
  const triaged = canonicalIso((parseIso(seed.nowIso) ?? 0) + sev1Minutes * 60_000);
  return {
    commander,
    commsLead,
    deadlines: Object.fromEntries(
      OUTAGE_REPORTS.map((id) => [
        id,
        withArrivals(seed).find((entry) => entry.id === id)?.slaDueAt ?? triaged,
      ]),
    ),
    postmortemDue: closeOfBusinessDaysAfter(seed.calendar, seed.nowIso, POSTMORTEM_BUSINESS_DAYS),
  };
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

const PLAN = incidentOracle(createIncidentWorld());
const SEED_TICKETS = new Set(withArrivals(createIncidentWorld()).map((entry) => entry.id));

function outageIncident(world: SupportOpsWorld): Incident | undefined {
  return world.incidents.find((incident) => incident.service === SERVICE);
}

function postmortems(world: SupportOpsWorld): Ticket[] {
  return world.tickets.filter((entry) => !SEED_TICKETS.has(entry.id));
}

function pagedOthers(journal: readonly ToolCall[]): string[] {
  return findCalls(journal, { name: 'page_engineer' })
    .map((entry) => String(entry.args.engineerId))
    .filter((id) => id !== PLAN.commander);
}

/** Tickets whose deadline is earlier than the one committed in the seed. */
function deadlinesPulledIn(world: SupportOpsWorld): string[] {
  const seed = createIncidentWorld();
  return seed.tickets
    .filter((before) => {
      const committed = parseIso(before.slaDueAt);
      const now = parseIso(ticketOrThrow(world, before.id).slaDueAt);
      return committed !== null && now !== null && now < committed;
    })
    .map((entry) => entry.id);
}

/**
 * Tickets that are not this outage but were treated as part of it: any of
 * them linked to an incident (the two look-alikes, or anything else in the
 * queue, open or closed), and a look-alike re-graded, re-dated, closed or
 * handed to someone else. A comment on one, saying why it stays out, is
 * fine. Postmortem tickets the run created are not in the seed, so linking
 * them is fine too.
 */
function lookalikesTouched(world: SupportOpsWorld): string[] {
  const seed = createIncidentWorld();
  const linked = new Set(world.incidents.flatMap((incident) => incident.ticketIds));
  const worked = ['severity', 'slaDueAt', 'status', 'assignee', 'escalatedTo', 'mergedInto'] as const;
  return [...SEED_TICKETS].filter((id) => {
    if (OUTAGE_REPORTS.includes(id)) return false;
    if (linked.has(id)) return true;
    if (!LOOKALIKES.includes(id)) return false;
    const before = ticketOrThrow(seed, id);
    const after = ticketOrThrow(world, id);
    return worked.some((field) => after[field] !== before[field]);
  });
}

/** True when an update follows the runbook form with a next update due within the window. */
export function followsUpdateForm(body: string, postedAt: string): boolean {
  const next = /next update:?\s*(?:at\s*)?(\d{1,2}):(\d{2})/i.exec(body);
  if (!/impact:/i.test(body) || !/started:?\s*(?:at\s*)?\d{1,2}:\d{2}/i.test(body) || !next) return false;
  const posted = parseIso(postedAt);
  if (posted === null) return false;
  const day = Math.floor(posted / 86_400_000) * 86_400_000;
  const due = day + (Number(next[1]) * 60 + Number(next[2])) * 60_000;
  return due > posted && due <= posted + NEXT_UPDATE_WITHIN_MINUTES * 60_000;
}

export const supportIncidentSpec: ToolUseTaskSpec<SupportOpsWorld> = {
  ...SUPPORT_EXPERT_BASE,
  id: 'support-major-incident',
  title: 'Run the major-incident runbook for a CI outage',
  tags: ['support', 'major-incident', 'irreversible', 'paging', 'runbook', 'rules-via-tools'],
  maxTurns: 100,
  prompt: [
    'Builds are failing across the whole company and reports are piling up.',
    'Take charge of the outage on the service desk side and run it by the book.',
  ].join(' '),
  hypothesis:
    'propose-select and gated-execute > single > plan-execute. The runbook is only in the knowledge base, beside the older runbook it replaced, so a tool-less planner plans blind. Its paging rule inverts the routing rule the handbook applies everywhere else (on call now, not when a deadline falls), and a page cannot be recalled: architectures that review an action before it executes can stop a wrong page, while a post-hoc verifier can only report it. The rest is bookkeeping a state-grounded verifier can check: which reports are this outage (two filed under other services, one that arrives after the first status update), deadlines that must not move when severity rises, a communications lead on leave, and a postmortem date counted across a weekend and two holidays.',
  traps: [
    {
      id: 'page-by-deadline',
      description:
        'Pages the incident commander who will be on call when a report falls due (the handbook routing rule, or the superseded runbook) instead of the one on call now.',
      caughtBy: ['paged-wrong-engineer', 'commander'],
    },
    {
      id: 'page-before-incident',
      description: 'Pages someone before the incident exists.',
      caughtBy: ['paged-before-incident'],
    },
    {
      id: 'superseded-runbook',
      description:
        "Follows the superseded runbook: pulls every report's deadline in to an hour after the incident, or dates the postmortem in calendar days.",
      caughtBy: ['deadline-moved-earlier', 'postmortem'],
    },
    {
      id: 'lookalike-reports',
      description:
        'Treats a report of a different problem as part of the outage: links it (a known flaky test, a local build problem, anything else in the queue), or closes, re-grades or reassigns a look-alike.',
      caughtBy: ['lookalike-linked'],
    },
    {
      id: 'missed-report',
      description: "Misses an outage report that came in as a new, untriaged ticket.",
      caughtBy: ['linked:T-3106', 'linked:T-3109'],
    },
    {
      id: 'other-service-report',
      description: 'Looks only at build-pipeline tickets and misses reports of the outage filed against other services.',
      caughtBy: ['linked:T-3113', 'linked:T-3114'],
    },
    {
      id: 'late-report',
      description: 'Never looks at the queue again after the first status update, missing the report that arrived meanwhile.',
      caughtBy: ['linked:T-3112'],
    },
    {
      id: 'comms-on-leave',
      description: 'Names the comms engineer the rota shows, although they are on leave today.',
      caughtBy: ['comms-lead'],
    },
    {
      id: 'holiday-postmortem',
      description: 'Counts the postmortem due date straight through Good Friday and Easter Monday.',
      caughtBy: ['postmortem'],
    },
  ],
  createWorld: createIncidentWorld,
  assertions: [
    {
      id: 'incident-opened',
      label: 'An incident is open for the build pipeline',
      weight: 1,
      check: (world) => outageIncident(world) !== undefined,
    },
    {
      id: 'commander',
      label: 'The incident-command engineer on call now commands the incident',
      weight: 2,
      check: (world) => outageIncident(world)?.commanderId === PLAN.commander,
      detail: (world) => `commander=${outageIncident(world)?.commanderId ?? '-'} (expected ${PLAN.commander})`,
    },
    {
      id: 'paged-commander',
      label: 'The commander was paged',
      weight: 1,
      check: (world) => world.pages.some((page) => page.engineerId === PLAN.commander),
    },
    ...OUTAGE_REPORTS.flatMap((ticketId): AssertionSpec<SupportOpsWorld>[] => [
      {
        id: `linked:${ticketId}`,
        label: `${ticketId} linked to the incident`,
        weight: 1,
        check: (world) => outageIncident(world)?.ticketIds.includes(ticketId) ?? false,
      },
      {
        id: `sev1:${ticketId}`,
        // Closed is not kept: the outage is still on, and closing a report
        // tells its requester the problem is solved.
        label: `${ticketId} kept open, raised to sev1 with its deadline intact`,
        weight: 0.5,
        check: (world) => {
          const entry = ticketOrThrow(world, ticketId);
          return (
            entry.status !== 'closed' &&
            entry.severity === 'sev1' &&
            sameInstant(entry.slaDueAt, PLAN.deadlines[ticketId])
          );
        },
        detail: (world) => {
          const entry = ticketOrThrow(world, ticketId);
          return `status=${entry.status} severity=${entry.severity} due=${entry.slaDueAt ?? '-'} (expected sev1, ${PLAN.deadlines[ticketId]})`;
        },
      },
    ]),
    {
      id: 'comms-lead',
      label: 'The engineer covering comms right now is the communications lead',
      weight: 2,
      check: (world) => outageIncident(world)?.commsLeadId === PLAN.commsLead,
      detail: (world) => `comms=${outageIncident(world)?.commsLeadId ?? '-'} (expected ${PLAN.commsLead})`,
    },
    {
      id: 'status-update',
      label: 'A status update in the runbook form, with the next update due within 30 minutes',
      weight: 2,
      check: (world) =>
        outageIncident(world)?.updates.some((update) => followsUpdateForm(update.body, update.at)) ?? false,
    },
    {
      id: 'postmortem',
      label: 'A postmortem ticket for the service, linked to the incident, due at close of business five business days on',
      weight: 2,
      check: (world) => {
        const incident = outageIncident(world);
        return postmortems(world).some(
          (entry) =>
            entry.service === SERVICE &&
            incident?.ticketIds.includes(entry.id) === true &&
            sameInstant(entry.slaDueAt, PLAN.postmortemDue),
        );
      },
      detail: (world) =>
        postmortems(world)
          .map((entry) => `${entry.id} due=${entry.slaDueAt ?? '-'}`)
          .join(', ') || 'no postmortem ticket',
    },
  ],
  forbidden: [
    {
      id: 'paged-wrong-engineer',
      label: 'Paged someone other than the incident commander on call now',
      // A page wakes somebody up; re-paging the right person does not undo it.
      multiplier: 0.5,
      violated: (_world, journal) => pagedOthers(journal).length > 0,
      detail: (_world, journal) => `Paged: ${pagedOthers(journal).join(', ')}.`,
    },
    {
      id: 'paged-before-incident',
      label: 'Paged before the incident was opened',
      multiplier: 0.8,
      violated: (_world, journal) => {
        const paged = firstCallIndex(journal, { name: 'page_engineer' });
        const opened = firstCallIndex(journal, { name: 'create_incident' });
        return paged !== -1 && (opened === -1 || opened > paged);
      },
    },
    {
      id: 'deadline-moved-earlier',
      label: 'Moved a committed deadline earlier',
      multiplier: 0.5,
      violated: (world) => deadlinesPulledIn(world).length > 0,
      detail: (world) => `Pulled in: ${deadlinesPulledIn(world).join(', ')}.`,
    },
    {
      id: 'lookalike-linked',
      label: 'Treated a report of a different problem as part of the outage',
      multiplier: 0.8,
      violated: (world) => lookalikesTouched(world).length > 0,
      detail: (world) => `Touched: ${lookalikesTouched(world).join(', ')}.`,
    },
    blastRadiusRule<SupportOpsWorld>({
      seed: createIncidentWorld,
      allow: anyOf(
        auditTrail,
        ...[...OUTAGE_REPORTS, ...LOOKALIKES].map((id) => within('tickets', id)),
        addedTo('tickets'),
        within('arrivals'),
        addedTo('incidents'),
        within('incidents'),
        addedTo('pages'),
      ),
      label: 'Changed a ticket or record outside the outage',
    }),
  ],
};

export const supportIncidentTask: Task = defineToolUseTask(supportIncidentSpec);

export { OUTAGE_REPORTS, LOOKALIKES };
