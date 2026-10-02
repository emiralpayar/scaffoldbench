/**
 * Checks over free text an agent wrote: a notice, a reply, a comment.
 *
 * Scoring prose is a judgement call, so these checks stay narrow: they ask
 * whether a specific fact made it into the text, in any of the ordinary ways a
 * person would write it, and never whether the text is good.
 */

const MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];

/**
 * True when `text` names the calendar date `iso` (`YYYY-MM-DD`): as the ISO
 * date itself, or as day and month in words in either order, with or without
 * an ordinal suffix or abbreviation ("2026-08-03", "August 3rd", "3 Aug",
 * "Monday, 3 August 2026"). Numeric forms such as 08/03 are not accepted:
 * they read differently on either side of the Atlantic.
 */
export function mentionsDate(text: string, iso: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) throw new Error(`mentionsDate needs a YYYY-MM-DD date, got ${iso}`);
  if (text.includes(iso)) return true;
  const month = MONTHS[Number(match[2]) - 1];
  const day = Number(match[3]);
  if (!month) return false;
  const name = `(?:${month}|${month.slice(0, 3)}\\.?)`;
  const dayPattern = `0?${day}(?:st|nd|rd|th)?`;
  const lower = text.toLowerCase();
  return (
    new RegExp(`\\b${name}\\s+${dayPattern}\\b`).test(lower) ||
    new RegExp(`\\b${dayPattern}\\s+(?:of\\s+)?${name}\\b`).test(lower)
  );
}

/** True when `text` contains `needle`, ignoring case. */
export function mentions(text: string, needle: string): boolean {
  return text.toLowerCase().includes(needle.toLowerCase());
}
