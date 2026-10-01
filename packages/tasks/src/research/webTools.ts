import { z } from 'zod';
import type { JournaledToolSpec, ToolReply } from '@arena/core';
import type { CorpusDocument, TaskCorpus } from './corpus';

/**
 * The agent's only door to the web: `search` and `fetch_page` over the task's
 * frozen corpus.
 *
 * Built-in WebSearch/WebFetch are deliberately unavailable. Routing every
 * retrieval through these two tools is what makes the web identical for every
 * architecture, and what lets the scorer prove from the tool journal alone
 * which pages were actually opened.
 *
 * The tools behave like a small, honest web. Search ranks pages with BM25 and
 * returns nothing when nothing matches. A URL that is not in the corpus is a
 * 404 — there is no "closest page" substitution, so an agent always reads the
 * document it asked for or knows that it did not. Errors never mention that
 * the web is a fixture: an agent told it is in a test behaves differently from
 * one that is not, and that difference would leak into the measurement.
 */

export const DEFAULT_PAGE_CHARS = 8_000;
const DEFAULT_SEARCH_LIMIT = 5;
const MAX_SEARCH_LIMIT = 10;
const MAX_FIND_HITS = 10;

export interface WebToolsOptions {
  corpus: TaskCorpus;
  /** Characters per `fetch_page` window. */
  pageChars?: number;
}

export function createWebTools(options: WebToolsOptions): JournaledToolSpec[] {
  const { corpus } = options;
  const pageChars = options.pageChars ?? DEFAULT_PAGE_CHARS;

  const search: JournaledToolSpec = {
    name: 'search',
    description:
      'Search the web and get back a ranked list of pages with titles, URLs and snippets. ' +
      'Snippets are previews only: open a page with fetch_page before relying on it.',
    readOnly: true,
    schema: {
      query: z.string().describe('Search query, phrased as you would type it into a search engine.'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(MAX_SEARCH_LIMIT)
        .optional()
        .describe(`Maximum results to return (default ${DEFAULT_SEARCH_LIMIT}).`),
    },
    handler(args: { query?: unknown; limit?: unknown }): ToolReply {
      const query = typeof args.query === 'string' ? args.query.trim() : '';
      if (query === '') return error('search requires a non-empty `query`.');

      const hits = corpus.search(query);
      if (hits.length === 0) return `No results found for "${query}".`;

      const shown = hits.slice(0, clampLimit(args.limit));
      const lines = shown.map(
        (hit, index) =>
          `${index + 1}. ${hit.document.title}\n   ${hit.document.url}\n   ${hit.snippet}` +
          (hit.offset > 0 ? `\n   (best match at offset ${hit.offset})` : ''),
      );
      const count = shown.length < hits.length ? `${shown.length} of ${hits.length}` : `${shown.length}`;
      return `Search results for "${query}" (${count}):\n${lines.join('\n')}`;
    },
  };

  const fetchPage: JournaledToolSpec = {
    name: 'fetch_page',
    description:
      'Open a web page and return its readable text, one window of characters at a time. Long ' +
      'pages continue at a later `offset`; `find` lists where a phrase occurs so you can jump ' +
      'there. This is the only way to read a source; only pages opened with it may be cited.',
    readOnly: true,
    schema: {
      url: z.string().describe('Absolute http(s) URL, normally taken from a search result.'),
      offset: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe('Character offset to start reading at (default 0). Each reply says where the next window starts.'),
      find: z
        .string()
        .optional()
        .describe('Instead of reading, list the offsets where this phrase occurs in the page (case-insensitive).'),
    },
    handler(args: { url?: unknown; offset?: unknown; find?: unknown }): ToolReply {
      const raw = typeof args.url === 'string' ? args.url.trim() : '';
      if (!isHttpUrl(raw)) return error(`\`${raw}\` is not an absolute http(s) URL.`);

      const document = corpus.resolve(raw);
      if (!document) return error(`HTTP 404 Not Found: ${raw}`);

      if (typeof args.find === 'string' && args.find.trim() !== '') {
        return renderFind(document, args.find.trim(), corpus);
      }

      const offset = typeof args.offset === 'number' && Number.isFinite(args.offset) ? Math.floor(args.offset) : 0;
      if (offset < 0 || offset >= document.text.length) {
        return error(
          `offset ${offset} is outside this page, which has ${document.text.length.toLocaleString('en-US')} characters.`,
        );
      }
      return renderWindow(document, offset, pageChars);
    },
  };

  return [search, fetchPage];
}

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------

function header(document: CorpusDocument): string {
  return `URL: ${document.url}\nTitle: ${document.title}`;
}

/**
 * One window of a page, ending at a line break when one is near so a window
 * never stops mid-word, with the offset to continue from.
 */
export function pageWindow(text: string, offset: number, size: number): { start: number; end: number } {
  let end = Math.min(text.length, offset + size);
  if (end < text.length) {
    const lineBreak = text.lastIndexOf('\n', end);
    if (lineBreak > offset + size * 0.75) end = lineBreak + 1;
  }
  return { start: offset, end };
}

function renderWindow(document: CorpusDocument, offset: number, size: number): string {
  const { text } = document;
  const { start, end } = pageWindow(text, offset, size);
  const total = text.length.toLocaleString('en-US');
  const range =
    start === 0 && end === text.length
      ? `Full page, ${total} characters.`
      : `Characters ${start.toLocaleString('en-US')}–${end.toLocaleString('en-US')} of ${total}.`;
  const footer =
    end < text.length
      ? `\n\n[The page continues. Call fetch_page with offset=${end} for the next window, or with find="<phrase>" to locate a passage.]`
      : '';
  return `${header(document)}\n${range}\n\n${text.slice(start, end).trim()}${footer}`;
}

function renderFind(document: CorpusDocument, phrase: string, corpus: TaskCorpus): string {
  const hits = corpus.find(document, phrase);
  if (hits.length === 0) {
    return `${header(document)}\nNo occurrences of "${phrase}" in this page (${document.text.length.toLocaleString('en-US')} characters).`;
  }
  const shown = hits.slice(0, MAX_FIND_HITS);
  const count = shown.length < hits.length ? `showing the first ${shown.length} of ${hits.length}` : `${hits.length}`;
  const lines = shown.map((hit) => `- offset ${hit.offset}: ${hit.context}`);
  return (
    `${header(document)}\nOccurrences of "${phrase}" (${count}):\n${lines.join('\n')}\n\n` +
    'Call fetch_page with one of these offsets to read the passage.'
  );
}

function error(text: string): ToolReply {
  return { text, isError: true };
}

function isHttpUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function clampLimit(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return DEFAULT_SEARCH_LIMIT;
  return Math.min(MAX_SEARCH_LIMIT, Math.max(1, Math.floor(raw)));
}
