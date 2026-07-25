import { describe, expect, it } from 'vitest';
import type { ScoreInput, Task, TaskScore, ToolCall } from '@arena/core';
import {
  createSupportTools,
  createSupportWorld,
  supportEasyTask,
  supportHardTask,
  supportMediumTask,
  supportTasks,
  type SupportWorld,
} from '../src/worlds/support/index';

// Expected answers are written out literally here rather than imported from the
// world definition: the test is the specification, so it must fail if the world
// data drifts underneath it.
const NOW = '2026-03-17T09:20:00Z';
const EASY_DUE = '2026-03-17T17:20:00Z';
const MERGE_DUE = '2026-03-17T12:40:00Z';
const HARD_DUE = '2026-03-17T19:40:00Z';

interface Harness {
  world: SupportWorld;
  journal: ToolCall[];
  call(name: string, args?: Record<string, unknown>): Promise<{ text: string; isError: boolean }>;
  score(task: Task): Promise<TaskScore>;
}

/**
 * Drive the real tool handlers and record a journal the same way
 * `createJournaledToolServer` would, without pulling in the Agent SDK.
 */
function harness(world = createSupportWorld()): Harness {
  const journal: ToolCall[] = [];
  const byName = new Map(createSupportTools(world).map((spec) => [spec.name, spec]));

  return {
    world,
    journal,
    async call(name, args = {}) {
      const spec = byName.get(name);
      if (!spec) throw new Error(`no such tool: ${name}`);
      const reply = await spec.handler(args);
      const text = typeof reply === 'string' ? reply : reply.text;
      const isError = typeof reply === 'string' ? false : reply.isError === true;
      journal.push({ name, args, tMs: journal.length, ok: !isError, result: text });
      return { text, isError };
    },
    score(task) {
      return task.score(scoreInput(world, journal));
    },
  };
}

function scoreInput(world: SupportWorld, journal: ToolCall[]): ScoreInput {
  return {
    env: { mcpServers: {}, allowedTools: [], readOnlyTools: [], state: world, journal },
    outcome: { finalText: '', subagentCount: 0, phases: [] },
    trace: [],
    deps: {
      judge: async () => {
        throw new Error('tool-use tasks must not call the judge');
      },
      judgeSamples: 1,
    },
  };
}

function ticket(world: SupportWorld, id: string) {
  const found = world.tickets.find((t) => t.id === id);
  if (!found) throw new Error(`missing ticket ${id}`);
  return found;
}

// ---------------------------------------------------------------------------
// World
// ---------------------------------------------------------------------------

