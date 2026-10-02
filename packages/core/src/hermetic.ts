import type { Options } from '@anthropic-ai/claude-agent-sdk';

/**
 * The tool the SDK injects when a call asks for structured output: the model
 * delivers its schema-shaped reply by calling it. It is part of the harness,
 * not of any task's toolset, so it has to be allowed explicitly wherever a
 * schema is requested — the sandbox guard once denied it, which silently
 * broke every planner, decomposer and selector in the first published run.
 * (Name taken from the CLI bundled with Agent SDK 0.3.287.)
 */
export const STRUCTURED_OUTPUT_TOOL = 'StructuredOutput';

/**
 * Variables through which a Claude Code session describes itself to the
 * processes it starts, or that it passes on from its own environment: that
 * the process runs inside Claude Code (`CLAUDECODE`, a child session), as
 * which session, entrypoint and process, on which session-messaging socket,
 * Remote Control bridge or IDE port, as which named agent.
 *
 * A benchmark started from inside a Claude Code session — by an operator, or
 * by an agent driving it — hands them on to every model call it makes. Its
 * sessions then report the host's entrypoint (`cli`) instead of the SDK's
 * own, run as children of a session that has nothing to do with them,
 * register with the host's session-messaging socket and token, and may
 * connect to the host's IDE. Started from a plain terminal, the same
 * benchmark has none of them, so they are removed.
 */
export const HOST_SESSION_ENV_VARS: readonly string[] = [
  'CLAUDECODE',
  'CLAUDE_PID',
  'CLAUDE_EFFORT',
  'AI_AGENT',
  'TRACEPARENT',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_SESSION_LOG',
  'CLAUDE_CODE_BRIDGE_SESSION_ID',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_SSE_PORT',
  'CLAUDE_CODE_AGENT',
  'CLAUDE_CODE_INVOKED_SKILLS',
  'CLAUDE_JOB_DIR',
];

/**
 * The subprocess environment for a model call: `base` without the
 * host-session variables. Credentials, `PATH`, `HOME` and everything else
 * are kept, because the SDK uses the environment it is given in place of
 * this process's, not on top of it.
 */
export function hermeticEnv(
  base: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string | undefined> {
  const env = { ...base };
  for (const name of HOST_SESSION_ENV_VARS) delete env[name];
  return env;
}

/**
 * Session options that make a model call independent of the machine and the
 * account running it.
 *
 * Without them a session picks up the operator's `~/.claude` settings, any
 * `.mcp.json` it can find and the claude.ai connectors attached to the
 * logged-in account: Gmail, Google Drive and Google Calendar appear in 70 of
 * the 252 session inits of the first run set. They were inert there because
 * they were unauthenticated, but on another host their tools would enter the
 * prompt, and two runs of the same task would no longer be comparable. Every
 * model call the harness makes — agent phases and the judge alike — starts
 * from these.
 *
 * `env` is the environment the call should run on (the run's
 * `subprocessEnv`, a visitor's for the live demo); by default this
 * process's. Either way it is passed through `hermeticEnv`.
 */
export function hermeticOptions(
  env?: Readonly<Record<string, string | undefined>>,
): Pick<
  Options,
  'settingSources' | 'strictMcpConfig' | 'settings' | 'permissionMode' | 'persistSession' | 'env'
> {
  return {
    // Never inherit user, project or local settings files.
    settingSources: [],
    // Only the MCP servers passed in `mcpServers`: no `.mcp.json`, plugins or user config.
    strictMcpConfig: true,
    // Account-level claude.ai connectors are not settings files, so they need
    // their own switch.
    settings: { disableClaudeAiConnectors: true },
    // Only pre-approved tools may run, and nothing prompts an operator.
    permissionMode: 'dontAsk',
    persistSession: false,
    // Nothing of a Claude Code session this benchmark may be running inside.
    env: hermeticEnv(env),
  };
}
