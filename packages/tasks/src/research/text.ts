/**
 * Text normalization shared by search, `find`, and the quote checker.
 *
 * One rule for all three, so a phrase an agent finds with the tools is a
 * phrase the scorer will also find.
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

/** A located quote, in the coordinates of the normalized document. */
export interface TextRange {
  start: number;
  end: number;
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
 * only — `cache` does not match inside `cacheable`.
 */
export function locateQuote(normalizedDocument: string, quote: string): TextRange[] {
  const segments = quoteSegments(quote);
  const [first, ...rest] = segments;
  if (first === undefined) return [];

  const found: TextRange[] = [];
  for (const start of wordOccurrences(normalizedDocument, first)) {
    let end = start + first.length;
    let complete = true;
    for (const segment of rest) {
      const next = wordOccurrences(normalizedDocument, segment, end).next();
      if (next.done || next.value - end > MAX_ELISION_GAP) {
        complete = false;
        break;
      }
      end = next.value + segment.length;
    }
    if (complete) found.push({ start, end });
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
