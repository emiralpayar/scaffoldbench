/**
 * A scripted stand-in for the Agent SDK's `query()`, for tests that drive the
 * real `runQuery`, judge and strategies.
 *
 * The model is scripted; everything around it behaves like the CLI where it
 * matters to the harness:
 *
 *  - In-process MCP servers are connected through the real MCP protocol
 *    object, which accepts one transport at a time. Two concurrent sessions
 *    handed the same server instance therefore fail exactly as they do in
 *    production: the second reports the server `failed` and sees no tools.
 *  - The tool list in the init message is what the session would really
 *    offer: the structured-output tool when a schema is requested, plus each
 *    connected server's tools as listed over MCP.
 *  - Tool calls go through the session's `PreToolUse` hooks first (the
 *    sandbox guard), then to the owning server's real handler.
 *  - Aborting the session's controller ends the stream with an error.
 *
 * Install it with `vi.mock('@anthropic-ai/claude-agent-sdk', …)` and replace
 * `query` with `fakeQuery`; see `runQuery.test.ts`.
 */

import type { HookCallbackMatcher, Options } from '@anthropic-ai/claude-agent-sdk';

export interface ToolOutcome {
  /** True when a `PreToolUse` hook denied the call. */
  denied: boolean;
  isError: boolean;
  text: string;
}

export interface FakeSession {
  prompt: string;
  options: Options;
  signal: AbortSignal;
  /** Tools listed in the init message. */
  tools: string[];
  mcpServers: { name: string; status: string }[];
  /** Run a tool the way the CLI does: hooks first, then the MCP server that owns it. */
  callTool(name: string, input?: Record<string, unknown>): Promise<ToolOutcome>;
  /** Never resolves; rejects once the session is aborted. */
  untilAborted(): Promise<never>;
}

export type Script = (session: FakeSession) => AsyncIterable<unknown>;

const state: { script: Script | undefined; sessions: FakeSession[] } = {
  script: undefined,
  sessions: [],
};

/** Set the model's behaviour for every session started from now on. */
export function setScript(script: Script): void {
  state.script = script;
}

/** Every session started since the last `resetFake()`, in start order. */
export function sessions(): readonly FakeSession[] {
  return state.sessions;
}

export function resetFake(): void {
  state.script = undefined;
  state.sessions = [];
}

/** Drop-in replacement for the SDK's `query`. */
export function fakeQuery({ prompt, options = {} }: { prompt: string; options?: Options }) {
  return runSession(prompt, options);
}

class AbortError extends Error {
  constructor() {
    super('Claude Code process aborted by user');
    this.name = 'AbortError';
  }
}

async function* runSession(prompt: string, options: Options): AsyncGenerator<unknown, void> {
  const script = state.script;
  if (!script) throw new Error('fakeClaudeCode: no script set');
  const signal = options.abortController?.signal ?? new AbortController().signal;

  const connections = await connectAll(options.mcpServers ?? {});
  const tools = [
    ...(options.outputFormat ? ['StructuredOutput'] : []),
    ...connections.flatMap((c) => c.tools.map((tool) => `mcp__${c.name}__${tool}`)),
  ];

  const session: FakeSession = {
    prompt,
    options,
    signal,
    tools,
    mcpServers: connections.map(({ name, status }) => ({ name, status })),
    callTool: (name, input = {}) => callTool(options, connections, signal, name, input),
    untilAborted: () =>
      new Promise<never>((_, reject) => {
        if (signal.aborted) reject(new AbortError());
        signal.addEventListener('abort', () => reject(new AbortError()), { once: true });
      }),
  };
  state.sessions.push(session);

  try {
    yield {
      type: 'system',
      subtype: 'init',
      model: options.model ?? 'claude-test',
      tools,
      mcp_servers: session.mcpServers,
      permissionMode: options.permissionMode ?? 'default',
    };
    for await (const message of script(session)) {
      if (signal.aborted) throw new AbortError();
      yield message;
    }
  } finally {
    await Promise.all(connections.map((connection) => connection.close()));
  }
}

// ---------------------------------------------------------------------------
// MCP, over the same kind of in-memory transport the SDK uses
// ---------------------------------------------------------------------------