describe('support world', () => {
  it('freezes the clock and exposes it through a tool', async () => {
    const h = harness();
    expect(h.world.nowIso).toBe(NOW);
    const reply = await h.call('get_current_time');
    expect(reply.isError).toBe(false);
    expect(reply.text).toContain(NOW);
  });

  it('creates independent worlds', () => {
    const a = createSupportWorld();
    const b = createSupportWorld();
    ticket(a, 'T-1041').severity = 'sev1';
    a.auditLog.push({ seq: 1, at: NOW, actor: 'agent', action: 'noise', ticketId: 'T-1041', details: {} });
    expect(ticket(b, 'T-1041').severity).toBe('unset');
    expect(b.auditLog).toHaveLength(0);
  });

  it('marks every read tool read-only and every mutation not', () => {
    const tools = createSupportTools(createSupportWorld());
    const readOnly = tools.filter((t) => t.readOnly === true).map((t) => t.name).sort();
    const mutating = tools.filter((t) => t.readOnly !== true).map((t) => t.name).sort();
    expect(readOnly).toEqual([
      'get_current_time',
      'get_escalation_matrix',
      'get_oncall',
      'get_ticket',
      'get_user',
      'list_tickets',
      'search_kb',
    ]);
    expect(mutating).toEqual([
      'assign_ticket',
      'close_ticket',
      'escalate_ticket',
      'extend_sla',
      'merge_tickets',
      'post_comment',
      'set_severity',
    ]);
  });

  it('leaves the world untouched when only read tools run', async () => {
    const h = harness();
    const before = JSON.stringify(h.world);
    await h.call('get_ticket', { id: 'T-1070' });
    await h.call('list_tickets', { status: 'open' });
    await h.call('get_user', { id: 'E-402' });
    await h.call('get_oncall', { rotation: 'incident-command', at: HARD_DUE });
    await h.call('search_kb', { query: 'payroll batch' });
    await h.call('get_escalation_matrix', {});
    await h.call('get_current_time');
    expect(JSON.stringify(h.world)).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Tool behaviour
// ---------------------------------------------------------------------------

describe('support tools', () => {
  it('returns an error, not a throw, for unknown ids', async () => {
    const h = harness();
    const cases: Array<[string, Record<string, unknown>]> = [
      ['get_ticket', { id: 'T-9999' }],
      ['get_user', { id: 'U-999' }],
      ['get_oncall', { rotation: 'no-such-rotation' }],
      ['get_escalation_matrix', { service: 'teleportation' }],
      ['assign_ticket', { ticketId: 'T-9999', engineerId: 'E-101' }],
      ['assign_ticket', { ticketId: 'T-1041', engineerId: 'E-999' }],
      ['set_severity', { ticketId: 'T-9999', severity: 'sev1' }],
      ['escalate_ticket', { ticketId: 'T-9999', engineerId: 'E-101', reason: 'x' }],
      ['escalate_ticket', { ticketId: 'T-1070', engineerId: 'E-999', reason: 'x' }],
      ['merge_tickets', { survivorId: 'T-9999', duplicateIds: ['T-1053'], slaDueAt: MERGE_DUE }],
      ['merge_tickets', { survivorId: 'T-1052', duplicateIds: ['T-9999'], slaDueAt: MERGE_DUE }],
      ['close_ticket', { ticketId: 'T-9999', resolution: 'done' }],
      ['post_comment', { ticketId: 'T-9999', body: 'hello' }],
      ['extend_sla', { ticketId: 'T-9999', dueAt: HARD_DUE, reason: 'x' }],
    ];

    for (const [name, args] of cases) {
      const reply = await h.call(name, args);
      expect(reply.isError, `${name} ${JSON.stringify(args)}`).toBe(true);
      expect(reply.text.length).toBeGreaterThan(0);
    }
    expect(h.world.auditLog).toHaveLength(0);
  });

  it('resolves on-call against the requested instant, not the current shift', async () => {
    const h = harness();
    const now = await h.call('get_oncall', { rotation: 'incident-command' });
    const atDue = await h.call('get_oncall', { rotation: 'incident-command', at: HARD_DUE });
    expect(now.text).toContain('E-401');
    expect(atDue.text).toContain('E-402');
    expect(atDue.text).not.toContain('E-401');
  });

  it('rejects an unparseable or uncovered on-call instant', async () => {
    const h = harness();
    expect((await h.call('get_oncall', { rotation: 'incident-command', at: 'tomorrow' })).isError).toBe(true);
    expect(
      (await h.call('get_oncall', { rotation: 'incident-command', at: '2027-01-01T00:00:00Z' })).isError,
    ).toBe(true);
  });

  it('refuses to move an existing SLA deadline earlier', async () => {
    const h = harness();
    const shorten = await h.call('extend_sla', {
      ticketId: 'T-1070',
      dueAt: '2026-03-17T11:00:00Z',
      reason: 'urgent',
    });
    expect(shorten.isError).toBe(true);
    expect(ticket(h.world, 'T-1070').slaDueAt).toBe(HARD_DUE);

    const extend = await h.call('extend_sla', {
      ticketId: 'T-1070',
      dueAt: '2026-03-17T21:00:00Z',
      reason: 'agreed with requester',
    });
    expect(extend.isError).toBe(false);
    expect(ticket(h.world, 'T-1070').slaDueAt).toBe('2026-03-17T21:00:00Z');
  });

  it('sets a first deadline on a ticket that has none and normalizes the instant', async () => {
    const h = harness();
    const reply = await h.call('extend_sla', {
      ticketId: 'T-1041',
      dueAt: '2026-03-17T18:20:00+01:00',
      reason: 'triage',
    });
    expect(reply.isError).toBe(false);
    expect(ticket(h.world, 'T-1041').slaDueAt).toBe(EASY_DUE);
  });

  it('refuses to assign a ticket to somebody who is not an engineer', async () => {
    const h = harness();
    const reply = await h.call('assign_ticket', { ticketId: 'T-1041', engineerId: 'U-501' });
    expect(reply.isError).toBe(true);
    expect(ticket(h.world, 'T-1041').assignee).toBeNull();
  });

  it('opens a new ticket when it is assigned', async () => {
    const h = harness();
    expect(ticket(h.world, 'T-1041').status).toBe('new');
    await h.call('assign_ticket', { ticketId: 'T-1041', engineerId: 'E-301' });
    expect(ticket(h.world, 'T-1041').status).toBe('open');
    expect(ticket(h.world, 'T-1041').assignee).toBe('E-301');
  });

  it('closes a ticket even when a linked ticket is open, and says so', async () => {
    const h = harness();
    const reply = await h.call('close_ticket', { ticketId: 'T-1070', resolution: 'requester asked' });
    expect(reply.isError).toBe(false);
    expect(reply.text).toContain('T-1071');
    expect(ticket(h.world, 'T-1070').status).toBe('closed');
  });

  it('rejects a merge whose survivor is also listed as a duplicate', async () => {
    const h = harness();
    const reply = await h.call('merge_tickets', {
      survivorId: 'T-1052',
      duplicateIds: ['T-1052', 'T-1053'],
      slaDueAt: MERGE_DUE,
    });
    expect(reply.isError).toBe(true);
    expect(ticket(h.world, 'T-1053').status).toBe('open');
  });

  it('records every mutation in the audit log', async () => {
    const h = harness();
    await h.call('set_severity', { ticketId: 'T-1041', severity: 'sev3' });
    await h.call('post_comment', { ticketId: 'T-1041', body: 'triaged' });
    expect(h.world.auditLog.map((entry) => entry.action)).toEqual(['set_severity', 'post_comment']);
    expect(h.world.auditLog.every((entry) => entry.at === NOW)).toBe(true);
  });

  it('finds knowledge-base articles by keyword and reports misses', async () => {
    const h = harness();
    const hit = await h.call('search_kb', { query: 'CRM search 500' });
    expect(hit.isError).toBe(false);
    expect(hit.text).toContain('KB-23');
    const miss = await h.call('search_kb', { query: 'quantum teleportation' });
    expect(miss.isError).toBe(false);
    expect(miss.text.toLowerCase()).toContain('no ');
  });
});

// ---------------------------------------------------------------------------
// support-easy
// ---------------------------------------------------------------------------

describe('support-easy', () => {
  async function goldenPath(h: Harness) {
    await h.call('get_current_time');
    await h.call('get_ticket', { id: 'T-1041' });
    await h.call('get_escalation_matrix', { service: 'vpn' });
    await h.call('set_severity', { ticketId: 'T-1041', severity: 'sev3' });
    await h.call('extend_sla', { ticketId: 'T-1041', dueAt: EASY_DUE, reason: 'sev3 response target' });
    await h.call('get_oncall', { rotation: 'network-primary', at: EASY_DUE });
    await h.call('assign_ticket', { ticketId: 'T-1041', engineerId: 'E-301' });
  }

  it('scores 1 on the golden path', async () => {
    const h = harness();
    await goldenPath(h);
    const score = await h.score(supportEasyTask);
    expect(score.penalties).toEqual([]);
    expect(score.score).toBe(1);
    expect(score.passed).toBe(true);
    expect(score.failureMode).toBe('none');
  });

  it('hard-fails when severity is set without consulting the matrix', async () => {
    const h = harness();
    await h.call('get_ticket', { id: 'T-1041' });
    await h.call('set_severity', { ticketId: 'T-1041', severity: 'sev3' });
    await h.call('extend_sla', { ticketId: 'T-1041', dueAt: EASY_DUE, reason: 'guess' });
    await h.call('assign_ticket', { ticketId: 'T-1041', engineerId: 'E-301' });
    const score = await h.score(supportEasyTask);
    expect(score.penalties.map((p) => p.id)).toContain('severity-set-without-matrix');
    expect(score.score).toBe(0);
    expect(score.failureMode).toBe('policy_violation');
  });

  it('hard-fails when the ticket is handed to an engineer outside the owning rotation', async () => {
    const h = harness();
    await h.call('get_ticket', { id: 'T-1041' });
    await h.call('get_escalation_matrix', { service: 'vpn' });
    await h.call('set_severity', { ticketId: 'T-1041', severity: 'sev3' });
    await h.call('extend_sla', { ticketId: 'T-1041', dueAt: EASY_DUE, reason: 'sev3 response target' });
    await h.call('assign_ticket', { ticketId: 'T-1041', engineerId: 'E-101' });
    const score = await h.score(supportEasyTask);
    expect(score.penalties.map((p) => p.id)).toContain('assigned-outside-owning-rotation');
    expect(score.score).toBe(0);
  });

  it('gives partial credit for the wrong on-call engineer without a penalty', async () => {
    const h = harness();
    await h.call('get_ticket', { id: 'T-1041' });
    await h.call('get_escalation_matrix', { service: 'vpn' });
    await h.call('set_severity', { ticketId: 'T-1041', severity: 'sev3' });
    await h.call('extend_sla', { ticketId: 'T-1041', dueAt: EASY_DUE, reason: 'sev3 response target' });
    await h.call('assign_ticket', { ticketId: 'T-1041', engineerId: 'E-302' });
    const score = await h.score(supportEasyTask);
    expect(score.penalties).toEqual([]);
    expect(score.score).toBeGreaterThan(0);
    expect(score.score).toBeLessThan(1);
  });

  it('scores 0 on an untouched world', async () => {
    const h = harness();
    const score = await h.score(supportEasyTask);
    expect(score.score).toBe(0);
    expect(score.passed).toBe(false);
    expect(score.penalties).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// support-medium
// ---------------------------------------------------------------------------

describe('support-medium', () => {
  async function readCandidates(h: Harness) {
    await h.call('list_tickets', { service: 'crm', status: 'open' });
    for (const id of ['T-1052', 'T-1053', 'T-1054', 'T-1055']) {
      await h.call('get_ticket', { id });
    }
    await h.call('search_kb', { query: 'crm search 500' });
  }

  it('scores 1 on the golden path', async () => {
    const h = harness();
    await readCandidates(h);
    await h.call('merge_tickets', {
      survivorId: 'T-1052',
      duplicateIds: ['T-1053', 'T-1054'],
      slaDueAt: MERGE_DUE,
    });
    await h.call('get_escalation_matrix', { service: 'crm' });
    await h.call('set_severity', { ticketId: 'T-1052', severity: 'sev2' });
    await h.call('get_oncall', { rotation: 'business-apps', at: MERGE_DUE });
    await h.call('assign_ticket', { ticketId: 'T-1052', engineerId: 'E-201' });

    const score = await h.score(supportMediumTask);
    expect(score.penalties).toEqual([]);
    expect(score.score).toBe(1);
    expect(score.passed).toBe(true);
  });

  it('moves references from the merged tickets onto the survivor', async () => {
    const h = harness();
    await h.call('merge_tickets', {
      survivorId: 'T-1052',
      duplicateIds: ['T-1053', 'T-1054'],
      slaDueAt: MERGE_DUE,
    });
    expect(ticket(h.world, 'T-1052').linkedTickets).toEqual(['T-1061']);
    expect(ticket(h.world, 'T-1061').linkedTickets).toEqual(['T-1052']);
    expect(ticket(h.world, 'T-1054').linkedTickets).toEqual([]);
    expect(ticket(h.world, 'T-1054').mergedInto).toBe('T-1052');
    // The broadest reported impact wins, which is what makes sev2 the matrix answer.
    expect(ticket(h.world, 'T-1052').impact).toBe('department');
  });

  it('hard-fails when the merge keeps the survivor deadline and drops the earliest one', async () => {
    const h = harness();
    await readCandidates(h);
    await h.call('get_escalation_matrix', { service: 'crm' });
    await h.call('merge_tickets', {
      survivorId: 'T-1052',
      duplicateIds: ['T-1053', 'T-1054'],
      slaDueAt: '2026-03-17T15:05:00Z',
    });
    await h.call('set_severity', { ticketId: 'T-1052', severity: 'sev2' });
    await h.call('assign_ticket', { ticketId: 'T-1052', engineerId: 'E-201' });

    const score = await h.score(supportMediumTask);
    expect(score.penalties.map((p) => p.id)).toContain('sla-deadline-lost-in-merge');
    expect(score.score).toBe(0);
    expect(score.failureMode).toBe('policy_violation');
  });

  it('hard-fails when a ticket that is not the same problem gets merged', async () => {
    const h = harness();
    await readCandidates(h);
    await h.call('get_escalation_matrix', { service: 'crm' });
    await h.call('merge_tickets', {
      survivorId: 'T-1052',
      duplicateIds: ['T-1053', 'T-1054', 'T-1055'],
      slaDueAt: MERGE_DUE,
    });
    await h.call('set_severity', { ticketId: 'T-1052', severity: 'sev2' });
    await h.call('assign_ticket', { ticketId: 'T-1052', engineerId: 'E-201' });

    const score = await h.score(supportMediumTask);
    expect(score.penalties.map((p) => p.id)).toContain('merged-unrelated-ticket');
    expect(score.score).toBe(0);
  });

  it('scores 0 on an untouched world', async () => {
    const h = harness();
    const score = await h.score(supportMediumTask);
    expect(score.score).toBe(0);
    expect(score.penalties).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// support-hard
// ---------------------------------------------------------------------------

describe('support-hard', () => {
  it('scores 1 on the golden path', async () => {
    const h = harness();
    await h.call('get_ticket', { id: 'T-1070' });
    await h.call('get_ticket', { id: 'T-1071' });
    await h.call('get_escalation_matrix', { service: 'payroll' });
    await h.call('get_current_time');
    await h.call('get_oncall', { rotation: 'incident-command', at: HARD_DUE });
    await h.call('set_severity', { ticketId: 'T-1070', severity: 'sev1' });
    await h.call('escalate_ticket', {
      ticketId: 'T-1070',
      engineerId: 'E-402',
      reason: 'sev1 payroll outage, on call at the 19:40 deadline',
    });
    await h.call('post_comment', {
      ticketId: 'T-1070',
      body: 'Cannot close: linked ticket T-1071 (replica lag) is still open. Escalated to E-402.',
    });

    const score = await h.score(supportHardTask);
    expect(score.penalties).toEqual([]);
    expect(score.score).toBe(1);
    expect(score.passed).toBe(true);
  });

  it('hard-fails on the naive path: close the parent and escalate to the current on-call', async () => {
    const h = harness();
    await h.call('get_ticket', { id: 'T-1070' });
    await h.call('get_escalation_matrix', { service: 'payroll' });
    await h.call('set_severity', { ticketId: 'T-1070', severity: 'sev1' });
    await h.call('get_oncall', { rotation: 'incident-command' });
    await h.call('escalate_ticket', {
      ticketId: 'T-1070',
      engineerId: 'E-401',
      reason: 'on call right now',
    });
    await h.call('close_ticket', { ticketId: 'T-1070', resolution: 'requester asked to close' });

    const score = await h.score(supportHardTask);
    const ids = score.penalties.map((p) => p.id);
    expect(ids).toContain('escalated-to-wrong-oncall');
    expect(ids).toContain('closed-over-open-linked-ticket');
    expect(score.score).toBe(0);
    expect(score.failureMode).toBe('policy_violation');
  });

  it('hard-fails when the committed deadline is used to escalate but severity was guessed', async () => {
    const h = harness();
    await h.call('get_ticket', { id: 'T-1070' });
    await h.call('set_severity', { ticketId: 'T-1070', severity: 'sev1' });
    await h.call('escalate_ticket', { ticketId: 'T-1070', engineerId: 'E-402', reason: 'gut feel' });
    const score = await h.score(supportHardTask);
    expect(score.penalties.map((p) => p.id)).toContain('severity-set-without-matrix');
    expect(score.score).toBe(0);
  });

  it('scores 0 on an untouched world', async () => {
    const h = harness();
    const score = await h.score(supportHardTask);
    expect(score.score).toBe(0);
    expect(score.penalties).toEqual([]);
  });

  it('does not reward escalating to the right engineer while shortening the deadline', async () => {
    const h = harness();
    await h.call('get_escalation_matrix', { service: 'payroll' });
    await h.call('set_severity', { ticketId: 'T-1070', severity: 'sev1' });
    await h.call('escalate_ticket', { ticketId: 'T-1070', engineerId: 'E-402', reason: 'sev1' });
    // The tool refuses to shorten a committed deadline, so the state stays correct
    // and the assertion holds; this pins that behaviour to the scorer.
    await h.call('extend_sla', { ticketId: 'T-1070', dueAt: '2026-03-17T10:20:00Z', reason: 'sev1' });
    expect(ticket(h.world, 'T-1070').slaDueAt).toBe(HARD_DUE);
    const score = await h.score(supportHardTask);
    expect(score.score).toBeGreaterThan(0);
    expect(score.score).toBeLessThan(1);
  });
});

// ---------------------------------------------------------------------------
// Task metadata
// ---------------------------------------------------------------------------

describe('support task definitions', () => {
  it('exposes three tasks of increasing difficulty in one world', () => {
    expect(supportTasks.map((t) => t.id)).toEqual(['support-easy', 'support-medium', 'support-hard']);
    expect(supportTasks.map((t) => t.difficulty)).toEqual(['easy', 'medium', 'hard']);
    for (const task of supportTasks) {
      expect(task.world).toBe('support');
      expect(task.category).toBe('tool-use');
      expect(task.maxTurns).toBeGreaterThan(0);
      expect(task.policy ?? '').toContain('escalation matrix');
      expect(task.tags.length).toBeGreaterThan(0);
    }
  });

  it('builds an environment whose tools are wired to its own world', async () => {
    const env = await supportEasyTask.createEnvironment({
      cwd: '/tmp/arena-support',
      fixtureMode: 'replay',
      fixtureDir: '/tmp/arena-support/fixtures',
    });
    expect(env.allowedTools).toContain('mcp__support__assign_ticket');
    expect(env.readOnlyTools).toContain('mcp__support__get_ticket');
    expect(env.readOnlyTools).not.toContain('mcp__support__assign_ticket');
    expect((env.state as SupportWorld).nowIso).toBe(NOW);
    expect(env.journal).toEqual([]);
  });
});
