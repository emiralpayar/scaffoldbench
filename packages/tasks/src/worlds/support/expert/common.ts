import type { JournaledToolSpec } from '@arena/core';
import type { ToolUseTaskSpec } from '../../../defineToolUseTask';
import type { ChangeFilter } from '../../../worldDiff';
import { SUPPORT_OPS_HANDBOOK } from '../handbook';
import { SUPPORT_OPS_INSTRUCTIONS, createSupportOpsTools, type SupportOpsWorld } from '../ops';
import {
  findTicket,
  type ImpactScope,
  type KbArticle,
  type ServiceId,
  type Severity,
  type SeverityPolicyRow,
  type SeverityRule,
  type ServiceOwner,
  type SupportUser,
  type Ticket,
  type TicketStatus,
} from '../world';

/**
 * What every expert support task shares: the world name, the operations
 * handbook and the full operations toolset. Each task brings its own seed,
 * prompt and scorer. Every task sees every ops tool, including the ones it
 * does not need, so the tool list itself never hints at the answer.
 */
export const SUPPORT_EXPERT_BASE = {
  world: 'support',
  difficulty: 'expert',
  policy: SUPPORT_OPS_HANDBOOK,
  instructions: SUPPORT_OPS_INSTRUCTIONS,
  createTools: (world: SupportOpsWorld): JournaledToolSpec[] => createSupportOpsTools(world),
} satisfies Partial<ToolUseTaskSpec<SupportOpsWorld>>;

export function ticketOrThrow(world: SupportOpsWorld, id: string): Ticket {
  const ticket = findTicket(world, id);
  if (!ticket) throw new Error(`ticket ${id} vanished from the world`);
  return ticket;
}

/** The audit log grows with every mutation; appending to it is never collateral damage. */
export const auditTrail: ChangeFilter = (change) =>
  change.path[0] === 'auditLog' && change.kind === 'added';

// ---------------------------------------------------------------------------
// The desk's standing tables, shared by every support seed
// ---------------------------------------------------------------------------

export const SEVERITY_MATRIX: SeverityRule[] = (
  [
    ['vpn', 'sev4', 'sev3', 'sev2', 'sev1'],
    ['payroll', 'sev3', 'sev2', 'sev1', 'sev1'],
    ['crm', 'sev4', 'sev3', 'sev2', 'sev1'],
    ['build-pipeline', 'sev4', 'sev2', 'sev2', 'sev1'],
  ] as const
).flatMap(([service, ...severities]) =>
  (['single-user', 'team', 'department', 'company-wide'] as const).map((impact, index) => ({
    service,
    impact,
    severity: severities[index] as Exclude<Severity, 'unset'>,
  })),
);

export const SEVERITY_POLICY: SeverityPolicyRow[] = [
  { severity: 'sev1', responseMinutes: 60, escalationRotation: 'incident-command' },
  { severity: 'sev2', responseMinutes: 240, escalationRotation: 'platform-primary' },
  { severity: 'sev3', responseMinutes: 480, escalationRotation: null },
  { severity: 'sev4', responseMinutes: 1440, escalationRotation: null },
];

export const SERVICE_OWNERS: ServiceOwner[] = [
  { service: 'vpn', rotation: 'network-primary' },
  { service: 'payroll', rotation: 'business-apps' },
  { service: 'crm', rotation: 'business-apps' },
  { service: 'build-pipeline', rotation: 'platform-primary' },
];

// ---------------------------------------------------------------------------
// Seed builders: keep the seed tables readable
// ---------------------------------------------------------------------------

export function person(
  id: string,
  name: string,
  department: string,
  fields: Partial<Pick<SupportUser, 'seniority' | 'managerId' | 'employment'>> = {},
): SupportUser {
  return {
    id,
    name,
    department,
    seniority: fields.seniority ?? 'senior',
    role: id.startsWith('E-') ? 'engineer' : 'requester',
    ...(fields.managerId ? { managerId: fields.managerId } : {}),
    ...(fields.employment ? { employment: fields.employment } : {}),
  };
}

export function ticket(
  id: string,
  createdAt: string,
  requesterId: string,
  service: ServiceId,
  impact: ImpactScope,
  title: string,
  description: string,
  fields: Partial<
    Pick<Ticket, 'severity' | 'assignee' | 'slaDueAt' | 'linkedTickets' | 'comments' | 'closedAt'> & {
      status: TicketStatus;
    }
  > = {},
): Ticket {
  return {
    id,
    title,
    description,
    requesterId,
    service,
    impact,
    severity: fields.severity ?? 'unset',
    status: fields.status ?? 'new',
    assignee: fields.assignee ?? null,
    escalatedTo: null,
    createdAt,
    slaDueAt: fields.slaDueAt ?? null,
    closedAt: fields.closedAt ?? null,
    mergedInto: null,
    linkedTickets: fields.linkedTickets ?? [],
    comments: fields.comments ?? [],
  };
}

export function article(
  id: string,
  title: string,
  tags: string[],
  body: string,
  supersededBy?: string,
): KbArticle {
  return { id, title, tags, body, ...(supersededBy ? { supersededBy } : {}) };
}
