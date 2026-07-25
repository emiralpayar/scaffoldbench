import { z } from 'zod';
import { normalizeUrl, type FixtureMode, type JournaledToolSpec, type ToolReply } from '@arena/core';
import { FixtureStore, fixtureKey, similarity, tokenize } from './fixtureStore';

const USER_AGENT =
  'AgentArenaBench/0.1 (agent harness benchmark; record/replay research tools; contact: benchmark operator)';
const REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_PAGE_CHARS = 6_000;
/** Fixtures keep more than the model sees, so raising the render cap needs no re-record. */
const MAX_STORED_PAGE_CHARS = 60_000;
const DEFAULT_SEARCH_LIMIT = 5;
const MAX_SEARCH_LIMIT = 10;
const MAX_STORED_RESULTS = 20;
const SEARCH_ENDPOINT = 'https://html.duckduckgo.com/html/?q=';

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

/** Overlap below this is too weak to be worth returning as a near match. */
const NEAR_MATCH_THRESHOLD = 0.34;
const NEAR_MATCH_RESULTS = 8;

/**
 * Answer a replay search that has no exact recording.
 *
 * Exact-key replay does not survive contact with a real agent: a recording
 * answers only the wording that produced it, and two runs never word a search
 * identically. Measured on a freshly recorded research task, a replay of the
 * same task missed on every one of its sixteen searches and scored near zero —
 * a number that says nothing about the architecture under test.
 *
 * So a miss falls back to the recorded corpus. First the closest recorded query
 * by content-word overlap; failing that, the recorded *pages* whose titles and
 * URLs match the query, assembled into results. As long as the relevant pages
 * were captured at all, any sensible phrasing reaches them — which is the
 * property replay actually needs.
 */
async function nearestRecordedResults(
  store: FixtureStore,
  query: string,
): Promise<SearchResult[] | undefined> {
  const wanted = tokenize(query);
  if (wanted.length === 0) return undefined;

  const searches = await store.all<SearchResult[]>('search');
  let best: { score: number; results: SearchResult[] } | undefined;
  for (const record of searches) {
    if (!Array.isArray(record.value) || record.value.length === 0) continue;
    const score = similarity(wanted, tokenize(record.payload));
    if (score >= NEAR_MATCH_THRESHOLD && (!best || score > best.score)) {
      best = { score, results: record.value };
    }
  }
  if (best) return best.results;

  // Nothing close among the queries — build results from the recorded pages
  // themselves, so a differently-worded search still finds captured sources.
  const scored = (await store.all<PageRecord>('fetch'))
    .filter((record) => isPageRecord(record.value))
    .map((record) => ({
      page: record.value,
      score: similarity(wanted, tokenize(`${record.value.url} ${record.value.title}`)),
    }))
    .filter((entry) => entry.score >= NEAR_MATCH_THRESHOLD)
    .sort((a, b) => b.score - a.score)
    .slice(0, NEAR_MATCH_RESULTS);

  if (scored.length === 0) return undefined;

  return scored.map(({ page }) => ({
    title: page.title || page.url,
    url: page.url,
    snippet: page.text.replace(/\s+/g, ' ').slice(0, 240).trim(),
  }));
}

/**
 * The part of a URL that identifies the page rather than the site.
 *
 * Scoring whole URLs does not work: on a documentation site the scaffolding
 * (`developer.mozilla.org`, `/en-US/docs/Web/`) is most of the string, so
 * `.../HTTP/Status/301` and `.../CSS/grid` come out 78% alike and an unrelated
 * page gets substituted for the one asked for. The last two path segments are
 * what actually name the page.
 */
function urlIdentity(raw: string): { host: string; tail: string[] } | undefined {
  try {
    const url = new URL(raw);
    const segments = url.pathname.split('/').filter((segment) => segment !== '');
    return {
      host: url.hostname.toLowerCase().replace(/^www\./, ''),
      tail: tokenize(segments.slice(-2).join(' ')),
    };
  } catch {
    return undefined;
  }
}

/**
 * Closest recorded page to a URL that was not captured verbatim.
 *
 * Stricter than the search fallback in two ways — the host must match exactly,
 * and the match is on the page-identifying tail — because a substituted page
 * reads to the agent as a real source, whereas an off-target search result is
 * merely ignored.
 */
