import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  Judge,
  JudgeRequest,
  JournaledToolSpec,
  ScoreInput,
  TaskEnvironment,
  ToolCall,
  TraceEvent,
} from '@arena/core';
import {
  FixtureStore,
  createWebTools,
  defineResearchTask,
  fixtureKey,
  htmlToText,
  pageFixtureKey,
  researchTasks,
  searchFixtureKey,
} from '../src/research/index';
import type { HttpResponse, PageRecord, ResearchTaskSpec, SearchResult } from '../src/research/index';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

let dir = '';

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'arena-fixtures-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

interface Reply {
  text: string;
  isError: boolean;
}

async function call(
  tools: JournaledToolSpec[],
  name: string,
  args: Record<string, unknown>,
): Promise<Reply> {
  const spec = tools.find((candidate) => candidate.name === name);
  if (!spec) throw new Error(`no tool named ${name}`);
  const reply = await spec.handler(args);
  return typeof reply === 'string'
    ? { text: reply, isError: false }
    : { text: reply.text, isError: reply.isError === true };
}

function responding(html: string) {
  return vi.fn(
    async (_url: string): Promise<HttpResponse> => ({
      ok: true,
      status: 200,
      text: async () => html,
    }),
  );
}

/** A fetch that must never run; the assertion is `not.toHaveBeenCalled`. */
function forbiddenFetch() {
  return vi.fn(async (_url: string): Promise<HttpResponse> => {
    throw new Error('replay mode reached the network');
  });
}

function judgeReturning(...values: unknown[]): { judge: Judge; requests: JudgeRequest[] } {
  const requests: JudgeRequest[] = [];
  let next = 0;
  const judge: Judge = async <T>(req: JudgeRequest) => {
    requests.push(req);
    const value = values[Math.min(next++, values.length - 1)];
    return { value: value as T, costUsd: 0 };
  };
  return { judge, requests };
}

const throwingJudge: Judge = async () => {
  throw new Error('judge unavailable');
};

const RUBRIC = [
  { id: 'a', claim: 'States A', weight: 1 },
  { id: 'b', claim: 'States B', weight: 3 },
];

function makeTask(overrides: Partial<ResearchTaskSpec> = {}) {
  return defineResearchTask({
    id: 'research-test',
    title: 'Test research task',
    question: 'What is the difference between A and B?',
    difficulty: 'easy',
    tags: ['test'],
    maxTurns: 6,
    rubric: RUBRIC,
    ...overrides,
  });
}

function verdicts(...pairs: Array<[string, 'met' | 'partial' | 'missing']>) {
  return {
    verdicts: pairs.map(([id, status]) => ({ id, status, evidence: `quote for ${id}` })),
  };
}

function fetchEvent(url: string, seq = 0): TraceEvent {
  return {
    seq,
    tMs: seq,
    phase: 'main',
    depth: 0,
    kind: 'tool_call',
    toolName: 'mcp__web__fetch_page',
    toolInput: { url },
  };
}

function emptyEnv(journal: ToolCall[] = []): TaskEnvironment {
  return { mcpServers: {}, allowedTools: [], readOnlyTools: [], state: {}, journal };
}

function scoreInput(options: {
  judge: Judge;
  finalText: string;
  judgeSamples?: number;
  trace?: TraceEvent[];
  journal?: ToolCall[];
}): ScoreInput {
  return {
    env: emptyEnv(options.journal),
    outcome: { finalText: options.finalText, subagentCount: 0, phases: [] },
    trace: options.trace ?? [],
    deps: { judge: options.judge, judgeSamples: options.judgeSamples ?? 1 },
  };
}

// ---------------------------------------------------------------------------
// fixtureKey
// ---------------------------------------------------------------------------

