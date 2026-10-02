import type { Task } from '@arena/core';
import { defineBreadthTask, type BreadthItem, type BreadthTaskSpec } from './defineBreadthTask';

/**
 * Three breadth research tasks, graded against gold keys with no judge.
 *
 * Each asks for the same few properties of eight to twelve independent items
 * and wants, for every item, a quote from the part of the authoritative source
 * that defines it. They are the cheap, exact test of the hypothesis that
 * multi-agent decomposition pays on breadth research. Every gold value was
 * read off the corpus snapshot, and the sufficiency test re-checks that each
 * gold quote is still where the key says it is.
 */

// ---------------------------------------------------------------------------
// status codes: one long specification, twelve independent lookups
// ---------------------------------------------------------------------------

/** One RFC 9110 status code: gold reason phrase, section and cacheability. */
function statusCode(
  code: number,
  reason: string,
  section: string,
  heuristicallyCacheable: boolean,
  nextHeading: string,
  goldQuote: string,
): BreadthItem {
  return {
    key: String(code),
    expected: { reason, section, heuristicallyCacheable },
    source: { doc: 'rfc9110', from: `${section}. ${code} ${reason}`, to: nextHeading },
    goldQuote,
  };
}

export const statusCodesSpec: BreadthTaskSpec = {
  id: 'research-status-codes',
  title: 'Twelve HTTP status codes, by the book',
  question:
    'For each HTTP status code below, report what the current HTTP Semantics specification says ' +
    'about it: its reason phrase, the section of that specification that defines it, and whether a ' +
    'response with that status code is heuristically cacheable (reusable by a cache without explicit ' +
    'freshness information).',
  difficulty: 'medium',
  tags: ['http', 'specifications', 'breadth', 'gold-key'],
  maxTurns: 40,
  corpus: {
    primary: ['rfc9110'],
    secondary: ['mdn-status-codes', 'mdn-status-307', 'mdn-status-308'],
    superseded: ['rfc7231'],
    distractor: ['rfc9111'],
  },
  key: { name: 'code', label: 'status code' },
  quoteFrom:
    'the numbered section of the specification that defines that status code (its own section, not an ' +
    'overview list or the table of contents)',
  fields: [
    { name: 'reason', kind: 'text', description: 'the reason phrase exactly as the current specification gives it' },
    {
      name: 'section',
      kind: 'section',
      description: 'the number of the section of the current specification that defines the code (just the number, e.g. "12.3.4")',
    },
    {
      name: 'heuristicallyCacheable',
      kind: 'boolean',
      description: 'true if the specification defines responses with this code as heuristically cacheable, otherwise false',
    },
  ],
  items: [
    statusCode(203, 'Non-Authoritative Information', '15.3.4', true, '15.3.5. 204 No Content',
      'The 203 (Non-Authoritative Information) status code indicates that the request was successful but the enclosed content has been modified from that of the origin server\'s 200 (OK) response by a transforming proxy'),
    statusCode(206, 'Partial Content', '15.3.7', true, '15.4. Redirection 3xx',
      'A 206 response is heuristically cacheable; i.e., unless otherwise indicated by explicit cache controls'),
    statusCode(303, 'See Other', '15.4.4', false, '15.4.5. 304 Not Modified',
      'The 303 (See Other) status code indicates that the server is redirecting the user agent to a different resource'),
    statusCode(307, 'Temporary Redirect', '15.4.8', false, '15.4.9. 308 Permanent Redirect',
      'the user agent MUST NOT change the request method if it performs an automatic redirection to that URI'),
    statusCode(308, 'Permanent Redirect', '15.4.9', true, '15.5. Client Error 4xx',
      'A 308 response is heuristically cacheable; i.e., unless otherwise indicated by the method definition or explicit cache controls'),
    statusCode(405, 'Method Not Allowed', '15.5.6', true, '15.5.7. 406 Not Acceptable',
      'The 405 (Method Not Allowed) status code indicates that the method received in the request-line is known by the origin server but not supported by the target resource.'),
    statusCode(410, 'Gone', '15.5.11', true, '15.5.12. 411 Length Required',
      'The 410 (Gone) status code indicates that access to the target resource is no longer available at the origin server'),
    statusCode(413, 'Content Too Large', '15.5.14', false, '15.5.15. 414 URI Too Long',
      'The 413 (Content Too Large) status code indicates that the server is refusing to process a request because the request content is larger than the server is willing or able to process.'),
    statusCode(414, 'URI Too Long', '15.5.15', true, '15.5.16. 415 Unsupported Media Type',
      'A 414 response is heuristically cacheable; i.e., unless otherwise indicated by the method definition or explicit cache controls'),
    statusCode(421, 'Misdirected Request', '15.5.20', false, '15.5.21. 422 Unprocessable Content',
      'The 421 (Misdirected Request) status code indicates that the request was directed at a server that is unable or unwilling to produce an authoritative response for the target URI.'),
    statusCode(422, 'Unprocessable Content', '15.5.21', false, '15.5.22. 426 Upgrade Required',
      'The 422 (Unprocessable Content) status code indicates that the server understands the content type of the request content'),
    statusCode(501, 'Not Implemented', '15.6.2', true, '15.6.3. 502 Bad Gateway',
      'The 501 (Not Implemented) status code indicates that the server does not support the functionality required to fulfill the request.'),
  ],
  hypothesis:
    'A tie on score: in a one-run calibration, single scored 1.0 with both Haiku 4.5 and Sonnet 5.5. ' +
    'Twelve independent lookups are what orchestrator-workers can split, so fan-out should show up as ' +
    'lower wall-clock time at a higher token cost. Grading is exact, so any score gap is not judge noise.',
  traps: [
    {
      id: 'renamed-reason-phrases',
      description:
        'RFC 9110 renamed 413 ("Payload Too Large" in RFC 7231) to "Content Too Large" and 422 ' +
        '("Unprocessable Entity" in WebDAV) to "Unprocessable Content". Memory and the obsolete RFC give the old names.',
      caughtBy: ['gold:reason'],
    },
    {
      id: 'obsolete-sections',
      description: 'RFC 7231 is in the corpus and numbers its status codes 6.x; the current sections are 15.x.',
      caughtBy: ['gold:section'],
    },
    {
      id: 'secondary-quote',
      description: 'Quoting MDN, or the overview list, instead of the section that defines the code.',
      caughtBy: ['quote grounding'],
    },
  ],
};