async function nearestRecordedPage(
  store: FixtureStore,
  raw: string,
): Promise<PageRecord | undefined> {
  const wanted = urlIdentity(raw);
  if (!wanted || wanted.tail.length === 0) return undefined;

  let best: { score: number; page: PageRecord } | undefined;
  for (const record of await store.all<PageRecord>('fetch')) {
    if (!isPageRecord(record.value)) continue;
    const candidate = urlIdentity(record.value.url);
    if (!candidate || candidate.host !== wanted.host) continue;

    const score = similarity(wanted.tail, candidate.tail);
    if (score >= 0.75 && (!best || score > best.score)) {
      best = { score, page: record.value };
    }
  }
  return best?.page;
}



export interface PageRecord {
  url: string;
  title: string;
  text: string;
}

/** The slice of `Response` these tools rely on, so tests can supply a plain object. */
export interface HttpResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

export type FetchLike = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal },
) => Promise<HttpResponse>;

export interface WebToolsOptions {
  fixtureMode: FixtureMode;
  fixtureDir: string;
  /** When set, `fetch_page` refuses any host outside this list (subdomains count). */
  allowedDomains?: string[];
  /** Injected by tests; production uses global fetch. */
  fetchImpl?: FetchLike;
  maxPageChars?: number;
}

export function searchFixtureKey(query: string): string {
  return fixtureKey('search', query);
}

/** Keys the canonical form of the URL so `/page` and `/page/` share one recording. */
export function pageFixtureKey(url: string): string {
  return fixtureKey('fetch', normalizeUrl(url));
}

/**
 * The agent's only door to the web.
 *
 * Built-in WebSearch/WebFetch are deliberately unavailable: routing every
 * retrieval through these tools is what makes a run reproducible in replay mode
 * and what lets the scorer prove, from the trace alone, that a cited page was
 * actually opened.
 */
export function createWebTools(options: WebToolsOptions): JournaledToolSpec[] {
  const store = new FixtureStore(options.fixtureDir);
  const doFetch = options.fetchImpl ?? defaultFetch;
  const maxPageChars = options.maxPageChars ?? DEFAULT_MAX_PAGE_CHARS;
  const allowedDomains = (options.allowedDomains ?? [])
    .map((domain) => domain.trim().toLowerCase().replace(/^www\./, ''))
    .filter((domain) => domain !== '');

  const search: JournaledToolSpec = {
    name: 'search',
    description:
      'Search the web and get back a ranked list of titles, URLs and snippets. ' +
      'Snippets are previews only — use fetch_page to read a source before relying on it.',
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
    async handler(args: { query?: unknown; limit?: unknown }): Promise<ToolReply> {
      const query = typeof args.query === 'string' ? args.query.trim() : '';
      if (query === '') return error('search requires a non-empty `query`.');
      const limit = clampLimit(args.limit);
      const key = searchFixtureKey(query);

      if (options.fixtureMode !== 'live') {
        const hit = await store.read<SearchResult[]>(key);
        if (hit && Array.isArray(hit.value) && hit.value.length > 0) {
          return renderSearch(query, hit.value, limit);
        }
      }

      if (options.fixtureMode === 'replay') {
        const near = await nearestRecordedResults(store, query);
        if (near) return renderSearch(query, near, limit);
        return error(
          `No recorded search results for "${query}". This run is in replay mode and never reaches ` +
            'the network, so this query cannot be answered. Continue with the sources you have ' +
            'already gathered, or try a broader query.',
        );
      }

      try {
        const results = await duckDuckGoSearch(doFetch, query);
        if (results.length === 0) {
          return error(
            `The search backend returned a page with no parsable results for "${query}". ` +
              'Try a different query. Do not guess URLs.',
          );
        }
        if (options.fixtureMode === 'record') {
          await store.write(key, {
            kind: 'search',
            payload: query,
            value: results.slice(0, MAX_STORED_RESULTS),
          });
        }
        return renderSearch(query, results, limit);
      } catch (caught) {
        return error(`Search failed: ${messageOf(caught)}`);
      }
    },
  };

  const fetchPage: JournaledToolSpec = {
    name: 'fetch_page',
    description:
      'Fetch one web page and return its readable text. This is the only way to read a source; ' +
      'only URLs opened with this tool may be cited.',
    readOnly: true,
    schema: {
      url: z.string().describe('Absolute http(s) URL, normally taken from a search result.'),
    },
    async handler(args: { url?: unknown }): Promise<ToolReply> {
      const raw = typeof args.url === 'string' ? args.url.trim() : '';
      const target = parseHttpUrl(raw);
      if (!target) return error(`\`${raw}\` is not an absolute http(s) URL.`);

      const host = target.hostname.toLowerCase().replace(/^www\./, '');
      if (allowedDomains.length > 0 && !allowedDomains.some((domain) => hostMatches(host, domain))) {
        return error(
          `${host} is not on the allowed domain list for this task (${allowedDomains.join(', ')}).`,
        );
      }

      const key = pageFixtureKey(raw);

      if (options.fixtureMode !== 'live') {
        const hit = await store.read<PageRecord>(key);
        if (hit && isPageRecord(hit.value)) return renderPage(hit.value, maxPageChars);
      }

      if (options.fixtureMode === 'replay') {
        // Same problem as search: a run that phrases its way to a slightly
        // different URL on the same page would otherwise get nothing. Accept
        // the closest recorded URL, and say so, so the agent can judge whether
        // it is the page it wanted.
        const near = await nearestRecordedPage(store, raw);
        if (near) {
          return renderPage(near, maxPageChars, `Closest recorded page for ${raw}.`);
        }
        return error(
          `No recorded page for ${raw}. This run is in replay mode and never reaches the network. ` +
            'Work with the pages you have already opened rather than guessing this one’s contents.',
        );
      }

      try {
        const html = await httpGet(doFetch, target.toString());
        const page: PageRecord = {
          url: target.toString(),
          title: extractTitle(html),
          text: htmlToText(html).slice(0, MAX_STORED_PAGE_CHARS),
        };
        if (page.text === '') return error(`${raw} returned no readable text.`);
        if (options.fixtureMode === 'record') {
          await store.write(key, { kind: 'fetch', payload: normalizeUrl(raw), value: page });
        }
        return renderPage(page, maxPageChars);
      } catch (caught) {
        return error(`Could not fetch ${raw}: ${messageOf(caught)}`);
      }
    },
  };

  return [search, fetchPage];
}

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------

