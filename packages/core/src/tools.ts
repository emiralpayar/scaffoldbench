import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { matchesToolList } from './guard';
import type { McpServerConfig, McpServerFilter, ToolCall } from './types';
import { truncate } from './trace';

/** What a task's tool handler may return. */
export type ToolReply = string | { text: string; isError?: boolean };

export interface JournaledToolSpec {
  name: string;
  description: string;
  /** Raw zod shape, e.g. `{ id: z.string() }`. */
  // Zod's generic shape type is intentionally loose here so tasks can declare
  // schemas without wrestling with variance.
  schema: Record<string, any>;
  /**
   * True when the tool only inspects state.
   *
   * Architectures that explore several approaches before committing to one
   * (`debate-select`) need to know which tools are safe to hand to a proposer
   * that will be thrown away. Without this, running proposals in parallel would
   * have them all mutating the same world.
   */
  readOnly?: boolean;
  handler: (args: any) => Promise<ToolReply> | ToolReply;
}

export interface JournaledServerOptions {
  name: string;
  instructions?: string;
  version?: string;
  tools: JournaledToolSpec[];
  /** Shared array the scorer reads after the run. */
  journal: ToolCall[];
  now?: () => number;
}

export interface JournaledServer {
  serverName: string;
  /**
   * A fresh server instance, keyed by `serverName`, exposing only the tools
   * the filter permits — or `{}` when it permits none. Every instance shares
   * the same handlers, world and journal; this is what a task hands to
   * `TaskEnvironment.createMcpServers`.
   */
  createMcpServers(filter?: McpServerFilter): Record<string, McpServerConfig>;
  /** Fully-qualified names to put in `allowedTools`. */
  allowedTools: string[];
  /** Subset of `allowedTools` that cannot mutate world state. */
  readOnlyTools: string[];
}

export function qualifiedToolName(serverName: string, toolName: string): string {
  return `mcp__${serverName}__${toolName}`;
}

/**
 * Wrap a task's tools so every invocation lands in a journal.
 *
 * The journal is the scorer's ground truth for "what did the agent actually
 * do", independent of anything the agent claims in prose. Handler exceptions
 * are converted into error replies rather than propagating, because a thrown
 * tool would abort the whole run and make the strategy look worse than it is.
 */
export function createJournaledToolServer(options: JournaledServerOptions): JournaledServer {
  const now = options.now ?? Date.now;
  const startedAt = now();
  const { journal, name: serverName } = options;

  const sdkTools = options.tools.map((spec) => ({
    qualifiedName: qualifiedToolName(serverName, spec.name),
    definition: tool(spec.name, spec.description, spec.schema, async (args: unknown) => {
      const argsRecord = (args ?? {}) as Record<string, unknown>;
      let text: string;
      let isError = false;

      try {
        const reply = await spec.handler(argsRecord);
        if (typeof reply === 'string') {
          text = reply;
        } else {
          text = reply.text;
          isError = reply.isError ?? false;
        }
      } catch (error) {
        isError = true;
        text = `Error: ${error instanceof Error ? error.message : String(error)}`;
      }

      journal.push({
        name: spec.name,
        args: argsRecord,
        tMs: now() - startedAt,
        ok: !isError,
        result: truncate(text, 2_000),
      });

      return {
        content: [{ type: 'text' as const, text }],
        ...(isError ? { isError: true } : {}),
      };
    }),
  }));

  return {
    serverName,
    createMcpServers(filter: McpServerFilter = {}): Record<string, McpServerConfig> {
      const { only } = filter;
      const exposed = sdkTools
        .filter(({ qualifiedName }) => only === undefined || matchesToolList(qualifiedName, only))
        .map(({ definition }) => definition);
      if (exposed.length === 0) return {};
      return {
        [serverName]: createSdkMcpServer({
          name: serverName,
          version: options.version ?? '1.0.0',
          ...(options.instructions ? { instructions: options.instructions } : {}),
          tools: exposed,
        }) as McpServerConfig,
      };
    },
    allowedTools: sdkTools.map(({ qualifiedName }) => qualifiedName),
    readOnlyTools: options.tools
      .filter((spec) => spec.readOnly === true)
      .map((spec) => qualifiedToolName(serverName, spec.name)),
  };
}

/** True when the journal contains a successful call to any of `names`. */
export function called(journal: readonly ToolCall[], ...names: string[]): boolean {
  return journal.some((entry) => entry.ok && names.includes(entry.name));
}

/** All successful calls to `name`, in order. */
export function callsTo(journal: readonly ToolCall[], name: string): ToolCall[] {
  return journal.filter((entry) => entry.name === name && entry.ok);
}

/**
 * True when `after` was called and every call to it came after at least one
 * successful call to `before`. Used to express ordering rules such as
 * "read the refund policy before issuing a refund".
 */
export function calledAfter(
  journal: readonly ToolCall[],
  before: string,
  after: string,
): boolean {
  const firstBefore = journal.findIndex((e) => e.ok && e.name === before);
  const firstAfter = journal.findIndex((e) => e.ok && e.name === after);
  if (firstAfter === -1) return false;
  return firstBefore !== -1 && firstBefore < firstAfter;
}
