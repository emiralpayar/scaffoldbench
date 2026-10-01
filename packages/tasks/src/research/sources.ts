import type { Extractor } from './extract';

/**
 * The curated source list the research corpus is built from.
 *
 * `scripts/build-corpus.ts` fetches every entry once, extracts its text and
 * freezes it under `fixtures/corpus/`. Which task may see which document is
 * decided by the tasks themselves (`corpus` in each task spec), so one copy of
 * RFC 9110 serves every HTTP task.
 *
 * Sources are chosen for redistributability as much as for content: IETF
 * RFCs, U.S. government publications and openly licensed specifications and
 * documentation. Every entry names its licence; `fixtures/NOTICE.md` is
 * generated from this list.
 */

export type LicenseId = 'ietf-trust' | 'us-government-work' | 'cc-by-4.0' | 'cc-by-sa-2.5' | 'cc-by-sa-4.0';

export interface LicenseInfo {
  name: string;
  url: string;
  /** What the licence allows and asks for, in one or two sentences. */
  terms: string;
}

export const LICENSES: Record<LicenseId, LicenseInfo> = {
  'ietf-trust': {
    name: 'IETF Trust Legal Provisions (BCP 78)',
    url: 'https://trustee.ietf.org/license-info',
    terms:
      'RFCs may be copied and distributed in full without modification. The text is reproduced as ' +
      'published, with its own copyright notice; only the print pagination of older RFCs (page ' +
      'footers, form feeds and running headers) is removed.',
  },
  'us-government-work': {
    name: 'Work of the U.S. Government (public domain in the United States, 17 U.S.C. § 105)',
    url: 'https://www.nist.gov/oism/copyrights',
    terms:
      'NIST publications are not subject to copyright protection in the United States. Attribution ' +
      'to NIST is given as a courtesy.',
  },
  'cc-by-4.0': {
    name: 'Creative Commons Attribution 4.0 International',
    url: 'https://creativecommons.org/licenses/by/4.0/',
    terms: 'Redistribution is permitted with attribution and an indication of changes.',
  },
  'cc-by-sa-2.5': {
    name: 'Creative Commons Attribution-ShareAlike 2.5 Generic',
    url: 'https://creativecommons.org/licenses/by-sa/2.5/',
    terms:
      'Redistribution is permitted with attribution and an indication of changes; the extracted text ' +
      'is distributed under the same licence, not under this repository’s MIT licence.',
  },
  'cc-by-sa-4.0': {
    name: 'Creative Commons Attribution-ShareAlike 4.0 International',
    url: 'https://creativecommons.org/licenses/by-sa/4.0/',
    terms:
      'Redistribution is permitted with attribution and an indication of changes; the extracted text ' +
      'is distributed under the same licence, not under this repository’s MIT licence.',
  },
};

export interface CorpusSource {
  /** Stable id: the document's file name and the name tasks refer to it by. */
  id: string;
  /** Canonical URL, shown in search results and expected in citations. */
  url: string;
  /** Where to fetch the text, when that is a different rendering of the same document. */
  fetchUrl?: string;
  /** Other URLs that serve the same document: renderings, mirrors, addresses it moved from. */
  aliases?: string[];
  title: string;
  publisher: string;
  license: LicenseId;
  /** Credit line for NOTICE.md. */
  attribution: string;
  extract: Extractor;
}

// ---------------------------------------------------------------------------
// source families
// ---------------------------------------------------------------------------

const RFC_EXTRACTOR: Extractor = { kind: 'rfc-text' };

/**
 * An RFC, fetched as plain text from the RFC Editor.
 *
 * The plain-text rendering is the archival one and needs no HTML clean-up.
 * Every common address of the same RFC is an alias, because an agent that
 * types `datatracker.ietf.org/doc/html/rfc9110` is asking for this document,
 * not for a different one.
 */
function rfc(number: number, title: string, options: { httpwg?: boolean } = {}): CorpusSource {
  const name = `rfc${number}`;
  return {
    id: name,
    url: `https://www.rfc-editor.org/rfc/${name}.html`,
    fetchUrl: `https://www.rfc-editor.org/rfc/${name}.txt`,
    aliases: [
      `https://www.rfc-editor.org/rfc/${name}`,
      `https://www.rfc-editor.org/rfc/${name}.txt`,
      `https://datatracker.ietf.org/doc/html/${name}`,
      `https://datatracker.ietf.org/doc/${name}`,
      `https://tools.ietf.org/html/${name}`,
      `https://www.ietf.org/rfc/${name}.txt`,
      ...(options.httpwg ? [`https://httpwg.org/specs/${name}.html`] : []),
    ],
    title: `RFC ${number}: ${title}`,
    publisher: 'IETF / RFC Editor',
    license: 'ietf-trust',
    attribution: `RFC ${number}, “${title}”. Copyright (c) IETF Trust and the persons identified as the document authors.`,
    extract: RFC_EXTRACTOR,
  };
}

