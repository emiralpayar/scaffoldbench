import type { ToolCall } from '@arena/core';
import { corpusUrlKey, type CorpusDocument, type TaskCorpus } from './corpus';
import { quoteSegments, wordCount, wordsBetween, type QuoteMatch, type TextRange } from './text';
import { displayedPassages } from './webTools';

/**
 * The deterministic half of research scoring: which pages the agent opened,
 * which it cited, and whether its quotes are really in the pages it names.
 *
 * Nothing here involves a model. The tool journal says what was opened, the
 * frozen corpus says what each page contains, and a quote either occurs in
 * its page or it does not.
 */

/**
 * Shortest quote that counts, in consecutive words. "308 Permanent Redirect"
 * occurs in a dozen places, including tables of contents; a quote has to be
 * long enough to show the sentence was read. Consecutive, because elision may
 * shorten a quote but must not assemble one: "SHALL … not … be … truncated"
 * is six words of the page and no sentence of it.
 */
export const MIN_QUOTE_WORDS = 6;
/**
 * Words of a quote that may lie outside every passage the run was shown:
 * enough to finish a sentence that a window or a `find` context cut off, too
 * few to quote a passage recalled from memory (see `checkQuote`).
 */
export const MAX_UNDISPLAYED_WORDS = 5;
/** Evidence entries beyond this are ignored, which bounds the judge prompt. */
export const MAX_EVIDENCE_ENTRIES = 40;

// ---------------------------------------------------------------------------
// the structured part of an answer
// ---------------------------------------------------------------------------

export interface AnswerBlock<T> {
  value: T;
  /** The answer with the block removed: what a reader sees as prose. */
  prose: string;
  /** True when the block only parsed after `parseJsonBlock` repaired it. */
  repaired: boolean;
}

