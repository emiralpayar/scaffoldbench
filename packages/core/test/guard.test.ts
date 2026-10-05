import { describe, expect, it } from 'vitest';
import {
  REVIEW_HOOK_TIMEOUT_SECONDS,
  SANDBOX_DENYLIST,
  STRUCTURED_OUTPUT_TOOL,
  TraceCollector,
  createSandboxGuard,
} from '@scaffoldbench/core';
import type { PendingToolCall, ToolCallReviewer } from '@scaffoldbench/core';
import type { HookInput } from '@anthropic-ai/claude-agent-sdk';

const preToolUse = (toolName: string, input: unknown = {}): HookInput =>
  ({
    hook_event_name: 'PreToolUse',
    tool_name: toolName,
    tool_input: input,
    tool_use_id: 'tu_1',
  }) as unknown as HookInput;

function makeGuard(allowedTools: string[]) {
  const trace = new TraceCollector();
  const denied: string[] = [];
  const matchers = createSandboxGuard({
    allowedTools,
    trace,
    phase: 'main',
    depth: 0,
    onDenied: (name) => denied.push(name),
  });
  const hook = matchers[0]?.hooks[0];
  if (!hook) throw new Error('guard produced no hook');
  return { hook, trace, denied };
}

const invoke = (hook: ReturnType<typeof makeGuard>['hook'], input: HookInput) =>
  hook(input, 'tu_1', { signal: new AbortController().signal });

describe('SANDBOX_DENYLIST', () => {
  it('covers filesystem and open-web built-ins', () => {
    for (const name of ['Bash', 'Write', 'Read', 'WebFetch', 'WebSearch', 'Glob', 'Grep']) {
      expect(SANDBOX_DENYLIST).toContain(name);
    }
  });

  it('does not block Agent, which subagent architectures need', () => {
    expect(SANDBOX_DENYLIST).not.toContain('Agent');
    expect(SANDBOX_DENYLIST).not.toContain('Task');
  });
});

describe('createSandboxGuard', () => {
  it('allows a tool on the allowlist', async () => {
    const { hook, trace, denied } = makeGuard(['mcp__airline__get_reservation']);
    const result = await invoke(hook, preToolUse('mcp__airline__get_reservation'));

    expect(result).toEqual({});
    expect(denied).toEqual([]);
    expect(trace.countOf('tool_denied')).toBe(0);
  });

  it('denies a tool that is not on the allowlist', async () => {
    const { hook, trace, denied } = makeGuard(['mcp__airline__get_reservation']);
    const result = await invoke(hook, preToolUse('Bash', { command: 'ls /' }));

    expect(result).toMatchObject({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny' },
    });
    expect(denied).toEqual(['Bash']);
    expect(trace.countOf('tool_denied')).toBe(1);
  });

  it('records what the blocked call was trying to do', async () => {
    const { hook, trace } = makeGuard([]);
    await invoke(hook, preToolUse('Write', { file_path: '/etc/passwd' }));

    const event = trace.events[0];
    expect(event?.toolName).toBe('Write');
    expect(event?.toolInput).toEqual({ file_path: '/etc/passwd' });
    expect(event?.isError).toBe(true);
    expect(event?.text).toContain('Blocked by sandbox guard');
  });

  it('explains the denial to the model so it can adapt', async () => {
    const { hook } = makeGuard([]);
    const result = (await invoke(hook, preToolUse('WebSearch'))) as {
      hookSpecificOutput: { permissionDecisionReason: string };
    };
    expect(result.hookSpecificOutput.permissionDecisionReason).toContain('WebSearch');
    expect(result.hookSpecificOutput.permissionDecisionReason).toContain('not available');
  });

  it('supports wildcard allowlist entries', async () => {
    const { hook, denied } = makeGuard(['mcp__web__*']);
    expect(await invoke(hook, preToolUse('mcp__web__fetch_page'))).toEqual({});
    expect(await invoke(hook, preToolUse('mcp__web__search'))).toEqual({});
    await invoke(hook, preToolUse('mcp__airline__cancel'));
    expect(denied).toEqual(['mcp__airline__cancel']);
  });

  it('ignores hook events other than PreToolUse', async () => {
    const { hook, trace } = makeGuard([]);
    const result = await invoke(hook, {
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
    } as unknown as HookInput);

    expect(result).toEqual({});
    expect(trace.countOf('tool_denied')).toBe(0);
  });

  it('counts every attempt, so repeated escapes are visible in the report', async () => {
    const { hook, denied } = makeGuard([]);
    await invoke(hook, preToolUse('Bash'));
    await invoke(hook, preToolUse('Bash'));
    await invoke(hook, preToolUse('Read'));
    expect(denied).toEqual(['Bash', 'Bash', 'Read']);
  });
});