interface JsonRpcMessage {
  jsonrpc: '2.0';
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { message?: string };
}

class InMemoryTransport {
  onmessage?: (message: JsonRpcMessage) => void;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  readonly #pending = new Map<number, (message: JsonRpcMessage) => void>();
  #nextId = 1;
  #closed = false;

  async start(): Promise<void> {}

  async send(message: JsonRpcMessage): Promise<void> {
    if (this.#closed) throw new Error('Transport is closed');
    if (message.id !== undefined && message.method === undefined) {
      this.#pending.get(message.id)?.(message);
      this.#pending.delete(message.id);
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.onclose?.();
  }

  request(method: string, params: unknown): Promise<JsonRpcMessage> {
    const id = this.#nextId++;
    return new Promise((resolve) => {
      this.#pending.set(id, resolve);
      this.onmessage?.({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method: string): void {
    this.onmessage?.({ jsonrpc: '2.0', method });
  }
}

interface Connection {
  name: string;
  status: 'connected' | 'failed';
  tools: string[];
  transport: InMemoryTransport | undefined;
  close(): Promise<void>;
}

interface ConnectableServer {
  connect(transport: InMemoryTransport): Promise<void>;
}

async function connectAll(servers: Record<string, unknown>): Promise<Connection[]> {
  // Connect every server before awaiting any of them, as the SDK does when it
  // constructs a session; the protocol object claims its transport
  // synchronously, which is what makes a shared instance fail.
  const pending = Object.entries(servers).map(([name, config]) => {
    const instance = (config as { type?: string; instance?: ConnectableServer }).instance;
    if ((config as { type?: string }).type !== 'sdk' || !instance) {
      return Promise.resolve(failed(name));
    }
    const transport = new InMemoryTransport();
    return instance.connect(transport).then(
      () => handshake(name, transport),
      () => failed(name),
    );
  });
  return Promise.all(pending);
}

function failed(name: string): Connection {
  return { name, status: 'failed', tools: [], transport: undefined, close: async () => {} };
}

async function handshake(name: string, transport: InMemoryTransport): Promise<Connection> {
  await transport.request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'fake-claude-code', version: '0.0.0' },
  });
  transport.notify('notifications/initialized');
  const listed = await transport.request('tools/list', {});
  const tools = ((listed.result as { tools?: { name: string }[] })?.tools ?? []).map((t) => t.name);
  return { name, status: 'connected', tools, transport, close: () => transport.close() };
}

async function callTool(
  options: Options,
  connections: Connection[],
  signal: AbortSignal,
  name: string,
  input: Record<string, unknown>,
): Promise<ToolOutcome> {
  const matchers: HookCallbackMatcher[] = options.hooks?.PreToolUse ?? [];
  for (const matcher of matchers) {
    for (const hook of matcher.hooks) {
      const output = (await hook(
        {
          hook_event_name: 'PreToolUse',
          tool_name: name,
          tool_input: input,
          tool_use_id: `toolu_${name}`,
          session_id: 'fake-session',
          transcript_path: '',
          cwd: options.cwd ?? '',
        } as never,
        `toolu_${name}`,
        { signal },
      )) as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } };
      if (output.hookSpecificOutput?.permissionDecision === 'deny') {
        return {
          denied: true,
          isError: true,
          text: output.hookSpecificOutput.permissionDecisionReason ?? 'denied',
        };
      }
    }
  }

  if (name === 'StructuredOutput') {
    return { denied: false, isError: false, text: 'Structured output provided successfully' };
  }

  const match = /^mcp__(.+?)__(.+)$/.exec(name);
  const connection = connections.find((c) => c.name === match?.[1]);
  if (!match || !connection?.transport || !connection.tools.includes(match[2] ?? '')) {
    return { denied: false, isError: true, text: `No such tool available: ${name}` };
  }
  const reply = await connection.transport.request('tools/call', {
    name: match[2],
    arguments: input,
  });
  const result = reply.result as { content?: { text?: string }[]; isError?: boolean } | undefined;
  return {
    denied: false,
    isError: result?.isError === true || reply.error !== undefined,
    text: result?.content?.map((part) => part.text ?? '').join('\n') ?? reply.error?.message ?? '',
  };
}

// ---------------------------------------------------------------------------
// Message builders
// ---------------------------------------------------------------------------

export interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

let responseCounter = 0;

/** An assistant response containing `text`. */
export function assistant(
  text: string,
  opts: { id?: string; model?: string; usage?: Usage; parent?: string; error?: string } = {},
) {
  return {
    type: 'assistant',
    parent_tool_use_id: opts.parent ?? null,
    ...(opts.error !== undefined ? { error: opts.error } : {}),
    message: {
      id: opts.id ?? `msg_${++responseCounter}`,
      model: opts.model ?? 'claude-haiku-4-5-20251001',
      content: [{ type: 'text', text }],
      usage: opts.usage ?? { input_tokens: 100, output_tokens: 10 },
    },
  };
}

/** An assistant response that calls `name`. */
export function toolUse(name: string, input: unknown, opts: { id?: string; model?: string; usage?: Usage } = {}) {
  return {
    type: 'assistant',
    parent_tool_use_id: null,
    message: {
      id: opts.id ?? `msg_${++responseCounter}`,
      model: opts.model ?? 'claude-haiku-4-5-20251001',
      content: [{ type: 'tool_use', id: `toolu_${name}`, name, input }],
      usage: opts.usage ?? { input_tokens: 100, output_tokens: 10 },
    },
  };
}

export function toolResult(outcome: ToolOutcome, toolUseId = 'toolu') {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: toolUseId, content: outcome.text, is_error: outcome.isError },
      ],
    },
  };
}

