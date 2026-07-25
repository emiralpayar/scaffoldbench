import { createHash } from 'node:crypto';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
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

  #pathFor(key: string): string {
    return join(this.#dir, `${key}.json`);
  }
}
