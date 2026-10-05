import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  called,
  calledAfter,
  callsTo,
  createJournaledToolServer,
  qualifiedToolName,
} from '@scaffoldbench/core';
import type { ToolCall } from '@scaffoldbench/core';

const entry = (name: string, ok = true): ToolCall => ({
  name,
  args: {},
  tMs: 0,
  ok,
  result: '',
});

describe('qualifiedToolName', () => {
  it('uses the MCP naming convention', () => {
    expect(qualifiedToolName('airline', 'get_reservation')).toBe('mcp__airline__get_reservation');
  });
});

describe('createJournaledToolServer', () => {
  it('exposes fully-qualified allowed tool names', () => {
    const journal: ToolCall[] = [];
    const server = createJournaledToolServer({
      name: 'shop',
      journal,
      tools: [
        {
          name: 'get_order',
          description: 'Read an order',
          schema: { id: z.string() },
          handler: () => 'ok',
        },
      ],
    });

    expect(server.serverName).toBe('shop');
    expect(server.allowedTools).toEqual(['mcp__shop__get_order']);
    expect(Object.keys(server.createMcpServers())).toEqual(['shop']);
  });

  it('builds a server for every declared tool', () => {
    const journal: ToolCall[] = [];
    const server = createJournaledToolServer({
      name: 'shop',
      journal,
      tools: [
        { name: 'a', description: 'a', schema: {}, handler: () => 'a' },
        { name: 'b', description: 'b', schema: {}, handler: () => 'b' },
      ],
    });
    expect(server.allowedTools).toHaveLength(2);
  });

  it('builds a fresh server instance for every call', () => {
    const server = createJournaledToolServer({
      name: 'shop',
      journal: [],
      tools: [{ name: 'a', description: 'a', schema: {}, handler: () => 'a' }],
    });
    const first = server.createMcpServers().shop as { instance?: unknown };
    const second = server.createMcpServers().shop as { instance?: unknown };

    // One MCP server instance can serve only one session at a time.
    expect(first.instance).toBeDefined();
    expect(first.instance).not.toBe(second.instance);
  });

  it('leaves out a server when the filter permits none of its tools', () => {
    const server = createJournaledToolServer({
      name: 'shop',
      journal: [],
      tools: [{ name: 'a', description: 'a', schema: {}, handler: () => 'a' }],
    });

    expect(server.createMcpServers({ only: [] })).toEqual({});
    expect(Object.keys(server.createMcpServers({ only: ['mcp__shop__a'] }))).toEqual(['shop']);
    expect(Object.keys(server.createMcpServers({ only: ['mcp__shop__*'] }))).toEqual(['shop']);
    expect(server.createMcpServers({ only: ['mcp__other__a'] })).toEqual({});
  });
});

describe('journal helpers', () => {
  const journal: ToolCall[] = [
    entry('read_policy'),
    entry('get_order'),
    entry('issue_refund'),
    entry('get_order'),
    entry('cancel_order', false),
  ];

  it('called() only counts successful invocations', () => {
    expect(called(journal, 'issue_refund')).toBe(true);
    expect(called(journal, 'cancel_order')).toBe(false);
    expect(called(journal, 'nope')).toBe(false);
  });

  it('called() accepts several names', () => {
    expect(called(journal, 'nope', 'get_order')).toBe(true);
  });

  it('callsTo() returns every successful call in order', () => {
    expect(callsTo(journal, 'get_order')).toHaveLength(2);
    expect(callsTo(journal, 'cancel_order')).toHaveLength(0);
  });

  it('calledAfter() enforces ordering', () => {
    expect(calledAfter(journal, 'read_policy', 'issue_refund')).toBe(true);
    expect(calledAfter(journal, 'issue_refund', 'read_policy')).toBe(false);
  });

  it('calledAfter() is false when the later call never happened', () => {
    expect(calledAfter(journal, 'read_policy', 'never_called')).toBe(false);
  });

  it('calledAfter() is false when the prerequisite never happened', () => {
    const j = [entry('issue_refund')];
    expect(calledAfter(j, 'read_policy', 'issue_refund')).toBe(false);
  });
});
