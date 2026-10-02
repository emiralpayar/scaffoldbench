import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@anthropic-ai/claude-agent-sdk')>();
  const fake = await import('./support/fakeClaudeCode');
  return { ...actual, query: fake.fakeQuery };
});

import {
  DEFAULT_JUDGE_EFFORT,
  JudgeError,
  STRUCTURED_OUTPUT_TOOL,
  buildScore,
  createJudge,
  runMatrix,
  sampleJudge,
} from '@arena/core';
import type { Judge, JudgeRequest, Strategy, Task } from '@arena/core';
import { assistant, resetFake, sessions, setScript, success } from './support/fakeClaudeCode';

/**
 * The judge, driven through a scripted SDK: what it is allowed to see, whose
 * credentials it runs on, what its failures cost, and how a grading outage is
 * kept from being scored as the agent's mistake.
 */

const MODEL = 'claude-haiku-4-5-20251001';
const REQUEST: JudgeRequest = {
  system: 'Grade the answer.',
  prompt: 'Answer: 308 is cacheable.',
  schema: { type: 'object', properties: { met: { type: 'boolean' } }, required: ['met'] },
};

afterEach(() => resetFake());

describe('createJudge', () => {
  it('runs tool-less, hermetic and at a pinned effort', async () => {
    setScript(async function* (session) {
      await session.callTool(STRUCTURED_OUTPUT_TOOL, { met: true });
      yield success({ structured: { met: true }, costUsd: 0.02 });
    });

    const reply = await createJudge({ model: MODEL })<{ met: boolean }>(REQUEST);

    expect(reply).toEqual({ value: { met: true }, costUsd: 0.02 });
    const { options, tools } = sessions()[0]!;
    expect(options.tools).toEqual([STRUCTURED_OUTPUT_TOOL]);
    expect(options.allowedTools).toEqual([STRUCTURED_OUTPUT_TOOL]);
    expect(options.mcpServers).toEqual({});
    expect(tools).toEqual([STRUCTURED_OUTPUT_TOOL]);
    expect(options.strictMcpConfig).toBe(true);
    expect(options.settings).toEqual({ disableClaudeAiConnectors: true });
    expect(options.settingSources).toEqual([]);
    expect(options.effort).toBe(DEFAULT_JUDGE_EFFORT);
    expect(options.abortController).toBeInstanceOf(AbortController);
    expect(options.env?.PATH).toBe(process.env.PATH);
  });

  it('grades outside any Claude Code session the benchmark may run inside', async () => {
    vi.stubEnv('CLAUDECODE', '1');
    vi.stubEnv('CLAUDE_CODE_MESSAGING_SOCKET', '/tmp/host.sock');
    setScript(async function* () {
      yield success({ structured: { met: true } });
    });

    try {
      await createJudge({ model: MODEL })(REQUEST);
      await createJudge({ model: MODEL })(REQUEST, { env: { PATH: '/usr/bin', CLAUDECODE: '1' } });
    } finally {
      vi.unstubAllEnvs();
    }

    const [own, given] = sessions().map((s) => s.options.env ?? {});
    expect(own).not.toHaveProperty('CLAUDECODE');
    expect(own).not.toHaveProperty('CLAUDE_CODE_MESSAGING_SOCKET');
    expect(given).toEqual({ PATH: '/usr/bin' });
  });

  it('grades at the effort a request names, and at its own otherwise', async () => {
    setScript(async function* () {
      yield success({ structured: { met: true } });
    });
    const judge = createJudge({ model: MODEL, effort: 'high' });

    await judge(REQUEST);
    await judge({ ...REQUEST, effort: 'low' });

    expect(sessions().map((s) => s.options.effort)).toEqual(['high', 'low']);
    expect(judge.info.effort).toBe('high');
  });

  it('runs on the environment it is given, and a per-call one wins', async () => {
    setScript(async function* () {
      yield success({ structured: { met: true } });
    });
    const judge = createJudge({ model: MODEL, env: { ANTHROPIC_API_KEY: 'judge-key' } });

    await judge(REQUEST);
    await judge(REQUEST, { env: { ANTHROPIC_API_KEY: 'visitor-key' } });

    expect(sessions().map((s) => s.options.env?.ANTHROPIC_API_KEY)).toEqual([
      'judge-key',
      'visitor-key',
    ]);
  });

  it('gives up on a call that never answers, and still accounts for its cost', async () => {
    setScript(async function* (session) {
      yield assistant('thinking…', { usage: { input_tokens: 20_000, output_tokens: 1_000 } });
      await session.untilAborted();
    });
    const costs: number[] = [];

    const failure = await createJudge({ model: MODEL, timeoutMs: 20, onCost: (usd) => costs.push(usd) })(
      REQUEST,
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(JudgeError);
    const error = failure as JudgeError;
    expect(error.apiError).toMatchObject({ kind: 'server', retryable: true });
    // 20k in + 1k out at Haiku 4.5 list price.
    expect(error.costUsd).toBeCloseTo(0.02 + 0.005, 10);
    expect(costs).toEqual([error.costUsd]);
  });

  it('reports an API failure, with what the call cost', async () => {
    setScript(async function* () {
      yield assistant('API Error: 529 Overloaded', { model: '<synthetic>', error: 'overloaded', usage: {} });
      yield success({ text: 'API Error: 529 Overloaded', isError: true, costUsd: 0.003 });
    });

    const error = (await createJudge({ model: MODEL })(REQUEST).catch((e: unknown) => e)) as JudgeError;

    expect(error).toBeInstanceOf(JudgeError);
    expect(error.apiError?.kind).toBe('overloaded');
    expect(error.costUsd).toBe(0.003);
  });

  it('says when the grader refused rather than failing at the API', async () => {
    const notice = "API Error: Haiku 4.5's safeguards flagged this message.";
    setScript(async function* () {
      yield {
        type: 'assistant',
        parent_tool_use_id: null,
        error: 'invalid_request',
        message: {
          id: 'msg_refusal',
          model: '<synthetic>',
          content: [{ type: 'text', text: notice }],
          stop_reason: 'refusal',
          stop_details: { type: 'refusal', category: 'cyber', explanation: null },
          usage: {},
        },
      };
      yield success({ text: notice, isError: true, costUsd: 0.001 });
    });

    const error = (await createJudge({ model: MODEL })(REQUEST).catch((e: unknown) => e)) as JudgeError;

    expect(error).toBeInstanceOf(JudgeError);
    expect(error.apiError).toBeUndefined();
    expect(error.message).toMatch(/^judge could not finish \(refusal\): Haiku 4\.5's safeguards/);
    expect(error.costUsd).toBe(0.001);
  });

  it('distinguishes a reply it cannot parse from an outage', async () => {
    setScript(async function* () {
      yield success({ text: 'I think it is met.', costUsd: 0.004 });
    });

    const error = (await createJudge({ model: MODEL })(REQUEST).catch((e: unknown) => e)) as JudgeError;

    expect(error).toBeInstanceOf(JudgeError);
    expect(error.apiError).toBeUndefined();
    expect(error.costUsd).toBe(0.004);
  });
});

describe('grading inside a run', () => {
  /** A research-style task whose score depends entirely on the judge. */
  function judgedTask(): Task {
    return {
      id: 'judged',
      category: 'research',
      world: 'web',
      title: 'Judged task',
      prompt: 'Explain 308.',
      difficulty: 'easy',
      tags: [],
      maxTurns: 3,
      createEnvironment: () => ({
        createMcpServers: () => ({}),
        allowedTools: [],
        readOnlyTools: [],
        state: {},
        journal: [],
      }),
      async score({ deps }) {
        const { values } = await sampleJudge<{ met: boolean }>(deps.judge, REQUEST, deps.judgeSamples);
        const met = values.filter((v) => v.met).length;
        return buildScore({
          breakdown: [{ id: 'met', label: 'Met', weight: 1, earned: values.length ? met / values.length : 0 }],
          penalties: [],
        });
      },
    };
  }

  const answers: Strategy = {
    id: 'answers',
    label: 'answers',
    description: 'returns a fixed answer without calling the model',
    run: async () => ({ finalText: '308 is cacheable.', subagentCount: 0, phases: [] }),
  };

  async function run(judge: Judge, subprocessEnv?: Record<string, string | undefined>) {
    const { records } = await runMatrix({
      runSetId: 'judge-test',
      strategies: [answers],
      tasks: [judgedTask()],
      models: [MODEL],
      effort: 'low',
      repeats: 1,
      concurrency: 1,
      maxCostUsdPerRun: 1,
      maxWallClockMsPerRun: 60_000,
      totalBudgetUsd: 10,
      fixtureMode: 'replay',
      fixtureDir: '/tmp',
      judge,
      judgeSamples: 3,
      persist: false,
      // One attempt: these tests are about grading, not about retrying the run.
      retry: { maxAttempts: 1 },
      ...(subprocessEnv ? { subprocessEnv } : {}),
    });
    const record = records[0];
    if (!record) throw new Error('no record');
    return record;
  }

  it('grades a visitor’s run on the visitor’s credentials', async () => {
    setScript(async function* () {
      yield success({ structured: { met: true } });
    });

    await run(createJudge({ model: MODEL }), { ANTHROPIC_API_KEY: 'visitor-key', PATH: '/usr/bin' });

    expect(sessions()).toHaveLength(3);
    for (const session of sessions()) {
      expect(session.options.env).toEqual({ ANTHROPIC_API_KEY: 'visitor-key', PATH: '/usr/bin' });
    }
  });

  it('labels a total grading outage an API error, not a wrong answer, and bills it', async () => {
    setScript(async function* () {
      yield assistant('API Error: 529 Overloaded', { model: '<synthetic>', error: 'overloaded', usage: {} });
      yield success({ text: 'API Error: 529 Overloaded', isError: true, costUsd: 0.001 });
    });

    const record = await run(createJudge({ model: MODEL }));

    expect(record.failureMode).toBe('api_error');
    expect(record.passed).toBe(false);
    expect(record.scoreMetadata.judgeOutage).toBe(true);
    expect(record.error).toMatch(/^judge unavailable/);
    expect(record.judgeCostUsd).toBeCloseTo(0.003, 10);
  });

  it('labels a judge that never returns a usable verdict a harness error', async () => {
    setScript(async function* () {
      yield success({ text: 'no json here', costUsd: 0.001 });
    });

    const record = await run(createJudge({ model: MODEL }));

    expect(record.failureMode).toBe('harness_error');
    expect(record.scoreMetadata.judgeOutage).toBe(true);
  });

  it('still scores normally when only some samples fail', async () => {
    let call = 0;
    setScript(async function* () {
      call += 1;
      if (call === 1) {
        yield success({ text: 'API Error: 500 Internal server error', isError: true, apiErrorStatus: 500, costUsd: 0 });
      } else {
        yield success({ structured: { met: true }, costUsd: 0.01 });
      }
    });

    const record = await run(createJudge({ model: MODEL }));

    expect(record.failureMode).toBe('none');
    expect(record.score).toBe(1);
    expect(record.judgeCostUsd).toBeCloseTo(0.02, 10);
  });
});
