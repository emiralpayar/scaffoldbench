/**
 * Canary for the model-call path.
 *
 * Starts real Agent SDK sessions through the real `runQuery` — the sandbox
 * guard, the per-call MCP servers, the hermetic options, the budget leases —
 * against an in-process MCP server built the way every task builds one. Four
 * calls run at the same time on one environment:
 *
 *   tools-a, tools-b  the full toolset; each must connect its own server and,
 *                     with a model, use it
 *   read-only         must be shown only the read-only tool
 *   structured        no task tools and a JSON schema; must be shown no task
 *                     server and, with a model, answer through the
 *                     structured-output tool without being denied
 *
 * Every session must list only the MCP servers it was given, so an operator's
 * claude.ai connectors leaking into a run fail the check.
 *
 *   npm run check:wiring                    # real model calls, a few cents
 *   npm run check:wiring -- --init-only     # free: offline, stops each session at start-up
 *   npm run check:wiring -- --model claude-sonnet-5-5 --max-cost 0.5
 *
 * `--init-only` needs no credentials, because a session reports its servers
 * and tools before it authenticates. It is free because it is offline: a
 * session sends its first request right after that report, and the script
 * only stops the sessions once the last of them has reported, so on a machine
 * with a login or a key the others would already have called the model. The
 * sessions therefore run with no credential variable and against a port
 * nothing listens on. Exits non-zero with a description of what was wrong.
 */

import { z } from 'zod';
import {
  BudgetTracker,
  CREDENTIAL_ENV_VARS,
  STRUCTURED_OUTPUT_TOOL,
  TraceCollector,
  createJournaledToolServer,
  runQuery,
} from '@scaffoldbench/core';
import type { QueryOutcome, QuerySpec, RunContext, Task, ToolCall, TraceEvent } from '@scaffoldbench/core';

const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
const DEFAULT_MAX_COST_USD = 0.4;
const TIMEOUT_MS = 120_000;
/** Where `--init-only` sessions are pointed: the discard port, on which nothing listens. */
const OFFLINE_ENDPOINT = 'http://127.0.0.1:9';
const SERVER = 'wiringcheck';
const READ_TOOL = `mcp__${SERVER}__read_thing`;
const WRITE_TOOL = `mcp__${SERVER}__write_thing`;

interface Args {
  model: string;
  initOnly: boolean;
  maxCostUsd: number;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { model: DEFAULT_MODEL, initOnly: false, maxCostUsd: DEFAULT_MAX_COST_USD };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--init-only') args.initOnly = true;
    else if (flag === '--model') args.model = argv[++i] ?? args.model;
    else if (flag === '--max-cost') args.maxCostUsd = Number(argv[++i] ?? args.maxCostUsd);
    else throw new Error(`unknown argument: ${flag}`);
  }
  if (!Number.isFinite(args.maxCostUsd) || args.maxCostUsd <= 0) {
    throw new Error('--max-cost must be a positive number of USD');
  }
  return args;
}

/**
 * This process's environment with every credential source removed and the API
 * endpoint unreachable. A session on it still starts, connects its MCP servers
 * and reports its tools, but cannot send a request anywhere, whatever Claude
 * Code login the machine has.
 */
