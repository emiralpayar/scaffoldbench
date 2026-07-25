import type { Task } from '@arena/core';
import { defineResearchTask } from './defineResearchTask';

/**
 * Three research questions whose correct answers do not drift.
 *
 * Every rubric item is a statement that either appears in the answer or does
 * not, so grading disagreements are about reading comprehension rather than
 * taste. Anything that changes with a release cycle — benchmarks, prices,
 * "current best practice" — is deliberately absent: a benchmark whose expected
 * answer moves under it stops measuring the harness.
 */

const httpRedirects = defineResearchTask({
  id: 'research-http-redirects',
  title: 'HTTP 301 vs 308',
  question:
    'What is the difference between HTTP status codes 301 and 308? Explain what each one means, ' +
    'how a client is expected to treat the request method and body when following each, whether ' +
    'each is cacheable, and where each is specified.',
  difficulty: 'easy',
  tags: ['http', 'specifications', 'comparison'],
  maxTurns: 14,
  requiredSources: ['rfc-editor.org', 'developer.mozilla.org'],
  rubric: [
    {
      id: 'names',
      claim:
        'States that 301 is "Moved Permanently" and 308 is "Permanent Redirect", and that both indicate the target resource has a new permanent URI.',
      weight: 1,
    },
    {
      id: 'method-preserved-308',
      claim:
        'States that 308 requires the client to reuse the original request method and body when following the redirect.',
      weight: 1.5,
    },
    {
      id: 'method-change-301',
      claim:
        'States that with 301 clients are permitted to change the request method — in practice a POST becomes a GET — which is exactly the behaviour 308 was introduced to prevent.',
      weight: 1.5,
    },
    {
      id: 'cacheable',
      claim:
        'States that both 301 and 308 are cacheable by default (a permanent redirect may be cached even without explicit cache headers).',
      weight: 1,
    },
    {
      id: 'specifications',
      claim:
        'States that 308 is defined in RFC 7538 and that 301 is defined in the core HTTP semantics specification (RFC 9110, previously RFC 7231 / RFC 2616).',
      weight: 1,
    },
  ],
});

const scriptLoading = defineResearchTask({
  id: 'research-script-loading',
  title: 'async vs defer on <script>',
  question:
    'In HTML, what exactly do the `async` and `defer` attributes on a <script> element do? Cover ' +
    'how each interacts with HTML parsing, when each executes relative to the DOMContentLoaded ' +
    'event, what each guarantees about execution order when there are several scripts, and how ' +
    'inline scripts and type="module" scripts differ from the classic src case.',
  difficulty: 'medium',
  tags: ['html', 'browser', 'synthesis'],
  maxTurns: 20,
  requiredSources: ['developer.mozilla.org', 'html.spec.whatwg.org', 'web.dev'],
  rubric: [
    {
      id: 'parallel-download',
      claim:
        'States that both async and defer let the script be downloaded in parallel with HTML parsing, so neither blocks the parser while fetching, unlike a plain classic script with src.',
      weight: 1,
    },
    {
      id: 'defer-timing',
      claim:
        'States that a defer script executes only after the document has finished parsing, and before DOMContentLoaded fires.',
      weight: 1.5,
    },
    {
      id: 'async-timing',
      claim:
        'States that an async script executes as soon as its download completes, interrupting parsing if parsing is still in progress, and may therefore run before or after DOMContentLoaded.',
      weight: 1.5,
    },
    {
      id: 'ordering',
      claim:
        'States that multiple defer scripts execute in document order, while async scripts execute in the order their downloads complete, which is not predictable.',
      weight: 1.5,
    },
    {
      id: 'inline-ignored',
      claim:
        'States that async and defer have no effect on a classic inline script (a script element without a src attribute).',
      weight: 1,
    },
    {
      id: 'modules',
      claim:
        'States that type="module" scripts are deferred by default, and that async does take effect on module scripts including inline ones.',
      weight: 1.5,
    },
  ],
});

const passwordHashing = defineResearchTask({
  id: 'research-password-hashing',
  title: 'OWASP vs NIST on password hashing',
  question:
    'A team must choose a password hashing algorithm for a web service that also has to satisfy US ' +
    'federal (FIPS) requirements. What does the OWASP Password Storage guidance recommend, what ' +
    'does NIST SP 800-63B require, and how should the team reconcile the two? Report what each ' +
    'source actually says.',
  difficulty: 'hard',
  tags: ['security', 'standards', 'disagreement'],
  maxTurns: 26,
  requiredSources: ['owasp.org', 'nist.gov'],
  rubric: [
    {
      id: 'owasp-argon2id',
      claim: 'States that OWASP recommends Argon2id as its first choice for password hashing.',
      weight: 1.5,
    },
    {
      id: 'owasp-fallbacks',
      claim:
        'States OWASP\'s fallback ordering when Argon2id is unavailable: scrypt, then bcrypt, then PBKDF2.',
      weight: 1,
    },
    {
      id: 'nist-pbkdf2',
      claim:
        'States that NIST SP 800-63B calls for an approved key derivation function such as PBKDF2 with an approved hash (SP 800-63B also names Balloon hashing) and does not list Argon2 among its options.',
      weight: 1.5,
    },
    {
      id: 'names-the-conflict',
      claim:
        'Explicitly says that the two sources give different answers, rather than presenting a single recommendation as if both agreed.',
      weight: 2,
    },
    {
      id: 'explains-the-conflict',
      claim:
        'Explains why they diverge: NIST is constrained to FIPS-approved primitives, whereas OWASP optimizes for resistance to GPU/ASIC-accelerated cracking, and the memory-hard functions OWASP prefers are not FIPS-approved.',
      weight: 1.5,
    },
    {
      id: 'common-ground',
      claim:
        'States at least one requirement both sources agree on, such as a unique per-user salt, or that a bare fast hash such as MD5, SHA-1 or plain SHA-256 must not be used for passwords.',
      weight: 1,
    },
  ],
});

export const researchTasks: Task[] = [httpRedirects, scriptLoading, passwordHashing];
