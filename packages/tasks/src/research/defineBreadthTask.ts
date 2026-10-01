import {
  buildScore,
  truncate,
  type EnvironmentOptions,
  type ScoreInput,
  type ScoreItem,
  type Task,
  type TaskEnvironment,
  type TaskScore,
} from '@arena/core';
import {
  auditCitations,
  checkQuote,
  citedUrls,
  openedDocuments,
  QUOTE_FAILURE_TEXT,
  readAnswerBlock,
} from './citations';
import type { CorpusDocument, TaskCorpus } from './corpus';
import {
  citationPenalty,
  createResearchEnvironment,
  RESEARCH_POLICY,
  researchMetadata,
  researchState,
  UNGROUNDED_CREDIT,
  type ResearchTaskBase,
} from './defineResearchTask';
import { normalizeForMatch } from './text';

/**
 * Breadth research: many small, independent facts, each graded against a
 * gold key with no model in the loop.
 *
 * These are the tasks where splitting the work should pay. Twelve status codes
 * are twelve lookups that do not depend on each other, so an architecture
 * that fans them out to workers has every reason to beat one agent working
 * through them in a single growing context — and if it does not, that is a
 * finding. Grading is exact and free: a field matches the key or it does not,
 * and a quote either occurs in the right part of the right document or it
 * does not.
 */

export type BreadthFieldKind = 'text' | 'section' | 'boolean' | 'integer' | 'keyword';

export interface BreadthField {
  name: string;
  kind: BreadthFieldKind;
  /** Shown to the agent: what to put in this field. */
  description: string;
  /** For `keyword` fields, the allowed values. */
  options?: string[];
}

export type GoldValue = string | number | boolean | null;

/**
 * Where an item's quote must come from: a document and a stretch of it. With
 * `to`, the body of the section headed `from` up to the heading `to`; without
 * it, the sentence `from` itself (see `TaskCorpus.spans`).
 */
export interface QuoteSource {
  doc: string;
  from: string;
  to?: string;
}

export interface BreadthItem {
  /** The item's name in the question and its key in the answer, e.g. `308`. */
  key: string;
  /** Extra wording shown next to the key, when the key alone is not a question. */
  prompt?: string;
  expected: Record<string, GoldValue>;
  /** Other answers that are equally right, per field. */
  alsoAccept?: Record<string, GoldValue[]>;
  source: QuoteSource;
  /**
   * A sentence from `source` that establishes the item. Not used for scoring;
   * the sufficiency test checks it lies inside the source span, which proves
   * the gold answer is in the corpus and the span is drawn where it should be.
   */
  goldQuote: string;
}

export interface BreadthTaskSpec extends ResearchTaskBase {
  /** The answer field that names the item, e.g. `{ name: 'code', label: 'status code' }`. */
  key: { name: string; label: string };
  fields: BreadthField[];
  /**
   * Where each item's quote must come from, in the words the prompt uses —
   * e.g. "the numbered section of the specification that defines the status
   * code". It must describe `source` exactly: the scorer accepts a quote only
   * from there, so a vaguer instruction would fail answers that followed it.
   */
  quoteFrom: string;
  items: BreadthItem[];
}

const ANSWER_FIELD_QUOTE = 'quote';
const ANSWER_FIELD_URL = 'url';

/** The prompt section that tells the agent what to report and in which shape. */
function answerFormat(spec: BreadthTaskSpec): string {
  const example: Record<string, unknown> = { [spec.key.name]: spec.items[0]?.key ?? '…' };
  for (const field of spec.fields) example[field.name] = placeholder(field);
  example[ANSWER_FIELD_QUOTE] = '<a sentence copied word for word>';
  example[ANSWER_FIELD_URL] = '<the URL of that page, as you opened it>';

  return [
    `Report, for every ${spec.key.label}:`,
    ...spec.fields.map((field) => `- ${field.name}: ${field.description}`),
    `- ${ANSWER_FIELD_QUOTE}: a sentence from ${spec.quoteFrom}, copied word for word (at least six words).`,
    `- ${ANSWER_FIELD_URL}: the URL of the page the quote comes from, which you opened with fetch_page.`,
    '',
    `Write whatever explanation you like, then end the answer with one fenced JSON block of exactly this shape, with one entry per ${spec.key.label}:`,
    '',
    '```json',
    JSON.stringify({ answers: [example] }),
    '```',
    '',
    'Quotes are checked against the text of the page at their URL, so copy them exactly. The block must be',
    'valid JSON: write a double quote inside a string as \\".',
  ].join('\n');
}

