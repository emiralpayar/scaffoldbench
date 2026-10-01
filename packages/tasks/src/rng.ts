/**
 * A small seeded random source for generating task worlds.
 *
 * A generated world must be identical on every machine and every run, so
 * nothing here touches `Math.random`. The same seed always yields the same
 * sequence, which is what lets a task be re-instantiated as a different but
 * equally valid variant (a new seed) while every scorer expectation is still
 * computed from the world rather than written down.
 */

export interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
  /** Uniform integer in [min, max], both inclusive. */
  int(min: number, max: number): number;
  pick<T>(items: readonly T[]): T;
  /** A shuffled copy; the input is not modified. */
  shuffle<T>(items: readonly T[]): T[];
}

/** mulberry32: tiny, fast and well distributed enough for picking test data. */
export function createRng(seed: number): Rng {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };

  const int = (min: number, max: number): number => min + Math.floor(next() * (max - min + 1));

  return {
    next,
    int,
    pick<T>(items: readonly T[]): T {
      if (items.length === 0) throw new Error('cannot pick from an empty list');
      return items[int(0, items.length - 1)] as T;
    },
    shuffle<T>(items: readonly T[]): T[] {
      const copy = [...items];
      for (let index = copy.length - 1; index > 0; index--) {
        const other = int(0, index);
        [copy[index], copy[other]] = [copy[other] as T, copy[index] as T];
      }
      return copy;
    },
  };
}
