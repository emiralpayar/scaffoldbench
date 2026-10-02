import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { FIXTURES_DIR, type Judge, type JudgeRequest, type ScoreInput, type Task, type TaskEnvironment } from '@arena/core';
import {
  JUDGE_EFFORT,
  UNGROUNDED_CREDIT,
  breadthResearchSpecs,
  createWebTools,
  defineBreadthTask,
  defineResearchTask,
  fieldMatches,
  judgedResearchSpecs,
  normalizeSection,
  researchState,
  researchTasks,
  type BreadthTaskSpec,
  type ResearchJudgeRequest,
  type ResearchTaskSpec,
} from '../src/research/index';
import { answerWithBlock, callTool, writeCorpus } from './researchHelpers';

// ---------------------------------------------------------------------------
// a small web for the scoring tests
// ---------------------------------------------------------------------------

const scratch = mkdtempSync(path.join(tmpdir(), 'arena-research-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const SPEC_URL = 'https://specs.test.org/widgets.html';
const OLD_URL = 'https://specs.test.org/widgets-v1.html';
const GUIDE_URL = 'https://guide.test.org/widgets';

const SPEC_TEXT = [
  'Widget Specification, version 2',
  '',
  '1. Blue Widgets',
  '',
  'A blue widget is always round and never weighs more than ten grams.',
  'Blue widgets are cacheable by default unless a header forbids it.',
  '',
  '2. Red Widgets',
  '',
  'A red widget is square and must be painted twice before shipping.',
  'Red widgets are never cacheable, whatever the headers say.',
  '',
  '3. Index',
].join('\n');

const OLD_TEXT = [
  'Widget Specification, version 1 (obsolete)',
  '',
  'A blue widget is always round and never weighs more than five grams.',
].join('\n');

const fixtureDir = writeCorpus(scratch, [
  { id: 'spec', url: SPEC_URL, title: 'Widget Specification v2', text: SPEC_TEXT },
  { id: 'old', url: OLD_URL, title: 'Widget Specification v1', text: OLD_TEXT },
  { id: 'guide', url: GUIDE_URL, title: 'Widget guide', text: 'A friendly guide: blue widgets are round, red widgets are square, and both are popular.' },
]);

const RUBRIC: ResearchTaskSpec['rubric'] = [
  { id: 'a', claim: 'States that blue widgets are round', weight: 1, support: [{ doc: 'spec', quote: 'A blue widget is always round' }] },
  { id: 'b', claim: 'States that red widgets are square', weight: 3, support: [{ doc: 'spec', quote: 'A red widget is square' }] },
];

function judgedTask(overrides: Partial<ResearchTaskSpec> = {}): Task {
  return defineResearchTask({
    id: 'research-test',
    title: 'Widgets',
    question: 'What shapes are blue and red widgets?',
    difficulty: 'easy',
    tags: ['test'],
    maxTurns: 6,
    corpus: { primary: ['spec'], secondary: ['guide'], superseded: ['old'] },
    rubric: RUBRIC,
    ...overrides,
  });
}

/** A run of `task`: its environment plus a driver for its web tools. */
function session(task: Task) {
  const env = task.createEnvironment({ cwd: scratch, fixtureMode: 'replay', fixtureDir }) as TaskEnvironment;
  const tools = createWebTools({ corpus: researchState(env).corpus });
  return {
    env,
    fetch: (url: string, extra: Record<string, unknown> = {}) => callTool(tools, env.journal, 'fetch_page', { url, ...extra }),
    search: (query: string) => callTool(tools, env.journal, 'search', { query }),
    input: (judge: Judge, finalText: string, judgeSamples = 1): ScoreInput => ({
      env,
      outcome: { finalText, subagentCount: 0, phases: [] },
      trace: [],
      deps: { judge, judgeSamples },
    }),
  };
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

type Status = 'met' | 'partial' | 'missing';

function verdicts(...entries: Array<[string, Status, string[]?, string?]>) {
  return {
    verdicts: entries.map(([id, status, support = [], answerQuote]) => ({
      id,
      status,
      support,
      answerQuote: answerQuote ?? (status === 'missing' ? '' : ANSWER_PROSE),
    })),
  };
}

const ANSWER_PROSE = 'Blue widgets are round and red widgets are square.';
const GOOD_EVIDENCE = {
  evidence: [
    { claim: 'Blue widgets are round', quote: 'A blue widget is always round and never weighs more than ten grams.', url: SPEC_URL },
    { claim: 'Red widgets are square', quote: 'A red widget is square and must be painted twice', url: SPEC_URL },
  ],
};

// ---------------------------------------------------------------------------
// judged tasks
// ---------------------------------------------------------------------------

describe('defineResearchTask environment', () => {
  it('exposes the two read-only web tools over the task corpus', () => {
    const task = judgedTask();
    const { env } = session(task);
    expect(env.allowedTools).toEqual(['mcp__web__search', 'mcp__web__fetch_page']);
    expect(env.readOnlyTools).toEqual(env.allowedTools);
    expect(Object.keys(env.createMcpServers())).toEqual(['web']);
    expect(researchState(env).corpus.documents.map((document) => document.id)).toEqual(['spec', 'guide', 'old']);
  });

  it('asks for quote-backed evidence in a fixed format, identically for every strategy', () => {
    const task = judgedTask();
    expect(task.prompt).toContain('What shapes are blue and red widgets?');
    expect(task.prompt).toContain('{"evidence": [{"claim"');
    expect(task.policy).toMatch(/word for word/);
    expect(task.policy).toMatch(/offset/);
    expect(task.category).toBe('research');
  });

  it('rejects a rubric with duplicate ids', () => {
    expect(() => judgedTask({ rubric: [RUBRIC[0]!, RUBRIC[0]!] })).toThrow(/duplicate/);
  });
});

describe('defineResearchTask scoring', () => {
  it('gives full credit to claims the judge links to verified quotes', async () => {
    const task = judgedTask();
    const run = session(task);
    await run.fetch(SPEC_URL);
    const { judge } = judgeReturning(verdicts(['a', 'met', ['E1']], ['b', 'met', ['E2']]));
    const score = await task.score(run.input(judge, answerWithBlock(ANSWER_PROSE, GOOD_EVIDENCE)));

    expect(score.score).toBe(1);
    expect(score.passed).toBe(true);
    expect(score.metadata).toMatchObject({ verifiedQuoteCount: 2, verifiedQuoteRate: 1, groundedWeightShare: 1 });
    expect(score.breakdown.find((item) => item.id === 'b')?.detail).toMatch(/verified evidence E2/);
  });

  it('discounts a correct claim that no verified quote backs', async () => {
    const task = judgedTask();
    const run = session(task);
    await run.fetch(SPEC_URL);
    const tampered = {
      evidence: [
        GOOD_EVIDENCE.evidence[0],
        { claim: 'Red widgets are square', quote: 'A red widget is square and comes in three sizes.', url: SPEC_URL },
      ],
    };
    const { judge } = judgeReturning(verdicts(['a', 'met', []], ['b', 'met', ['E2']]));
    const score = await task.score(run.input(judge, answerWithBlock(ANSWER_PROSE, tampered)));

    expect(score.breakdown.map((item) => item.earned)).toEqual([UNGROUNDED_CREDIT, UNGROUNDED_CREDIT]);
    expect(score.breakdown[1]?.detail).toMatch(/did not verify/);
    expect(score.metadata).toMatchObject({ verifiedQuoteRate: 0.5, groundedWeightShare: 0 });
    expect(score.metadata?.evidence).toMatchObject([{ verified: true }, { verified: false, failure: 'the quote does not occur in the page' }]);
  });

  it('does not let evidence from an unopened page count, and penalises citing it', async () => {
    const task = judgedTask();
    const run = session(task);
    const { judge } = judgeReturning(verdicts(['a', 'met', ['E1']], ['b', 'met', ['E2']]));
    const score = await task.score(run.input(judge, answerWithBlock(ANSWER_PROSE, GOOD_EVIDENCE)));

    expect(score.breakdown.every((item) => item.earned === UNGROUNDED_CREDIT)).toBe(true);
    expect(score.penalties[0]).toMatchObject({ id: 'citation-integrity', multiplier: 0.5 });
    expect(score.score).toBeCloseTo(UNGROUNDED_CREDIT * 0.5, 6);
  });

  it('does not let evidence count from a page that was opened but never shown', async () => {
    // A `find` that matches nothing opens the page and displays none of it.
    const task = judgedTask();
    const run = session(task);
    expect((await run.fetch(SPEC_URL, { find: 'zebra crossing' })).text).toContain('No occurrences');
    const { judge } = judgeReturning(verdicts(['a', 'met', ['E1']], ['b', 'met', ['E2']]));
    const score = await task.score(run.input(judge, answerWithBlock(ANSWER_PROSE, GOOD_EVIDENCE)));

    expect(score.penalties).toEqual([]);
    expect(score.score).toBeCloseTo(UNGROUNDED_CREDIT, 6);
    expect(score.metadata?.evidence).toMatchObject([
      { verified: false, failure: 'no tool ever showed the run this passage' },
      { verified: false, failure: 'no tool ever showed the run this passage' },
    ]);
  });

  it('downgrades a verdict whose quote is not actually in the answer', async () => {
    const task = judgedTask();
    const run = session(task);
    await run.fetch(SPEC_URL);
    const { judge } = judgeReturning(
      verdicts(['a', 'met', ['E1']], ['b', 'met', ['E2'], 'red widgets are square and also triangular']),
    );
    const score = await task.score(run.input(judge, answerWithBlock(ANSWER_PROSE, GOOD_EVIDENCE)));

    expect(score.breakdown.find((item) => item.id === 'b')?.earned).toBe(0.5);
    expect(score.metadata?.judgeUnverifiedQuotes).toBe(1);
  });

  it('accepts a judge quote that elides part of the answer', async () => {
    const task = judgedTask();
    const run = session(task);
    await run.fetch(SPEC_URL);
    const { judge } = judgeReturning(
      verdicts(['a', 'met', ['E1'], 'Blue widgets are round …'], ['b', 'met', ['E2'], 'Blue widgets ... red widgets are square']),
    );
    const score = await task.score(run.input(judge, answerWithBlock(ANSWER_PROSE, GOOD_EVIDENCE)));

    expect(score.score).toBe(1);
    expect(score.metadata?.judgeUnverifiedQuotes).toBe(0);
  });

  it('takes the median of judge samples', async () => {
    const task = judgedTask();
    const run = session(task);
    await run.fetch(SPEC_URL);
    const { judge, requests } = judgeReturning(
      verdicts(['a', 'met', ['E1']], ['b', 'met', ['E2']]),
      verdicts(['a', 'met', ['E1']], ['b', 'met', ['E2']]),
      verdicts(['a', 'missing'], ['b', 'missing']),
    );
    const score = await task.score(run.input(judge, answerWithBlock(ANSWER_PROSE, GOOD_EVIDENCE), 3));

    expect(requests).toHaveLength(3);
    expect(score.score).toBe(1);
    expect(score.metadata?.judgeVerdicts).toHaveLength(3);
  });

  it('pins the judge to this rubric and this evidence, at low effort', async () => {
    const task = judgedTask();
    const run = session(task);
    await run.fetch(SPEC_URL);
    const { judge, requests } = judgeReturning(verdicts(['a', 'met'], ['b', 'met']));
    await task.score(run.input(judge, answerWithBlock(ANSWER_PROSE, GOOD_EVIDENCE)));

    const request = requests[0] as ResearchJudgeRequest;
    expect(request.effort).toBe(JUDGE_EFFORT);
    const verdictsSchema = (request.schema.properties as Record<string, Record<string, unknown>>).verdicts!;
    expect(verdictsSchema.minItems).toBe(2);
    expect(verdictsSchema.maxItems).toBe(2);
    const item = verdictsSchema.items as { properties: Record<string, { enum?: string[]; items?: { enum?: string[] } }> };
    expect(item.properties.id?.enum).toEqual(['a', 'b']);
    expect(item.properties.support?.items?.enum).toEqual(['E1', 'E2']);

    expect(request.prompt).toContain('E1. claim: Blue widgets are round');
    const marker = /<<<(ANSWER-[0-9a-f]+)/.exec(request.prompt)?.[1];
    expect(marker).toBeDefined();
    expect(request.prompt.trimEnd().endsWith(`${marker}>>>`)).toBe(true);
    // The evidence block is listed above the answer, not repeated inside it.
    expect(request.prompt.split(`<<<${marker}`)[1]).not.toContain('"evidence"');
  });

  it('ignores verdicts for unknown ids, duplicates and support ids that do not exist', async () => {
    const task = judgedTask();
    const run = session(task);
    await run.fetch(SPEC_URL);
    const { judge } = judgeReturning({
      verdicts: [
        { id: 'zzz', status: 'met', support: ['E1'], answerQuote: ANSWER_PROSE },
        { id: 'a', status: 'MET', support: ['E9', 'E1'], answerQuote: ANSWER_PROSE },
        { id: 'a', status: 'missing', support: [], answerQuote: '' },
      ],
    });
    const score = await task.score(run.input(judge, answerWithBlock(ANSWER_PROSE, GOOD_EVIDENCE)));
    expect(score.breakdown.map((item) => item.earned)).toEqual([1, 0]);
  });

  it('flags a judge outage as a harness failure, not a wrong answer', async () => {
    const task = judgedTask();
    const run = session(task);
    const failing: Judge = async () => {
      throw new Error('judge unavailable');
    };
    const score = await task.score(run.input(failing, 'Some answer.', 3));
    expect(score.failureMode).toBe('harness_error');
    expect(score.metadata).toMatchObject({ judgeFailed: true, judgeFailures: 3 });
  });

  it('scores an empty answer zero without paying the judge', async () => {
    const task = judgedTask();
    const run = session(task);
    await run.fetch(SPEC_URL);
    const { judge, requests } = judgeReturning(verdicts(['a', 'met'], ['b', 'met']));
    const score = await task.score(run.input(judge, '   '));
    expect(score.score).toBe(0);
    expect(requests).toHaveLength(0);
    expect(score.metadata?.emptyAnswer).toBe(true);
  });

  it('keeps a closed-book answer low even when every claim is right', async () => {
    const task = judgedTask();
    const run = session(task);
    const { judge } = judgeReturning(verdicts(['a', 'met'], ['b', 'met']));
    const score = await task.score(run.input(judge, ANSWER_PROSE));
    expect(score.score).toBeCloseTo(UNGROUNDED_CREDIT, 6);
    expect(score.metadata?.evidenceBlock).toBe(false);
  });

  it('counts a failed fetch as unopened, and ignores example URLs', async () => {
    const task = judgedTask();
    const run = session(task);
    await run.fetch('https://specs.test.org/widgets-v3.html');
    const { judge } = judgeReturning(verdicts(['a', 'met'], ['b', 'met']));
    const prose = `${ANSWER_PROSE} See https://specs.test.org/widgets-v3.html. Example: Location: https://www.example.com/x`;
    const score = await task.score(run.input(judge, prose));
    expect(score.metadata?.hallucinatedUrls).toEqual(['https://specs.test.org/widgets-v3.html']);
    expect(score.metadata?.citedCount).toBe(1);
    expect(score.penalties[0]?.multiplier).toBe(0.5);
  });

  it('records corpus provenance and what was read', async () => {
    const task = judgedTask();
    const run = session(task);
    await run.search('blue widget');
    await run.fetch(SPEC_URL);
    await run.fetch(OLD_URL);
    const { judge } = judgeReturning(verdicts(['a', 'met'], ['b', 'met']));
    const score = await task.score(run.input(judge, ANSWER_PROSE));
    expect(score.metadata?.corpus).toMatchObject({ version: 1, snapshot: '2026-10-01', documents: 3 });
    expect(score.metadata?.openedByRole).toEqual({ primary: ['spec'], superseded: ['old'] });
    // Both pages fit one window; the search also showed the guide's snippet, which is its whole text.
    expect(score.metadata?.displayedShare).toEqual({ spec: 1, old: 1, guide: 1 });
  });

  it('records how much of a page the run was shown, not just that it opened it', async () => {
    const task = judgedTask();
    const run = session(task);
    await run.fetch(SPEC_URL, { find: 'red widget is square' });
    const { judge } = judgeReturning(verdicts(['a', 'missing'], ['b', 'missing']));
    const score = await task.score(run.input(judge, ANSWER_PROSE));
    const share = (score.metadata?.displayedShare as Record<string, number>).spec ?? 0;
    expect(share).toBeGreaterThan(0.2);
    expect(share).toBeLessThan(1);
  });
});

// ---------------------------------------------------------------------------
// breadth tasks
// ---------------------------------------------------------------------------

const BREADTH: BreadthTaskSpec = {
  id: 'research-breadth-test',
  title: 'Widget facts',
  question: 'For each widget colour, give its shape, the section defining it and whether it is cacheable.',
  difficulty: 'medium',
  tags: ['test'],
  maxTurns: 10,
  corpus: { primary: ['spec'], superseded: ['old'], secondary: ['guide'] },
  key: { name: 'colour', label: 'widget colour' },
  quoteFrom: 'the section of the specification that defines that colour',
  fields: [
    { name: 'shape', kind: 'text', description: 'its shape' },
    { name: 'section', kind: 'section', description: 'the defining section' },
    { name: 'cacheable', kind: 'boolean', description: 'whether it is cacheable by default' },
  ],
  items: [
    {
      key: 'blue',
      expected: { shape: 'round', section: '1', cacheable: true },
      source: { doc: 'spec', from: '1. Blue Widgets', to: '2. Red Widgets' },
      goldQuote: 'Blue widgets are cacheable by default unless a header forbids it.',
    },
    {
      key: 'red',
      expected: { shape: 'square', section: '2', cacheable: false },
      alsoAccept: { shape: ['a square'] },
      source: { doc: 'spec', from: '2. Red Widgets', to: '3. Index' },
      goldQuote: 'Red widgets are never cacheable, whatever the headers say.',
    },
  ],
};

const breadthTask = defineBreadthTask(BREADTH);
const noJudge: Judge = async () => {
  throw new Error('breadth tasks must not call the judge');
};

function breadthAnswer(...entries: Array<Record<string, unknown>>): string {
  return answerWithBlock('Here is what the specification says.', { answers: entries });
}

const BLUE = { colour: 'blue', shape: 'Round', section: 'Section 1.', cacheable: true, quote: 'Blue widgets are cacheable by default', url: SPEC_URL };
const RED = { colour: 'Red widgets', shape: 'a square', section: '§2', cacheable: 'no', quote: 'A red widget is square and must be painted twice before shipping.', url: SPEC_URL };

describe('defineBreadthTask', () => {
  it('lists every item and the exact answer shape in the prompt', () => {
    expect(breadthTask.prompt).toContain('- blue\n- red');
    expect(breadthTask.prompt).toContain('"answers":[{"colour":"blue"');
    expect(breadthTask.prompt).toContain(
      '- quote: a sentence from the section of the specification that defines that colour, copied word for word',
    );
  });

  it('refuses an item without a gold value for every field', () => {
    const broken = { ...BREADTH, items: [{ ...BREADTH.items[0]!, expected: { shape: 'round' } }] };
    expect(() => defineBreadthTask(broken)).toThrow(/no gold value for section/);
  });

  it('scores a correct, grounded answer 1 without a judge', async () => {
    const run = session(breadthTask);
    await run.fetch(SPEC_URL);
    const score = await breadthTask.score(run.input(noJudge, breadthAnswer(BLUE, RED)));
    expect(score.score).toBe(1);
    expect(score.passed).toBe(true);
    expect(score.metadata).toMatchObject({ itemsAnswered: 2, fieldAccuracy: 1, groundedItems: 2 });
  });

  it('gives partial credit field by field and says what was expected', async () => {
    const run = session(breadthTask);
    await run.fetch(SPEC_URL);
    const score = await breadthTask.score(run.input(noJudge, breadthAnswer({ ...BLUE, section: '2' }, RED)));
    const blue = score.breakdown.find((item) => item.id === 'blue');
    expect(blue?.earned).toBeCloseTo(2 / 3, 6);
    expect(blue?.detail).toContain('section: answered "2", expected "1"');
    expect(score.metadata?.fieldMisses).toEqual({ section: 1 });
  });

  it('only accepts a quote from the defining section of the right document', async () => {
    const run = session(breadthTask);
    await run.fetch(SPEC_URL);
    await run.fetch(OLD_URL);
    const fromOld = { ...BLUE, quote: 'A blue widget is always round and never weighs more than five grams.', url: OLD_URL };
    const wrongSection = { ...RED, quote: 'Blue widgets are cacheable by default unless a header forbids it.' };
    const score = await breadthTask.score(run.input(noJudge, breadthAnswer(fromOld, wrongSection)));
    expect(score.breakdown.map((item) => item.earned)).toEqual([UNGROUNDED_CREDIT, UNGROUNDED_CREDIT]);
    expect(score.breakdown[0]?.detail).toContain('quote is from old, expected spec');
    expect(score.breakdown[1]?.detail).toContain('outside the part that defines this item');
  });

  it('needs six of the quote\'s own words inside the defining section, not just a toe across the heading', async () => {
    const run = session(breadthTask);
    await run.fetch(SPEC_URL);
    // Mostly section 1, running three words into section 2.
    const straddling = { ...RED, quote: 'Blue widgets are cacheable by default unless a header forbids it. 2. Red Widgets A red widget' };
    const elided = { ...RED, quote: 'Blue widgets are cacheable by default … A red widget' };
    for (const red of [straddling, elided]) {
      const score = await breadthTask.score(run.input(noJudge, breadthAnswer(BLUE, red)));
      expect(score.breakdown[1]?.detail, red.quote).toContain('outside the part that defines this item');
    }
  });

  it('also grounds a quote from another place that states the item', async () => {
    const elsewhere = 'blue widgets are round, red widgets are square, and both are popular';
    const task = defineBreadthTask({
      ...BREADTH,
      items: BREADTH.items.map((item) => (item.key === 'blue' ? { ...item, alsoSource: [{ doc: 'guide', from: elsewhere }] } : item)),
    });
    const run = session(task);
    await run.fetch(SPEC_URL);
    await run.fetch(GUIDE_URL);
    const answer = breadthAnswer({ ...BLUE, quote: elsewhere, url: GUIDE_URL }, RED);
    expect((await task.score(run.input(noJudge, answer))).score).toBe(1);
    const without = await breadthTask.score(run.input(noJudge, answer));
    expect(without.breakdown[0]?.detail).toContain('quote is from guide, expected spec');
  });

  it('does not ground a quote from a page the run never opened, and penalises the citation', async () => {
    const run = session(breadthTask);
    const score = await breadthTask.score(run.input(noJudge, breadthAnswer(BLUE, RED)));
    expect(score.breakdown.every((item) => item.earned === UNGROUNDED_CREDIT)).toBe(true);
    expect(score.breakdown[0]?.detail).toContain('the page was never opened');
    expect(score.penalties[0]?.multiplier).toBe(0.5);
  });

  it('reads a block whose quote kept the page’s quotation marks unescaped', async () => {
    const run = session(breadthTask);
    await run.fetch(SPEC_URL);
    // Valid JSON would be \"cacheable\"; models often re-type a page's “…” as bare quotes.
    const answer = breadthAnswer(BLUE, RED).replace('"Blue widgets are cacheable by default"', '"Blue widgets are "cacheable" by default"');
    expect(answer).toContain('are "cacheable" by');
    const score = await breadthTask.score(run.input(noJudge, answer));
    expect(score.score).toBe(1);
    expect(score.metadata).toMatchObject({ answerBlock: true, answerBlockRepaired: true });
  });

  it('scores an unanswered item, or an answer without the block, zero', async () => {
    const run = session(breadthTask);
    await run.fetch(SPEC_URL);
    const partial = await breadthTask.score(run.input(noJudge, breadthAnswer(BLUE)));
    expect(partial.breakdown.find((item) => item.id === 'red')).toMatchObject({ earned: 0, detail: 'Not answered.' });
    expect(partial.score).toBeCloseTo(0.5, 6);

    const prose = await breadthTask.score(run.input(noJudge, 'Blue is round, red is square.'));
    expect(prose.score).toBe(0);
    expect(prose.metadata?.answerBlock).toBe(false);
  });
});

describe('fieldMatches', () => {
  const text = { name: 'reason', kind: 'text' as const, description: '' };
  const section = { name: 'section', kind: 'section' as const, description: '' };
  const integer = { name: 'rfc', kind: 'integer' as const, description: '' };
  const keyword = { name: 'keyword', kind: 'keyword' as const, description: '' };
  const flag = { name: 'flag', kind: 'boolean' as const, description: '' };

  it('compares each kind by meaning, not formatting', () => {
    expect(fieldMatches(text, 'non-authoritative  information', 'Non-Authoritative Information')).toBe(true);
    expect(fieldMatches(text, 'Payload Too Large', 'Content Too Large')).toBe(false);
    expect(normalizeSection('Section 15.4.9.')).toBe('15.4.9');
    expect(fieldMatches(section, '§ 15.4.9', '15.4.9')).toBe(true);
    expect(fieldMatches(section, '15.4.9.1', '15.4.9')).toBe(false);
    expect(fieldMatches(integer, 'RFC 9,111', 9111)).toBe(true);
    expect(fieldMatches(integer, 9111.5, 9111)).toBe(false);
    expect(fieldMatches(keyword, 'shall  not', 'SHALL NOT')).toBe(true);
    expect(fieldMatches(keyword, 'SHOULD NOT', 'SHALL NOT')).toBe(false);
    expect(fieldMatches(flag, 'Yes', true)).toBe(true);
    expect(fieldMatches(flag, 'maybe', false)).toBe(false);
  });

  it('expects nothing where the gold value is null', () => {
    expect(fieldMatches(integer, null, null)).toBe(true);
    expect(fieldMatches(integer, undefined, null)).toBe(true);
    expect(fieldMatches(integer, 64, null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// the shipped task set, end to end against the shipped corpus
// ---------------------------------------------------------------------------

function shippedSession(task: Task) {
  const env = task.createEnvironment({ cwd: scratch, fixtureMode: 'replay', fixtureDir: FIXTURES_DIR }) as TaskEnvironment;
  const corpus = researchState(env).corpus;
  const tools = createWebTools({ corpus });
  const urlOf = (id: string): string => {
    const document = corpus.documents.find((candidate) => candidate.id === id);
    if (!document) throw new Error(`${id} is not in ${task.id}'s corpus`);
    return document.url;
  };
  return {
    env,
    corpus,
    /** Open a page and nothing more: its first window. */
    fetchDoc: async (id: string) => {
      const reply = await callTool(tools, env.journal, 'fetch_page', { url: urlOf(id) });
      expect(reply.isError).toBe(false);
      return urlOf(id);
    },
    /**
     * Read a passage the way an agent does: `find` a few of its words (the
     * first four that `find` can match: it does not skip an RFC's `|` margin),
     * then read a window from each place they occur.
     */
    readPassage: async (id: string, quote: string) => {
      const url = urlOf(id);
      const words = quote.split(/\s+/);
      for (let first = 0; first + 4 <= words.length; first++) {
        const found = await callTool(tools, env.journal, 'fetch_page', { url, find: words.slice(first, first + 4).join(' ') });
        const offsets = [...found.text.matchAll(/^- offset (\d+):/gm)].map((match) => Number(match[1]));
        for (const offset of offsets) await callTool(tools, env.journal, 'fetch_page', { url, offset: Math.max(0, offset - 300) });
        if (offsets.length > 0) return url;
      }
      throw new Error(`${id}: no four consecutive words of "${quote}" can be found`);
    },
    input: (judge: Judge, finalText: string): ScoreInput => ({
      env,
      outcome: { finalText, subagentCount: 0, phases: [] },
      trace: [],
      deps: { judge, judgeSamples: 1 },
    }),
  };
}

describe('researchTasks', () => {
  it('ships three judged and three gold-key tasks, each with a hypothesis and traps', () => {
    expect(researchTasks.map((task) => task.id)).toEqual([
      'research-http-redirects',
      'research-script-loading',
      'research-password-hashing',
      'research-status-codes',
      'research-header-fields',
      'research-nist-password-rules',
    ]);
    for (const task of researchTasks) {
      expect(task.category).toBe('research');
      expect(task.world).toBe('web');
      expect(task.hypothesis, task.id).toBeTruthy();
      expect(task.traps?.length, task.id).toBeGreaterThan(0);
      expect(task.prompt, task.id).toContain('```json');
    }
  });

  it('keeps rubrics small and positive, and breadth tasks broad', () => {
    for (const spec of judgedResearchSpecs) {
      expect(spec.rubric.length).toBeGreaterThanOrEqual(4);
      expect(spec.rubric.length).toBeLessThanOrEqual(6);
      expect(spec.rubric.every((item) => item.weight > 0)).toBe(true);
    }
    for (const spec of breadthResearchSpecs) expect(spec.items.length).toBeGreaterThanOrEqual(8);
  });

  for (const spec of breadthResearchSpecs) {
    const task = researchTasks.find((candidate) => candidate.id === spec.id)!;

    it(`${spec.id}: the gold key, quoted from the passages the run read, scores 1`, async () => {
      const run = shippedSession(task);
      const answers = [];
      for (const item of spec.items) {
        const url = await run.readPassage(item.source.doc, item.goldQuote);
        answers.push({ [spec.key.name]: item.key, ...item.expected, quote: item.goldQuote, url });
      }
      const score = await task.score(run.input(noJudge, answerWithBlock('Answer.', { answers })));
      expect(score.score).toBe(1);
    });

    it(`${spec.id}: opening each page but quoting from memory earns no grounding`, async () => {
      // The page is opened, so no citation is a fabrication, and every quote
      // is in it word for word; but the run was only shown each page's first
      // window, and a model can recite a specification it has memorized.
      const run = shippedSession(task);
      const answers = [];
      for (const item of spec.items) {
        const url = await run.fetchDoc(item.source.doc);
        answers.push({ [spec.key.name]: item.key, ...item.expected, quote: item.goldQuote, url });
      }
      const score = await task.score(run.input(noJudge, answerWithBlock('Answer.', { answers })));
      expect(score.penalties).toEqual([]);
      expect(score.score).toBeCloseTo(UNGROUNDED_CREDIT, 6);
      expect(score.breakdown[0]?.detail).toContain('no tool ever showed the run this passage');
    });

    it(`${spec.id}: a perfect closed-book answer stays low`, async () => {
      const run = shippedSession(task);
      const answers = spec.items.map((item) => ({
        [spec.key.name]: item.key,
        ...item.expected,
        quote: item.goldQuote,
        url: run.corpus.documents.find((document) => document.id === item.source.doc)?.url,
      }));
      const score = await task.score(run.input(noJudge, answerWithBlock('From memory.', { answers })));
      expect(score.score).toBeCloseTo(UNGROUNDED_CREDIT * 0.5, 6);
    });
  }

  for (const spec of judgedResearchSpecs) {
    const task = researchTasks.find((candidate) => candidate.id === spec.id)!;

    it(`${spec.id}: an answer quoting the documented support scores 1`, async () => {
      const run = shippedSession(task);
      const evidence: Array<{ claim: string; quote: string; url: string }> = [];
      const support: Record<string, string[]> = {};
      for (const item of spec.rubric) {
        for (const passage of item.support) {
          evidence.push({ claim: item.claim, quote: passage.quote, url: await run.readPassage(passage.doc, passage.quote) });
          (support[item.id] ??= []).push(`E${evidence.length}`);
        }
      }
      const prose = spec.rubric.map((item) => item.claim).join(' ');
      const { judge } = judgeReturning({
        verdicts: spec.rubric.map((item) => ({ id: item.id, status: 'met', support: support[item.id], answerQuote: item.claim })),
      });
      const score = await task.score(run.input(judge, answerWithBlock(prose, { evidence })));
      expect(score.score).toBe(1);
    });

    it(`${spec.id}: a perfect closed-book answer stays low`, async () => {
      const run = shippedSession(task);
      const prose = spec.rubric.map((item) => item.claim).join(' ');
      const { judge } = judgeReturning({
        verdicts: spec.rubric.map((item) => ({ id: item.id, status: 'met', support: [], answerQuote: item.claim })),
      });
      const score = await task.score(run.input(judge, prose));
      expect(score.score).toBeCloseTo(UNGROUNDED_CREDIT, 6);
    });
  }
});