// ---------------------------------------------------------------------------
// header fields: four current RFCs, three obsolete ones with the same numbers
// ---------------------------------------------------------------------------

function headerField(
  name: string,
  rfc: number,
  section: string,
  heading: string,
  nextHeading: string,
  goldQuote: string,
): BreadthItem {
  return {
    key: name,
    expected: { rfc, section },
    source: { doc: `rfc${rfc}`, from: heading, to: nextHeading },
    goldQuote,
  };
}

export const headerFieldsSpec: BreadthTaskSpec = {
  id: 'research-header-fields',
  title: 'Where ten HTTP header fields are defined',
  question:
    'For each HTTP header field below, find the RFC that currently defines it and the section of ' +
    'that RFC that contains its definition. An RFC that has since been obsoleted does not count.',
  difficulty: 'hard',
  tags: ['http', 'specifications', 'breadth', 'versions', 'gold-key'],
  maxTurns: 40,
  corpus: {
    primary: ['rfc9110', 'rfc9111', 'rfc6797', 'rfc8288'],
    secondary: ['mdn-header-cache-control', 'mdn-header-strict-transport-security'],
    superseded: ['rfc7231', 'rfc7232', 'rfc7234'],
  },
  key: { name: 'field', label: 'header field' },
  quoteFrom: 'the section of that RFC that defines the field',
  fields: [
    { name: 'rfc', kind: 'integer', description: 'the number of the RFC that currently defines the field' },
    {
      name: 'section',
      kind: 'section',
      description: 'the number of the section of that RFC that defines the field (just the number, e.g. "12.3.4")',
    },
  ],
  items: [
    headerField('Age', 9111, '5.1', '5.1. Age', '5.2. Cache-Control',
      'The "Age" response header field conveys the sender\'s estimate of the time since the response was generated or successfully validated at the origin server.'),
    headerField('Cache-Control', 9111, '5.2', '5.2. Cache-Control', '5.3. Expires',
      'The "Cache-Control" header field is used to list directives for caches along the request/response chain.'),
    headerField('Expires', 9111, '5.3', '5.3. Expires', '5.4. Pragma',
      'The "Expires" response header field gives the date/time after which the response is considered stale.'),
    headerField('Last-Modified', 9110, '8.8.2', '8.8.2. Last-Modified', '8.8.3. ETag',
      'The "Last-Modified" header field in a response provides a timestamp indicating the date and time at which the origin server believes the selected representation was last modified'),
    headerField('ETag', 9110, '8.8.3', '8.8.3. ETag', '9. Methods',
      'The "ETag" field in a response provides the current entity tag for the selected representation'),
    headerField('Location', 9110, '10.2.2', '10.2.2. Location', '10.2.3. Retry-After',
      'The "Location" header field is used in some responses to refer to a specific resource in relation to the response.'),
    headerField('Retry-After', 9110, '10.2.3', '10.2.3. Retry-After', '10.2.4. Server',
      'Servers send the "Retry-After" header field to indicate how long the user agent ought to wait before making a follow-up request.'),
    headerField('Vary', 9110, '12.5.5', '12.5.5. Vary', '13. Conditional Requests',
      'The "Vary" header field in a response describes what parts of a request message, aside from the method and target URI, might have influenced the origin server\'s process for selecting the content of this response.'),
    headerField('Strict-Transport-Security', 6797, '6.1', '6.1. Strict-Transport-Security HTTP Response Header Field', '6.2. Examples',
      'The Strict-Transport-Security HTTP response header field (STS header field) indicates to a UA that it MUST enforce the HSTS Policy'),
    headerField('Link', 8288, '3', '3. Link Serialisation in HTTP Headers', '4. IANA Considerations',
      'The Link header field provides a means for serialising one or more links into HTTP headers.'),
  ],
  hypothesis:
    'The strongest case for fan-out, ten lookups across four current RFCs, but expect a tie on score: ' +
    'in a one-run calibration, single scored 1.0 with both Haiku 4.5 and Sonnet 5.5 once it read the ' +
    'corpus (closed-book, Haiku named an obsolete RFC for 8 of 10 fields). Fan-out should cut wall-clock ' +
    'time at a higher token cost.',
  traps: [
    {
      id: 'obsolete-rfc',
      description:
        'RFC 7231, 7232 and 7234 define Location, Retry-After, Vary, ETag, Last-Modified, Age, ' +
        'Cache-Control and Expires, and are obsoleted by RFC 9110 and 9111.',
      caughtBy: ['gold:rfc'],
    },
    {
      id: 'same-section-numbers',
      description:
        'RFC 7234 numbers Age, Cache-Control and Expires 5.1, 5.2 and 5.3, exactly like RFC 9111, so the ' +
        'section alone does not reveal an obsolete source; the quote must come from RFC 9111.',
      caughtBy: ['quote grounding'],
    },
  ],
};

