/**
 * A small Markdown parser for what agents actually write: headings, lists,
 * tables, fenced code, quotes, emphasis, inline code and links.
 *
 * It produces a tree, never HTML, and `components/Markdown.tsx` turns the tree
 * into React elements, so text is always escaped by React and nothing an agent
 * writes can inject markup. Links survive only with an `http`, `https` or
 * `mailto` scheme; anything else renders as its text.
 *
 * Deliberately not CommonMark-complete. A model's reply is read here, not
 * authored here: the bar is "renders what the trace shows the way the model
 * meant it", and a full parser would be a dependency for edge cases agents do
 * not produce. Two departures from the spec are on purpose. A single newline
 * is a line break, because agents lay out "key: value" lines that a soft break
 * would run together. And emphasis with `_` needs a word boundary on both
 * sides, so identifiers like `get_reservation` stay intact.
 *
 * Pure: safe on the server and in the browser.
 */

export type Inline =
  | { t: 'text'; v: string }
  | { t: 'code'; v: string }
  | { t: 'strong'; c: Inline[] }
  | { t: 'em'; c: Inline[] }
  | { t: 'del'; c: Inline[] }
  | { t: 'link'; href: string; c: Inline[] }
  | { t: 'br' };

export type Align = 'left' | 'center' | 'right' | null;

export type Block =
  | { t: 'p'; c: Inline[] }
  | { t: 'h'; level: number; c: Inline[] }
  | { t: 'code'; lang: string; v: string }
  | { t: 'quote'; c: Block[] }
  | { t: 'list'; ordered: boolean; start: number; items: Block[][] }
  | { t: 'hr' }
  | { t: 'table'; align: Align[]; head: Inline[][]; rows: Inline[][][] };

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE = /^ {0,3}>\s?(.*)$/;
const BULLET = /^( {0,12})([-*+])\s+(.*)$/;
const ORDERED = /^( {0,12})(\d{1,9})[.)]\s+(.*)$/;
const TABLE_DIVIDER = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n');
  return parseBlocks(lines);
}

function parseBlocks(lines: readonly string[]): Block[] {
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] as string;

    if (line.trim() === '') {
      i++;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1] as string;
      const body: string[] = [];
      i++;
      while (i < lines.length && !(lines[i] as string).trim().startsWith(marker)) {
        body.push(lines[i] as string);
        i++;
      }
      i++; // the closing fence, or past the end of an unclosed one
      blocks.push({ t: 'code', lang: fence[2] ?? '', v: body.join('\n') });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({ t: 'h', level: (heading[1] as string).length, c: parseInline(heading[2] ?? '') });
      i++;
      continue;
    }

    if (RULE.test(line)) {
      blocks.push({ t: 'hr' });
      i++;
      continue;
    }

    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i] as string)) {
        body.push((QUOTE.exec(lines[i] as string) as RegExpExecArray)[1] ?? '');
        i++;
      }
      blocks.push({ t: 'quote', c: parseBlocks(body) });
      continue;
    }

    if (isTableStart(lines, i)) {
      const { block, next } = parseTable(lines, i);
      blocks.push(block);
      i = next;
      continue;
    }

    if (BULLET.test(line) || ORDERED.test(line)) {
      const { block, next } = parseList(lines, i);
      blocks.push(block);
      i = next;
      continue;
    }

    // A paragraph runs until a blank line or the start of another block.
    const body: string[] = [];
    while (i < lines.length) {
      const current = lines[i] as string;
      if (current.trim() === '') break;
      if (body.length > 0 && startsBlock(lines, i)) break;
      body.push(current.trim());
      i++;
    }
    blocks.push({ t: 'p', c: joinLines(body) });
  }

  return blocks;
}

function startsBlock(lines: readonly string[], i: number): boolean {
  const line = lines[i] as string;
  return (
    FENCE.test(line) ||
    HEADING.test(line) ||
    RULE.test(line) ||
    QUOTE.test(line) ||
    BULLET.test(line) ||
    ORDERED.test(line) ||
    isTableStart(lines, i)
  );
}

function joinLines(lines: readonly string[]): Inline[] {
  const out: Inline[] = [];
  lines.forEach((line, index) => {
    if (index > 0) out.push({ t: 'br' });
    out.push(...parseInline(line));
  });
  return out;
}

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------

interface ListMarker {
  indent: number;
  ordered: boolean;
  number: number;
  text: string;
}

function listMarker(line: string): ListMarker | null {
  const bullet = BULLET.exec(line);
  if (bullet) {
    return { indent: (bullet[1] as string).length, ordered: false, number: 0, text: bullet[3] ?? '' };
  }
  const ordered = ORDERED.exec(line);
  if (ordered) {
    return {
      indent: (ordered[1] as string).length,
      ordered: true,
      number: Number(ordered[2]),
      text: ordered[3] ?? '',
    };
  }
  return null;
}

