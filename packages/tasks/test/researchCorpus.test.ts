import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { FIXTURES_DIR, type ToolCall } from '@arena/core';
import {
  Bm25Index,
  CORPUS_DIRNAME,
  CORPUS_ROLES,
  CORPUS_SOURCES,
  Corpus,
  LICENSES,
  breadthResearchSpecs,
  chunkDocument,
  corpusUrlKey,
  createWebTools,
  documentFile,
  judgedResearchSpecs,
  normalizeForMatch,
  sha256,
  type CorpusSelection,
} from '../src/research/index';
import { callTool, writeCorpus } from './researchHelpers';

const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

function freshDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'arena-corpus-'));
  scratch.push(dir);
  return dir;
}

const LONG_TEXT = Array.from(
  { length: 400 },
  (_unused, index) => `Line ${index}: filler text about caching rules and redirects.`,
).join('\n');

function smallCorpus() {
  const dir = writeCorpus(freshDir(), [
    {
      id: 'spec',
      url: 'https://specs.test.org/rfc9110.html',
      aliases: ['https://specs.test.org/rfc9110.txt'],
      title: 'RFC 9110: HTTP Semantics',
      text: `A 308 response is heuristically cacheable; i.e., unless otherwise indicated.\n${LONG_TEXT}\nThe final line mentions Balloon hashing.`,
    },
    {
      id: 'spec-old',
      url: 'https://specs.test.org/rfc9111.html',
      title: 'RFC 9111: HTTP Caching',
      text: 'Caches store responses. Heuristic freshness applies to some responses only.',
    },
    {
      id: 'guide',
      url: 'https://docs.test.org/en-US/docs/Web/HTTP/Status/308',
      title: '308 Permanent Redirect',
      text: 'The 308 status code redirects permanently and keeps the method. Redirects redirect redirecting.',
    },
    {
      id: 'outside',
      url: 'https://elsewhere.test.org/page',
      text: 'A page that exists in the corpus but not in this task.',
    },
  ]);
  const corpus = Corpus.load(path.join(dir, CORPUS_DIRNAME));
  const selection: CorpusSelection = { primary: ['spec'], secondary: ['guide'], superseded: ['spec-old'] };
  return { dir, corpus, view: corpus.forTask(selection) };
}

// ---------------------------------------------------------------------------
// loading and addressing
// ---------------------------------------------------------------------------

describe('Corpus.load', () => {
  it('refuses a document edited after the manifest was written', () => {
    const dir = writeCorpus(freshDir(), [{ id: 'a', url: 'https://a.test.org/', text: 'original text' }]);
    writeFileSync(documentFile(path.join(dir, CORPUS_DIRNAME), 'a'), 'edited text', 'utf8');
    expect(() => Corpus.load(path.join(dir, CORPUS_DIRNAME))).toThrow(/frozen/);
  });

  it('explains how to get a corpus when there is none', () => {
    expect(() => Corpus.load(path.join(freshDir(), CORPUS_DIRNAME))).toThrow(/build-corpus/);
  });
});

describe('corpusUrlKey', () => {
  it('ignores scheme, www, trailing slash, fragment, query and case', () => {
    const key = corpusUrlKey('https://www.rfc-editor.org/rfc/rfc9110.html');
    expect(corpusUrlKey('http://rfc-editor.org/rfc/RFC9110.html/#section-15.4.9')).toBe(key);
    expect(corpusUrlKey('https://www.rfc-editor.org/rfc/rfc9110.html?utm_source=x')).toBe(key);
  });

  it('decodes percent-encoding and rejects non-web URLs', () => {
    expect(corpusUrlKey('https://a.test.org/%3Cscript%3E')).toBe(corpusUrlKey('https://a.test.org/<script>'));
    expect(corpusUrlKey('ftp://a.test.org/x')).toBeUndefined();
    expect(corpusUrlKey('not a url')).toBeUndefined();
  });
});

