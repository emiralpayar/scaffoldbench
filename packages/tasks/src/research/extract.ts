/**
 * Turn a fetched page into the plain text the research corpus stores.
 *
 * Build-time only: `scripts/build-corpus.ts` runs this once per source and
 * commits the result, so the benchmark itself never parses HTML. It lives in
 * the package rather than in the script so the extraction rules are type
 * checked and tested like everything else.
 *
 * The goal is the text a careful reader would see on the page, minus the site
 * around it: navigation, sidebars, footers and feedback widgets are noise that
 * costs the agent tokens and dilutes search. Inline markup is removed without
 * inserting spaces, so a sentence reads exactly as the browser renders it and a
 * quote copied from the page matches the stored text.
 */

/** Selects an element by tag and, optionally, a token in one of its attributes. */
export interface ElementMatcher {
  tag: string;
  /** Attribute to test, e.g. `class` or `id`. */
  attr?: string;
  /** Whitespace-separated token the attribute must contain (`class`), or its exact value (`id`). */
  value?: string;
}

export type Extractor =
  | {
      /** An RFC's plain-text rendering. Pagination is removed; the text is otherwise verbatim. */
      kind: 'rfc-text';
    }
  | {
      kind: 'html';
      /** The element holding the article. Defaults to `<body>`. */
      root?: ElementMatcher;
      /** Page furniture inside the root to remove, on top of the elements every page loses. */
      drop?: ElementMatcher[];
      /**
       * Number headings from their nesting. Some sites (pages.nist.gov) render
       * section numbers with CSS counters, so they are absent from the markup
       * but present on screen — and the text cross-references them ("Sec.
       * 3.1.1.2"), so a reader needs them.
       */
      numberHeadings?: boolean;
      /** Whole lines to delete, e.g. a build timestamp that changes on every fetch. */
      dropLines?: RegExp[];
    };

export interface ExtractedDocument {
  title: string;
  text: string;
}

/**
 * Elements that never carry article text, removed from every HTML page.
 * `<aside>` is not among them: web.dev sets its notes, cautions and key terms
 * in `<aside>`, and those are article text. A site whose asides are sidebars
 * drops them in its own extractor.
 */
const ALWAYS_DROPPED = [
  'script',
  'style',
  'noscript',
  'template',
  'svg',
  'nav',
  'header',
  'footer',
  'form',
  'button',
  'iframe',
  'dialog',
  'select',
];

export function extractDocument(raw: string, extractor: Extractor): ExtractedDocument {
  if (extractor.kind === 'rfc-text') return { title: '', text: rfcPlainText(raw) };

  const title = extractTitle(raw);
  // Comments, and the `<?…>` / `<!…>` constructs a browser also treats as
  // comments (MDN's templates leave stray `<?>` markers in the page).
  let html = raw.replace(/<!--[\s\S]*?-->/g, '').replace(/<[?!][^>]*>/g, '');
  const root = extractor.root ?? { tag: 'body' };
  const span = findElement(html, root);
  if (!span) throw new Error(`extract: no <${root.tag}> matching ${JSON.stringify(root)}`);
  html = html.slice(span.innerStart, span.innerEnd);

  for (const tag of ALWAYS_DROPPED) html = dropElements(html, { tag });
  for (const matcher of extractor.drop ?? []) html = dropElements(html, matcher);

  let text = htmlToText(html, { numberHeadings: extractor.numberHeadings === true });
  for (const pattern of extractor.dropLines ?? []) {
    text = text
      .split('\n')
      .filter((line) => !pattern.test(line))
      .join('\n');
  }
  return { title, text: tidy(text) };
}

// ---------------------------------------------------------------------------
// RFC plain text
// ---------------------------------------------------------------------------

/** `Fielding & Reschke   Standards Track   [Page 12]` */
const RFC_PAGE_FOOTER = /^\S.*\[Page \d+\]\s*$/;
/** `RFC 7231    HTTP/1.1 Semantics and Content    June 2014` */
const RFC_PAGE_HEADER = /^RFC \d+ {2,}.* {2,}[A-Z][a-z]+ \d{4}\s*$/;

/**
 * An RFC's text with its print pagination removed.
 *
 * Older RFCs are paginated for line printers: every 58 lines a footer, a form
 * feed and a running header interrupt the text, often mid-sentence. Those
 * three lines are layout, not content, and leaving them in would break any
 * sentence quoted across a page boundary. Otherwise only whitespace changes:
 * trailing spaces go, and the blank lines a page break leaves become one.
 */
export function rfcPlainText(raw: string): string {
  const lines = raw.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n');
  const kept: string[] = [];
  for (const line of lines) {
    const content = line.replace(/\f/g, '');
    if (RFC_PAGE_FOOTER.test(content) || RFC_PAGE_HEADER.test(content)) continue;
    kept.push(content.replace(/\s+$/, ''));
  }
  return tidy(kept.join('\n'));
}

// ---------------------------------------------------------------------------
// element selection
// ---------------------------------------------------------------------------

/**
 * One tag, attributes included. Quoted attribute values are consumed whole, so
 * a `<script>` inside `title="The <script> element"` is never mistaken for a
 * tag — the WHATWG spec is full of those.
 */
