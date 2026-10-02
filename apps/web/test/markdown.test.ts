import { describe, expect, it } from 'vitest';

import { inlineText, parseInline, parseMarkdown, safeHref } from '../lib/markdown';

describe('parseMarkdown blocks', () => {
  it('reads the shapes agents write: headings, lists, rules and paragraphs', () => {
    const blocks = parseMarkdown(
      ['## Findings', '', '**Reservation R1042**', '- Cabin: economy', '- Bags: 1', '', '---', 'Done.'].join('\n'),
    );
    expect(blocks.map((block) => block.t)).toEqual(['h', 'p', 'list', 'hr', 'p']);
    const list = blocks[2];
    expect(list?.t === 'list' && list.items.length).toBe(2);
  });

  it('keeps single newlines as line breaks, because agents lay out key: value lines', () => {
    const [block] = parseMarkdown('status: confirmed\ncabin: economy');
    expect(block).toEqual({
      t: 'p',
      c: [{ t: 'text', v: 'status: confirmed' }, { t: 'br' }, { t: 'text', v: 'cabin: economy' }],
    });
  });

  it('numbers ordered lists from their first marker and nests deeper items', () => {
    const [block] = parseMarkdown(['3. Verify', '   - read the ledger', '4. Charge'].join('\n'));
    expect(block?.t).toBe('list');
    if (block?.t !== 'list') return;
    expect(block.ordered).toBe(true);
    expect(block.start).toBe(3);
    expect(block.items).toHaveLength(2);
    expect(block.items[0]?.map((child) => child.t)).toEqual(['p', 'list']);
  });

  it('treats fenced code literally, including Markdown inside it', () => {
    const [block] = parseMarkdown(['```json', '{"a": "**not bold**"}', '```'].join('\n'));
    expect(block).toEqual({ t: 'code', lang: 'json', v: '{"a": "**not bold**"}' });
  });

  it('survives an unclosed fence by running it to the end', () => {
    const [block] = parseMarkdown('```\nunterminated');
    expect(block).toEqual({ t: 'code', lang: '', v: 'unterminated' });
  });

  it('parses GFM tables with alignment and pads short rows', () => {
    const [block] = parseMarkdown(['| Line | Refund |', '|:--|--:|', '| L1 | $219 |', '| L2 |'].join('\n'));
    expect(block?.t).toBe('table');
    if (block?.t !== 'table') return;
    expect(block.align).toEqual(['left', 'right']);
    expect(block.rows).toHaveLength(2);
    expect(block.rows[1]?.[1]).toEqual([]);
  });

  it('does not mistake a pipe in prose for a table', () => {
    expect(parseMarkdown('a | b\nnot a divider').map((block) => block.t)).toEqual(['p']);
  });

  it('reads quotes as nested blocks', () => {
    const [block] = parseMarkdown('> **Approved**\n> no defects');
    expect(block?.t).toBe('quote');
  });
});

describe('parseInline', () => {
  it('reads emphasis, code and strikethrough', () => {
    expect(parseInline('**bold** and *em* and `code` and ~~gone~~')).toEqual([
      { t: 'strong', c: [{ t: 'text', v: 'bold' }] },
      { t: 'text', v: ' and ' },
      { t: 'em', c: [{ t: 'text', v: 'em' }] },
      { t: 'text', v: ' and ' },
      { t: 'code', v: 'code' },
      { t: 'text', v: ' and ' },
      { t: 'del', c: [{ t: 'text', v: 'gone' }] },
    ]);
  });

  it('leaves snake_case identifiers and lone asterisks alone', () => {
    expect(inlineText(parseInline('call get_reservation_details then add_baggage'))).toBe(
      'call get_reservation_details then add_baggage',
    );
    expect(parseInline('2 * 3 = 6')).toEqual([{ t: 'text', v: '2 * 3 = 6' }]);
  });

  it('keeps Markdown inside code spans literal', () => {
    expect(parseInline('`**x**`')).toEqual([{ t: 'code', v: '**x**' }]);
  });

  it('links web URLs and drops sentence punctuation from bare ones', () => {
    expect(parseInline('See https://developer.mozilla.org/en-US/docs/Web.')).toEqual([
      { t: 'text', v: 'See ' },
      {
        t: 'link',
        href: 'https://developer.mozilla.org/en-US/docs/Web',
        c: [{ t: 'text', v: 'https://developer.mozilla.org/en-US/docs/Web' }],
      },
      { t: 'text', v: '.' },
    ]);
    const [wiki] = parseInline('https://en.wikipedia.org/wiki/Bcrypt_(algorithm)');
    expect(wiki).toMatchObject({ t: 'link', href: 'https://en.wikipedia.org/wiki/Bcrypt_(algorithm)' });
  });

  it('never links an unsafe scheme, and keeps the label as text', () => {
    expect(parseInline('[click](javascript:alert(1))')).toEqual([
      { t: 'text', v: 'click' },
      { t: 'text', v: ')' },
    ]);
    expect(safeHref('javascript:alert(1)')).toBeNull();
    expect(safeHref(' https://example.com ')).toBe('https://example.com');
    expect(parseInline('[docs](https://example.com/a)')).toEqual([
      { t: 'link', href: 'https://example.com/a', c: [{ t: 'text', v: 'docs' }] },
    ]);
  });

  it('honours backslash escapes', () => {
    expect(inlineText(parseInline('\\*not em\\*'))).toBe('*not em*');
  });
});
