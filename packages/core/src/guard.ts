import type { HookCallbackMatcher, HookInput } from '@anthropic-ai/claude-agent-sdk';
import type { TraceSink } from './types';

/**
 * Built-in tools that must never run during a benchmark.
 *
 * A strategy that could shell out or hit the open web would not be solving the
 * task through the sandbox the task defined, and its score would not be
 * comparable to the others. `runQuery` already offers no built-in tools at all
 * (it pins `tools` to the harness's own), so this list is the second line of
 * defence, in case a future SDK starts injecting one regardless.
 */
export const SANDBOX_DENYLIST: readonly string[] = [
  'Bash',
  'BashOutput',
  'KillShell',
  'Write',
  'Edit',
  'NotebookEdit',
  'Read',
  'Glob',
  'Grep',
  'WebFetch',
  'WebSearch',
  'Monitor',
  'Artifact',
  'EnterWorktree',
  'ExitWorktree',
  'CronCreate',
  'CronDelete',
  'RemoteTrigger',
  'PushNotification',
];

export interface SandboxGuardOptions {
  /** Fully-qualified tool names the agent may call, plus any harness tools. */
  allowedTools: readonly string[];
  trace: TraceSink;
  phase: string;
  depth: number;
  agent?: string;
  /** The call this guard belongs to, stamped on its trace events. */
  callId?: string;
  onDenied?: (toolName: string) => void;
}

/** True when `toolName` matches an entry of `allowed`, exactly or by a trailing `*` wildcard. */
export function matchesToolList(toolName: string, allowed: readonly string[]): boolean {
  for (const pattern of allowed) {
    if (pattern === toolName) return true;
    // Support `mcp__server__*` style wildcards used by MCP allowlists.
    if (pattern.endsWith('*') && toolName.startsWith(pattern.slice(0, -1))) return true;
  }
  return false;
}

/**
 * Defence in depth for the sandbox.
 *
 * `permissionMode: 'dontAsk'` plus an exact `allowedTools` list already blocks
 * unapproved tools, but the denial is invisible. This hook makes each attempt
 * an explicit `tool_denied` trace event, which is what lets the report
 * distinguish "the strategy never tried to escape" from "it tried and was
 * stopped" — a real behavioural difference between architectures.
 */
export function createSandboxGuard(options: SandboxGuardOptions): HookCallbackMatcher[] {
  const { allowedTools, trace, phase, depth, agent, callId, onDenied } = options;

  return [
    {
      hooks: [
        async (input: HookInput) => {
          if (input.hook_event_name !== 'PreToolUse') return {};
          const toolName = input.tool_name;

          if (matchesToolList(toolName, allowedTools)) return {};

          onDenied?.(toolName);
          trace.append({
            phase,
            depth,
            ...(agent !== undefined ? { agent } : {}),
            ...(callId !== undefined ? { callId } : {}),
            kind: 'tool_denied',
            toolName,
            toolInput: input.tool_input,
            isError: true,
            text: `Blocked by sandbox guard: ${toolName} is not part of this task's toolset.`,
          });

          return {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse' as const,
              permissionDecision: 'deny' as const,
              permissionDecisionReason:
                `The tool "${toolName}" is not available for this task. ` +
                `Use only the tools provided by the task's toolset.`,
            },
          };
        },
      ],
    },
  ];
}