function placeholder(field: BreadthField): string | boolean {
  switch (field.kind) {
    case 'boolean':
      return true;
    case 'keyword':
      return field.options?.join(' | ') ?? '…';
    default:
      return '…';
  }
}

function question(spec: BreadthTaskSpec): string {
  const list = spec.items.map((item) => `- ${item.key}${item.prompt ? `: ${item.prompt}` : ''}`);
  return `${spec.question}\n\n${list.join('\n')}`;
}

export function defineBreadthTask(spec: BreadthTaskSpec): Task {
  const keys = spec.items.map((item) => normalizeKey(item.key));
  if (new Set(keys).size !== keys.length) throw new Error(`${spec.id}: duplicate item keys`);
  for (const item of spec.items) {
    for (const field of spec.fields) {
      if (!(field.name in item.expected)) throw new Error(`${spec.id}/${item.key}: no gold value for ${field.name}`);
    }
  }

  const fullQuestion = question(spec);
  return {
    id: spec.id,
    category: 'research',
    world: 'web',
    title: spec.title,
    prompt: `${fullQuestion}\n\nResearch this with the provided web tools.\n\n${answerFormat(spec)}`,
    policy: RESEARCH_POLICY,
    difficulty: spec.difficulty,
    tags: spec.tags,
    maxTurns: spec.maxTurns,
    ...(spec.hypothesis ? { hypothesis: spec.hypothesis } : {}),
    ...(spec.traps ? { traps: spec.traps } : {}),

    createEnvironment(options: EnvironmentOptions): TaskEnvironment {
      return createResearchEnvironment(spec.corpus, options);
    },

    async score({ env, outcome }: ScoreInput): Promise<TaskScore> {
      const { corpus } = researchState(env);
      const answer = outcome.finalText.trim();
      const opened = openedDocuments(env.journal, corpus);
      const block = readAnswerBlock(answer, isAnswersBlock);
      const entries = new Map<string, Record<string, unknown>>();
      for (const raw of block?.value.answers ?? []) {
        if (typeof raw !== 'object' || raw === null) continue;
        const entry = raw as Record<string, unknown>;
        const key = normalizeKey(String(entry[spec.key.name] ?? ''));
        if (key !== '' && !entries.has(key)) entries.set(key, entry);
      }

      const quoteUrls = [...entries.values()]
        .map((entry) => entry[ANSWER_FIELD_URL])
        .filter((url): url is string => typeof url === 'string');
      const audit = auditCitations(citedUrls(block?.prose ?? answer, quoteUrls), corpus, opened);

      let fieldsCorrect = 0;
      let grounded = 0;
      const misses: Record<string, number> = {};
      const breakdown: ScoreItem[] = spec.items.map((item) => {
        const entry = findEntry(entries, item.key);
        if (!entry) {
          return { id: item.key, label: itemLabel(spec, item), weight: 1, earned: 0, detail: 'Not answered.' };
        }

        const notes: string[] = [];
        let correct = 0;
        for (const field of spec.fields) {
          const expected = item.expected[field.name] ?? null;
          const accepted = [expected, ...(item.alsoAccept?.[field.name] ?? [])];
          if (accepted.some((gold) => fieldMatches(field, entry[field.name], gold))) {
            correct += 1;
          } else {
            misses[field.name] = (misses[field.name] ?? 0) + 1;
            notes.push(`${field.name}: answered ${show(entry[field.name])}, expected ${show(expected)}`);
          }
        }
        fieldsCorrect += correct;

        const grounding = groundItem(corpus, opened, item, entry);
        if (grounding.ok) grounded += 1;
        notes.push(grounding.note);

        const accuracy = correct / spec.fields.length;
        return {
          id: item.key,
          label: itemLabel(spec, item),
          weight: 1,
          earned: accuracy * (grounding.ok ? 1 : UNGROUNDED_CREDIT),
          detail: truncate(notes.join('; '), 300),
        };
      });

      const metadata = researchMetadata(corpus, opened, audit);
      metadata.answerBlock = block !== undefined;
      metadata.answerBlockRepaired = block?.repaired === true;
      metadata.itemsAnswered = spec.items.filter((item) => findEntry(entries, item.key)).length;
      metadata.itemCount = spec.items.length;
      metadata.fieldAccuracy = fieldsCorrect / (spec.items.length * spec.fields.length);
      metadata.groundedItems = grounded;
      metadata.fieldMisses = misses;
      if (answer === '') metadata.emptyAnswer = true;

      return buildScore({ breakdown, penalties: citationPenalty(audit), metadata });
    },
  };
}