describe('TaskCorpus.resolve', () => {
  const { view } = smallCorpus();

  it('finds a document by its URL or any alias', () => {
    expect(view.resolve('https://specs.test.org/rfc9110.html')?.id).toBe('spec');
    expect(view.resolve('http://www.specs.test.org/rfc9110.txt#section-1')?.id).toBe('spec');
  });

  it('never substitutes a similar document', () => {
    // Each of these fooled the old near-match replay into serving another page.
    expect(view.resolve('https://specs.test.org/rfc9112.html')).toBeUndefined();
    expect(view.resolve('https://specs.test.org/rfc9110')).toBeUndefined();
    expect(view.resolve('https://docs.test.org/en-US/docs/Web/HTTP/Status/307')).toBeUndefined();
  });

  it('does not serve documents outside the task selection', () => {
    expect(view.resolve('https://elsewhere.test.org/page')).toBeUndefined();
    expect(view.documents.map((document) => document.id)).toEqual(['spec', 'guide', 'spec-old']);
    expect(view.roleOf('spec-old')).toBe('superseded');
  });

  it('refuses a selection naming an unknown document or two documents at one address', () => {
    const { corpus } = smallCorpus();
    expect(() => corpus.forTask({ primary: ['missing'] })).toThrow(/not in the corpus/);
    const dir = writeCorpus(freshDir(), [
      { id: 'x', url: 'https://a.test.org/page', text: 'one' },
      { id: 'y', url: 'https://b.test.org/page', aliases: ['https://a.test.org/page/'], text: 'two' },
    ]);
    expect(() => Corpus.load(path.join(dir, CORPUS_DIRNAME)).forTask({ primary: ['x', 'y'] })).toThrow(
      /addresses both/,
    );
  });

  it('gives each distinct selection its own hash', () => {
    const { corpus } = smallCorpus();
    const a = corpus.forTask({ primary: ['spec'] });
    const b = corpus.forTask({ primary: ['spec', 'guide'] });
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.hash).not.toBe(b.hash);
    expect(corpus.forTask({ primary: ['spec'] })).toBe(a);
  });
});

// ---------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------

describe('Bm25Index', () => {
  const passages = [
    { docId: 'a', offset: 0, text: 'cache cache cache redirect' },
    { docId: 'b', offset: 0, text: 'cache redirect' },
    { docId: 'c', offset: 0, text: 'argon2id memory hard password hashing' },
    { docId: 'd', offset: 0, text: 'cache' },
  ];
  const index = new Bm25Index(passages);

  it('ranks by term frequency and rarity, and drops non-matches', () => {
    expect(index.search('argon2id').map((hit) => hit.passage.docId)).toEqual(['c']);
    const ranked = index.search('cache redirect').map((hit) => hit.passage.docId);
    expect(ranked.slice(0, 2).sort()).toEqual(['a', 'b']);
    expect(ranked).not.toContain('c');
    expect(index.search('nothing here matches')).toEqual([]);
  });

  it('splits identifiers at letter-digit boundaries and folds plurals', () => {
    const terms = new Bm25Index([{ docId: 'x', offset: 0, text: 'RFC 9110 defines redirects' }]);
    expect(terms.search('rfc9110')).toHaveLength(1);
    expect(terms.search('redirect')).toHaveLength(1);
  });

  it('breaks ties deterministically', () => {
    const tied = new Bm25Index([
      { docId: 'z', offset: 0, text: 'same words' },
      { docId: 'y', offset: 5, text: 'same words' },
      { docId: 'y', offset: 0, text: 'same words' },
    ]);
    expect(tied.search('same').map((hit) => `${hit.passage.docId}@${hit.passage.offset}`)).toEqual([
      'y@0',
      'y@5',
      'z@0',
    ]);
  });
});

describe('chunkDocument', () => {
  it('covers the document with passages whose offsets point at their text', () => {
    const passages = chunkDocument('doc', LONG_TEXT, 500);
    expect(passages.length).toBeGreaterThan(10);
    for (const passage of passages) {
      expect(LONG_TEXT.slice(passage.offset, passage.offset + passage.text.length)).toBe(passage.text);
    }
    expect(passages.map((passage) => passage.text).join('\n')).toBe(LONG_TEXT);
  });
});