describe('fixtureKey', () => {
  it('is stable across calls', () => {
    expect(fixtureKey('search', 'rfc 7538')).toBe(fixtureKey('search', 'rfc 7538'));
    expect(fixtureKey('search', 'rfc 7538')).toHaveLength(32);
    expect(fixtureKey('search', 'rfc 7538')).toMatch(/^[0-9a-f]{32}$/);
  });

  it('normalizes surrounding and inner whitespace and case', () => {
    expect(fixtureKey('search', '  RFC   7538 ')).toBe(fixtureKey('search', 'rfc 7538'));
    expect(fixtureKey('search', 'RFC\t7538')).toBe(fixtureKey('search', 'rfc 7538'));
  });

  it('separates the two kinds', () => {
    expect(fixtureKey('search', 'rfc 7538')).not.toBe(fixtureKey('fetch', 'rfc 7538'));
  });

  it('canonicalizes URLs before keying a page fixture', () => {
    expect(pageFixtureKey('https://www.rfc-editor.org/rfc/rfc7538/')).toBe(
      pageFixtureKey('https://rfc-editor.org/rfc/rfc7538'),
    );
    expect(pageFixtureKey('https://a.example.com/x')).not.toBe(searchFixtureKey('https://a.example.com/x'));
  });
});

// ---------------------------------------------------------------------------
// FixtureStore
// ---------------------------------------------------------------------------

