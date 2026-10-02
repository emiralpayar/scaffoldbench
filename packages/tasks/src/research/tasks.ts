import type { Task } from '@arena/core';
import { breadthTasks } from './breadthTasks';
import { defineResearchTask, type ResearchTaskSpec } from './defineResearchTask';

/**
 * Three judged research questions, each answered from its own slice of the
 * frozen corpus.
 *
 * Every rubric item is a flat statement the answer either makes or does not,
 * so grading disagreements are about reading rather than taste, and every item
 * lists the corpus passages that establish it. Answers are graded as of the
 * corpus snapshot, not as of today: standards move (NIST replaced SP 800-63B
 * revision 3 with revision 4 in August 2025, and OWASP retunes its iteration
 * counts), which is precisely why the web these tasks see is frozen and dated.
 */

export const httpRedirectsSpec: ResearchTaskSpec = {
  id: 'research-http-redirects',
  title: 'HTTP 301 vs 308',
  question:
    'What is the difference between HTTP status codes 301 and 308? Explain what each one means, ' +
    'how a client is expected to treat the request method and body when following each, whether ' +
    'each is cacheable, and where each is currently specified.',
  difficulty: 'easy',
  tags: ['http', 'specifications', 'comparison'],
  maxTurns: 22,
  corpus: {
    primary: ['rfc9110'],
    secondary: ['mdn-status-301', 'mdn-status-308', 'mdn-redirections', 'rfc9111'],
    superseded: ['rfc7538', 'rfc7231'],
    distractor: ['mdn-status-307'],
  },
  hypothesis:
    'Near the ceiling for every architecture: all five claims sit in two short sections of RFC 9110. ' +
    'The one place a verify phase can earn its cost is the MDN trap below.',
  traps: [
    {
      id: 'mdn-301-method',
      description:
        "MDN's 308 page says a 301 'requires the request method and the body to remain unchanged'; " +
        'RFC 9110 says a user agent MAY change POST to GET. Repeating MDN contradicts the primary source.',
      caughtBy: ['rubric:method-change-301'],
    },
    {
      id: 'rfc7231-cacheable-list',
      description: "RFC 7231's list of cacheable-by-default codes predates 308; an answer built on it gets 308 wrong.",
      caughtBy: ['rubric:cacheable'],
    },
    {
      id: 'rfc7538-current',
      description: 'Citing RFC 7538 as the current definition of 308; RFC 9110 obsoletes it.',
      caughtBy: ['rubric:specifications'],
    },
  ],
  rubric: [
    {
      id: 'names',
      claim:
        'States that 301 is "Moved Permanently" and 308 is "Permanent Redirect", and that both indicate the target resource has been assigned a new permanent URI.',
      weight: 1,
      support: [
        {
          doc: 'rfc9110',
          quote:
            'The 308 (Permanent Redirect) status code indicates that the target resource has been assigned a new permanent URI',
        },
      ],
    },
    {
      id: 'method-preserved-308',
      claim:
        'States that a client following a 308 must not change the request method: a POST is repeated as a POST, with its body.',
      weight: 1.5,
      support: [
        { doc: 'rfc7538', quote: 'except that it does not allow changing the request method from POST to GET' },
        {
          doc: 'rfc9110',
          quote:
            '307 (Temporary Redirect) and 308 (Permanent Redirect) [RFC7538] were later added to unambiguously indicate method-preserving redirects',
        },
      ],
    },
    {
      id: 'method-change-301',
      claim:
        'States that when following a 301 a user agent MAY change the request method from POST to GET (for historical reasons), which is the behaviour 308 exists to rule out.',
      weight: 1.5,
      support: [
        {
          doc: 'rfc9110',
          quote: 'For historical reasons, a user agent MAY change the request method from POST to GET for the subsequent request.',
        },
      ],
    },
    {
      id: 'cacheable',
      claim:
        'States that both 301 and 308 responses are heuristically cacheable, i.e. a cache may reuse them by default unless the method definition or explicit cache controls say otherwise.',
      weight: 1,
      support: [
        { doc: 'rfc9110', quote: 'A 301 response is heuristically cacheable' },
        { doc: 'rfc9110', quote: 'A 308 response is heuristically cacheable' },
      ],
    },
    {
      id: 'specifications',
      claim:
        'States that both codes are currently specified in RFC 9110 (HTTP Semantics), and that 308 was originally defined in RFC 7538, which RFC 9110 obsoletes.',
      weight: 1,
      support: [
        {
          doc: 'rfc9110',
          quote: 'This document updates RFC 3864 and obsoletes RFCs 2818, 7231, 7232, 7233, 7235, 7538, 7615, 7694, and portions of 7230.',
        },
      ],
    },
  ],
};