function isAnswersBlock(value: unknown): value is { answers: unknown[] } {
  return (
    typeof value === 'object' && value !== null && Array.isArray((value as { answers?: unknown }).answers)
  );
}

/**
 * The answer entry for an item: keyed exactly, or keyed with the item's name
 * followed by more words (`"308 Permanent Redirect"` for `308`), which is a
 * formatting choice, not a different answer.
 */
function findEntry(
  entries: ReadonlyMap<string, Record<string, unknown>>,
  key: string,
): Record<string, unknown> | undefined {
  const wanted = normalizeKey(key);
  const exact = entries.get(wanted);
  if (exact) return exact;
  for (const [candidate, entry] of entries) {
    if (candidate.startsWith(`${wanted} `)) return entry;
  }
  return undefined;
}

function itemLabel(spec: BreadthTaskSpec, item: BreadthItem): string {
  return `${spec.key.label} ${item.key}${item.prompt ? `: ${item.prompt}` : ''}`;
}

/**
 * Whether the item's quote comes from where the gold answer says it should:
 * a page the run opened, word for word, in the expected document and inside
 * the expected section or sentence. A true sentence from the wrong section —
 * or from the obsolete RFC — does not count: the point is to show the answer
 * was read where it is defined.
 */
export function groundItem(
  corpus: TaskCorpus,
  opened: ReadonlyMap<string, CorpusDocument>,
  item: BreadthItem,
  entry: Record<string, unknown>,
): { ok: boolean; note: string } {
  const quote = entry[ANSWER_FIELD_QUOTE];
  const url = entry[ANSWER_FIELD_URL];
  if (typeof quote !== 'string' || quote.trim() === '' || typeof url !== 'string') {
    return { ok: false, note: 'no quote' };
  }

  const check = checkQuote(corpus, opened, quote, url);
  if (!check.ok) return { ok: false, note: `quote not verified: ${QUOTE_FAILURE_TEXT[check.reason]}` };
  if (check.document.id !== item.source.doc) {
    return { ok: false, note: `quote is from ${check.document.id}, expected ${item.source.doc}` };
  }

  const spans = corpus.spans(check.document, item.source.from, item.source.to);
  const inside = check.ranges.some((range) => spans.some((span) => range.start < span.end && range.end > span.start));
  return inside
    ? { ok: true, note: `quote verified in ${item.source.doc}` }
    : { ok: false, note: `quote is from ${item.source.doc} but outside the part that defines this item` };
}

// ---------------------------------------------------------------------------
// field comparison
// ---------------------------------------------------------------------------

function normalizeKey(key: string): string {
  return normalizeForMatch(key);
}

/** `Section 15.4.9.`, `§15.4.9` and `15.4.9` are the same section. */
export function normalizeSection(value: string): string {
  return value
    .toLowerCase()
    .replace(/section|sec\.?|§/g, '')
    .replace(/\s+/g, '')
    .replace(/\.+$/, '');
}

export function fieldMatches(field: BreadthField, answered: unknown, expected: GoldValue): boolean {
  if (expected === null) return answered === null || answered === undefined || answered === '';
  switch (field.kind) {
    case 'boolean':
      return toBoolean(answered) === expected;
    case 'integer':
      return toInteger(answered) === expected;
    case 'section':
      return typeof answered === 'string' || typeof answered === 'number'
        ? normalizeSection(String(answered)) === normalizeSection(String(expected))
        : false;
    case 'keyword':
      return typeof answered === 'string' && answered.trim().replace(/\s+/g, ' ').toUpperCase() === String(expected);
    case 'text':
      return typeof answered === 'string' && normalizeForMatch(answered) === normalizeForMatch(String(expected));
  }
}

function toBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return undefined;
  const word = value.trim().toLowerCase();
  if (word === 'true' || word === 'yes') return true;
  if (word === 'false' || word === 'no') return false;
  return undefined;
}

/** A number, or the first integer in a string such as `RFC 9111` or `15 characters`. */
function toInteger(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isInteger(value) ? value : undefined;
  if (typeof value !== 'string') return undefined;
  const match = value.replace(/,/g, '').match(/\d+/);
  return match ? Number(match[0]) : undefined;
}

function show(value: unknown): string {
  if (value === undefined) return 'nothing';
  return typeof value === 'string' ? `"${truncate(value, 60)}"` : JSON.stringify(value);
}
