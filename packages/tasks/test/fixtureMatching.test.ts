import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FixtureStore, similarity, tokenize } from '../src/research/fixtureStore';
import { createWebTools, pageFixtureKey, searchFixtureKey } from '../src/research/webTools';
import type { PageRecord, SearchResult } from '../src/research/webTools';

/**
 * Near-match replay.
 *
 * Exact-key replay looked correct and was unusable: a recording answers only
 * the wording that produced it, and a real agent never repeats a phrasing. A
 * replay of a freshly recorded research task missed on all sixteen of its
 * searches and scored 0.08; with the fallbacks exercised here the same task
 * scored 0.86. These tests pin the behaviour that difference rests on.
 */

let dir: string;
let store: FixtureStore;

const failingFetch = () => {
  throw new Error('replay mode must never reach the network');
};

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'arena-fixtures-'));
  store = new FixtureStore(dir);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function recordSearch(query: string, results: SearchResult[]): Promise<void> {
  await store.write(searchFixtureKey(query), { kind: 'search', payload: query, value: results });
}

async function recordPage(page: PageRecord): Promise<void> {
  await store.write(pageFixtureKey(page.url), { kind: 'fetch', payload: page.url, value: page });
}

function tools() {
  return createWebTools({ fixtureMode: 'replay', fixtureDir: dir, fetchImpl: failingFetch });
}

function toolNamed(name: string) {
  const spec = tools().find((tool) => tool.name === name);
  if (!spec) throw new Error(`no tool named ${name}`);
  return spec;
}

async function call(name: string, args: Record<string, unknown>): Promise<string> {
  const reply = await toolNamed(name).handler(args);
  return typeof reply === 'string' ? reply : reply.text;
}

async function isError(name: string, args: Record<string, unknown>): Promise<boolean> {
  const reply = await toolNamed(name).handler(args);
  return typeof reply === 'string' ? false : reply.isError === true;
}

describe('tokenize', () => {
  it('keeps content words and drops filler', () => {
    expect(tokenize('What is the difference between 301 and 308?')).toEqual([
      'difference',
      '301',
      '308',
    ]);
  });

  it('splits URLs into their meaningful parts', () => {
    expect(tokenize('https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/301')).toContain(
      'mozilla',
    );
    expect(tokenize('https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/301')).toContain(
      '301',
    );
  });

  it('drops single characters and returns nothing for filler-only input', () => {
    expect(tokenize('a of the')).toEqual([]);
  });
});

describe('similarity', () => {
  it('is 1 when the recording covers every content word', () => {
    expect(similarity(tokenize('301 vs 308'), tokenize('http 301 and 308 redirects'))).toBe(1);
  });

  it('is 0 with nothing in common', () => {
    expect(similarity(tokenize('password hashing'), tokenize('redirect status codes'))).toBe(0);
  });

  it('measures coverage of the request, not mutual similarity', () => {
    // A broad recording fully answering a narrow query scores 1, even though
    // the two share little by length — which is the case that matters.
    const narrow = tokenize('argon2id');
    const broad = tokenize('owasp password storage cheat sheet argon2id scrypt bcrypt');
    expect(similarity(narrow, broad)).toBe(1);
    expect(similarity(broad, narrow)).toBeLessThan(0.3);
  });

  it('is 0 for an empty side', () => {
    expect(similarity([], tokenize('anything'))).toBe(0);
    expect(similarity(tokenize('anything'), [])).toBe(0);
  });
});

describe('FixtureStore.all', () => {
  it('is empty when the directory does not exist', async () => {
    const missing = new FixtureStore(path.join(dir, 'nope'));
    expect(await missing.all('search')).toEqual([]);
  });

  it('returns only the requested kind', async () => {
    await recordSearch('q', [{ title: 't', url: 'https://a.com', snippet: 's' }]);
    await recordPage({ url: 'https://a.com', title: 't', text: 'body' });

    expect(await store.all('search')).toHaveLength(1);
    expect(await store.all('fetch')).toHaveLength(1);
  });

  it('caches, and invalidate() picks up later recordings', async () => {
    await recordSearch('first', [{ title: 't', url: 'https://a.com', snippet: 's' }]);
    expect(await store.all('search')).toHaveLength(1);

    await recordSearch('second', [{ title: 't2', url: 'https://b.com', snippet: 's' }]);
    expect(await store.all('search')).toHaveLength(1);

    store.invalidate();
    expect(await store.all('search')).toHaveLength(2);
  });
});

