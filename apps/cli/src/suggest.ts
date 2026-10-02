/** "Did you mean …?" for flags, commands and run set ids. Pure. */

/** Levenshtein distance. */
export function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const substitution = (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1);
      current.push(Math.min((previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1, substitution));
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
}

/**
 * Up to `limit` known words close enough to `wanted` to be what was meant:
 * within a third of the word's length (at least two edits), or starting
 * with it.
 */
export function closest(wanted: string, known: readonly string[], limit = 3): string[] {
  const needle = wanted.toLowerCase();
  return known
    .map((word) => {
      const hay = word.toLowerCase();
      const distance = hay.startsWith(needle) && needle.length >= 3 ? 0.5 : editDistance(needle, hay);
      return { word, distance };
    })
    .filter(({ word, distance }) => distance <= Math.max(2, Math.floor(word.length / 3)))
    .sort((a, b) => a.distance - b.distance || a.word.localeCompare(b.word))
    .slice(0, limit)
    .map(({ word }) => word);
}