const FENCE = /(^|\n)[ \t]*(`{3,}|~{3,})[^\n]*\n([\s\S]*?)\n[ \t]*\2[ \t]*(?=\n|$)/g;

/**
 * The last JSON block in an answer that `accept` recognises.
 *
 * Answers end with a fenced ```json block, but models also write ```JSON, a
 * bare fence, or no fence at all after the prose; all of those are read. The
 * last matching block wins because a model that revises itself repeats the
 * block, and the final version is its answer.
 */
export function readAnswerBlock<T>(
  answer: string,
  accept: (value: unknown) => value is T,
): AnswerBlock<T> | undefined {
  const fenced = [...answer.matchAll(FENCE)].reverse();
  for (const match of fenced) {
    const parsed = parseJsonBlock(match[3] ?? '');
    if (parsed && accept(parsed.value)) {
      const start = (match.index ?? 0) + (match[1] ?? '').length;
      const end = (match.index ?? 0) + match[0].length;
      return { value: parsed.value, prose: `${answer.slice(0, start)}${answer.slice(end)}`.trim(), repaired: parsed.repaired };
    }
  }

  // Unfenced: try each line that opens an object, last first.
  const lines = [...answer.matchAll(/(^|\n)[ \t]*\{/g)].reverse();
  for (const line of lines) {
    const start = (line.index ?? 0) + (line[1] ?? '').length;
    const end = answer.lastIndexOf('}');
    if (end <= start) continue;
    const parsed = parseJsonBlock(answer.slice(start, end + 1));
    if (parsed && accept(parsed.value)) {
      return { value: parsed.value, prose: `${answer.slice(0, start)}${answer.slice(end + 1)}`.trim(), repaired: parsed.repaired };
    }
  }
  return undefined;
}

/**
 * Parse a JSON block, repairing the one slip models make in otherwise valid
 * blocks: a double quote copied into a string without its backslash. Quotes
 * are copied from pages, and a page that says `(e.g., “What was the name of
 * your first pet?”)` is re-typed with straight quotes; one such character
 * would otherwise void every entry in the block, which grades JSON escaping
 * rather than research. Raw line breaks inside strings are repaired too.
 */
export function parseJsonBlock(text: string): { value: unknown; repaired: boolean } | undefined {
  const trimmed = text.trim();
  try {
    return { value: JSON.parse(trimmed), repaired: false };
  } catch {
    // Fall through to the repair.
  }
  const repaired = escapeStrayQuotes(trimmed);
  if (repaired === trimmed) return undefined;
  try {
    return { value: JSON.parse(repaired), repaired: true };
  } catch {
    return undefined;
  }
}

/**
 * Inside a string, a double quote ends the string only when what follows it
 * can follow a string (`,` `:` `}` `]`, or nothing); any other is escaped as
 * a literal character. A stray quote that happens to precede a comma is left
 * alone, and then the block simply does not parse.
 */
function escapeStrayQuotes(text: string): string {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i] as string;
    if (!inString) {
      out += char;
      if (char === '"') inString = true;
    } else if (char === '\\') {
      out += char + (text[i + 1] ?? '');
      i += 1;
    } else if (char === '"') {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j] as string)) j += 1;
      const next = text[j];
      if (next === undefined || ',:}]'.includes(next)) {
        out += char;
        inString = false;
      } else {
        out += '\\"';
      }
    } else {
      out += char === '\n' ? '\\n' : char;
    }
  }
  return out;
}

export interface EvidenceEntry {
  claim: string;
  quote: string;
  url: string;
}

export interface ParsedEvidence {
  entries: EvidenceEntry[];
  prose: string;
  /** False when the answer has no evidence block at all. */
  found: boolean;
  /** True when the block only parsed after repair (see `parseJsonBlock`). */
  repaired: boolean;
}

function isEvidenceBlock(value: unknown): value is { evidence: unknown[] } {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as { evidence?: unknown }).evidence)
  );
}

/** The `{"evidence": [{claim, quote, url}]}` block a research answer ends with. */
export function parseEvidence(answer: string): ParsedEvidence {
  const block = readAnswerBlock(answer, isEvidenceBlock);
  if (!block) return { entries: [], prose: answer.trim(), found: false, repaired: false };

  const entries: EvidenceEntry[] = [];
  for (const raw of block.value.evidence) {
    if (typeof raw !== 'object' || raw === null) continue;
    const item = raw as Record<string, unknown>;
    if (typeof item.quote !== 'string' || typeof item.url !== 'string') continue;
    entries.push({
      claim: typeof item.claim === 'string' ? item.claim : '',
      quote: item.quote,
      url: item.url.trim(),
    });
    if (entries.length === MAX_EVIDENCE_ENTRIES) break;
  }
  return { entries, prose: block.prose, found: true, repaired: block.repaired };
}

// ---------------------------------------------------------------------------
// what was opened, and what was read
// ---------------------------------------------------------------------------

/** What a run saw of its web, as the scorer reconstructs it from the tool journal. */
export interface Reading {
  /** Documents opened by a successful `fetch_page`, by id. */
  opened: Map<string, CorpusDocument>;
  /** Per document id, the passages any tool displayed, in normalized coordinates. */
  displayed: Map<string, TextRange[]>;
}

/** The reading a journal records: what was opened, and what was displayed. */
export function readingOf(journal: readonly ToolCall[], corpus: TaskCorpus): Reading {
  const displayed = new Map<string, TextRange[]>();
  for (const [id, ranges] of displayedPassages(journal, corpus)) {
    const document = corpus.corpus.document(id);
    if (!document) continue;
    displayed.set(
      id,
      ranges.map((range) => ({ start: corpus.toNormalized(document, range.start), end: corpus.toNormalized(document, range.end) })),
    );
  }
  return { opened: openedDocuments(journal, corpus), displayed };
}

/**
 * Documents the agent actually opened: successful `fetch_page` calls only.
 *
 * The journal, not the trace, is the source: it records every call any phase
 * or subagent made through the task's tools, and whether it succeeded. A
 * fetch that failed — a 404 for a guessed URL — opened nothing, so citing that
 * URL is as unsupported as citing one never requested.
 */
export function openedDocuments(
  journal: readonly ToolCall[],
  corpus: TaskCorpus,
): Map<string, CorpusDocument> {
  const opened = new Map<string, CorpusDocument>();
  for (const entry of journal) {
    if (entry.name !== 'fetch_page' || !entry.ok || typeof entry.args.url !== 'string') continue;
    const document = corpus.resolve(entry.args.url);
    if (document) opened.set(document.id, document);
  }
  return opened;
}

// ---------------------------------------------------------------------------
// quotes
// ---------------------------------------------------------------------------

export type QuoteFailure = 'not-in-corpus' | 'not-opened' | 'too-short' | 'not-in-page' | 'not-displayed';

export type QuoteCheck =
  | {
      ok: true;
      document: CorpusDocument;
      /** The quote's occurrences in the page that the run was shown. */
      ranges: QuoteMatch[];
    }
  | { ok: false; reason: QuoteFailure; document?: CorpusDocument };

export const QUOTE_FAILURE_TEXT: Record<QuoteFailure, string> = {
  'not-in-corpus': 'the URL is not a page that exists',
  'not-opened': 'the page was never opened',
  'too-short': `the quote has fewer than ${MIN_QUOTE_WORDS} consecutive words`,
  'not-in-page': 'the quote does not occur in the page',
  'not-displayed': 'no tool ever showed the run this passage',
};

/**
 * Whether `quote` is genuinely from the page at `url`, as read in this run:
 * the page exists, the agent opened it, the quote occurs in it word for word
 * (case, punctuation and whitespace aside), and a tool displayed that
 * passage during the run.
 *
 * The last condition is what makes a verified quote evidence of research.
 * Models know RFCs and NIST guidance nearly by heart, so "the page contains
 * this sentence" is satisfied by a run that opens a page's first window and
 * then quotes its section 15 from memory. A quote counts only where the run
 * was shown the passage, allowing `MAX_UNDISPLAYED_WORDS` words beyond the
 * edge of what it was shown.
 */
export function checkQuote(corpus: TaskCorpus, reading: Reading, quote: string, url: string): QuoteCheck {
  const document = corpus.resolve(url);
  if (!document) return { ok: false, reason: 'not-in-corpus' };
  if (!reading.opened.has(document.id)) return { ok: false, reason: 'not-opened', document };

  const longest = Math.max(0, ...quoteSegments(quote).map(wordCount));
  if (longest < MIN_QUOTE_WORDS) return { ok: false, reason: 'too-short', document };

  const matches = corpus.locate(document, quote);
  if (matches.length === 0) return { ok: false, reason: 'not-in-page', document };

  const normalized = corpus.normalized(document);
  const displayed = reading.displayed.get(document.id) ?? [];
  const read = matches.filter((match) => undisplayedWords(normalized, match, displayed) <= MAX_UNDISPLAYED_WORDS);
  if (read.length === 0) return { ok: false, reason: 'not-displayed', document };
  return { ok: true, document, ranges: read };
}

/**
 * Words of a quote occurrence outside every displayed range. Only the quoted
 * pieces count: what an ellipsis skipped was never part of the quote.
 */
export function undisplayedWords(normalized: string, match: QuoteMatch, displayed: readonly TextRange[]): number {
  let words = 0;
  for (const segment of match.segments) {
    let cursor = segment.start;
    for (const range of displayed) {
      if (range.end <= cursor) continue;
      if (range.start >= segment.end) break;
      words += wordsBetween(normalized, cursor, range.start);
      cursor = Math.max(cursor, range.end);
      if (cursor >= segment.end) break;
    }
    words += wordsBetween(normalized, cursor, segment.end);
  }
  return words;
}

/** Words of a quote occurrence inside `span`: how much of the quote comes from there. */
export function wordsInside(normalized: string, match: QuoteMatch, span: TextRange): number {
  return match.segments.reduce(
    (total, segment) => total + wordsBetween(normalized, Math.max(segment.start, span.start), Math.min(segment.end, span.end)),
    0,
  );
}

// ---------------------------------------------------------------------------
// cited URLs
// ---------------------------------------------------------------------------

/** Reserved for documentation (RFC 2606, RFC 6761): an example, never a citation. */
function isReservedHost(host: string): boolean {
  const name = host.toLowerCase().replace(/\.$/, '');
  if (name === 'localhost' || /\.(test|example|invalid|localhost)$/.test(name)) return true;
  return /(^|\.)example\.(com|net|org)$/.test(name);
}

// Square brackets end a URL: unencoded they only appear in IPv6 hosts, which
// no source has, while `[https://a](https://a)` is how Markdown often links.
const BARE_URL = /https?:\/\/[^\s<>"'`[\]]+/gi;
const TRAILING_PUNCTUATION = new Set(['.', ',', ';', ':', '!', '?', '*', '_', '~', "'", '"']);
const BRACKETS: Record<string, string> = { ')': '(', ']': '[', '}': '{' };

/**
 * Strip what surrounds a URL in prose and Markdown without cutting into it.
 *
 * `[RFC 9110](https://…/rfc9110)` leaves a `)`; `**https://…**` leaves
 * asterisks; a sentence leaves a full stop. A closing bracket is part of the
 * URL only when the URL also opened one, as in
 * `https://en.wikipedia.org/wiki/Foo_(bar)`.
 */
export function trimUrl(candidate: string): string {
  let url = candidate;
  for (;;) {
    const last = url.at(-1);
    if (last === undefined) return url;
    if (TRAILING_PUNCTUATION.has(last)) {
      url = url.slice(0, -1);
      continue;
    }
    const opener = BRACKETS[last];
    if (opener && count(url, opener) < count(url, last)) {
      url = url.slice(0, -1);
      continue;
    }
    return url;
  }
}

function count(text: string, char: string): number {
  let total = 0;
  for (const c of text) if (c === char) total += 1;
  return total;
}

/**
 * Every URL the answer cites: links in its prose plus the URLs of its
 * evidence entries, de-duplicated by address.
 *
 * Code blocks are skipped — a `Location: https://new.example/path` in a
 * redirect example is an illustration, not a source — and so are the
 * reserved example domains, which no answer can have read.
 */
export function citedUrls(prose: string, evidenceUrls: readonly string[] = []): string[] {
  const text = prose.replace(FENCE, '\n');
  const found = [...(text.match(BARE_URL) ?? []).map(trimUrl), ...evidenceUrls];

  const seen = new Set<string>();
  const cited: string[] = [];
  for (const url of found) {
    let host: string;
    try {
      host = new URL(url).hostname;
    } catch {
      continue;
    }
    if (isReservedHost(host)) continue;
    const key = corpusUrlKey(url) ?? url;
    if (seen.has(key)) continue;
    seen.add(key);
    cited.push(url);
  }
  return cited;
}

export interface CitationAudit {
  cited: string[];
  /** Cited and opened. */
  verified: string[];
  /** In the corpus, but never opened by this run. */
  unopened: string[];
  /** Not a page that exists in the task's web: could not have been opened. */
  outsideCorpus: string[];
  /** Share of cited URLs that were opened; 1 when nothing is cited. */
  integrity: number;
}

/**
 * Cross-check cited URLs against opened documents. Aliases count as the same
 * page: citing `rfc9110.txt` after opening `rfc9110.html` is fine.
 */
export function auditCitations(
  cited: readonly string[],
  corpus: TaskCorpus,
  opened: ReadonlyMap<string, CorpusDocument>,
): CitationAudit {
  const verified: string[] = [];
  const unopened: string[] = [];
  const outsideCorpus: string[] = [];
  for (const url of cited) {
    const document = corpus.resolve(url);
    if (!document) outsideCorpus.push(url);
    else if (opened.has(document.id)) verified.push(url);
    else unopened.push(url);
  }
  return {
    cited: [...cited],
    verified,
    unopened,
    outsideCorpus,
    integrity: cited.length === 0 ? 1 : verified.length / cited.length,
  };
}