export const scriptLoadingSpec: ResearchTaskSpec = {
  id: 'research-script-loading',
  title: 'async vs defer on <script>',
  question:
    'In HTML, what exactly do the `async` and `defer` attributes on a <script> element do? Cover ' +
    'how each interacts with HTML parsing, when each executes relative to the DOMContentLoaded ' +
    'event, what each guarantees about execution order when there are several scripts, and how ' +
    'inline scripts and type="module" scripts differ from the classic src case.',
  difficulty: 'medium',
  tags: ['html', 'browser', 'synthesis'],
  maxTurns: 30,
  corpus: {
    primary: ['whatwg-html-scripting'],
    secondary: [
      'mdn-script-element',
      'mdn-js-modules',
      'mdn-domcontentloaded',
      'webdev-third-party-javascript',
      'webdev-optimize-resource-loading',
    ],
  },
  hypothesis:
    'Mostly memorable material, so expect high rubric agreement across architectures; the spread ' +
    'should come from grounding — whether each claim is backed by a verified quote — and from the ' +
    'module-script details, which only the HTML Standard states precisely.',
  traps: [
    {
      id: 'async-after-dcl',
      description:
        "MDN's DOMContentLoaded page says the event fires 'before the execution of scripts with async'; " +
        'the HTML Standard says an async script runs as soon as it is available, possibly before parsing completes.',
      caughtBy: ['rubric:async-timing'],
    },
    {
      id: 'module-defer',
      description: 'Claiming defer changes a module script; the HTML Standard says it has no effect on module scripts.',
      caughtBy: ['rubric:modules'],
    },
  ],
  rubric: [
    {
      id: 'parallel-download',
      claim:
        'States that both async and defer let a classic script be fetched in parallel with HTML parsing, so the fetch does not block the parser, unlike a classic script with src and neither attribute.',
      weight: 1,
      support: [
        {
          doc: 'whatwg-html-scripting',
          quote:
            'If neither attribute is present, then the script is fetched and evaluated immediately, blocking parsing until these are both complete.',
        },
      ],
    },
    {
      id: 'defer-timing',
      claim:
        'States that a defer script executes only after the document has finished parsing, and before DOMContentLoaded fires.',
      weight: 1.5,
      support: [
        {
          doc: 'webdev-third-party-javascript',
          quote:
            'Scripts with the defer attribute execute after HTML parsing is completely finished, but before the DOMContentLoaded event.',
        },
      ],
    },
    {
      id: 'async-timing',
      claim:
        'States that an async script executes as soon as it is available, interrupting parsing if parsing is still in progress, so it may run before or after DOMContentLoaded.',
      weight: 1.5,
      support: [
        {
          doc: 'whatwg-html-scripting',
          quote:
            'the classic script will be fetched in parallel to parsing and evaluated as soon as it is available (potentially before parsing completes)',
        },
      ],
    },
    {
      id: 'ordering',
      claim:
        'States that multiple defer scripts execute in document order, while async scripts execute in the order their downloads complete, which is not predictable.',
      weight: 1.5,
      support: [
        {
          doc: 'mdn-script-element',
          quote: 'Scripts with the defer attribute will execute in the order in which they appear in the document.',
        },
        {
          doc: 'webdev-third-party-javascript',
          quote: "it's possible (and likely) that async scripts won't run in the order in which they appear in the HTML",
        },
      ],
    },
    {
      id: 'inline-ignored',
      claim:
        'States that async and defer have no effect on a classic inline script (a script element without a src attribute).',
      weight: 1,
      support: [
        {
          doc: 'mdn-script-element',
          quote:
            'This attribute must not be used if the src attribute is absent (i.e., for inline scripts) for classic scripts, in this case it would have no effect.',
        },
      ],
    },
    {
      id: 'modules',
      claim:
        'States that module scripts are deferred by default, so the defer attribute has no effect on them, while the async attribute does apply to module scripts.',
      weight: 1.5,
      support: [
        {
          doc: 'whatwg-html-scripting',
          quote:
            'For module scripts, if the async attribute is present, then the module script and all its dependencies will be fetched in parallel to parsing',
        },
        { doc: 'whatwg-html-scripting', quote: '(The defer attribute has no effect on module scripts.)' },
      ],
    },
  ],
};