const MDN_EXTRACTOR: Extractor = {
  kind: 'html',
  root: { tag: 'main', attr: 'id', value: 'content' },
  drop: [
    { tag: 'div', attr: 'class', value: 'article-footer' },
    { tag: 'mdn-survey' },
  ],
};

/**
 * An MDN Web Docs page. `formerPaths` are the pre-2025 addresses MDN still
 * redirects from (`Web/HTTP/Status/308` became `Web/HTTP/Reference/Status/308`).
 */
function mdn(id: string, docPath: string, title: string, formerPaths: string[] = []): CorpusSource {
  const base = 'https://developer.mozilla.org';
  const paths = [docPath, ...formerPaths];
  return {
    id,
    url: `${base}/en-US/docs/${docPath}`,
    aliases: [
      ...formerPaths.map((former) => `${base}/en-US/docs/${former}`),
      // MDN redirects locale-less addresses to the English page.
      ...paths.map((path) => `${base}/docs/${path}`),
    ],
    title: `${title} - MDN Web Docs`,
    publisher: 'MDN Web Docs (Mozilla)',
    license: 'cc-by-sa-2.5',
    attribution: `“${title}” by Mozilla Contributors, MDN Web Docs, licensed under CC BY-SA 2.5.`,
    extract: MDN_EXTRACTOR,
  };
}

const OWASP_EXTRACTOR: Extractor = {
  kind: 'html',
  root: { tag: 'article', attr: 'class', value: 'md-content__inner' },
  drop: [{ tag: 'a', attr: 'class', value: 'headerlink' }],
};

function owasp(id: string, slug: string, title: string): CorpusSource {
  return {
    id,
    url: `https://cheatsheetseries.owasp.org/cheatsheets/${slug}.html`,
    title: `${title} - OWASP Cheat Sheet Series`,
    publisher: 'OWASP Foundation',
    license: 'cc-by-sa-4.0',
    attribution: `“${title}”, OWASP Cheat Sheet Series, by the OWASP Foundation and contributors, licensed under CC BY-SA 4.0.`,
    extract: OWASP_EXTRACTOR,
  };
}

const NIST_DROP = [
  // LaTeX page-break directives kept in the HTML for the PDF build.
  { tag: 'div', attr: 'latex-literal' },
  { tag: 'div', attr: 'class', value: 'page-switch' },
];

const WEB_DEV_EXTRACTOR: Extractor = {
  kind: 'html',
  root: { tag: 'article', attr: 'class', value: 'devsite-article' },
  drop: [
    { tag: 'div', attr: 'class', value: 'devsite-article-meta' },
    { tag: 'devsite-feature-tooltip' },
    { tag: 'devsite-thumb-rating' },
    { tag: 'devsite-toc' },
    { tag: 'devsite-actions' },
  ],
};

// ---------------------------------------------------------------------------
// the list
// ---------------------------------------------------------------------------