describe('search in replay mode', () => {
  const mdnResults: SearchResult[] = [
    { title: '301 Moved Permanently - MDN', url: 'https://developer.mozilla.org/301', snippet: 'a' },
    { title: '308 Permanent Redirect - MDN', url: 'https://developer.mozilla.org/308', snippet: 'b' },
  ];

  it('serves an exact recording', async () => {
    await recordSearch('http 301 vs 308', mdnResults);
    const out = await call('search', { query: 'http 301 vs 308' });
    expect(out).toContain('developer.mozilla.org/301');
  });

  it('serves a differently-worded query from the closest recording', async () => {
    await recordSearch('http 301 vs 308 redirect difference', mdnResults);
    // Wording no recording anticipated — the exact-key path misses here.
    const out = await call('search', { query: '308 permanent redirect 301 difference' });
    expect(out).toContain('developer.mozilla.org/308');
  });

  it('falls back to the recorded pages when no query is close', async () => {
    await recordSearch('completely unrelated topic', [
      { title: 'x', url: 'https://x.com', snippet: 'x' },
    ]);
    await recordPage({
      url: 'https://owasp.org/password-storage-cheat-sheet',
      title: 'Password Storage Cheat Sheet',
      text: 'Argon2id is the first choice for password hashing.',
    });

    const out = await call('search', { query: 'owasp password storage argon2id' });
    expect(out).toContain('owasp.org/password-storage-cheat-sheet');
    expect(out).toContain('Password Storage Cheat Sheet');
  });

  it('still errors when nothing in the corpus is related', async () => {
    await recordSearch('redirect status codes', [
      { title: 'x', url: 'https://x.com', snippet: 'x' },
    ]);
    expect(await isError('search', { query: 'kubernetes ingress controller tuning' })).toBe(true);
  });

  it('errors on an empty corpus rather than inventing results', async () => {
    expect(await isError('search', { query: 'anything at all' })).toBe(true);
  });

  it('never reaches the network', async () => {
    // failingFetch throws if called; reaching the error branch proves it did not.
    await expect(call('search', { query: 'unrecorded topic' })).resolves.toContain('No recorded');
  });
});

describe('fetch_page in replay mode', () => {
  const mdn: PageRecord = {
    url: 'https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/301',
    title: '301 Moved Permanently',
    text: 'The HTTP 301 Moved Permanently redirect status response code.',
  };

  it('serves an exact recording', async () => {
    await recordPage(mdn);
    expect(await call('fetch_page', { url: mdn.url })).toContain('Moved Permanently');
  });

  it('serves a trailing-slash variant from the same recording', async () => {
    await recordPage(mdn);
    expect(await call('fetch_page', { url: `${mdn.url}/` })).toContain('Moved Permanently');
  });

  it('serves the closest recorded page and says that is what it did', async () => {
    await recordPage(mdn);
    const out = await call('fetch_page', {
      url: 'https://developer.mozilla.org/docs/Web/HTTP/Status/301',
    });
    expect(out).toContain('Closest recorded page');
    expect(out).toContain('Moved Permanently');
  });

  it('refuses a page that is merely on the same site', async () => {
    await recordPage(mdn);
    // Substituting an unrelated page would read to the agent as a real source,
    // so the bar here is deliberately higher than for search.
    expect(
      await isError('fetch_page', { url: 'https://developer.mozilla.org/en-US/docs/Web/CSS/grid' }),
    ).toBe(true);
  });

  it('errors on an empty corpus', async () => {
    expect(await isError('fetch_page', { url: 'https://example.com/page' })).toBe(true);
  });
});
