import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Bm25Index, chunkDocument } from './bm25';
import {
  locateQuote,
  normalizedOffsets,
  normalizeForMatch,
  searchTerms,
  wordOccurrences,
  type QuoteMatch,
  type TextRange,
} from './text';

/**
 * The frozen web the research tasks run against.
 *
 * Every page lives in `fixtures/corpus/`: one text file per document plus a
 * manifest with its URL, licence, retrieval date and checksum. Each task names
 * the documents it may see, and `search` ranks only those, so every
 * architecture searches the same small web and gets the same answer to the
 * same query — which is the precondition for comparing them at all.
 *
 * The corpus is built once by `scripts/build-corpus.ts` and only ever read
 * here. Loading verifies every checksum: a corpus edited by hand is refused,
 * because a run's recorded corpus hash would otherwise describe a web the run
 * never saw.
 */

export const CORPUS_DIRNAME = 'corpus';
export const CORPUS_MANIFEST = 'manifest.json';

/** How a document relates to the question a task asks. */
export type CorpusRole = 'primary' | 'secondary' | 'superseded' | 'distractor';

/** The documents a task may see, by role. Only `primary` is required. */
export interface CorpusSelection {
  /** The authoritative sources the gold answer comes from. */
  primary: string[];
  /** Reliable restatements: useful, quotable, not the last word. */
  secondary?: string[];
  /** Earlier versions the primary sources replaced — the version trap. */
  superseded?: string[];
  /** Plausible but off-target pages, there to be passed over. */
  distractor?: string[];
}

export const CORPUS_ROLES: readonly CorpusRole[] = ['primary', 'secondary', 'superseded', 'distractor'];

/** One document as the manifest records it. */
export interface CorpusDocumentRecord {
  id: string;
  /** The canonical URL: what search shows and what an agent should cite. */
  url: string;
  /** Other URLs of the same document (renderings, mirrors, pre-move paths). */
  aliases: string[];
  title: string;
  publisher: string;
  /** Key into `LICENSES` in `sources.ts`. */
  license: string;
  /** Where the text was fetched from, when that differs from `url`. */
  fetchedFrom: string;
  retrievedAt: string;
  sha256: string;
  chars: number;
}

export interface CorpusManifest {
  version: number;
  /** Date the snapshot was taken (YYYY-MM-DD). Answers are graded as of this date. */
  snapshot: string;
  documents: CorpusDocumentRecord[];
}

export interface CorpusDocument extends CorpusDocumentRecord {
  text: string;
}

export function documentFile(dir: string, id: string): string {
  return path.join(dir, 'docs', `${id}.txt`);
}

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * The lookup key for a URL: host without `www.`, decoded lower-case path
 * without a trailing slash. Scheme, query and fragment are ignored — every
 * page in the corpus is addressed by host and path alone, and `#section-15.4`
 * names a place in a document, not a different document.
 */
