import type { HookCallbackMatcher, HookInput } from '@anthropic-ai/claude-agent-sdk';
import { STRUCTURED_OUTPUT_TOOL } from './hermetic';
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

/** A tool call the agent is about to make, as the `PreToolUse` hook sees it. */
export interface PendingToolCall {
  /** Fully-qualified name, e.g. `mcp__airline__cancel_reservation`. */
  toolName: string;
  toolInput: unknown;
  /** The id the call carries in the trace (`TraceEvent.toolUseId`). */
  toolUseId: string;
}

/** A decision on a pending tool call. A denial's reason is what the agent reads back. */
export type ToolCallDecision = { allow: true } | { allow: false; reason: string };

/**
 * Decides whether a tool call the allowlist permits may run, before it runs.
 *
 * This is how an architecture reviews actions at the point of execution: the
 * call waits for the decision, and a denial comes back to the agent as the
 * tool's result, with the reason, so it can adapt. `signal` aborts when the
 * session stops waiting.
 */
export type ToolCallReviewer = (
  call: PendingToolCall,
  options: { signal: AbortSignal },
) => Promise<ToolCallDecision>;

/**
 * How long the CLI waits on a hook that reviews calls, in seconds. A review
 * is a model call of its own, so it is bounded by the run's wall-clock cap,
 * which aborts it; this only keeps the CLI's own hook timeout out of the way.
 */
export const REVIEW_HOOK_TIMEOUT_SECONDS = 3_600;

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
  /**
   * Consulted for every call the allowlist permits, harness tools excepted.
   * A denial is the reviewer's decision, not a sandbox violation, so it is
   * neither traced as `tool_denied` nor counted by `onDenied`.
   */
  review?: ToolCallReviewer;
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
  const { allowedTools, trace, phase, depth, agent, callId, onDenied, review } = options;

  return [
    {
      ...(review ? { timeout: REVIEW_HOOK_TIMEOUT_SECONDS } : {}),
      hooks: [
        async (input: HookInput, _toolUseId: string | undefined, { signal }: { signal: AbortSignal }) => {
          if (input.hook_event_name !== 'PreToolUse') return {};
          const toolName = input.tool_name;

          if (matchesToolList(toolName, allowedTools)) {
            if (!review || toolName === STRUCTURED_OUTPUT_TOOL) return {};
            const decision = await decide(
              review,
              { toolName, toolInput: input.tool_input, toolUseId: input.tool_use_id },
              signal,
            );
            if (decision.allow) return {};
            return {
              hookSpecificOutput: {
                hookEventName: 'PreToolUse' as const,
                permissionDecision: 'deny' as const,
                permissionDecisionReason: decision.reason,
              },
            };
          }

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

/**
 * A reviewer's decision, failing closed. The CLI lets a call through when its
 * hook throws, so a review that cannot be completed must turn into a denial
 * here or the call would run unreviewed.
 */
async function decide(
  review: ToolCallReviewer,
  call: PendingToolCall,
  signal: AbortSignal,
): Promise<ToolCallDecision> {
  try {
    return await review(call, { signal });
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    return {
      allow: false,
      reason: `This call could not be reviewed (${why}), so it was not run.`,
    };
  }
}
