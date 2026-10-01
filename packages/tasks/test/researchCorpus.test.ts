import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { FIXTURES_DIR } from '@arena/core';
import { Bm25Index, chunkDocument } from '../src/research/bm25';
import { CORPUS_DIRNAME, Corpus, corpusUrlKey, documentFile, sha256, type CorpusSelection } from '../src/research/corpus';
import { CORPUS_SOURCES, LICENSES } from '../src/research/sources';
import { writeCorpus } from './researchHelpers';

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
});
