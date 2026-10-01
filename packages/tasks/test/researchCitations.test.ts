import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { ToolCall } from '@arena/core';
import {
  CORPUS_DIRNAME,
  Corpus,
  DEFAULT_PAGE_CHARS,
  MAX_EVIDENCE_ENTRIES,
  MAX_UNDISPLAYED_WORDS,
  auditCitations,
  checkQuote,
  citedUrls,
  openedDocuments,
  pageWindow,
  parseEvidence,
  parseJsonBlock,
  readAnswerBlock,
  readingOf,
  trimUrl,
} from '../src/research/index';
import { answerWithBlock, writeCorpus } from './researchHelpers';

const scratch = mkdtempSync(path.join(tmpdir(), 'arena-citations-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const SPEC_TEXT = [
  '15.4.2.  301 Moved Permanently',
  '',
  '      |  *Note:* For historical reasons, a user agent MAY change the',
  '      |  request method from POST to GET for the subsequent request.  If',
  '      |  this behavior is undesired, the 308 (Permanent Redirect) status',
  '      |  code can be used instead.',
  '',
  '   The Hypertext Transfer Protocol (HTTP) is a stateless application-',
  '   level protocol for distributed, collaborative, hypertext information',
  '   systems.',
].join('\n');

/**
 * A page several windows long, one paragraph with no line breaks, whose one
 * notable sentence sits near the end.
 */
const LONG_URL = 'https://docs.test.org/long-page';
const FILLER = 'Plain filler text about nothing in particular, repeated so the page is long. ';
const LATE_SENTENCE = 'Verifiers SHALL NOT truncate a password before comparing it with the stored hash.';
const LONG_TEXT = `${FILLER.repeat(200)}${LATE_SENTENCE} ${FILLER.repeat(5)}`.trim();

writeCorpus(scratch, [
  {
    id: 'spec',
    url: 'https://www.rfc-editor.org/rfc/rfc9110.html',
    aliases: ['https://www.rfc-editor.org/rfc/rfc9110.txt'],
    text: SPEC_TEXT,
  },
  { id: 'guide', url: 'https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Status/301', text: 'A guide page about 301 redirects and nothing else of note here.' },
  { id: 'long', url: LONG_URL, text: LONG_TEXT },
]);
const corpus = Corpus.load(path.join(scratch, CORPUS_DIRNAME)).forTask({
  primary: ['spec'],
  secondary: ['guide', 'long'],
});

function fetched(url: string, ok = true, extra: Record<string, unknown> = {}): ToolCall {
  return { name: 'fetch_page', args: { url, ...extra }, tMs: 0, ok, result: '' };
}

// ---------------------------------------------------------------------------
// URLs in prose
// ---------------------------------------------------------------------------

describe('trimUrl', () => {
  it.each([
    ['https://a.org/x).', 'https://a.org/x'],
    ['https://a.org/x**', 'https://a.org/x'],
    ['https://a.org/x,', 'https://a.org/x'],
    ['https://a.org/x]', 'https://a.org/x'],
    ['https://en.wikipedia.org/wiki/Foo_(bar)', 'https://en.wikipedia.org/wiki/Foo_(bar)'],
    ['https://en.wikipedia.org/wiki/Foo_(bar)).', 'https://en.wikipedia.org/wiki/Foo_(bar)'],
  ])('%s → %s', (raw, trimmed) => {
    expect(trimUrl(raw)).toBe(trimmed);
  });
});

describe('citedUrls', () => {
  it('reads URLs out of Markdown links, autolinks, emphasis and sentences', () => {
    const prose = [
      'See [RFC 9110](https://www.rfc-editor.org/rfc/rfc9110.html#section-15.4.2) and',
      '[MDN](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Status/301 "MDN page").',
      'Also <https://a.test.org/one>, **https://b.org/two**, and (https://c.org/three).',
      'Linked as itself: [https://d.org/four](https://d.org/four).',
    ].join('\n');
    expect(citedUrls(prose)).toEqual([
      'https://www.rfc-editor.org/rfc/rfc9110.html#section-15.4.2',
      'https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Status/301',
      'https://a.test.org/one',
      'https://b.org/two',
      'https://c.org/three',
      'https://d.org/four',
    ]);
  });

  it('ignores code samples and reserved example domains', () => {
    const prose = [
      'A redirect looks like this:',
      '```http',
      'HTTP/1.1 308 Permanent Redirect',
      'Location: https://new-site.org/path',
      '```',
      'Inline: Location: https://www.example.com/new and http://localhost:3000/x and https://api.test/y',
    ].join('\n');
    expect(citedUrls(prose)).toEqual([]);
  });

  it('adds evidence URLs and de-duplicates by address, not spelling', () => {
    const cited = citedUrls('Per https://www.rfc-editor.org/rfc/rfc9110.html.', [
      'http://rfc-editor.org/rfc/rfc9110.html#section-1',
      'https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Status/301',
    ]);
    expect(cited).toEqual([
      'https://www.rfc-editor.org/rfc/rfc9110.html',
      'https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Status/301',
    ]);
  });
});

// ---------------------------------------------------------------------------
// the answer's JSON block
// ---------------------------------------------------------------------------

const isObject = (value: unknown): value is { evidence: unknown[] } =>
  typeof value === 'object' && value !== null && Array.isArray((value as { evidence?: unknown }).evidence);

describe('readAnswerBlock', () => {
  it('takes the last matching fenced block, whatever the fence says', () => {
    const answer = 'Prose.\n```JSON\n{"evidence": [1]}\n```\nMore.\n~~~\n{"evidence": [2]}\n~~~';
    const block = readAnswerBlock(answer, isObject);
    expect(block?.value.evidence).toEqual([2]);
    expect(block?.prose).toBe('Prose.\n```JSON\n{"evidence": [1]}\n```\nMore.');
  });

  it('skips blocks that are not JSON or not the expected shape', () => {
    const answer = 'x\n```json\n{"evidence": [1]}\n```\n```js\nconst a = {};\n```\n```json\n{"other": 1}\n```';
    expect(readAnswerBlock(answer, isObject)?.value.evidence).toEqual([1]);
  });

  it('reads an unfenced object at the end of the answer', () => {
    const block = readAnswerBlock('Done.\n{"evidence": [3]}', isObject);
    expect(block?.value.evidence).toEqual([3]);
    expect(block?.prose).toBe('Done.');
  });

  it('returns undefined when there is no block', () => {
    expect(readAnswerBlock('Just prose with {braces}.', isObject)).toBeUndefined();
  });
});

describe('parseJsonBlock', () => {
  it('parses valid JSON as it is', () => {
    expect(parseJsonBlock(' {"a": "say \\"hi\\""} ')).toEqual({ value: { a: 'say "hi"' }, repaired: false });
  });

  it('escapes a quote mark copied into a string without its backslash', () => {
    const raw = '{"quote": "use KBA (e.g., "What was the name of your first pet?") or questions.", "url": "u"}';
    expect(parseJsonBlock(raw)).toEqual({
      value: { quote: 'use KBA (e.g., "What was the name of your first pet?") or questions.', url: 'u' },
      repaired: true,
    });
  });

  it('repairs a raw line break inside a string', () => {
    expect(parseJsonBlock('{"a": "one\ntwo"}')).toEqual({ value: { a: 'one\ntwo' }, repaired: true });
  });

  it('gives up rather than guess when a stray quote precedes a comma', () => {
    expect(parseJsonBlock('{"a": "he said "yes", then left"}')).toBeUndefined();
    expect(parseJsonBlock('not json')).toBeUndefined();
  });
});

describe('parseEvidence', () => {
  it('keeps well-formed entries and drops the rest', () => {
    const answer = answerWithBlock('The answer.', {
      evidence: [
        { claim: 'c1', quote: 'q1', url: ' https://a.org/x ' },
        { claim: 'no url', quote: 'q2' },
        'not an object',
        { quote: 'q3', url: 'https://a.org/y' },
      ],
    });
    const parsed = parseEvidence(answer);
    expect(parsed.found).toBe(true);
    expect(parsed.prose).toBe('The answer.');
    expect(parsed.entries).toEqual([
      { claim: 'c1', quote: 'q1', url: 'https://a.org/x' },
      { claim: '', quote: 'q3', url: 'https://a.org/y' },
    ]);
  });

  it('caps the number of entries', () => {
    const evidence = Array.from({ length: MAX_EVIDENCE_ENTRIES + 5 }, (_unused, i) => ({ quote: `q${i}`, url: 'https://a.org' }));
    expect(parseEvidence(answerWithBlock('x', { evidence })).entries).toHaveLength(MAX_EVIDENCE_ENTRIES);
  });

  it('reports a missing block', () => {
    expect(parseEvidence('No block here.')).toEqual({ entries: [], prose: 'No block here.', found: false, repaired: false });
  });
});

// ---------------------------------------------------------------------------
// what was opened, and whether quotes are real
// ---------------------------------------------------------------------------

describe('openedDocuments', () => {
  it('counts only successful fetches of pages that exist, under any alias', () => {
    const opened = openedDocuments(
      [
        fetched('https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Status/301', false),
        fetched('https://www.rfc-editor.org/rfc/rfc9110.txt#section-15.4.2'),
        fetched('https://made-up.org/page', false),
        { name: 'search', args: { query: 'x', url: 'https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Status/301' }, tMs: 0, ok: true, result: '' },
      ],
      corpus,
    );
    expect([...opened.keys()]).toEqual(['spec']);
  });
});

describe('checkQuote', () => {
  const reading = readingOf([fetched('https://www.rfc-editor.org/rfc/rfc9110.html')], corpus);
  const url = 'https://www.rfc-editor.org/rfc/rfc9110.txt';

  it('verifies a quote across RFC line breaks, sidebars and re-typed punctuation', () => {
    const check = checkQuote(corpus, reading, '“For historical reasons, a user agent MAY change the request method from POST to GET”', url);
    expect(check.ok).toBe(true);
    expect(checkQuote(corpus, reading, 'HTTP is a stateless application-level protocol for distributed, collaborative, hypertext information systems', url).ok).toBe(true);
  });

  it('accepts elisions when every piece matches in order', () => {
    expect(checkQuote(corpus, reading, 'a user agent MAY change the request method … the 308 (Permanent Redirect) status code can be used instead', url).ok).toBe(true);
    expect(checkQuote(corpus, reading, 'the 308 (Permanent Redirect) status code can be used instead ... a user agent MAY change the request method', url)).toMatchObject({ ok: false, reason: 'not-in-page' });
  });

  it('refuses a quote assembled from fragments, however many words they add up to', () => {
    // Every piece is in the page, in order, but the "quote" is no sentence of it.
    expect(checkQuote(corpus, reading, 'user agent … MAY change … request method … POST to … GET for', url)).toMatchObject({
      ok: false,
      reason: 'too-short',
    });
  });

  it('matches whole words only', () => {
    expect(checkQuote(corpus, reading, 'a user agent MAY change the request meth', url)).toMatchObject({ ok: false, reason: 'not-in-page' });
  });

  it('names why a quote does not count', () => {
    expect(checkQuote(corpus, reading, 'MAY change the request method', url)).toMatchObject({ ok: false, reason: 'too-short' });
    expect(checkQuote(corpus, reading, 'a user agent MAY change the request method to PUT', url)).toMatchObject({ ok: false, reason: 'not-in-page' });
    expect(
      checkQuote(corpus, reading, 'A guide page about 301 redirects and nothing else', 'https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Status/301'),
    ).toMatchObject({ ok: false, reason: 'not-opened' });
    expect(checkQuote(corpus, reading, 'a user agent MAY change the request method', 'https://made-up.org/rfc9110')).toMatchObject({
      ok: false,
      reason: 'not-in-corpus',
    });
  });
});

describe('checkQuote on a long page', () => {
  const late = LONG_TEXT.indexOf(LATE_SENTENCE);

  it('does not count a passage of an opened page that no tool displayed', () => {
    // Opening the page shows its first window; the sentence is far beyond it.
    expect(late).toBeGreaterThan(DEFAULT_PAGE_CHARS * 1.5);
    const reading = readingOf([fetched(LONG_URL)], corpus);
    expect(checkQuote(corpus, reading, LATE_SENTENCE, LONG_URL)).toMatchObject({ ok: false, reason: 'not-displayed' });
  });

  it('counts it once a window, a find context or a search snippet showed it', () => {
    const shownBy: ToolCall[][] = [
      [fetched(LONG_URL, true, { offset: late - 100 })],
      [fetched(LONG_URL, true, { find: 'SHALL NOT truncate' })],
      [fetched(LONG_URL), { name: 'search', args: { query: 'verifiers truncate password hash' }, tMs: 0, ok: true, result: '' }],
    ];
    for (const journal of shownBy) {
      expect(checkQuote(corpus, readingOf(journal, corpus), LATE_SENTENCE, LONG_URL).ok, JSON.stringify(journal[0]?.args)).toBe(true);
    }
  });

  it('ignores what failed calls would have shown', () => {
    const reading = readingOf([fetched(LONG_URL), fetched(LONG_URL, false, { offset: late - 100 })], corpus);
    expect(checkQuote(corpus, reading, LATE_SENTENCE, LONG_URL)).toMatchObject({ ok: false, reason: 'not-displayed' });
  });

  it('lets a quote finish a sentence a few words past the edge of what was shown', () => {
    // A window that stops just before "with the stored hash.": the agent saw
    // the sentence and finished it.
    const cut = late + LATE_SENTENCE.indexOf('with the stored hash');
    expect(pageWindow(LONG_TEXT, cut - DEFAULT_PAGE_CHARS, DEFAULT_PAGE_CHARS).end).toBe(cut);
    const reading = readingOf([fetched(LONG_URL, true, { offset: cut - DEFAULT_PAGE_CHARS })], corpus);
    expect(LATE_SENTENCE.slice(cut - late).split(' ').length).toBeLessThanOrEqual(MAX_UNDISPLAYED_WORDS);
    expect(checkQuote(corpus, reading, LATE_SENTENCE, LONG_URL).ok).toBe(true);

    // Twice as far past the edge is a passage the run never read.
    const longer = `${LATE_SENTENCE} ${FILLER.repeat(2)}`.trim();
    expect(checkQuote(corpus, reading, longer, LONG_URL)).toMatchObject({ ok: false, reason: 'not-displayed' });
  });
});

describe('auditCitations', () => {
  it('splits citations into opened, unopened and nonexistent pages', () => {
    const opened = openedDocuments([fetched('https://www.rfc-editor.org/rfc/rfc9110.html')], corpus);
    const audit = auditCitations(
      [
        'https://www.rfc-editor.org/rfc/rfc9110.txt',
        'https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Status/301',
        'https://made-up.org/page',
      ],
      corpus,
      opened,
    );
    expect(audit.verified).toEqual(['https://www.rfc-editor.org/rfc/rfc9110.txt']);
    expect(audit.unopened).toEqual(['https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Status/301']);
    expect(audit.outsideCorpus).toEqual(['https://made-up.org/page']);
    expect(audit.integrity).toBeCloseTo(1 / 3, 6);
  });

  it('treats an answer that cites nothing as fully consistent', () => {
    expect(auditCitations([], corpus, new Map()).integrity).toBe(1);
  });
});