describe('FixtureStore', () => {
  it('round-trips a record through disk', async () => {
    const store = new FixtureStore(dir);
    const key = searchFixtureKey('rfc 7538');

    expect(await store.has(key)).toBe(false);
    await store.write(key, { kind: 'search', payload: 'rfc 7538', value: [{ n: 1 }] });
    expect(await store.has(key)).toBe(true);

    const record = await store.read<Array<{ n: number }>>(key);
    expect(record?.key).toBe(key);
    expect(record?.kind).toBe('search');
    expect(record?.payload).toBe('rfc 7538');
    expect(record?.value[0]?.n).toBe(1);
    expect(typeof record?.recordedAt).toBe('string');
  });

  it('returns undefined for a missing key instead of throwing', async () => {
    const store = new FixtureStore(dir);
    await expect(store.read('does-not-exist')).resolves.toBeUndefined();
    await expect(store.has('does-not-exist')).resolves.toBe(false);
  });

  it('returns undefined for a corrupt fixture file', async () => {
    const store = new FixtureStore(dir);
    await store.write('corrupt', { kind: 'fetch', payload: 'x', value: 1 });
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(dir, 'corrupt.json'), '{ not json', 'utf8');
    await expect(store.read('corrupt')).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// htmlToText
// ---------------------------------------------------------------------------

describe('htmlToText', () => {
  it('drops script and style content and collapses whitespace', () => {
    const html = [
      '<html><head><title>Doc</title><style>body { color: red; }</style></head>',
      '<body><script>var x = 1; if (x < 2) { alert("hi"); }</script>',
      '<p>Hello    <b>world</b>   &amp; friends</p></body></html>',
    ].join('\n');

    const text = htmlToText(html);
    expect(text).toBe('Hello world & friends');
    expect(text).not.toContain('alert');
    expect(text).not.toContain('color');
  });

  it('turns block boundaries into line breaks and caps blank-line runs', () => {
    expect(htmlToText('<p>one</p><p>two</p>')).toBe('one\ntwo');
    expect(htmlToText('<p>one</p>\n\n\n\n<p>two</p>')).toBe('one\n\ntwo');
  });
});

// ---------------------------------------------------------------------------
// web tools — replay
// ---------------------------------------------------------------------------

describe('createWebTools in replay mode', () => {
  it('returns two read-only tools', () => {
    const tools = createWebTools({ fixtureMode: 'replay', fixtureDir: dir });
    expect(tools.map((tool) => tool.name)).toEqual(['search', 'fetch_page']);
    expect(tools.every((tool) => tool.readOnly === true)).toBe(true);
  });

  it('reports a miss without touching the network', async () => {
    const fetchImpl = forbiddenFetch();
    const tools = createWebTools({ fixtureMode: 'replay', fixtureDir: dir, fetchImpl });

    const search = await call(tools, 'search', { query: 'rfc 7538' });
    const page = await call(tools, 'fetch_page', { url: 'https://rfc-editor.org/rfc/rfc7538' });

    expect(search.isError).toBe(true);
    expect(search.text).toMatch(/no recorded/i);
    expect(page.isError).toBe(true);
    expect(page.text).toMatch(/no recorded/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('serves a seeded search fixture and normalizes the query', async () => {
    const fetchImpl = forbiddenFetch();
    const store = new FixtureStore(dir);
    const results: SearchResult[] = [
      {
        title: 'RFC 7538',
        url: 'https://www.rfc-editor.org/rfc/rfc7538',
        snippet: 'The 308 Permanent Redirect status code.',
      },
    ];
    await store.write(searchFixtureKey('rfc 7538'), {
      kind: 'search',
      payload: 'rfc 7538',
      value: results,
    });

    const tools = createWebTools({ fixtureMode: 'replay', fixtureDir: dir, fetchImpl });
    const reply = await call(tools, 'search', { query: '  RFC   7538  ' });

    expect(reply.isError).toBe(false);
    expect(reply.text).toContain('https://www.rfc-editor.org/rfc/rfc7538');
    expect(reply.text).toContain('1.');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('serves a seeded page fixture and truncates long text', async () => {
    const store = new FixtureStore(dir);
    const body = `START ${'x'.repeat(9_000)} END`;
    await store.write(pageFixtureKey('https://example.com/doc'), {
      kind: 'fetch',
      payload: 'https://example.com/doc',
      value: { url: 'https://example.com/doc', title: 'Doc', text: body },
    });

    const tools = createWebTools({ fixtureMode: 'replay', fixtureDir: dir, fetchImpl: forbiddenFetch() });
    const reply = await call(tools, 'fetch_page', { url: 'https://example.com/doc' });

    expect(reply.isError).toBe(false);
    expect(reply.text).toContain('START');
    expect(reply.text).not.toContain('END');
    expect(reply.text).toMatch(/truncated/i);
  });

  it('rejects a domain outside allowedDomains before looking anything up', async () => {
    const tools = createWebTools({
      fixtureMode: 'replay',
      fixtureDir: dir,
      allowedDomains: ['rfc-editor.org'],
      fetchImpl: forbiddenFetch(),
    });

    const blocked = await call(tools, 'fetch_page', { url: 'https://evil.example.com/x' });
    expect(blocked.isError).toBe(true);
    expect(blocked.text).toMatch(/not on the allowed/i);

    // A listed domain gets past the policy check and fails only on the fixture miss.
    const allowed = await call(tools, 'fetch_page', { url: 'https://www.rfc-editor.org/rfc/rfc7538' });
    expect(allowed.isError).toBe(true);
    expect(allowed.text).toMatch(/no recorded/i);
  });

  it('rejects a malformed url', async () => {
    const tools = createWebTools({ fixtureMode: 'replay', fixtureDir: dir, fetchImpl: forbiddenFetch() });
    const reply = await call(tools, 'fetch_page', { url: 'not-a-url' });
    expect(reply.isError).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// web tools — record
// ---------------------------------------------------------------------------

describe('createWebTools in record mode', () => {
  it('fetches once, writes a fixture, then replays it', async () => {
    const fetchImpl = responding(
      '<html><head><title>Doc</title></head><body><p>Recorded body text</p></body></html>',
    );
    const tools = createWebTools({ fixtureMode: 'record', fixtureDir: dir, fetchImpl });

    const first = await call(tools, 'fetch_page', { url: 'https://example.com/doc' });
    expect(first.isError).toBe(false);
    expect(first.text).toContain('Recorded body text');
    expect(first.text).toContain('Doc');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://example.com/doc');

    const record = await new FixtureStore(dir).read<PageRecord>(pageFixtureKey('https://example.com/doc'));
    expect(record?.kind).toBe('fetch');
    expect(record?.value.text).toContain('Recorded body text');
    expect(await readdir(dir)).toHaveLength(1);

    const second = await call(tools, 'fetch_page', { url: 'https://example.com/doc' });
    expect(second.text).toContain('Recorded body text');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('parses DuckDuckGo result links and records them', async () => {
    const html = `
      <div class="result results_links">
        <h2 class="result__title">
          <a rel="nofollow" class="result__a"
             href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.rfc-editor.org%2Frfc%2Frfc7538&amp;rut=deadbeef">RFC 7538 - Permanent Redirect</a>
        </h2>
        <a class="result__snippet" href="//duckduckgo.com/l/?uddg=x">The <b>308</b>    status code.</a>
      </div>`;
    const fetchImpl = responding(html);
    const tools = createWebTools({ fixtureMode: 'record', fixtureDir: dir, fetchImpl });

    const reply = await call(tools, 'search', { query: 'rfc 7538' });
    expect(reply.isError).toBe(false);
    expect(reply.text).toContain('https://www.rfc-editor.org/rfc/rfc7538');
    expect(reply.text).toContain('RFC 7538 - Permanent Redirect');
    expect(reply.text).toContain('The 308 status code.');
    expect(fetchImpl.mock.calls[0]?.[0]).toContain('html.duckduckgo.com');

    const record = await new FixtureStore(dir).read<SearchResult[]>(searchFixtureKey('rfc 7538'));
    expect(record?.value[0]?.url).toBe('https://www.rfc-editor.org/rfc/rfc7538');
  });

  it('reports an error rather than inventing results when parsing yields nothing', async () => {
    const fetchImpl = responding('<html><body>no results here</body></html>');
    const tools = createWebTools({ fixtureMode: 'record', fixtureDir: dir, fetchImpl });

    const reply = await call(tools, 'search', { query: 'rfc 7538' });
    expect(reply.isError).toBe(true);
    expect(await readdir(dir)).toHaveLength(0);
  });

  it('turns a transport failure into an error reply instead of throwing', async () => {
    const fetchImpl = vi.fn(async (_url: string): Promise<HttpResponse> => {
      throw new Error('ECONNREFUSED');
    });
    const tools = createWebTools({ fixtureMode: 'record', fixtureDir: dir, fetchImpl });

    const reply = await call(tools, 'fetch_page', { url: 'https://example.com/doc' });
    expect(reply.isError).toBe(true);
    expect(reply.text).toContain('ECONNREFUSED');
  });

  it('turns a non-2xx response into an error reply', async () => {
    const fetchImpl = vi.fn(
      async (_url: string): Promise<HttpResponse> => ({ ok: false, status: 503, text: async () => '' }),
    );
    const tools = createWebTools({ fixtureMode: 'record', fixtureDir: dir, fetchImpl });

    const reply = await call(tools, 'fetch_page', { url: 'https://example.com/doc' });
    expect(reply.isError).toBe(true);
    expect(reply.text).toContain('503');
  });
});

// ---------------------------------------------------------------------------
// defineResearchTask — environment
// ---------------------------------------------------------------------------

describe('defineResearchTask environment', () => {
  it('exposes web tools with readOnlyTools equal to allowedTools', async () => {
    const env = await makeTask().createEnvironment({
      cwd: dir,
      fixtureMode: 'replay',
      fixtureDir: dir,
    });

    expect(env.allowedTools).toEqual(['mcp__web__search', 'mcp__web__fetch_page']);
    expect(env.readOnlyTools).toEqual(env.allowedTools);
    expect(Object.keys(env.mcpServers)).toEqual(['web']);
    expect(env.journal).toEqual([]);
  });

  it('carries research metadata onto the task', () => {
    const task = makeTask();
    expect(task.category).toBe('research');
    expect(task.world).toBe('web');
    expect(task.prompt).toContain('What is the difference between A and B?');
    expect(task.policy).toMatch(/cite/i);
  });
});

// ---------------------------------------------------------------------------
// defineResearchTask — rubric scoring
// ---------------------------------------------------------------------------

describe('defineResearchTask rubric scoring', () => {
  it('scores 1.0 when every rubric item is met', async () => {
    const { judge, requests } = judgeReturning(verdicts(['a', 'met'], ['b', 'met']));
    const score = await makeTask().score(scoreInput({ judge, finalText: 'A differs from B.' }));

    expect(score.score).toBe(1);
    expect(score.passed).toBe(true);
    expect(score.failureMode).toBe('none');
    expect(requests[0]?.prompt).toContain('States A');
    expect(requests[0]?.prompt).toContain('A differs from B.');
    expect(requests[0]?.system).toMatch(/only what the answer/i);
  });

  it('weights a mixed verdict set', async () => {
    const { judge } = judgeReturning(verdicts(['a', 'met'], ['b', 'partial']));
    const score = await makeTask().score(scoreInput({ judge, finalText: 'Partly right.' }));

    // (1 * 1 + 3 * 0.5) / 4
    expect(score.score).toBeCloseTo(0.625, 6);
    expect(score.breakdown.find((item) => item.id === 'b')?.earned).toBe(0.5);
  });

  it('takes the median across samples so one outlier cannot move the score', async () => {
    const { judge } = judgeReturning(
      verdicts(['a', 'met'], ['b', 'met']),
      verdicts(['a', 'met'], ['b', 'met']),
      verdicts(['a', 'missing'], ['b', 'missing']),
    );
    const score = await makeTask().score(
      scoreInput({ judge, finalText: 'A differs from B.', judgeSamples: 3 }),
    );

    expect(score.score).toBe(1);
  });

  it('scores an item no judge returned as zero', async () => {
    const { judge } = judgeReturning(verdicts(['a', 'met']));
    const score = await makeTask().score(scoreInput({ judge, finalText: 'Only A.' }));

    expect(score.breakdown.find((item) => item.id === 'b')?.earned).toBe(0);
    expect(score.score).toBeCloseTo(0.25, 6);
  });

  it('survives a judge that always throws', async () => {
    const score = await makeTask().score(
      scoreInput({ judge: throwingJudge, finalText: 'Something.', judgeSamples: 3 }),
    );

    expect(score.score).toBe(0);
    expect(score.metadata?.judgeFailed).toBe(true);
    expect(score.metadata?.judgeFailures).toBe(3);
    expect(score.failureMode).toBe('wrong_answer');
  });

  it('skips the judge entirely for an empty answer', async () => {
    const { judge, requests } = judgeReturning(verdicts(['a', 'met'], ['b', 'met']));
    const score = await makeTask().score(scoreInput({ judge, finalText: '   ' }));

    expect(score.score).toBe(0);
    expect(requests).toHaveLength(0);
    expect(score.metadata?.emptyAnswer).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// defineResearchTask — citation integrity
// ---------------------------------------------------------------------------

describe('defineResearchTask citation integrity', () => {
  const allMet = verdicts(['a', 'met'], ['b', 'met']);

  it('applies a 0.75 multiplier when half the cited URLs were never fetched', async () => {
    const { judge } = judgeReturning(allMet);
    const score = await makeTask().score(
      scoreInput({
        judge,
        finalText: 'See https://a.example.com/one and https://b.example.com/two for details.',
        trace: [fetchEvent('https://a.example.com/one')],
      }),
    );

    expect(score.metadata?.citationIntegrity).toBeCloseTo(0.5, 6);
    expect(score.score).toBeCloseTo(0.75, 6);
    expect(score.penalties[0]?.kind).toBe('hallucinated_citation');
    expect(score.penalties[0]?.multiplier).toBeCloseTo(0.75, 6);
    expect(score.metadata?.citedCount).toBe(2);
    expect(score.metadata?.verifiedCount).toBe(1);
    expect(score.metadata?.hallucinatedCount).toBe(1);
  });

  it('does not penalise an answer that cites nothing', async () => {
    const { judge } = judgeReturning(allMet);
    const score = await makeTask().score(scoreInput({ judge, finalText: 'No links at all here.' }));

    expect(score.penalties).toHaveLength(0);
    expect(score.metadata?.citationIntegrity).toBe(1);
    expect(score.score).toBe(1);
  });

  it('accepts a URL recorded only in the tool journal', async () => {
    const { judge } = judgeReturning(allMet);
    const journal: ToolCall[] = [
      { name: 'fetch_page', args: { url: 'https://a.example.com/one' }, tMs: 1, ok: true, result: '' },
    ];
    const score = await makeTask().score(
      scoreInput({ judge, finalText: 'Per https://a.example.com/one it holds.', journal }),
    );

    expect(score.score).toBe(1);
    expect(score.penalties).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// defineResearchTask — source coverage
// ---------------------------------------------------------------------------

describe('defineResearchTask source coverage', () => {
  it('reports the fraction of required domains that were fetched', async () => {
    const { judge } = judgeReturning(verdicts(['a', 'met'], ['b', 'met']));
    const task = makeTask({ requiredSources: ['a.example.com', 'b.example.com'] });
    const score = await task.score(
      scoreInput({
        judge,
        finalText: 'An answer without links.',
        trace: [fetchEvent('https://sub.a.example.com/one'), fetchEvent('https://other.test/x', 1)],
      }),
    );

    const coverage = score.breakdown.find((item) => item.id === 'source-coverage');
    expect(coverage?.earned).toBeCloseTo(0.5, 6);
    expect(score.metadata?.missingSources).toEqual(['b.example.com']);
    expect(score.score).toBeLessThan(1);
  });

  it('omits the coverage item when no sources are required', async () => {
    const { judge } = judgeReturning(verdicts(['a', 'met'], ['b', 'met']));
    const score = await makeTask().score(scoreInput({ judge, finalText: 'x' }));
    expect(score.breakdown.map((item) => item.id)).toEqual(['a', 'b']);
  });
});

// ---------------------------------------------------------------------------
// the shipped task set
// ---------------------------------------------------------------------------

describe('researchTasks', () => {
  it('ships three tasks with unique ids across all difficulties', () => {
    expect(researchTasks).toHaveLength(3);
    expect(new Set(researchTasks.map((task) => task.id)).size).toBe(3);
    expect(researchTasks.map((task) => task.difficulty).sort()).toEqual(['easy', 'hard', 'medium']);
    expect(researchTasks.every((task) => task.category === 'research')).toBe(true);
    expect(researchTasks.every((task) => task.world === 'web')).toBe(true);
  });

  it('gives every task 4 to 6 positively weighted rubric items', async () => {
    for (const task of researchTasks) {
      const { judge } = judgeReturning({ verdicts: [] });
      const score = await task.score(scoreInput({ judge, finalText: 'placeholder' }));
      const rubricItems = score.breakdown.filter((item) => item.id !== 'source-coverage');
      expect(rubricItems.length).toBeGreaterThanOrEqual(4);
      expect(rubricItems.length).toBeLessThanOrEqual(6);
      expect(rubricItems.every((item) => item.weight > 0)).toBe(true);
    }
  });

  it('builds a usable environment for every task', async () => {
    for (const task of researchTasks) {
      const env = await task.createEnvironment({ cwd: dir, fixtureMode: 'replay', fixtureDir: dir });
      expect(env.readOnlyTools).toEqual(env.allowedTools);
      expect(env.allowedTools).toHaveLength(2);
    }
  });
});