export function corpusUrlKey(raw: string): string | undefined {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
  let pathname = url.pathname;
  try {
    pathname = decodeURIComponent(pathname);
  } catch {
    // A malformed escape is still a usable key as written.
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  return `${host}${pathname.replace(/\/+$/, '').toLowerCase()}`;
}

/** A whole corpus on disk, loaded and checksum-verified. */
export class Corpus {
  readonly dir: string;
  readonly manifest: CorpusManifest;
  readonly #documents = new Map<string, CorpusDocument>();
  readonly #views = new Map<string, TaskCorpus>();

  private constructor(dir: string, manifest: CorpusManifest, documents: CorpusDocument[]) {
    this.dir = dir;
    this.manifest = manifest;
    for (const document of documents) this.#documents.set(document.id, document);
  }

  static #cache = new Map<string, Corpus>();

  /** Load `dir` (the directory holding `manifest.json`), once per process. */
  static load(dir: string): Corpus {
    const resolved = path.resolve(dir);
    const cached = Corpus.#cache.get(resolved);
    if (cached) return cached;

    let manifest: CorpusManifest;
    try {
      manifest = JSON.parse(readFileSync(path.join(resolved, CORPUS_MANIFEST), 'utf8')) as CorpusManifest;
    } catch (error) {
      throw new Error(
        `No research corpus at ${resolved} (${error instanceof Error ? error.message : String(error)}). ` +
          'It ships with the repository; rebuild it with `npx tsx scripts/build-corpus.ts`.',
      );
    }

    const documents = manifest.documents.map((record) => {
      const text = readFileSync(documentFile(resolved, record.id), 'utf8');
      if (sha256(text) !== record.sha256) {
        throw new Error(
          `Corpus document ${record.id} does not match its manifest checksum. The corpus is frozen: ` +
            'rebuild it with `npx tsx scripts/build-corpus.ts` instead of editing it.',
        );
      }
      return { ...record, text };
    });

    const corpus = new Corpus(resolved, manifest, documents);
    Corpus.#cache.set(resolved, corpus);
    return corpus;
  }

  document(id: string): CorpusDocument | undefined {
    return this.#documents.get(id);
  }

  get documents(): CorpusDocument[] {
    return [...this.#documents.values()];
  }

  /** The view one task gets. Cached, since the search index is the expensive part. */
  forTask(selection: CorpusSelection): TaskCorpus {
    const key = JSON.stringify(selection);
    let view = this.#views.get(key);
    if (!view) {
      view = new TaskCorpus(this, selection);
      this.#views.set(key, view);
    }
    return view;
  }
}

export interface SearchHit {
  document: CorpusDocument;
  score: number;
  /** Offset of the best-matching passage, so the agent can open the page there. */
  offset: number;
  snippet: string;
  /** The stretch of the document the snippet shows, in document offsets. */
  shown: TextRange;
}

export interface FindHit {
  offset: number;
  context: string;
  /** The stretch of the document the context shows, in document offsets. */
  shown: TextRange;
}

const SNIPPET_CHARS = 240;
const FIND_CONTEXT_CHARS = 160;

/** The slice of the corpus one task can see, with its search index. */
export class TaskCorpus {
  readonly corpus: Corpus;
  readonly documents: CorpusDocument[];
  /** Hash of exactly the documents this task sees, recorded with every run. */
  readonly hash: string;
  readonly #roles = new Map<string, CorpusRole>();
  readonly #byUrl = new Map<string, CorpusDocument>();
  readonly #index: Bm25Index;
  readonly #normalized = new Map<string, string>();
  readonly #flattened = new Map<string, { flat: string; offsets: number[] }>();
  readonly #offsetMaps = new Map<string, Int32Array | undefined>();

  constructor(corpus: Corpus, selection: CorpusSelection) {
    this.corpus = corpus;
    this.documents = [];
    for (const role of CORPUS_ROLES) {
      for (const id of selection[role] ?? []) {
        const document = corpus.document(id);
        if (!document) throw new Error(`Task corpus names ${id}, which is not in the corpus.`);
        if (this.#roles.has(id)) throw new Error(`Task corpus lists ${id} twice.`);
        this.#roles.set(id, role);
        this.documents.push(document);
      }
    }

    for (const document of this.documents) {
      for (const url of [document.url, ...document.aliases]) {
        const key = corpusUrlKey(url);
        if (!key) throw new Error(`Corpus document ${document.id} has an invalid URL: ${url}`);
        const clash = this.#byUrl.get(key);
        if (clash && clash.id !== document.id) {
          throw new Error(`${url} addresses both ${clash.id} and ${document.id}.`);
        }
        this.#byUrl.set(key, document);
      }
    }

    this.hash = sha256(
      this.documents
        .map((document) => `${document.id}:${document.sha256}`)
        .sort()
        .join('\n'),
    );

    const byId = new Map(this.documents.map((document) => [document.id, document]));
    this.#index = new Bm25Index(
      this.documents.flatMap((document) => chunkDocument(document.id, document.text)),
      (id) => {
        const document = byId.get(id);
        return document ? `${document.title} ${document.url}` : '';
      },
    );
  }

  roleOf(id: string): CorpusRole | undefined {
    return this.#roles.get(id);
  }

  /** The document a URL addresses, exactly — never a nearby one. */
  resolve(url: string): CorpusDocument | undefined {
    const key = corpusUrlKey(url);
    return key === undefined ? undefined : this.#byUrl.get(key);
  }

  /** Documents ranked by their best passage. */
  search(query: string): SearchHit[] {
    const terms = new Set(searchTerms(query));
    const seen = new Set<string>();
    const hits: SearchHit[] = [];
    for (const { passage, score } of this.#index.search(query)) {
      if (seen.has(passage.docId)) continue;
      seen.add(passage.docId);
      const document = this.documents.find((candidate) => candidate.id === passage.docId);
      if (!document) continue;
      const snippet = snippetOf(passage.text, terms);
      hits.push({
        document,
        score,
        offset: passage.offset,
        snippet: snippet.text,
        shown: { start: passage.offset + snippet.start, end: passage.offset + snippet.end },
      });
    }
    return hits;
  }

  /** Case- and whitespace-insensitive occurrences of `phrase` in a document. */
  find(document: CorpusDocument, phrase: string): FindHit[] {
    const needle = phrase.trim().replace(/\s+/g, ' ').toLowerCase();
    if (needle === '') return [];
    let flattened = this.#flattened.get(document.id);
    if (!flattened) {
      flattened = flattenWhitespace(document.text);
      this.#flattened.set(document.id, flattened);
    }
    const { flat, offsets } = flattened;
    const hits: FindHit[] = [];
    for (let at = flat.indexOf(needle); at !== -1; at = flat.indexOf(needle, at + 1)) {
      const offset = offsets[at] ?? 0;
      const { from, to } = wholeWords(flat, at - FIND_CONTEXT_CHARS / 2, at + needle.length + FIND_CONTEXT_CHARS / 2);
      const shown = { start: offsets[from] ?? 0, end: offsets[to] ?? document.text.length };
      const context = document.text.slice(shown.start, shown.end).replace(/\s+/g, ' ').trim();
      hits.push({ offset, context: `${from > 0 ? '…' : ''}${context}${to < flat.length ? '…' : ''}`, shown });
    }
    return hits;
  }

  /** The document's text in `normalizeForMatch` form, computed once. */
  normalized(document: CorpusDocument): string {
    let text = this.#normalized.get(document.id);
    if (text === undefined) {
      text = normalizeForMatch(document.text);
      this.#normalized.set(document.id, text);
    }
    return text;
  }

  /** Where a quote occurs in a document, in normalized coordinates. */
  locate(document: CorpusDocument, quote: string): QuoteMatch[] {
    return locateQuote(this.normalized(document), quote);
  }

  /** A document offset in normalized coordinates: where `text.slice(0, offset)` ends once normalized. */
  toNormalized(document: CorpusDocument, offset: number): number {
    if (!this.#offsetMaps.has(document.id)) this.#offsetMaps.set(document.id, normalizedOffsets(document.text));
    const map = this.#offsetMaps.get(document.id);
    const clamped = Math.max(0, Math.min(document.text.length, offset));
    // No exact map (see `normalizedOffsets`): normalizing the prefix is slower but exact.
    return map ? (map[clamped] as number) : normalizeForMatch(document.text.slice(0, clamped)).length;
  }

  /**
   * The stretch of a document a gold answer's quote must come from.
   *
   * With `to`, the body of a section: from the line after the heading `from`
   * to the line holding the next heading `to`. Headings are matched as whole
   * lines, which skips cross-references ("Section 6.1 (Strict-Transport-
   * Security HTTP Response Header Field)") and dotted table-of-contents
   * entries; where a table of contents repeats a heading line exactly, the
   * last such line — the real heading — wins. Without `to`, every occurrence
   * of the sentence `from` itself.
   */
  spans(document: CorpusDocument, from: string, to?: string): TextRange[] {
    const wanted = normalizeForMatch(from);
    if (to === undefined) {
      const text = this.normalized(document);
      return [...wordOccurrences(text, wanted)].map((at) => ({ start: at, end: at + wanted.length }));
    }

    const lines = document.text.split('\n');
    const offsets: number[] = [];
    let offset = 0;
    for (const line of lines) {
      offsets.push(offset);
      offset += line.length + 1;
    }
    const heading = lines.findLastIndex((line) => normalizeForMatch(line) === wanted);
    if (heading === -1) return [];
    const next = normalizeForMatch(to);
    const stop = lines.findIndex((line, index) => index > heading && normalizeForMatch(line) === next);
    if (stop === -1) return [];

    // Normalizing a prefix that ends at a line break gives exactly the
    // normalized text up to that point, so its length is the offset.
    const start = normalizeForMatch(document.text.slice(0, offsets[heading + 1])).length;
    const end = normalizeForMatch(document.text.slice(0, offsets[stop])).length;
    return [{ start, end }];
  }
}

/** Lower-cased text with whitespace runs collapsed, mapped back to original offsets. */
function flattenWhitespace(text: string): { flat: string; offsets: number[] } {
  let flat = '';
  const offsets: number[] = [];
  let pendingSpace = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i] as string;
    if (/\s/.test(char)) {
      pendingSpace = flat.length > 0;
      continue;
    }
    if (pendingSpace) {
      flat += ' ';
      offsets.push(i);
      pendingSpace = false;
    }
    // A character whose lower case is longer (rare outside Turkish and
    // German) stays as it is, so every flat character maps to one offset.
    const lower = char.toLowerCase();
    flat += lower.length === char.length ? lower : char;
    offsets.push(i);
  }
  offsets.push(text.length);
  return { flat, offsets };
}

/**
 * The window of a passage that holds the most distinct query terms, so the
 * snippet shows why the page matched rather than wherever a common word first
 * appears. Returns the snippet and the stretch of `text` it shows.
 */
function snippetOf(text: string, terms: ReadonlySet<string>): { text: string } & TextRange {
  const { flat, offsets } = flattenWhitespace(text);
  const hits: Array<{ at: number; term: string }> = [];
  for (const term of terms) {
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(term)}`, 'gu');
    for (const match of flat.matchAll(pattern)) hits.push({ at: match.index ?? 0, term });
  }

  let best = 0;
  let bestTerms = 0;
  for (const hit of hits) {
    const covered = new Set(hits.filter((other) => other.at >= hit.at && other.at < hit.at + SNIPPET_CHARS - 40).map((other) => other.term));
    if (covered.size > bestTerms || (covered.size === bestTerms && hit.at < best)) {
      best = hit.at;
      bestTerms = covered.size;
    }
  }

  const { from, to } = wholeWords(flat, best - 40, best - 40 + SNIPPET_CHARS);
  const start = offsets[from] ?? 0;
  const end = offsets[to] ?? text.length;
  const shown = text.slice(start, end).replace(/\s+/g, ' ').trim();
  return { text: `${from > 0 ? '…' : ''}${shown}${to < flat.length ? '…' : ''}`, start, end };
}

/**
 * Widen `[from, to)` of single-spaced text so it neither starts nor ends inside
 * a word. Agents copy quotes out of snippets and `find` contexts, and a window
 * that cut "Balloon" to "Ball" would hand them a quote that cannot verify.
 */
function wholeWords(flat: string, from: number, to: number): { from: number; to: number } {
  let start = Math.max(0, from);
  let end = Math.min(flat.length, to);
  if (start > 0 && flat[start - 1] !== ' ') start = flat.lastIndexOf(' ', start) + 1;
  if (end < flat.length && flat[end] !== ' ') {
    const space = flat.indexOf(' ', end);
    end = space === -1 ? flat.length : space;
  }
  return { from: start, to: end };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
