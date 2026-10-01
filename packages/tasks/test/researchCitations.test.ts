import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { ToolCall } from '@arena/core';
import {
  CORPUS_DIRNAME,
  Corpus,
  MAX_EVIDENCE_ENTRIES,
  auditCitations,
  checkQuote,
  citedUrls,
  openedDocuments,
  parseEvidence,
  readAnswerBlock,
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

writeCorpus(scratch, [
  {
    id: 'spec',
    url: 'https://www.rfc-editor.org/rfc/rfc9110.html',
    aliases: ['https://www.rfc-editor.org/rfc/rfc9110.txt'],
    text: SPEC_TEXT,
  },
  { id: 'guide', url: 'https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Status/301', text: 'A guide page about 301 redirects and nothing else of note here.' },
]);
const corpus = Corpus.load(path.join(scratch, CORPUS_DIRNAME)).forTask({ primary: ['spec'], secondary: ['guide'] });

function fetched(url: string, ok = true): ToolCall {
  return { name: 'fetch_page', args: { url }, tMs: 0, ok, result: '' };
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
    expect(parseEvidence('No block here.')).toEqual({ entries: [], prose: 'No block here.', found: false });
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
  const opened = openedDocuments([fetched('https://www.rfc-editor.org/rfc/rfc9110.html')], corpus);
  const url = 'https://www.rfc-editor.org/rfc/rfc9110.txt';

  it('verifies a quote across RFC line breaks, sidebars and re-typed punctuation', () => {
    const check = checkQuote(corpus, opened, '“For historical reasons, a user agent MAY change the request method from POST to GET”', url);
    expect(check.ok).toBe(true);
    expect(checkQuote(corpus, opened, 'HTTP is a stateless application-level protocol for distributed, collaborative, hypertext information systems', url).ok).toBe(true);
  });

  it('accepts elisions when every piece matches in order', () => {
    expect(checkQuote(corpus, opened, 'a user agent MAY change the request method … the 308 (Permanent Redirect) status code can be used instead', url).ok).toBe(true);
    expect(checkQuote(corpus, opened, 'the 308 (Permanent Redirect) status code can be used instead ... a user agent MAY change the request method', url)).toMatchObject({ ok: false, reason: 'not-in-page' });
  });

  it('matches whole words only', () => {
    expect(checkQuote(corpus, opened, 'a user agent MAY change the request meth', url)).toMatchObject({ ok: false, reason: 'not-in-page' });
  });

  it('names why a quote does not count', () => {
    expect(checkQuote(corpus, opened, 'MAY change the request method', url)).toMatchObject({ ok: false, reason: 'too-short' });
    expect(checkQuote(corpus, opened, 'a user agent MAY change the request method to PUT', url)).toMatchObject({ ok: false, reason: 'not-in-page' });
    expect(
      checkQuote(corpus, opened, 'A guide page about 301 redirects and nothing else', 'https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Status/301'),
    ).toMatchObject({ ok: false, reason: 'not-opened' });
    expect(checkQuote(corpus, opened, 'a user agent MAY change the request method', 'https://made-up.org/rfc9110')).toMatchObject({
      ok: false,
      reason: 'not-in-corpus',
    });
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
