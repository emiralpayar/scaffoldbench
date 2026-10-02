import { searchTerms } from './text';

/**
 * Okapi BM25 over passages: the ranking function behind `search`.
 *
 * A dozen lines of arithmetic, kept in-repo rather than pulled in as a
 * dependency, so the ranking every architecture sees is fully specified by
 * this file and the frozen corpus. k1 and b are the textbook defaults.
 */

const K1 = 1.2;
const B = 0.75;

/** A slice of one document, the unit the index ranks. */
export interface Passage {
  docId: string;
  /** Character offset of the passage in its document. */
  offset: number;
  text: string;
}

export interface PassageHit {
  passage: Passage;
  score: number;
}

interface IndexedPassage {
  passage: Passage;
  frequencies: Map<string, number>;
  length: number;
}

export class Bm25Index {
  readonly #passages: IndexedPassage[];
  readonly #documentFrequency = new Map<string, number>();
  readonly #averageLength: number;

  /**
   * @param context Extra text indexed with every passage of a document — its
   *   title and URL — so a query naming the document finds it from any page.
   */
  constructor(passages: readonly Passage[], context: (docId: string) => string = () => '') {
    const contextTerms = new Map<string, string[]>();
    this.#passages = passages.map((passage) => {
      let extra = contextTerms.get(passage.docId);
      if (!extra) {
        extra = searchTerms(context(passage.docId));
        contextTerms.set(passage.docId, extra);
      }
      const terms = [...extra, ...searchTerms(passage.text)];
      const frequencies = new Map<string, number>();
      for (const term of terms) frequencies.set(term, (frequencies.get(term) ?? 0) + 1);
      for (const term of frequencies.keys()) {
        this.#documentFrequency.set(term, (this.#documentFrequency.get(term) ?? 0) + 1);
      }
      return { passage, frequencies, length: terms.length };
    });
    const total = this.#passages.reduce((sum, entry) => sum + entry.length, 0);
    this.#averageLength = this.#passages.length > 0 ? total / this.#passages.length : 0;
  }

  get size(): number {
    return this.#passages.length;
  }

  /** Every passage with a positive score, best first; ties break on document id, then offset. */
  search(query: string): PassageHit[] {
    const terms = [...new Set(searchTerms(query))];
    if (terms.length === 0) return [];

    const count = this.#passages.length;
    const weights = terms.map((term) => {
      const df = this.#documentFrequency.get(term) ?? 0;
      return { term, idf: Math.log(1 + (count - df + 0.5) / (df + 0.5)), df };
    });

    const hits: PassageHit[] = [];
    for (const entry of this.#passages) {
      let score = 0;
      for (const { term, idf, df } of weights) {
        if (df === 0) continue;
        const tf = entry.frequencies.get(term) ?? 0;
        if (tf === 0) continue;
        const norm = 1 - B + (B * entry.length) / (this.#averageLength || 1);
        score += (idf * tf * (K1 + 1)) / (tf + K1 * norm);
      }
      if (score > 0) hits.push({ passage: entry.passage, score });
    }

    return hits.sort(
      (a, b) =>
        b.score - a.score ||
        a.passage.docId.localeCompare(b.passage.docId) ||
        a.passage.offset - b.passage.offset,
    );
  }
}

/**
 * Cut a document into passages of roughly `size` characters, ending each at a
 * line break where one is near, so passages are paragraphs rather than
 * arbitrary windows.
 */
export function chunkDocument(docId: string, text: string, size = 1_200): Passage[] {
  const passages: Passage[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + size);
    if (end < text.length) {
      const lineBreak = text.lastIndexOf('\n', end);
      if (lineBreak > start + size / 2) end = lineBreak + 1;
    }
    const raw = text.slice(start, end);
    const lead = raw.length - raw.trimStart().length;
    const body = raw.trim();
    if (body !== '') passages.push({ docId, offset: start + lead, text: body });
    start = end;
  }
  return passages;
}
