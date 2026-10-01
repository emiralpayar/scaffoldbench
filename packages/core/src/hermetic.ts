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
 */
export function hermeticOptions(): Pick<
  Options,
  'settingSources' | 'strictMcpConfig' | 'settings' | 'permissionMode' | 'persistSession'
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
  };
}