function renderSearch(query: string, results: readonly SearchResult[], limit: number): string {
  const shown = results.slice(0, limit);
  const lines = shown.map(
    (result, index) =>
      `${index + 1}. ${result.title}\n   ${result.url}${result.snippet ? `\n   ${result.snippet}` : ''}`,
  );
  const header =
    shown.length < results.length
      ? `Search results for "${query}" (showing ${shown.length} of ${results.length}):`
      : `Search results for "${query}" (${shown.length}):`;
  return `${header}\n${lines.join('\n')}\n\nUse fetch_page on one of these URLs to read the source.`;
}

function renderPage(page: PageRecord, maxChars: number, note?: string): string {
  const truncated = page.text.length > maxChars;
  const body = truncated ? page.text.slice(0, maxChars) : page.text;
  const head = [note ?? '', `URL: ${page.url}`, page.title ? `Title: ${page.title}` : '']
    .filter(Boolean)
    .join('\n');
  const footer = truncated
    ? `\n\n[Truncated: showing the first ${maxChars} of ${page.text.length} characters.]`
    : '';
  return `${head}\n\n${body}${footer}`;
}

function error(text: string): ToolReply {
  return { text, isError: true };
}

// ---------------------------------------------------------------------------
// network
// ---------------------------------------------------------------------------

const defaultFetch: FetchLike = (url, init) => globalThis.fetch(url, init);