export const passwordHashingSpec: ResearchTaskSpec = {
  id: 'research-password-hashing',
  title: 'OWASP vs NIST on password hashing',
  question:
    'A team must choose a password hashing algorithm for a web service that also has to satisfy US ' +
    'federal (FIPS) requirements. What does the OWASP Password Storage guidance recommend, what ' +
    'does the current revision of NIST SP 800-63B require, and how should the team reconcile the ' +
    'two? Report what each source actually says.',
  difficulty: 'hard',
  tags: ['security', 'standards', 'versions'],
  maxTurns: 38,
  corpus: {
    primary: ['owasp-password-storage', 'nist-sp800-63b-4'],
    secondary: ['rfc9106'],
    superseded: ['nist-sp800-63b-3'],
    distractor: ['owasp-authentication'],
  },
  hypothesis:
    'Plan-and-verify architectures should lead: the difficulty is version and nuance, not breadth. ' +
    'A verifier that rereads the current NIST text catches revision-3 wording; parallel workers add little.',
  traps: [
    {
      id: 'nist-revision-3',
      description:
        "Reporting revision 3's 'PBKDF2 and Balloon ... a memory-hard function SHOULD be used' as what NIST " +
        'currently requires. Revision 3 is in the corpus and says it is superseded.',
      caughtBy: ['rubric:nist-current'],
    },
    {
      id: 'false-conflict',
      description:
        'Presenting OWASP and NIST as irreconcilable. OWASP itself prescribes PBKDF2 when FIPS-140 compliance is required.',
      caughtBy: ['rubric:reconciliation'],
    },
    {
      id: 'strict-ranking',
      description: "Reading OWASP's alternatives as a strict ranking rather than conditions (unavailable / legacy / FIPS).",
      caughtBy: ['rubric:owasp-conditions'],
    },
  ],
  rubric: [
    {
      id: 'owasp-argon2id',
      claim:
        'States that OWASP recommends Argon2id first, with a minimum configuration of 19 MiB of memory, an iteration count of 2 and 1 degree of parallelism.',
      weight: 1.5,
      support: [
        {
          doc: 'owasp-password-storage',
          quote: 'Use Argon2id with a minimum configuration of 19 MiB of memory, an iteration count of 2, and 1 degree of parallelism.',
        },
      ],
    },
    {
      id: 'owasp-conditions',
      claim:
        "States OWASP's alternatives as conditions: scrypt if Argon2id is not available, bcrypt only for legacy systems, and PBKDF2 (at least 600,000 iterations with HMAC-SHA-256) if FIPS-140 compliance is required.",
      weight: 1,
      support: [
        { doc: 'owasp-password-storage', quote: 'If Argon2id is not available, use scrypt with a minimum CPU/memory cost parameter' },
        { doc: 'owasp-password-storage', quote: 'For legacy systems using bcrypt, use a work factor of 10 or more' },
        {
          doc: 'owasp-password-storage',
          quote: 'If FIPS-140 compliance is required, use PBKDF2 with a work factor of 600,000 or more and set with an internal hash function of HMAC-SHA-256.',
        },
      ],
    },
    {
      id: 'nist-current',
      claim:
        'States that the current NIST SP 800-63B (revision 4) requires passwords to be salted and hashed with a suitable password hashing scheme that takes a cost factor, and says an approved scheme from the latest revision of SP 800-132 (or updated NIST guidelines) SHOULD be used.',
      weight: 1.5,
      support: [
        { doc: 'nist-sp800-63b-4', quote: 'Passwords SHALL be salted and hashed using a suitable password hashing scheme.' },
        {
          doc: 'nist-sp800-63b-4',
          quote:
            'An approved password hashing scheme published in the latest revision of [SP800-132] or updated NIST guidelines on password hashing schemes SHOULD be used.',
        },
      ],
    },
    {
      id: 'nist-revision',
      claim:
        'States that the superseded revision 3 named PBKDF2 and Balloon as example key derivation functions and said a memory-hard function SHOULD be used, and that revision 4 no longer contains that wording.',
      weight: 1,
      support: [
        {
          doc: 'nist-sp800-63b-3',
          quote:
            'Examples of suitable key derivation functions include Password-based Key Derivation Function 2 (PBKDF2) [SP 800-132] and Balloon [BALLOON]. A memory-hard function SHOULD be used because it increases the cost of an attack.',
        },
        {
          doc: 'nist-sp800-63b-3',
          quote: 'This revision of NIST SP 800-63 has been superseded by NIST SP 800-63-4 as of August 1, 2025.',
        },
      ],
    },
    {
      id: 'reconciliation',
      claim:
        "Explains that for this team the two do not actually conflict: OWASP's own guidance is to use PBKDF2 (HMAC-SHA-256, at least 600,000 iterations) when FIPS-140 compliance is required, and NIST permits PBKDF2, so PBKDF2-HMAC-SHA-256 satisfies both; Argon2id remains OWASP's choice only where FIPS does not apply.",
      weight: 2,
      support: [
        {
          doc: 'owasp-password-storage',
          quote:
            'Since PBKDF2 is permitted by NIST SP 800-63B-4 and has FIPS-140 validated implementations, it should be the preferred algorithm when these are required.',
        },
      ],
    },
    {
      id: 'common-ground',
      claim:
        'States at least one requirement both sources share, such as a unique salt for every password or a deliberately expensive hash with a tunable cost (work) factor instead of a fast general-purpose hash.',
      weight: 1,
      support: [
        { doc: 'owasp-password-storage', quote: 'A unique salt must be added to each password' },
        {
          doc: 'nist-sp800-63b-4',
          quote: 'The salt SHALL be at least 32 bits in length and chosen to minimize salt value collisions among stored hashes',
        },
      ],
    },
  ],
};

export const judgedResearchSpecs: ResearchTaskSpec[] = [httpRedirectsSpec, scriptLoadingSpec, passwordHashingSpec];

export const judgedResearchTasks: Task[] = judgedResearchSpecs.map(defineResearchTask);

/** Every research task, judged ones first, in the order they render. */
export const researchTasks: Task[] = [...judgedResearchTasks, ...breadthTasks];