export const CORPUS_SOURCES: CorpusSource[] = [
  // HTTP specifications, current
  rfc(9110, 'HTTP Semantics', { httpwg: true }),
  rfc(9111, 'HTTP Caching', { httpwg: true }),
  rfc(6797, 'HTTP Strict Transport Security (HSTS)'),
  rfc(8288, 'Web Linking'),
  // HTTP specifications, obsoleted by RFC 9110/9111 — kept as the version trap
  rfc(7231, 'Hypertext Transfer Protocol (HTTP/1.1): Semantics and Content', { httpwg: true }),
  rfc(7232, 'Hypertext Transfer Protocol (HTTP/1.1): Conditional Requests', { httpwg: true }),
  rfc(7234, 'Hypertext Transfer Protocol (HTTP/1.1): Caching', { httpwg: true }),
  rfc(7538, 'The Hypertext Transfer Protocol Status Code 308 (Permanent Redirect)'),

  // HTTP, secondary
  mdn('mdn-status-301', 'Web/HTTP/Reference/Status/301', '301 Moved Permanently', ['Web/HTTP/Status/301']),
  mdn('mdn-status-307', 'Web/HTTP/Reference/Status/307', '307 Temporary Redirect', ['Web/HTTP/Status/307']),
  mdn('mdn-status-308', 'Web/HTTP/Reference/Status/308', '308 Permanent Redirect', ['Web/HTTP/Status/308']),
  mdn('mdn-status-codes', 'Web/HTTP/Reference/Status', 'HTTP response status codes', ['Web/HTTP/Status']),
  mdn('mdn-redirections', 'Web/HTTP/Guides/Redirections', 'Redirections in HTTP', ['Web/HTTP/Redirections']),
  mdn(
    'mdn-header-cache-control',
    'Web/HTTP/Reference/Headers/Cache-Control',
    'Cache-Control header',
    ['Web/HTTP/Headers/Cache-Control'],
  ),
  mdn(
    'mdn-header-strict-transport-security',
    'Web/HTTP/Reference/Headers/Strict-Transport-Security',
    'Strict-Transport-Security header',
    ['Web/HTTP/Headers/Strict-Transport-Security'],
  ),

  // HTML script loading
  {
    id: 'whatwg-html-scripting',
    url: 'https://html.spec.whatwg.org/multipage/scripting.html',
    aliases: ['https://html.spec.whatwg.org/dev/scripting.html'],
    title: 'HTML Standard, 4.12 Scripting',
    publisher: 'WHATWG',
    license: 'cc-by-4.0',
    attribution:
      'HTML Living Standard, “4.12 Scripting”. Copyright © WHATWG (Apple, Google, Mozilla, Microsoft), licensed under CC BY 4.0.',
    extract: {
      kind: 'html',
      // Browser-support boxes copied from MDN: compatibility data, not spec text.
      drop: [{ tag: 'div', attr: 'class', value: 'mdn-anno' }],
    },
  },
  mdn('mdn-script-element', 'Web/HTML/Reference/Elements/script', '<script>: The Script element', [
    'Web/HTML/Element/script',
  ]),
  mdn('mdn-js-modules', 'Web/JavaScript/Guide/Modules', 'JavaScript modules'),
  mdn(
    'mdn-domcontentloaded',
    'Web/API/Document/DOMContentLoaded_event',
    'Document: DOMContentLoaded event',
  ),
  {
    id: 'webdev-third-party-javascript',
    url: 'https://web.dev/articles/efficiently-load-third-party-javascript',
    aliases: ['https://web.dev/efficiently-load-third-party-javascript'],
    title: 'Efficiently load third-party JavaScript - web.dev',
    publisher: 'web.dev (Google)',
    license: 'cc-by-4.0',
    attribution:
      '“Efficiently load third-party JavaScript” by Milica Mihajlija, web.dev, licensed under CC BY 4.0 (code samples Apache 2.0).',
    extract: WEB_DEV_EXTRACTOR,
  },
  {
    id: 'webdev-optimize-resource-loading',
    url: 'https://web.dev/learn/performance/optimize-resource-loading',
    title: 'Optimize resource loading - web.dev',
    publisher: 'web.dev (Google)',
    license: 'cc-by-4.0',
    attribution:
      '“Optimize resource loading”, Learn Performance, web.dev, licensed under CC BY 4.0 (code samples Apache 2.0).',
    extract: WEB_DEV_EXTRACTOR,
  },

  // Password storage and authentication
  owasp('owasp-password-storage', 'Password_Storage_Cheat_Sheet', 'Password Storage Cheat Sheet'),
  owasp('owasp-authentication', 'Authentication_Cheat_Sheet', 'Authentication Cheat Sheet'),
  {
    id: 'nist-sp800-63b-4',
    url: 'https://pages.nist.gov/800-63-4/sp800-63b.html',
    title: 'NIST SP 800-63B-4, Digital Identity Guidelines: Authentication and Authenticator Management',
    publisher: 'National Institute of Standards and Technology',
    license: 'us-government-work',
    attribution:
      'NIST Special Publication 800-63B-4, Digital Identity Guidelines: Authentication and Authenticator Management (August 2025). National Institute of Standards and Technology.',
    extract: {
      kind: 'html',
      root: { tag: 'div', attr: 'class', value: 'container' },
      drop: NIST_DROP,
      numberHeadings: true,
    },
  },
  {
    id: 'nist-sp800-63b-3',
    url: 'https://pages.nist.gov/800-63-3/sp800-63b.html',
    title: 'NIST SP 800-63B (Revision 3), Digital Identity Guidelines: Authentication and Lifecycle Management',
    publisher: 'National Institute of Standards and Technology',
    license: 'us-government-work',
    attribution:
      'NIST Special Publication 800-63B, Digital Identity Guidelines: Authentication and Lifecycle Management (June 2017, updated March 2020; superseded). National Institute of Standards and Technology.',
    extract: {
      kind: 'html',
      root: { tag: 'div', attr: 'class', value: 'container' },
      drop: NIST_DROP,
      // The page stamps itself with the time it was served.
      dropLines: [/^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} [+-]\d{4}$/],
    },
  },
  rfc(9106, 'Argon2 Memory-Hard Function for Password Hashing and Proof-of-Work Applications'),
];
