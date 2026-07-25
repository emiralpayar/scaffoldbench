import { createHash } from 'node:crypto';
import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export type FixtureKind = 'search' | 'fetch';

/** One recorded web interaction, as it sits on disk. */
export interface FixtureRecord<T = unknown> {
  key: string;
  kind: FixtureKind;
  /** The normalized-but-readable request this recording answers. */
  payload: string;
  recordedAt: string;
  value: T;
}

export type FixtureWrite<T = unknown> = Pick<FixtureRecord<T>, 'kind' | 'payload' | 'value'>;

const KEY_LENGTH = 32;

/**
 * Content address for a recorded request.
 *
 * Whitespace and case are normalized so that a model asking for `RFC  7538`
 * and one asking for `rfc 7538` share a recording. Without that, replay runs
 * would miss on cosmetic differences and silently penalise the strategy.
 */
export function fixtureKey(kind: FixtureKind, payload: string): string {
  const normalized = payload.trim().replace(/\s+/g, ' ').toLowerCase();
  return createHash('sha256').update(`${kind}:${normalized}`).digest('hex').slice(0, KEY_LENGTH);
}

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'between', 'by', 'do', 'does', 'for', 'from', 'how',
  'in', 'is', 'it', 'of', 'on', 'or', 'the', 'to', 'vs', 'what', 'when', 'which', 'why', 'with',
]);

/** Content words of a query or URL, for near-match scoring. */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token));
}

/**
 * Weighted overlap between a request and a recording, in 0..1.
 *
 * Weighted rather than plain Jaccard because a recorded query is often broader
 * than the one being asked; what matters is how much of the *request* the
 * recording covers, not how similar their lengths are.
 */
export function similarity(request: readonly string[], candidate: readonly string[]): number {
  if (request.length === 0 || candidate.length === 0) return 0;
  const other = new Set(candidate);
  let shared = 0;
  for (const token of new Set(request)) {
    if (other.has(token)) shared += 1;
  }
  return shared / new Set(request).size;
}

/** Content-addressed cache of recorded web responses, one JSON file per key. */
export class FixtureStore {
  readonly #dir: string;

  constructor(dir: string) {
    this.#dir = dir;
  }

  get dir(): string {
    return this.#dir;
  }

  async has(key: string): Promise<boolean> {
    try {
      await access(this.#pathFor(key));
      return true;
    } catch {
      return false;
    }
  }

  /** Undefined for a missing or unreadable fixture — a cache miss is never fatal. */
  async read<T = unknown>(key: string): Promise<FixtureRecord<T> | undefined> {
    try {
      const raw = await readFile(this.#pathFor(key), 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null) return undefined;
      if (!('value' in parsed)) return undefined;
      return parsed as FixtureRecord<T>;
    } catch {
      return undefined;
    }
  }

  async write<T>(key: string, entry: FixtureWrite<T>): Promise<FixtureRecord<T>> {
    const record: FixtureRecord<T> = {
      key,
      kind: entry.kind,
      payload: entry.payload,
      recordedAt: new Date().toISOString(),
      value: entry.value,
    };
    await mkdir(this.#dir, { recursive: true });
    await writeFile(this.#pathFor(key), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    return record;
  }

  /**
   * Every recording of one kind, loaded once and cached.
   *
   * Needed because exact-key replay turned out to be unusable in practice: a
   * recording answers only the precise wording that produced it, and no two
   * runs word a search the same way. A first replay of a freshly recorded
   * research task missed on all sixteen of its searches. Near-matching against
   * the whole corpus is what makes replay work at all, and it needs the corpus
   * in memory.
   */
  async all<T = unknown>(kind: FixtureKind): Promise<FixtureRecord<T>[]> {
    const cached = this.#corpus.get(kind);
    if (cached) return cached as FixtureRecord<T>[];

    const records: FixtureRecord<unknown>[] = [];
    try {
      for (const name of await readdir(this.#dir)) {
        if (!name.endsWith('.json')) continue;
        const record = await this.read(name.slice(0, -5));
        if (record && record.kind === kind) records.push(record);
      }
    } catch {
      // No fixture directory yet: an empty corpus, not an error.
    }

    records.sort((a, b) => a.payload.localeCompare(b.payload));
    this.#corpus.set(kind, records);
    return records as FixtureRecord<T>[];
  }

  /** Drop the cached corpus. Used after a record run adds new fixtures. */
  invalidate(): void {
    this.#corpus.clear();
  }

  #pathFor(key: string): string {
    return join(this.#dir, `${key}.json`);
  }

  readonly #corpus = new Map<FixtureKind, FixtureRecord<unknown>[]>();
}