// ---------------------------------------------------------------------------
// web tools
// ---------------------------------------------------------------------------

describe('search tool', () => {
  const { view } = smallCorpus();
  const tools = createWebTools({ corpus: view });

  it('returns ranked pages with title, canonical URL and a snippet around the match', async () => {
    const reply = await callTool(tools, [], 'search', { query: 'heuristically cacheable 308' });
    expect(reply.isError).toBe(false);
    const first = reply.text.split('\n').slice(1, 4).join('\n');
    expect(first).toContain('RFC 9110: HTTP Semantics');
    expect(first).toContain('https://specs.test.org/rfc9110.html');
    expect(first).toContain('heuristically cacheable');
  });

  it('points at the offset of the best passage in a long page', async () => {
    const reply = await callTool(tools, [], 'search', { query: 'Balloon hashing' });
    const offset = Number(/best match at offset (\d+)/.exec(reply.text)?.[1]);
    expect(offset).toBeGreaterThan(1_000);
  });

  it('answers a query with no matches with an empty result, not an error', async () => {
    const reply = await callTool(tools, [], 'search', { query: 'zebra' });
    expect(reply).toEqual({ text: 'No results found for "zebra".', isError: false });
  });

  it('honours the limit', async () => {
    const reply = await callTool(tools, [], 'search', { query: 'redirect cache responses', limit: 1 });
    expect(reply.text).toMatch(/\(1 of \d+\)/);
  });
});

