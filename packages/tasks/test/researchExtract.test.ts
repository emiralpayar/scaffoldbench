import { describe, expect, it } from 'vitest';
import {
  decodeEntities,
  dropElements,
  extractDocument,
  findElement,
  htmlToText,
  rfcPlainText,
} from '../src/research/extract';
import { normalizeForMatch } from '../src/research/text';

describe('findElement', () => {
  it('matches a class token and finds the matching close tag across nesting', () => {
    const html = '<div class="a main b"><div>inner</div><p>tail</p></div><div>after</div>';
    const span = findElement(html, { tag: 'div', attr: 'class', value: 'main' });
    expect(span && html.slice(span.innerStart, span.innerEnd)).toBe('<div>inner</div><p>tail</p>');
  });

  it('matches ids exactly and bare boolean attributes', () => {
    const html = '<main id="content-x">no</main><main id="content">yes</main><div latex-literal>x</div>';
    const byId = findElement(html, { tag: 'main', attr: 'id', value: 'content' });
    expect(byId && html.slice(byId.innerStart, byId.innerEnd)).toBe('yes');
    expect(findElement(html, { tag: 'div', attr: 'latex-literal' })).toBeDefined();
  });

  it('never mistakes a tag inside a quoted attribute for a real one', () => {
    // The WHATWG spec annotates links with titles like this one.
    const html = '<a title="The <script> element">link</a><p>kept</p><script>var x = "<p>";</script><p>also</p>';
    const span = findElement(html, { tag: 'script' });
    expect(span && html.slice(span.start, span.end)).toBe('<script>var x = "<p>";</script>');
  });

  it('treats an explicitly self-closed element as empty', () => {
    const html = '<div class="x"><div class="breaker" /><p>body</p></div>';
    const span = findElement(html, { tag: 'div', attr: 'class', value: 'x' });
    expect(span && html.slice(span.innerStart, span.innerEnd)).toBe('<div class="breaker" /><p>body</p>');
  });
});

describe('dropElements', () => {
  it('removes every match with everything nested inside it', () => {
    const html = '<p>a</p><nav><nav>deep</nav>menu</nav><p>b</p><nav>more</nav>';
    expect(htmlToText(dropElements(html, { tag: 'nav' }))).toBe('a\n\nb');
  });
});

describe('htmlToText', () => {
  it('removes inline tags without inserting spaces', () => {
    expect(htmlToText('<p>Passwords <strong>SHALL</strong> be <em>salted</em>, x<sup>2</sup>.</p>')).toBe(
      'Passwords SHALL be salted, x2.',
    );
  });

  it('keeps paragraphs, list items and headings on their own lines', () => {
    const text = htmlToText('<h2>Title</h2><p>One</p><ul><li>first<li>second</ul><p>Two</p>');
    expect(text).toBe('Title\n\nOne\n\n- first\n- second\n\nTwo');
  });

  it('separates table cells even when the page omits </td>', () => {
    const html = '<table><tr><th><th>async<th>defer<tr><th>Inline classic scripts<td>·<td>·</table>';
    expect(htmlToText(html)).toBe('| async | defer\nInline classic scripts | · | ·');
  });

  it('preserves the whitespace of preformatted blocks', () => {
    const text = htmlToText('<p>Example:</p><pre>GET / HTTP/1.1\n  Host: a</pre><p>after</p>');
    expect(text).toBe('Example:\n\nGET / HTTP/1.1\n  Host: a\n\nafter');
  });

  it('skips raw-text content and decodes entities', () => {
    expect(htmlToText('<p>a&nbsp;&amp;&#8217;b&#xA0;c</p><style>p { x: "<p>" }</style>')).toBe('a &’b c');
  });

  it('numbers headings from data-section chapters, leaving front matter unnumbered', () => {
    const html = [
      '<h1 id="abstract">Abstract</h1>',
      '<h1 data-section="3">Requirements</h1>',
      '<h2>By Type</h2><h3>Passwords</h3><h4>Authenticators</h4><h4>Verifiers</h4>',
      '<h3>Look-Up Secrets</h3>',
      '<h1 data-section="A">Strength</h1><h2>Introduction</h2>',
    ].join('');
    const headings = htmlToText(html, { numberHeadings: true }).split('\n\n');
    expect(headings).toEqual([
      'Abstract',
      '3 Requirements',
      '3.1 By Type',
      '3.1.1 Passwords',
      '3.1.1.1 Authenticators',
      '3.1.1.2 Verifiers',
      '3.1.2 Look-Up Secrets',
      'A Strength',
      'A.1 Introduction',
    ]);
  });
});

describe('decodeEntities', () => {
  it('decodes named and numeric references and leaves unknown ones alone', () => {
    expect(decodeEntities('&sect;15 &#x2014; &bogus; &#0;')).toBe('§15 — &bogus; &#0;');
  });
});

describe('extractDocument', () => {
  it('keeps the root article and drops page furniture inside it', () => {
    const html = [
      '<html><head><title>Doc &amp; Title</title></head><body>',
      '<header>site header</header><nav>menu</nav>',
      '<article class="content"><h1>Heading</h1><aside>related</aside><p>Body text.</p>',
      '<div class="feedback">Was this helpful?</div><footer>page footer</footer></article>',
      '<footer>site footer</footer></body></html>',
    ].join('');
    const out = extractDocument(html, {
      kind: 'html',
      root: { tag: 'article', attr: 'class', value: 'content' },
      drop: [{ tag: 'div', attr: 'class', value: 'feedback' }],
    });
    expect(out.title).toBe('Doc & Title');
    expect(out.text).toBe('Heading\n\nBody text.');
  });

  it('treats <?…> and <!…> like the comments a browser takes them for', () => {
    const out = extractDocument('<!DOCTYPE html><body><?> <p>One<!-- note --></p><?xml x?><p>Two</p></body>', {
      kind: 'html',
    });
    expect(out.text).toBe('One\n\nTwo');
  });

  it('drops whole lines that match dropLines', () => {
    const out = extractDocument('<body><p>Thu, 01 Oct 2026 12:03:36 +0000</p><p>Kept.</p></body>', {
      kind: 'html',
      dropLines: [/^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} [+-]\d{4}$/],
    });
    expect(out.text).toBe('Kept.');
  });

  it('fails loudly when the root element is missing', () => {
    expect(() => extractDocument('<body>x</body>', { kind: 'html', root: { tag: 'main' } })).toThrow(/no <main>/);
  });
});

describe('rfcPlainText', () => {
  const paginated = [
    '﻿3.  Status Codes',
    '',
    '   The 308 status code is similar to 301, except that it does not allow',
    'Reschke                      Standards Track                    [Page 3]',
    '\f',
    'RFC 7538            HTTP Status Code 308 (Permanent Redirect)        April 2015',
    '',
    '   changing the request method from POST to GET.',
  ].join('\n');

  it('removes footers, form feeds and running headers but keeps every content line', () => {
    const text = rfcPlainText(paginated);
    expect(text).not.toMatch(/\[Page 3\]|\f|April 2015|﻿/);
    expect(text).toContain('3.  Status Codes');
    expect(text).toContain('   changing the request method from POST to GET.');
  });

  it('makes a sentence that crossed a page boundary quotable', () => {
    const normalized = normalizeForMatch(rfcPlainText(paginated));
    expect(normalized).toContain(
      normalizeForMatch('it does not allow changing the request method from POST to GET'),
    );
  });
});
