/**
 * Text normalization for search and the quote checker.
 *
 * Search terms and quote matching both start from `normalizeForMatch`.
 * `fetch_page`'s `find` is stricter (it ignores only case and whitespace), so
 * any run of whole words it locates is a quote the scorer accepts.
 */

/**
 * Canonical form for comparing a quote with a document: case-folded, every run
 * of punctuation and whitespace collapsed to one space.
 *
 * Quotes reach the scorer through a model, which re-types them. It changes
 * curly quotes to straight ones, drops the hyphen an RFC broke across a line
 * ("application-\n   level"), and re-spaces "600,000". None of that changes
 * what the source says, so none of it may decide whether a quote counts.
 * Words and their order still have to match exactly.
 */
export function normalizeForMatch(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Number of words in a normalized string. */
export function wordCount(normalized: string): number {
  return normalized === '' ? 0 : normalized.split(' ').length;
}

/** Words of a normalized text in `[start, end)`, a word cut by either end counting as one. */
export function wordsBetween(normalized: string, start: number, end: number): number {
  return end <= start ? 0 : wordCount(normalized.slice(start, end).trim());
}

const WORD_CHARACTER = /[\p{L}\p{N}]/u;

/**
 * Where each offset of `text` lands in `normalizeForMatch(text)`: entry `i` is
 * the length of the normalized text produced by `text.slice(0, i)`.
 *
 * It lets the scorer turn "characters 12,000–20,000 were displayed" into the
 * coordinates quotes are located in. The map is built a code point at a time,
 * which matches normalizing the whole text except where NFKC composes across
 * code points (a combining accent after its letter); for such a text there is
 * no exact map and the result is `undefined`.
 */
export function normalizedOffsets(text: string): Int32Array | undefined {
  const offsets = new Int32Array(text.length + 1);
  let out = '';
  let gap = false;
  for (let i = 0; i < text.length; ) {
    const codePoint = text.codePointAt(i) as number;
    const width = codePoint > 0xffff ? 2 : 1;
    offsets[i] = out.length;
    if (width === 2) offsets[i + 1] = out.length;
    const character = String.fromCodePoint(codePoint);
    for (const folded of (codePoint < 0x80 ? character : character.normalize('NFKC')).toLowerCase()) {
      if (!WORD_CHARACTER.test(folded)) {
        gap = true;
        continue;
      }
      if (gap && out.length > 0) out += ' ';
      gap = false;
      out += folded;
    }
    i += width;
  }
  offsets[text.length] = out.length;
  return out === normalizeForMatch(text) ? offsets : undefined;
}

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'can', 'do', 'does', 'for', 'from', 'has', 'have',
  'how', 'i', 'if', 'in', 'into', 'is', 'it', 'its', 'of', 'on', 'or', 'should', 'so', 'than', 'that',
  'the', 'their', 'then', 'there', 'these', 'this', 'to', 'vs', 'was', 'what', 'when', 'where',
  'which', 'who', 'why', 'will', 'with',
]);

/**
 * Search terms of a query or a passage.
 *
 * Letter–digit boundaries split (`rfc9110` → `rfc 9110`, `sha256` → `sha 256`)
 * so a query matches however the document happens to spell an identifier, and
 * a trailing plural `s` is dropped so `redirects` finds `redirect`. Both sides
 * go through the same function, which is all a stemmer has to guarantee.
 */
export function searchTerms(text: string): string[] {
  const terms: string[] = [];
  for (const raw of normalizeForMatch(text).split(' ')) {
    for (const part of raw.split(/(?<=\p{L})(?=\p{N})|(?<=\p{N})(?=\p{L})/u)) {
      if (part === '' || STOP_WORDS.has(part) || part.length > 40) continue;
      terms.push(stem(part));
    }
  }
  return terms;
}

function stem(term: string): string {
  if (term.length > 3 && term.endsWith('s') && !term.endsWith('ss')) return term.slice(0, -1);
  return term;
}

/** A stretch of text: of the normalized document, unless a comment says otherwise. */
export interface TextRange {
  start: number;
  end: number;
}

/** One occurrence of a quote: its whole extent, and each elided piece on its own. */
export interface QuoteMatch extends TextRange {
  segments: TextRange[];
}

/**
 * The pieces of a quote, split where the quoter elided text with an ellipsis.
 *
 * Elision is how people quote a long sentence, and a checker that refused it
 * would reward copying whole paragraphs. Each piece is still matched word for
 * word, in order, close together.
 */
export function quoteSegments(quote: string): string[] {
  return quote
    .split(/\.{3,}|…|\[\s*\.{3}\s*\]/)
    .map(normalizeForMatch)
    .filter((segment) => segment !== '');
}

/** Largest gap an elision may skip, in normalized characters (about two paragraphs). */
const MAX_ELISION_GAP = 1_000;

/**
 * Every place `quote` occurs in `normalizedDocument`, matching whole words
 * only — `cache` does not match inside `cacheable`. Elided pieces are matched
 * greedily: each at its first occurrence after the piece before it.
 */
export function locateQuote(normalizedDocument: string, quote: string): QuoteMatch[] {
  const segments = quoteSegments(quote);
  const [first, ...rest] = segments;
  if (first === undefined) return [];

  const found: QuoteMatch[] = [];
  for (const start of wordOccurrences(normalizedDocument, first)) {
    const pieces: TextRange[] = [{ start, end: start + first.length }];
    let end = start + first.length;
    let complete = true;
    for (const segment of rest) {
      const next = wordOccurrences(normalizedDocument, segment, end).next();
      if (next.done || next.value - end > MAX_ELISION_GAP) {
        complete = false;
        break;
      }
      pieces.push({ start: next.value, end: next.value + segment.length });
      end = next.value + segment.length;
    }
    if (complete) found.push({ start, end, segments: pieces });
  }
  return found;
}

/** Start offsets of `needle` in `haystack` at word boundaries, from `from` on. */
export function* wordOccurrences(haystack: string, needle: string, from = 0): Generator<number> {
  if (needle === '') return;
  const padded = ` ${haystack} `;
  const target = ` ${needle} `;
  // In `padded`, the match of ` needle ` begins one character before the
  // needle, which is exactly the needle's offset in `haystack`.
  for (let at = padded.indexOf(target, from); at !== -1; at = padded.indexOf(target, at + 1)) {
    yield at;
  }
}
