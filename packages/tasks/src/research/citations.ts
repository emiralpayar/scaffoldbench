import type { ToolCall } from '@arena/core';
import { corpusUrlKey, type CorpusDocument, type TaskCorpus } from './corpus';
import { quoteSegments, wordCount, type TextRange } from './text';

/**
 * The deterministic half of research scoring: which pages the agent opened,
 * which it cited, and whether its quotes are really in the pages it names.
 *
 * Nothing here involves a model. The tool journal says what was opened, the
 * frozen corpus says what each page contains, and a quote either occurs in
 * its page or it does not.
 */

/**
 * Shortest quote that counts. "308 Permanent Redirect" occurs in a dozen
 * places, including tables of contents; a quote has to be long enough to show
 * the sentence was read.
 */
export const MIN_QUOTE_WORDS = 6;
/** Evidence entries beyond this are ignored, which bounds the judge prompt. */
export const MAX_EVIDENCE_ENTRIES = 40;

// ---------------------------------------------------------------------------
// the structured part of an answer
// ---------------------------------------------------------------------------

export interface AnswerBlock<T> {
  value: T;
  /** The answer with the block removed: what a reader sees as prose. */
  prose: string;
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
    const value = parseJson(match[3] ?? '');
    if (accept(value)) {
      const start = (match.index ?? 0) + (match[1] ?? '').length;
      const end = (match.index ?? 0) + match[0].length;
      return { value, prose: `${answer.slice(0, start)}${answer.slice(end)}`.trim() };
    }
  }

  // Unfenced: try each line that opens an object, last first.
  const lines = [...answer.matchAll(/(^|\n)[ \t]*\{/g)].reverse();
  for (const line of lines) {
    const start = (line.index ?? 0) + (line[1] ?? '').length;
    const end = answer.lastIndexOf('}');
    if (end <= start) continue;
    const value = parseJson(answer.slice(start, end + 1));
    if (accept(value)) {
      return { value, prose: `${answer.slice(0, start)}${answer.slice(end + 1)}`.trim() };
    }
  }
  return undefined;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text.trim());
  } catch {
    return undefined;
  }
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
  if (!block) return { entries: [], prose: answer.trim(), found: false };

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
  return { entries, prose: block.prose, found: true };
}

// ---------------------------------------------------------------------------
// what was opened
// ---------------------------------------------------------------------------

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

export type QuoteFailure = 'not-in-corpus' | 'not-opened' | 'too-short' | 'not-in-page';

export type QuoteCheck =
  | { ok: true; document: CorpusDocument; ranges: TextRange[] }
  | { ok: false; reason: QuoteFailure; document?: CorpusDocument };

export const QUOTE_FAILURE_TEXT: Record<QuoteFailure, string> = {
  'not-in-corpus': 'the URL is not a page that exists',
  'not-opened': 'the page was never opened',
  'too-short': `the quote is shorter than ${MIN_QUOTE_WORDS} words`,
  'not-in-page': 'the quote does not occur in the page',
};

/**
 * Whether `quote` is genuinely from the page at `url`: the page exists, the
 * agent opened it, and the quote occurs in it word for word (case,
 * punctuation and whitespace aside).
 */
export function checkQuote(
  corpus: TaskCorpus,
  opened: ReadonlyMap<string, CorpusDocument>,
  quote: string,
  url: string,
): QuoteCheck {
  const document = corpus.resolve(url);
  if (!document) return { ok: false, reason: 'not-in-corpus' };
  if (!opened.has(document.id)) return { ok: false, reason: 'not-opened', document };

  const words = quoteSegments(quote).reduce((total, segment) => total + wordCount(segment), 0);
  if (words < MIN_QUOTE_WORDS) return { ok: false, reason: 'too-short', document };

  const ranges = corpus.locate(document, quote);
  if (ranges.length === 0) return { ok: false, reason: 'not-in-page', document };
  return { ok: true, document, ranges };
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