function offlineEnv(base: NodeJS.ProcessEnv = process.env): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...base };
  for (const name of CREDENTIAL_ENV_VARS) delete env[name];
  env.ANTHROPIC_BASE_URL = OFFLINE_ENDPOINT;
  return env;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const journal: ToolCall[] = [];
  const server = createJournaledToolServer({
    name: SERVER,
    instructions: 'Canary server.',
    journal,
    tools: [
      {
        name: 'read_thing',
        description: 'Read a thing by id',
        schema: { id: z.string() },
        readOnly: true,
        handler: (input: { id: string }) => `thing ${input.id} is blue`,
      },
      {
        name: 'write_thing',
        description: 'Write a thing',
        schema: { id: z.string(), value: z.string() },
        handler: (input: { id: string; value: string }) => `wrote ${input.id}=${input.value}`,
      },
    ],
  });

  const problems: string[] = [];
  if (server.readOnlyTools.join() !== READ_TOOL) {
    problems.push(`read-only filtering is wrong: ${JSON.stringify(server.readOnlyTools)}`);
  }

  const specs: QuerySpec[] = [
    {
      phase: 'tools-a',
      prompt: 'Call the read_thing tool with id "alpha", then reply with exactly the text it returned.',
    },
    {
      phase: 'tools-b',
      prompt: 'Call the read_thing tool with id "beta", then reply with exactly the text it returned.',
    },
    {
      phase: 'read-only',
      prompt: 'Reply with the word "ready".',
      allowedTools: [...server.readOnlyTools],
    },
    {
      phase: 'structured',
      prompt: 'What is 2 + 3? Give the number as the answer.',
      allowedTools: [],
      outputSchema: {
        type: 'object',
        properties: { answer: { type: 'integer' } },
        required: ['answer'],
        additionalProperties: false,
      },
    },
  ];

  // In --init-only mode, stop every session once all of them have started.
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), TIMEOUT_MS);
  let inits = 0;
  const trace = new TraceCollector({
    onAppend: (event) => {
      if (event.kind === 'system_init' && ++inits === specs.length && args.initOnly) stop.abort();
    },
  });
  const budget = new BudgetTracker({ maxCostUsd: args.maxCostUsd, maxWallClockMs: TIMEOUT_MS });

  const ctx: RunContext = {
    runId: 'wiring-check',
    task: { id: 'wiring-check', maxTurns: 4 } as Task,
    strategyId: 'wiring-check',
    model: args.model,
    effort: 'low',
    env: {
      createMcpServers: server.createMcpServers,
      allowedTools: server.allowedTools,
      readOnlyTools: server.readOnlyTools,
      state: {},
      journal,
    },
    cwd: process.cwd(),
    signal: stop.signal,
    budget,
    trace,
    systemPrompt: 'You are a wiring canary. Do exactly what the user asks and nothing else.',
    ...(args.initOnly ? { subprocessEnv: offlineEnv() } : {}),
  };

  // Equal shares, as `runAll` hands out to concurrent phases.
  const share = budget.availableUsd / specs.length;
  let outcomes: QueryOutcome[];
  try {
    outcomes = await Promise.all(specs.map((spec) => runQuery(ctx, { ...spec, maxBudgetUsd: share })));
  } finally {
    clearTimeout(timer);
  }

  const initOf = (outcome: QueryOutcome): TraceEvent | undefined =>
    trace.events.find((e) => e.kind === 'system_init' && e.callId === outcome.callId);
  const toolsOf = (outcome: QueryOutcome): string[] =>
    ((initOf(outcome)?.meta?.tools as string[] | undefined) ?? []).filter(
      (name) => name.startsWith(`mcp__${SERVER}__`) || name === STRUCTURED_OUTPUT_TOOL,
    );

  for (const [index, outcome] of outcomes.entries()) {
    const phase = specs[index]?.phase ?? '?';
    if (!initOf(outcome)) {
      problems.push(`${phase}: never received an init message (${outcome.error ?? outcome.subtype})`);
      continue;
    }
    // Hermeticity: nothing but the servers this call was given.
    const unexpected = outcome.mcpServers.filter((s) => !outcome.mcpServersExpected.includes(s.name));
    if (unexpected.length > 0) {
      problems.push(`${phase}: unexpected MCP servers loaded: ${JSON.stringify(unexpected)}`);
    }
    for (const name of outcome.mcpServersExpected) {
      const status = outcome.mcpServers.find((s) => s.name === name)?.status;
      if (status !== 'connected') problems.push(`${phase}: MCP server ${name} is ${status ?? 'missing'}`);
    }
  }

  const [toolsA, toolsB, readOnly, structured] = outcomes as [
    QueryOutcome,
    QueryOutcome,
    QueryOutcome,
    QueryOutcome,
  ];

  for (const outcome of [toolsA, toolsB]) {
    const shown = toolsOf(outcome);
    if (!shown.includes(READ_TOOL) || !shown.includes(WRITE_TOOL)) {
      problems.push(`a full-toolset call was shown ${JSON.stringify(shown)}`);
    }
  }
  if (toolsOf(readOnly).join() !== READ_TOOL) {
    problems.push(`the read-only call was shown ${JSON.stringify(toolsOf(readOnly))}`);
  }
  if (structured.mcpServersExpected.length > 0 || toolsOf(structured).join() !== STRUCTURED_OUTPUT_TOOL) {
    problems.push(
      `the tool-less structured call was shown ${JSON.stringify(toolsOf(structured))} ` +
        `with servers ${JSON.stringify(structured.mcpServersExpected)}`,
    );
  }

  if (!args.initOnly) {
    for (const [index, outcome] of outcomes.entries()) {
      const phase = specs[index]?.phase ?? '?';
      if (outcome.apiError) {
        problems.push(
          `${phase}: the model call failed (${outcome.apiError.kind}): ${outcome.apiError.message}` +
            (outcome.apiError.kind === 'auth' ? ' — run with --init-only to check without credentials' : ''),
        );
      } else if (outcome.subtype !== 'success') {
        problems.push(`${phase}: ended ${outcome.subtype}${outcome.error ? `: ${outcome.error}` : ''}`);
      }
      if (outcome.deniedToolCalls > 0) problems.push(`${phase}: ${outcome.deniedToolCalls} tool call(s) denied`);
    }
    const answer = (structured.structured as { answer?: unknown } | undefined)?.answer;
    if (structured.structuredMissing || answer !== 5) {
      problems.push(`structured output missing or wrong: ${JSON.stringify(structured.structured)}`);
    }
    const ids = journal.map((entry) => entry.args.id).sort();
    if (JSON.stringify(ids) !== JSON.stringify(['alpha', 'beta'])) {
      problems.push(`the concurrent calls did not both use their tools: journal ids ${JSON.stringify(ids)}`);
    }
  }

  if (problems.length > 0) {
    console.error('Wiring check FAILED:');
    for (const problem of problems) console.error(`  - ${problem}`);
    return 1;
  }

  console.log(`Wiring check OK${args.initOnly ? ' (init only)' : ''}`);
  console.log(`  model      : ${args.model}`);
  const served = outcomes.filter((o) => o.mcpServersExpected.includes(SERVER)).length;
  console.log(
    `  concurrent : ${outcomes.length} sessions at once; the ${served} given a ${SERVER} server each connected its own`,
  );
  console.log(`  read-only  : shown ${toolsOf(readOnly).join(', ')}`);
  console.log(`  structured : shown ${toolsOf(structured).join(', ')}`);
  if (!args.initOnly) {
    console.log(`  tool calls : ${journal.map((entry) => `${entry.name}(${String(entry.args.id)})`).join(', ')}`);
    console.log(`  structured : ${JSON.stringify(structured.structured)}`);
    console.log(`  cost       : $${budget.spentUsd.toFixed(4)}`);
  }
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error('Wiring check crashed:', error);
    process.exit(1);
  });
