/**
 * Canary for the tool layer.
 *
 * Starts a real Agent SDK session against an in-process MCP server built the
 * same way every task builds one, and stops at the init message. It needs no
 * API key, because the SDK reports the connected servers and registered tools
 * before it authenticates — which makes this a cheap way to catch the class of
 * breakage an SDK upgrade causes: the server object shape changing, tool names
 * no longer being registered, or the MCP handshake failing.
 *
 *   npm run check:wiring
 *
 * Exits non-zero with a description of what was missing.
 */

import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { createJournaledToolServer } from '@arena/core';
import type { ToolCall } from '@arena/core';

const INIT_TIMEOUT_MS = 60_000;

async function main(): Promise<number> {
  const journal: ToolCall[] = [];
  const { createMcpServers, serverName, allowedTools, readOnlyTools } = createJournaledToolServer({
    name: 'wiringcheck',
    instructions: 'Canary server.',
    journal,
    tools: [
      {
        name: 'read_thing',
        description: 'Read a thing',
        schema: { id: z.string() },
        readOnly: true,
        handler: (args: { id: string }) => `thing ${args.id}`,
      },
      {
        name: 'write_thing',
        description: 'Write a thing',
        schema: { id: z.string(), value: z.string() },
        handler: (args: { id: string; value: string }) => `wrote ${args.id}=${args.value}`,
      },
    ],
  });

  const problems: string[] = [];

  if (readOnlyTools.length !== 1 || readOnlyTools[0] !== 'mcp__wiringcheck__read_thing') {
    problems.push(`read-only filtering is wrong: ${JSON.stringify(readOnlyTools)}`);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), INIT_TIMEOUT_MS);

  let init: { tools?: string[]; mcp_servers?: { name: string; status: string }[] } | undefined;

  try {
    for await (const message of query({
      prompt: 'noop',
      options: {
        model: 'claude-sonnet-5',
        systemPrompt: 'canary',
        allowedTools,
        mcpServers: createMcpServers(),
        permissionMode: 'dontAsk',
        settingSources: [],
        persistSession: false,
        maxTurns: 1,
        maxBudgetUsd: 0.05,
        abortController: controller,
      },
    }) as AsyncIterable<SDKMessage>) {
      if (message.type === 'system' && message.subtype === 'init') {
        init = { tools: message.tools, mcp_servers: message.mcp_servers };
        break;
      }
      if (message.type === 'result') break;
    }
  } catch (error) {
    problems.push(`session failed before init: ${error instanceof Error ? error.message : error}`);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }

  if (!init) {
    problems.push('never received an init message');
  } else {
    const connected = init.mcp_servers?.find((s) => s.name === serverName);
    if (connected?.status !== 'connected') {
      problems.push(`MCP server did not connect: ${JSON.stringify(init.mcp_servers)}`);
    }
    for (const expected of allowedTools) {
      if (!init.tools?.includes(expected)) {
        problems.push(`tool not registered with the session: ${expected}`);
      }
    }
  }

  if (problems.length > 0) {
    console.error('Wiring check FAILED:');
    for (const problem of problems) console.error(`  - ${problem}`);
    return 1;
  }

  console.log('Wiring check OK');
  console.log(`  server    : ${serverName} (connected)`);
  console.log(`  tools     : ${allowedTools.join(', ')}`);
  console.log(`  read-only : ${readOnlyTools.join(', ')}`);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error('Wiring check crashed:', error);
    process.exit(1);
  });