export interface ResultOptions {
  text?: string;
  structured?: unknown;
  costUsd?: number;
  turns?: number;
  usage?: Usage;
  modelUsage?: Record<string, { inputTokens: number; outputTokens: number; costUSD: number }>;
  isError?: boolean;
  apiErrorStatus?: number;
  terminalReason?: string;
}

export function success(opts: ResultOptions = {}) {
  return {
    type: 'result',
    subtype: 'success',
    is_error: opts.isError ?? false,
    result: opts.text ?? '',
    ...(opts.structured !== undefined ? { structured_output: opts.structured } : {}),
    ...(opts.apiErrorStatus !== undefined ? { api_error_status: opts.apiErrorStatus } : {}),
    ...(opts.terminalReason !== undefined ? { terminal_reason: opts.terminalReason } : {}),
    total_cost_usd: opts.costUsd ?? 0.01,
    num_turns: opts.turns ?? 1,
    stop_reason: 'end_turn',
    duration_ms: 1,
    duration_api_ms: 1,
    usage: { ...emptyWireUsage(), ...(opts.usage ?? { input_tokens: 100, output_tokens: 10 }) },
    modelUsage: expandModelUsage(opts.modelUsage),
    permission_denials: [],
  };
}

export function errorResult(
  subtype: 'error_max_turns' | 'error_during_execution' | 'error_max_budget_usd',
  opts: ResultOptions & { errors?: string[] } = {},
) {
  return {
    type: 'result',
    subtype,
    is_error: true,
    errors: opts.errors ?? [subtype],
    ...(opts.terminalReason !== undefined ? { terminal_reason: opts.terminalReason } : {}),
    total_cost_usd: opts.costUsd ?? 0.01,
    num_turns: opts.turns ?? 1,
    stop_reason: null,
    duration_ms: 1,
    duration_api_ms: 1,
    usage: { ...emptyWireUsage(), ...(opts.usage ?? {}) },
    modelUsage: expandModelUsage(opts.modelUsage),
    permission_denials: [],
  };
}

function emptyWireUsage() {
  return { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
}

function expandModelUsage(
  modelUsage: ResultOptions['modelUsage'],
): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const [model, u] of Object.entries(modelUsage ?? {})) {
    out[model] = {
      inputTokens: u.inputTokens,
      outputTokens: u.outputTokens,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      webSearchRequests: 0,
      costUSD: u.costUSD,
      contextWindow: 200_000,
      maxOutputTokens: 64_000,
    };
  }
  return out;
}

/** Resolve after `ms`, so scripts can interleave like real concurrent sessions. */
export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