describe('createSandboxGuard with a reviewer', () => {
  function makeReviewedGuard(allowedTools: string[], review: ToolCallReviewer) {
    const trace = new TraceCollector();
    const denied: string[] = [];
    const matchers = createSandboxGuard({
      allowedTools,
      trace,
      phase: 'execute',
      depth: 0,
      onDenied: (name) => denied.push(name),
      review,
    });
    const hook = matchers[0]?.hooks[0];
    if (!hook) throw new Error('guard produced no hook');
    return { matchers, hook, trace, denied };
  }

  it('asks the reviewer about a permitted call and lets an allowed one run', async () => {
    const seen: PendingToolCall[] = [];
    const { hook } = makeReviewedGuard(['mcp__shop__refund'], async (call) => {
      seen.push(call);
      return { allow: true };
    });

    expect(await invoke(hook, preToolUse('mcp__shop__refund', { id: 'O-1' }))).toEqual({});
    expect(seen).toEqual([{ toolName: 'mcp__shop__refund', toolInput: { id: 'O-1' }, toolUseId: 'tu_1' }]);
  });

  it('returns a denial with the reviewer’s reason, without calling it a sandbox violation', async () => {
    const { hook, trace, denied } = makeReviewedGuard(['mcp__shop__refund'], async () => ({
      allow: false,
      reason: 'The order is not eligible for a refund.',
    }));

    const result = await invoke(hook, preToolUse('mcp__shop__refund'));

    expect(result).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'The order is not eligible for a refund.',
      },
    });
    expect(denied).toEqual([]);
    expect(trace.countOf('tool_denied')).toBe(0);
  });

  it('denies a call whose review throws, since the CLI would run it unreviewed', async () => {
    const { hook } = makeReviewedGuard(['mcp__shop__refund'], async () => {
      throw new Error('reviewer offline');
    });

    const result = (await invoke(hook, preToolUse('mcp__shop__refund'))) as {
      hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string };
    };
    expect(result.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(result.hookSpecificOutput.permissionDecisionReason).toContain('reviewer offline');
  });

  it('never sends a call outside the allowlist, or a harness tool, for review', async () => {
    const seen: string[] = [];
    const { hook, denied } = makeReviewedGuard(['mcp__shop__refund', STRUCTURED_OUTPUT_TOOL], async (call) => {
      seen.push(call.toolName);
      return { allow: true };
    });

    await invoke(hook, preToolUse('Bash'));
    expect(await invoke(hook, preToolUse(STRUCTURED_OUTPUT_TOOL))).toEqual({});

    expect(seen).toEqual([]);
    expect(denied).toEqual(['Bash']);
  });

  it('keeps the CLI’s hook timeout out of a review’s way', () => {
    const { matchers } = makeReviewedGuard([], async () => ({ allow: true }));
    expect(matchers[0]?.timeout).toBe(REVIEW_HOOK_TIMEOUT_SECONDS);
    const plain = createSandboxGuard({ allowedTools: [], trace: new TraceCollector(), phase: 'p', depth: 0 });
    expect(plain[0]?.timeout).toBeUndefined();
  });
});