async function httpGet(doFetch: FetchLike, url: string): Promise<string> {
  const response = await doFetch(url, {
    headers: {
      'user-agent': USER_AGENT,
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'en-US,en;q=0.9',
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
}

async function duckDuckGoSearch(doFetch: FetchLike, query: string): Promise<SearchResult[]> {
  const html = await httpGet(doFetch, `${SEARCH_ENDPOINT}${encodeURIComponent(query)}`);
  return parseDuckDuckGoHtml(html);
}

const ANCHOR_PATTERN = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;

/** Returns an empty list when the markup does not look like a result page — never a guess. */
export function parseDuckDuckGoHtml(html: string): SearchResult[] {
  const links: Array<{ title: string; url: string }> = [];
  const snippets: string[] = [];

  for (const match of html.matchAll(ANCHOR_PATTERN)) {
    const attributes = match[1] ?? '';
    const inner = match[2] ?? '';
    const classes = classListOf(attributes);

    if (classes.has('result__a')) {
      const href = attributeOf(attributes, 'href');
      const url = href ? resolveResultHref(href) : undefined;
      if (url) links.push({ title: htmlToText(inner) || url, url });
    } else if (classes.has('result__snippet')) {
      snippets.push(htmlToText(inner));
    }
  }

  const seen = new Set<string>();
  const results: SearchResult[] = [];
  links.forEach((link, index) => {
    if (seen.has(link.url)) return;
    seen.add(link.url);
    results.push({ title: link.title, url: link.url, snippet: snippets[index] ?? '' });
  });
  return results;
}

/** DuckDuckGo wraps every result in a redirect whose `uddg` parameter holds the target. */
function resolveResultHref(rawHref: string): string | undefined {
  const href = decodeEntities(rawHref).trim();
  const absolute = href.startsWith('//') ? `https:${href}` : href;

  let parsed: URL;
  try {
    parsed = new URL(absolute);
  } catch {
    return undefined;
  }

  const target = parsed.searchParams.get('uddg');
  if (target) {
    const resolved = parseHttpUrl(target);
    return resolved?.toString();
  }

  if (!isHttpProtocol(parsed)) return undefined;
  if (parsed.hostname.toLowerCase().endsWith('duckduckgo.com')) return undefined;
  return parsed.toString();
}

function classListOf(attributes: string): Set<string> {
  const value = attributeOf(attributes, 'class');
  if (!value) return new Set();
  return new Set(value.split(/\s+/).filter(Boolean));
}

function attributeOf(attributes: string, name: string): string | undefined {
  const match = attributes.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i'));
  return match?.[1];
}

// ---------------------------------------------------------------------------
// HTML to text
// ---------------------------------------------------------------------------

const DROPPED_ELEMENTS = /<(script|style|noscript|template|svg|head)\b[^>]*>[\s\S]*?<\/\1>/gi;
const BLOCK_BOUNDARY =
  /<\/(p|div|section|article|li|ul|ol|h[1-6]|tr|td|th|dt|dd|blockquote|pre|table|header|footer|nav|main|figure|figcaption)\s*>/gi;

/**
 * Minimal readability pass: enough to give the model prose instead of markup,
 * without pulling a parser dependency into the benchmark's hot path.
 */
export function htmlToText(html: string): string {
  const stripped = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(DROPPED_ELEMENTS, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(BLOCK_BOUNDARY, '\n')
    .replace(/<[^>]*>/g, ' ');

  return decodeEntities(stripped)
    .replace(/[^\S\n]+/g, ' ')
    .replace(/[^\S\n]*\n[^\S\n]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function extractTitle(html: string): string {
  const match = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  return match?.[1] ? htmlToText(match[1]).slice(0, 200) : '';
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  rsquo: '’',
  lsquo: '‘',
  ldquo: '“',
  rdquo: '”',
};

function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (match, raw: string) => {
    const name = raw.toLowerCase();
    const named = NAMED_ENTITIES[name];
    if (named !== undefined) return named;

    const code = name.startsWith('#x')
      ? Number.parseInt(name.slice(2), 16)
      : name.startsWith('#')
        ? Number.parseInt(name.slice(1), 10)
        : Number.NaN;
    if (!Number.isInteger(code) || code < 0 || code > 0x10ffff) return match;
    return String.fromCodePoint(code);
  });
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

function parseHttpUrl(raw: string): URL | undefined {
  try {
    const url = new URL(raw);
    return isHttpProtocol(url) ? url : undefined;
  } catch {
    return undefined;
  }
}

function isHttpProtocol(url: URL): boolean {
  return url.protocol === 'http:' || url.protocol === 'https:';
}

/** True when `host` is the domain itself or one of its subdomains. */
export function hostMatches(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

function clampLimit(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return DEFAULT_SEARCH_LIMIT;
  return Math.min(MAX_SEARCH_LIMIT, Math.max(1, Math.floor(raw)));
}

function isPageRecord(value: unknown): value is PageRecord {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.url === 'string' && typeof candidate.text === 'string';
}

function messageOf(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}