/**
 * One list at the indent of its first marker. Lines indented deeper belong to
 * the current item (a nested list or a continuation); a marker at the same
 * indent starts the next item; anything shallower ends the list.
 */
function parseList(lines: readonly string[], start: number): { block: Block; next: number } {
  const first = listMarker(lines[start] as string) as ListMarker;
  const items: string[][] = [];
  let i = start;

  while (i < lines.length) {
    const line = lines[i] as string;
    const marker = listMarker(line);

    if (marker && marker.indent <= first.indent + 1) {
      if (marker.ordered !== first.ordered || marker.indent < first.indent) break;
      items.push([marker.text]);
      i++;
      continue;
    }

    if (line.trim() === '') {
      // A blank line inside a list continues it only if the next line is
      // indented under the item or is another item of this list.
      const after = lines[i + 1];
      const afterMarker = after === undefined ? null : listMarker(after);
      const continues =
        after !== undefined &&
        ((afterMarker && afterMarker.indent <= first.indent + 1 && afterMarker.ordered === first.ordered) ||
          indentOf(after) > first.indent + 1);
      if (!continues) break;
      items[items.length - 1]?.push('');
      i++;
      continue;
    }

    if (indentOf(line) > first.indent || items.length > 0) {
      // Deeper content belongs to the item; a lazy continuation line too.
      if (indentOf(line) <= first.indent && startsBlock(lines, i)) break;
      const contentIndent = first.indent + 2;
      items[items.length - 1]?.push(line.slice(Math.min(indentOf(line), contentIndent)));
      i++;
      continue;
    }
    break;
  }

  return {
    block: {
      t: 'list',
      ordered: first.ordered,
      start: first.number || 1,
      items: items.map((item) => parseItem(item)),
    },
    next: i,
  };
}