const TAG = /<(\/?)([a-zA-Z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;

/** Elements whose content is raw text: a `<` inside them never starts a tag. */
const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title', 'xmp']);

interface ScannedTag {
  start: number;
  end: number;
  closing: boolean;
  name: string;
  attributes: string;
  selfClosing: boolean;
}

/** Every tag from `from` on, in document order, stepping over raw-text content. */
function* scanTags(html: string, from: number): Generator<ScannedTag> {
  const pattern = new RegExp(TAG.source, 'g');
  pattern.lastIndex = from;
  for (let match = pattern.exec(html); match; match = pattern.exec(html)) {
    const name = (match[2] ?? '').toLowerCase();
    const attributes = match[3] ?? '';
    const tag: ScannedTag = {
      start: match.index,
      end: match.index + match[0].length,
      closing: match[1] === '/',
      name,
      attributes,
      selfClosing: attributes.trimEnd().endsWith('/'),
    };
    yield tag;

    if (!tag.closing && !tag.selfClosing && RAW_TEXT.has(name)) {
      const close = html.toLowerCase().indexOf(`</${name}`, tag.end);
      if (close === -1) return;
      pattern.lastIndex = close;
    }
  }
}

interface ElementSpan {
  start: number;
  innerStart: number;
  innerEnd: number;
  end: number;
}

function attributeValue(attributes: string, name: string): string | undefined {
  const pattern = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i');
  const match = attributes.match(pattern);
  if (!match) {
    // A bare boolean attribute, e.g. `<div latex-literal>`.
    return new RegExp(`(?:^|\\s)${name}(?:\\s|$)`, 'i').test(attributes) ? '' : undefined;
  }
  return match[1] ?? match[2] ?? match[3] ?? '';
}

function matches(tag: ScannedTag, matcher: ElementMatcher): boolean {
  if (tag.closing || tag.name !== matcher.tag.toLowerCase()) return false;
  if (!matcher.attr) return true;
  const value = attributeValue(tag.attributes, matcher.attr);
  if (value === undefined) return false;
  if (matcher.value === undefined) return true;
  if (matcher.attr.toLowerCase() === 'class') return value.split(/\s+/).includes(matcher.value);
  return value === matcher.value;
}

/**
 * The first element matching `matcher` at or after `from`, with its matching
 * close tag found by counting nested elements of the same name.
 *
 * A `<div ... />` is counted as self-closing. HTML would treat it as an open
 * tag, but the pages that write it (pages.nist.gov) mean an empty element, and
 * honouring the slash keeps the nesting count balanced.
 */
export function findElement(
  html: string,
  matcher: ElementMatcher,
  from = 0,
): ElementSpan | undefined {
  const tags = scanTags(html, from);
  for (const tag of tags) {
    if (!matches(tag, matcher)) continue;
    if (tag.selfClosing) {
      return { start: tag.start, innerStart: tag.end, innerEnd: tag.end, end: tag.end };
    }

    let depth = 1;
    for (const next of tags) {
      if (next.name !== tag.name || next.selfClosing) continue;
      depth += next.closing ? -1 : 1;
      if (depth === 0) {
        return { start: tag.start, innerStart: tag.end, innerEnd: next.start, end: next.end };
      }
    }
    // Unclosed: the element runs to the end of the document.
    return { start: tag.start, innerStart: tag.end, innerEnd: html.length, end: html.length };
  }
  return undefined;
}

/** Remove every element matching `matcher`, including everything nested inside it. */
export function dropElements(html: string, matcher: ElementMatcher): string {
  let out = '';
  let cursor = 0;
  for (let span = findElement(html, matcher, cursor); span; span = findElement(html, matcher, cursor)) {
    out += `${html.slice(cursor, span.start)} `;
    cursor = span.end;
  }
  return out + html.slice(cursor);
}

// ---------------------------------------------------------------------------
// HTML to text
// ---------------------------------------------------------------------------

const BLOCK_TAGS = new Set([
  'p', 'div', 'section', 'article', 'aside', 'main', 'ul', 'ol', 'dl', 'dt', 'dd', 'table', 'thead', 'tbody',
  'tfoot', 'caption', 'blockquote', 'figure', 'figcaption', 'details', 'summary', 'hr', 'address',
]);

export function extractTitle(html: string): string {
  const match = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  return match?.[1] ? collapse(decodeEntities(match[1])) : '';
}

/**
 * Readable text from an HTML fragment, keeping the structure a reader relies
 * on: paragraphs, headings, list items, table rows and preformatted blocks.
 *
 * Inline tags vanish without a trace: `<strong>SHALL</strong> be` must read
 * `SHALL be`, and `x<sup>2</sup>` must not become `x 2`.
 */
export function htmlToText(html: string, options: { numberHeadings?: boolean } = {}): string {
  const out: string[] = [];
  // Preformatted blocks keep their whitespace, so their text is set aside and
  // restored after everything else has been collapsed.
  const preserved: string[] = [];
  let preDepth = 0;
  let preText = '';
  let skipping: string | undefined;
  let heading: { level: number; attributes: string; at: number } | undefined;
  let cells = 0;
  const numbering = new HeadingNumbering();

  const emit = (raw: string): void => {
    if (raw === '' || skipping) return;
    const text = decodeEntities(raw);
    if (preDepth > 0) preText += text;
    else out.push(text.replace(/\s+/g, ' '));
  };

  let cursor = 0;
  for (const tag of scanTags(html, 0)) {
    emit(html.slice(cursor, tag.start));
    cursor = tag.end;
    const { name, closing } = tag;

    if (skipping) {
      if (closing && name === skipping) skipping = undefined;
      continue;
    }
    if (!closing && !tag.selfClosing && RAW_TEXT.has(name)) {
      skipping = name;
      continue;
    }

    if (name === 'pre') {
      if (!closing) {
        preDepth += 1;
      } else if (preDepth > 0 && --preDepth === 0) {
        preserved.push(preText.replace(/^\n+|\s+$/g, ''));
        preText = '';
        out.push(`\n\n\u0000${preserved.length - 1}\u0000\n\n`);
      }
    } else if (preDepth > 0) {
      if (name === 'br') preText += '\n';
    } else if (/^h[1-6]$/.test(name)) {
      if (!closing) {
        heading = { level: Number(name.slice(1)), attributes: tag.attributes, at: out.length };
      } else if (heading) {
        const text = collapse(out.splice(heading.at).join(''));
        const prefix = options.numberHeadings ? numbering.next(heading.level, heading.attributes) : '';
        out.push(`\n\n${prefix}${text}\n\n`);
        heading = undefined;
      }
    } else if (name === 'br') {
      out.push('\n');
    } else if (name === 'li') {
      if (!closing) out.push('\n- ');
    } else if (name === 'tr') {
      if (!closing) {
        out.push('\n');
        cells = 0;
      }
    } else if (name === 'td' || name === 'th') {
      // Separators go before cells, not after them: HTML lets a page omit
      // `</td>`, and the WHATWG spec does.
      if (!closing) {
        if (cells > 0) out.push(' | ');
        cells += 1;
      }
    } else if (name === 'p') {
      out.push('\n\n');
    } else if (BLOCK_TAGS.has(name)) {
      out.push('\n');
    }
  }
  emit(html.slice(cursor));

  const text = out
    .join('')
    .split('\n')
    .map((line) => collapse(line))
    .join('\n');
  return tidy(text.replace(/\u0000(\d+)\u0000/g, (_match, index: string) => preserved[Number(index)] ?? ''));
}

/**
 * Section numbers for headings that carry them only through CSS counters.
 *
 * pages.nist.gov marks each top-level heading with `data-section` (a chapter
 * number or appendix letter) and numbers the levels below it on screen. Front
 * matter has no `data-section` and stays unnumbered, like on the page.
 */
class HeadingNumbering {
  #chapter: string | undefined;
  #counters: number[] = [];

  next(level: number, attributes: string): string {
    if (level === 1) {
      this.#chapter = attributeValue(attributes, 'data-section') || undefined;
      this.#counters = [];
      return this.#chapter ? `${this.#chapter} ` : '';
    }
    if (!this.#chapter) return '';
    const depth = level - 2;
    this.#counters.length = depth + 1;
    for (let i = 0; i < depth; i++) this.#counters[i] = this.#counters[i] ?? 1;
    this.#counters[depth] = (this.#counters[depth] ?? 0) + 1;
    return `${[this.#chapter, ...this.#counters].join('.')} `;
  }
}

function collapse(value: string): string {
  return value.replace(/[^\S\n]+/g, ' ').trim();
}

/** Trim the ends of lines, cap blank-line runs at one, and trim the whole. */
function tidy(text: string): string {
  return text
    .replace(/[^\S\n]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ensp: ' ',
  emsp: ' ',
  thinsp: ' ',
  shy: '',
  zwj: '',
  zwnj: '',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  minus: '−',
  rsquo: '’',
  lsquo: '‘',
  ldquo: '“',
  rdquo: '”',
  laquo: '«',
  raquo: '»',
  bull: '•',
  middot: '·',
  para: '¶',
  sect: '§',
  copy: '©',
  reg: '®',
  trade: '™',
  times: '×',
  divide: '÷',
  deg: '°',
  plusmn: '±',
  le: '≤',
  ge: '≥',
  ne: '≠',
  rarr: '→',
  larr: '←',
  harr: '↔',
  uarr: '↑',
  darr: '↓',
  check: '✓',
};

export function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z][a-z0-9]*);/gi, (match, raw: string) => {
    const lower = raw.toLowerCase();
    const named = NAMED_ENTITIES[lower];
    if (named !== undefined) return named;

    const code = lower.startsWith('#x')
      ? Number.parseInt(lower.slice(2), 16)
      : lower.startsWith('#')
        ? Number.parseInt(lower.slice(1), 10)
        : Number.NaN;
    if (!Number.isInteger(code) || code <= 0 || code > 0x10ffff) return match;
    // A numeric no-break space is still a space to a reader.
    return code === 0xa0 ? ' ' : String.fromCodePoint(code);
  });
}