describe('fetch_page tool', () => {
  const { view } = smallCorpus();
  const spec = view.resolve('https://specs.test.org/rfc9110.html');
  if (!spec) throw new Error('fixture missing');
  const tools = createWebTools({ corpus: view, pageChars: 2_000 });

  it('serves exactly the requested document, under its canonical URL', async () => {
    const reply = await callTool(tools, [], 'fetch_page', { url: 'https://specs.test.org/rfc9110.txt' });
    expect(reply.isError).toBe(false);
    expect(reply.text).toMatch(/^URL: https:\/\/specs\.test\.org\/rfc9110\.html\nTitle: RFC 9110: HTTP Semantics/);
  });

  it('pages through a long document without gaps or overlaps', async () => {
    let offset = 0;
    let read = '';
    for (let guard = 0; guard < 50; guard++) {
      const reply = await callTool(tools, [], 'fetch_page', { url: spec.url, offset });
      const body = reply.text.split('\n\n').slice(1).join('\n\n').replace(/\n\n\[The page continues[\s\S]*$/, '');
      const range = /Characters ([\d,]+)–([\d,]+) of/.exec(reply.text);
      expect(range).not.toBeNull();
      const end = Number(range?.[2]?.replace(/,/g, ''));
      read += spec.text.slice(offset, end);
      expect(spec.text.slice(offset, end).trim()).toBe(body.trim());
      const next = /offset=(\d+)/.exec(reply.text)?.[1];
      if (!next) break;
      expect(Number(next)).toBe(end);
      offset = end;
    }
    expect(read).toBe(spec.text);
  });

  it('returns a short page whole', async () => {
    const reply = await callTool(tools, [], 'fetch_page', { url: 'https://specs.test.org/rfc9111.html' });
    expect(reply.text).toContain('Full page, ');
    expect(reply.text).not.toContain('offset=');
  });

  it('finds a phrase and points at an offset that shows it', async () => {
    const found = await callTool(tools, [], 'fetch_page', { url: spec.url, find: 'BALLOON   hashing' });
    const offset = Number(/offset (\d+):/.exec(found.text)?.[1]);
    expect(spec.text.slice(offset, offset + 15)).toBe('Balloon hashing');
    const page = await callTool(tools, [], 'fetch_page', { url: spec.url, offset });
    expect(page.text).toContain('Balloon hashing');
    const none = await callTool(tools, [], 'fetch_page', { url: spec.url, find: 'argon2' });
    expect(none).toMatchObject({ isError: false });
    expect(none.text).toContain('No occurrences of "argon2"');
  });

  it('answers an unknown URL with a 404 and a bad offset with an error', async () => {
    const journal: ToolCall[] = [];
    const missing = await callTool(tools, journal, 'fetch_page', { url: 'https://specs.test.org/rfc9112.html' });
    expect(missing).toEqual({ text: 'HTTP 404 Not Found: https://specs.test.org/rfc9112.html', isError: true });
    expect(journal[0]?.ok).toBe(false);
    const past = await callTool(tools, journal, 'fetch_page', { url: spec.url, offset: spec.text.length });
    expect(past.isError).toBe(true);
    const bad = await callTool(tools, journal, 'fetch_page', { url: 'mailto:x@test.org' });
    expect(bad.isError).toBe(true);
  });

  it('never tells the agent it is running against a fixture', async () => {
    const replies = [
      await callTool(tools, [], 'fetch_page', { url: 'https://nowhere.test.org/' }),
      await callTool(tools, [], 'search', { query: 'zebra' }),
      await callTool(tools, [], 'search', { query: '' }),
    ];
    for (const reply of replies) expect(reply.text).not.toMatch(/replay|record|fixture|corpus|benchmark|offline/i);
  });
});

// ---------------------------------------------------------------------------
// the shipped corpus
// ---------------------------------------------------------------------------

describe('shipped corpus integrity', () => {
  const dir = path.join(FIXTURES_DIR, CORPUS_DIRNAME);
  const corpus = Corpus.load(dir);
  const manifest = corpus.manifest;

  it('holds exactly the curated sources, with matching metadata and checksums', () => {
    expect(manifest.documents.map((record) => record.id).sort()).toEqual(
      CORPUS_SOURCES.map((source) => source.id).sort(),
    );
    for (const source of CORPUS_SOURCES) {
      const document = corpus.document(source.id);
      expect(document, source.id).toBeDefined();
      if (!document) continue;
      expect(document.url).toBe(source.url);
      expect(document.aliases).toEqual(source.aliases ?? []);
      expect(document.title).toBe(source.title);
      expect(document.license).toBe(source.license);
      expect(document.sha256).toBe(sha256(document.text));
      expect(document.chars).toBe(document.text.length);
      expect(Date.parse(document.retrievedAt)).not.toBeNaN();
    }
  });

  it('stores clean text: no binaries, no page chrome, nothing truncated to a stub', () => {
    for (const document of corpus.documents) {
      expect(document.text.length, document.id).toBeGreaterThan(1_000);
      expect(document.text, document.id).not.toMatch(/^%PDF|\u0000/);
      expect(document.text, document.id).not.toMatch(/Skip to main content|Stay organized with collections|Was this page helpful/);
    }
  });

  it('gives every document a distinct address', () => {
    const owners = new Map<string, string>();
    for (const document of corpus.documents) {
      for (const url of [document.url, ...document.aliases]) {
        const key = corpusUrlKey(url);
        expect(key, url).toBeDefined();
        if (!key) continue;
        expect(owners.get(key) ?? document.id, url).toBe(document.id);
        owners.set(key, document.id);
      }
    }
  });

  it('credits every document, with a known licence, in fixtures/NOTICE.md', () => {
    const notice = readFileSync(path.join(FIXTURES_DIR, 'NOTICE.md'), 'utf8');
    expect(notice).toMatch(/not covered by the repository’s MIT licence/);
    for (const document of corpus.documents) {
      const license = LICENSES[document.license as keyof typeof LICENSES];
      expect(license, document.id).toBeDefined();
      expect(notice).toContain(`### \`${document.id}\``);
      expect(notice).toContain(document.url);
      expect(notice).toContain(license?.name ?? '');
    }
  });

  it('is fully used: every document belongs to some task, every task document exists', () => {
    const selections = [...judgedResearchSpecs, ...breadthResearchSpecs].map((spec) => spec.corpus);
    const used = new Set(selections.flatMap((selection) => CORPUS_ROLES.flatMap((role) => selection[role] ?? [])));
    expect([...used].sort()).toEqual(corpus.documents.map((document) => document.id).sort());
    for (const selection of selections) expect(() => corpus.forTask(selection)).not.toThrow();
  });
});

describe('shipped corpus sufficiency', () => {
  const corpus = Corpus.load(path.join(FIXTURES_DIR, CORPUS_DIRNAME));

  for (const spec of judgedResearchSpecs) {
    it(`${spec.id}: every rubric claim is quotable from the task's own web`, () => {
      const view = corpus.forTask(spec.corpus);
      for (const item of spec.rubric) {
        expect(item.support.length, item.id).toBeGreaterThan(0);
        for (const support of item.support) {
          const document = view.documents.find((candidate) => candidate.id === support.doc);
          expect(document, `${item.id}: ${support.doc} is in the task corpus`).toBeDefined();
          if (!document) continue;
          expect(view.locate(document, support.quote), `${item.id}: ${support.quote}`).not.toEqual([]);
        }
      }
    });
  }

  for (const spec of breadthResearchSpecs) {
    it(`${spec.id}: every gold quote sits inside the section its key points at`, () => {
      const view = corpus.forTask(spec.corpus);
      for (const item of spec.items) {
        expect(view.roleOf(item.source.doc), item.key).toBe('primary');
        const document = corpus.document(item.source.doc);
        if (!document) throw new Error(`${item.source.doc} missing`);
        const spans = view.spans(document, item.source.from, item.source.to);
        expect(spans.length, `${item.key}: span found`).toBeGreaterThan(0);
        for (const span of spans) {
          expect(span.end - span.start, item.key).toBeGreaterThan(40);
          expect(span.end - span.start, item.key).toBeLessThan(20_000);
        }
        const ranges = view.locate(document, item.goldQuote);
        const inside = ranges.some((range) => spans.some((span) => range.start < span.end && range.end > span.start));
        expect(inside, `${item.key}: ${item.goldQuote}`).toBe(true);
      }
    });
  }

  it('states the facts the gold keys rely on, in the words the keys use', () => {
    const rfc9110 = normalizeForMatch(corpus.document('rfc9110')?.text ?? '');
    for (const item of breadthResearchSpecs[0]?.items ?? []) {
      expect(rfc9110).toContain(normalizeForMatch(String(item.source.from)));
      const cacheable = rfc9110.includes(normalizeForMatch(`A ${item.key} response is heuristically cacheable`));
      expect(cacheable, item.key).toBe(item.expected.heuristicallyCacheable);
    }
  });

  // Ranking is purely lexical — no authority or recency prior — so an obsolete
  // RFC can outrank the current one, as it can on the real web. What has to
  // hold is that the authoritative page is among the five results an agent
  // sees by default.
  it('answers natural queries with the authoritative page among the default results', () => {
    const queries: Array<[CorpusSelection, string, string]> = [
      [breadthResearchSpecs[0]!.corpus, '308 Permanent Redirect status code', 'rfc9110'],
      [breadthResearchSpecs[0]!.corpus, 'heuristically cacheable status codes', 'rfc9110'],
      [breadthResearchSpecs[1]!.corpus, 'Cache-Control header field definition', 'rfc9111'],
      [breadthResearchSpecs[1]!.corpus, 'Strict-Transport-Security response header field', 'rfc6797'],
      [breadthResearchSpecs[1]!.corpus, 'Link header field serialisation', 'rfc8288'],
      [breadthResearchSpecs[2]!.corpus, 'password minimum length single-factor verifiers', 'nist-sp800-63b-4'],
      [judgedResearchSpecs[1]!.corpus, 'async defer script element HTML standard', 'whatwg-html-scripting'],
      [judgedResearchSpecs[2]!.corpus, 'OWASP password storage Argon2id', 'owasp-password-storage'],
      [judgedResearchSpecs[2]!.corpus, 'NIST 800-63B password hashing scheme salt', 'nist-sp800-63b-4'],
    ];
    for (const [selection, query, expected] of queries) {
      const top = corpus.forTask(selection).search(query).slice(0, 5).map((hit) => hit.document.id);
      expect(top, query).toContain(expected);
    }
  });
});