/** A tight item is one paragraph; anything structured inside is parsed as blocks. */
function parseItem(lines: string[]): Block[] {
  const blocks = parseBlocks(lines);
  return blocks.length > 0 ? blocks : [{ t: 'p', c: [] }];
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

function isTableStart(lines: readonly string[], i: number): boolean {
  const head = lines[i];
  const divider = lines[i + 1];
  if (head === undefined || divider === undefined) return false;
  if (!head.includes('|')) return false;
  if (!TABLE_DIVIDER.test(divider) || !divider.includes('-')) return false;
  return splitRow(head).length === splitRow(divider).length;
}

function parseTable(lines: readonly string[], start: number): { block: Block; next: number } {
  const head = splitRow(lines[start] as string);
  const align = splitRow(lines[start + 1] as string).map((cell): Align => {
    const left = cell.startsWith(':');
    const right = cell.endsWith(':');
    return left && right ? 'center' : right ? 'right' : left ? 'left' : null;
  });
  const rows: Inline[][][] = [];
  let i = start + 2;
  while (i < lines.length && (lines[i] as string).includes('|') && (lines[i] as string).trim() !== '') {
    const cells = splitRow(lines[i] as string);
    rows.push(head.map((_, index) => parseInline(cells[index] ?? '')));
    i++;
  }
  return { block: { t: 'table', align, head: head.map((cell) => parseInline(cell)), rows }, next: i };
}

function splitRow(line: string): string[] {
  let body = line.trim();
  if (body.startsWith('|')) body = body.slice(1);
  if (body.endsWith('|') && !body.endsWith('\\|')) body = body.slice(0, -1);
  const cells: string[] = [];
  let current = '';
  let inCode = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i] as string;
    if (ch === '\\' && body[i + 1] === '|') {
      current += '|';
      i++;
    } else if (ch === '`') {
      inCode = !inCode;
      current += ch;
    } else if (ch === '|' && !inCode) {
      cells.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  cells.push(current.trim());
  return cells;
}

// ---------------------------------------------------------------------------
// Inline
// ---------------------------------------------------------------------------

const SAFE_SCHEME = /^(https?:|mailto:)/i;

/** Only links a reader can follow safely: web and mail. Everything else is text. */
export function safeHref(href: string): string | null {
  const trimmed = href.trim();
  return SAFE_SCHEME.test(trimmed) ? trimmed : null;
}

export function parseInline(source: string): Inline[] {
  const out: Inline[] = [];
  let text = '';
  const flush = () => {
    if (text) out.push({ t: 'text', v: text });
    text = '';
  };

  let i = 0;
  while (i < source.length) {
    const ch = source[i] as string;
    const rest = source.slice(i);

    // Backslash escapes for punctuation.
    if (ch === '\\' && i + 1 < source.length && /[\\`*_{}[\]()#+\-.!|~<>]/.test(source[i + 1] as string)) {
      text += source[i + 1];
      i += 2;
      continue;
    }

    if (ch === '`') {
      const run = /^`+/.exec(rest)?.[0] ?? '`';
      const close = source.indexOf(run, i + run.length);
      if (close > i) {
        flush();
        out.push({ t: 'code', v: source.slice(i + run.length, close).replace(/^ (.*) $/, '$1') });
        i = close + run.length;
        continue;
      }
    }

    if (ch === '[') {
      const link = /^\[([^\]]+)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/.exec(rest);
      if (link) {
        flush();
        const href = safeHref(link[2] as string);
        const label = parseInline(link[1] as string);
        if (href) out.push({ t: 'link', href, c: label });
        else out.push(...label);
        i += link[0].length;
        continue;
      }
    }

    if (ch === '<') {
      const auto = /^<((?:https?:\/\/|mailto:)[^>\s]+)>/i.exec(rest);
      if (auto) {
        flush();
        out.push({ t: 'link', href: auto[1] as string, c: [{ t: 'text', v: auto[1] as string }] });
        i += auto[0].length;
        continue;
      }
    }

    if ((ch === 'h' || ch === 'H') && /^https?:\/\//i.test(rest) && !/[\w/]$/.test(text)) {
      const href = trimUrl(/^https?:\/\/[^\s<>"'`]+/i.exec(rest)?.[0] ?? '');
      if (href.length > 8) {
        flush();
        out.push({ t: 'link', href, c: [{ t: 'text', v: href }] });
        i += href.length;
        continue;
      }
    }

    if (ch === '~' && rest.startsWith('~~')) {
      const close = source.indexOf('~~', i + 2);
      if (close > i + 2) {
        flush();
        out.push({ t: 'del', c: parseInline(source.slice(i + 2, close)) });
        i = close + 2;
        continue;
      }
    }

    if (ch === '*' || ch === '_') {
      const span = emphasis(source, i);
      if (span) {
        flush();
        out.push(span.node);
        i = span.end;
        continue;
      }
    }

    text += ch;
    i++;
  }
  flush();
  return out;
}

/**
 * Trailing punctuation belongs to the sentence, not the URL; a closing
 * parenthesis stays only when the URL opened one (Wikipedia-style paths).
 */
function trimUrl(url: string): string {
  let end = url.length;
  while (end > 0) {
    const last = url[end - 1] as string;
    if ('.,;:!?*_]'.includes(last)) {
      end--;
      continue;
    }
    if (last === ')') {
      const head = url.slice(0, end);
      if ((head.match(/\(/g) ?? []).length < (head.match(/\)/g) ?? []).length) {
        end--;
        continue;
      }
    }
    break;
  }
  return url.slice(0, end);
}

/**
 * `**strong**`, `*em*`, `__strong__`, `_em_`. A delimiter opens only when
 * the next character is not a space; `_` additionally needs a non-word
 * character (or the start) before it and after its closer.
 */
function emphasis(source: string, i: number): { node: Inline; end: number } | null {
  const ch = source[i] as string;
  const double = source[i + 1] === ch;
  const delimiter = double ? ch + ch : ch;
  const before = i === 0 ? ' ' : (source[i - 1] as string);
  const firstInside = source[i + delimiter.length];

  if (firstInside === undefined || /\s/.test(firstInside)) return null;
  if (ch === '_' && /\w/.test(before)) return null;

  let search = i + delimiter.length;
  while (search < source.length) {
    const close = source.indexOf(delimiter, search);
    if (close < 0) return null;
    const lastInside = source[close - 1] as string;
    const after = source[close + delimiter.length];
    const tripled = !double && source[close + 1] === ch;
    const closesWord = ch !== '_' || after === undefined || !/\w/.test(after);
    if (close > i + delimiter.length && !/\s/.test(lastInside) && closesWord && !tripled) {
      const inner = parseInline(source.slice(i + delimiter.length, close));
      return { node: double ? { t: 'strong', c: inner } : { t: 'em', c: inner }, end: close + delimiter.length };
    }
    search = close + 1;
  }
  return null;
}

/** Plain text of a tree, for accessible names and comparisons. */
export function inlineText(nodes: readonly Inline[]): string {
  return nodes
    .map((node) => {
      switch (node.t) {
        case 'text':
        case 'code':
          return node.v;
        case 'br':
          return '\n';
        default:
          return inlineText(node.c);
      }
    })
    .join('');
}