// ---------------------------------------------------------------------------
// NIST password rules: one section, and a superseded revision that disagrees
// ---------------------------------------------------------------------------

const NIST_REV4 = 'nist-sp800-63b-4';

/**
 * One rule of SP 800-63B-4: the sentence that states it is both the place a
 * quote must come from and the gold quote. `alsoStated` lists other sentences
 * of revision 4 that state the same rule with the same keyword.
 */
function nistRule(
  key: string,
  prompt: string,
  keyword: string,
  value: number | null,
  sentence: string,
  alsoStated: string[] = [],
): BreadthItem {
  return {
    key,
    prompt,
    expected: { keyword, value },
    source: { doc: NIST_REV4, from: sentence },
    ...(alsoStated.length > 0 ? { alsoSource: alsoStated.map((from) => ({ doc: NIST_REV4, from })) } : {}),
    goldQuote: sentence,
  };
}

export const nistPasswordRulesSpec: BreadthTaskSpec = {
  id: 'research-nist-password-rules',
  title: 'NIST SP 800-63B password rules, current revision',
  question:
    'What does the current revision of NIST SP 800-63B require of verifiers and credential service ' +
    'providers about passwords? For each topic below, give the normative keyword of the requirement ' +
    'and the number it sets, if any.',
  difficulty: 'medium',
  tags: ['security', 'standards', 'breadth', 'versions', 'gold-key'],
  maxTurns: 30,
  corpus: {
    primary: [NIST_REV4],
    secondary: ['owasp-authentication', 'owasp-password-storage'],
    superseded: ['nist-sp800-63b-3'],
  },
  key: { name: 'topic', label: 'topic' },
  quoteFrom: 'the current revision of SP 800-63B that states the requirement',
  fields: [
    {
      name: 'keyword',
      kind: 'keyword',
      description: 'the normative keyword the current requirement uses',
      options: ['SHALL', 'SHALL NOT', 'SHOULD', 'SHOULD NOT', 'MAY'],
    },
    {
      name: 'value',
      kind: 'integer',
      description: 'the number the requirement sets (in characters or bits), or null when it sets none',
    },
  ],
  items: [
    nistRule('single-factor-minimum-length', 'minimum length of a password used as the only authentication factor (characters)', 'SHALL', 15,
      'Verifiers and CSPs SHALL require passwords that are used as a single-factor authentication mechanism to be a minimum of 15 characters in length.'),
    nistRule('maximum-length', 'the maximum password length verifiers permit (characters)', 'SHOULD', 64,
      'Verifiers and CSPs SHOULD permit a maximum password length of at least 64 characters.'),
    nistRule('composition-rules', 'imposing composition rules, such as requiring a mix of character types', 'SHALL NOT', null,
      'Verifiers and CSPs SHALL NOT impose other composition rules (e.g., requiring mixtures of different character types) for passwords.',
      // Section 3.1.1.1 states the same rule from the CSP's side.
      ['Other composition requirements for passwords SHALL NOT be imposed.']),
    nistRule('periodic-change', 'requiring subscribers to change their passwords periodically', 'SHALL NOT', null,
      'Verifiers and CSPs SHALL NOT require subscribers to change passwords periodically.'),
    nistRule('password-hints', 'letting subscribers store a password hint that unauthenticated claimants can see', 'SHALL NOT', null,
      'Verifiers and CSPs SHALL NOT permit the subscriber to store a hint (e.g., a reminder of how the password was created) that is accessible to an unauthenticated claimant.'),
    nistRule('security-questions', 'prompting for knowledge-based authentication or security questions when a password is chosen', 'SHALL NOT', null,
      'Verifiers and CSPs SHALL NOT prompt subscribers to use knowledge-based authentication (KBA) (e.g., “What was the name of your first pet?”) or security questions when choosing passwords.'),
    nistRule('blocklist', 'checking a new password against a blocklist of commonly used, expected or compromised passwords', 'SHALL', null,
      'When processing a request to establish or change a password, verifiers SHALL compare the prospective secret against a blocklist that contains known commonly used, expected, or compromised passwords.'),
    nistRule('password-managers', 'allowing password managers and autofill', 'SHALL', null,
      'Verifiers SHALL allow the use of password managers and autofill functionality.'),
    nistRule('salt-length', 'the length of the salt used when storing passwords (bits)', 'SHALL', 32,
      'The salt SHALL be at least 32 bits in length and chosen to minimize salt value collisions among stored hashes'),
    nistRule('hashing-scheme', 'using an approved password hashing scheme from the latest revision of SP 800-132', 'SHOULD', null,
      'An approved password hashing scheme published in the latest revision of [SP800-132] or updated NIST guidelines on password hashing schemes SHOULD be used.'),
  ],
  hypothesis:
    'A version trap more than a breadth task: every rule sits in one section of one document, but the ' +
    'superseded revision 3, also in the corpus, answers four of them differently. Decomposition has ' +
    'nothing to split, so expect single to match or beat fan-out on score and cost; in a one-run ' +
    'calibration it scored 1.0 with both Haiku 4.5 and Sonnet 5.5.',
  traps: [
    {
      id: 'revision-3',
      description:
        'Revision 3 sets an 8-character minimum, says composition rules and periodic changes SHOULD NOT ' +
        '(not SHALL NOT) be imposed, and only SHOULD permit paste. It is in the corpus, marked superseded.',
      caughtBy: ['gold:keyword', 'gold:value'],
    },
    {
      id: 'owasp-as-nist',
      description:
        "Answering from OWASP's Authentication Cheat Sheet, which paraphrases NIST in its own words " +
        '("verifiers should not mandate arbitrary password changes") and so cannot settle which keyword NIST uses.',
      caughtBy: ['gold:keyword', 'quote grounding'],
    },
  ],
};

export const breadthResearchSpecs: BreadthTaskSpec[] = [statusCodesSpec, headerFieldsSpec, nistPasswordRulesSpec];

export const breadthTasks: Task[] = breadthResearchSpecs.map(defineBreadthTask);
