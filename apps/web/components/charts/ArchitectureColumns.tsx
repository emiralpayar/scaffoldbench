import { architectureName } from '../../lib/architectures';
import { ArchitectureGlyph } from '../ArchitectureGlyph';

/**
 * The grid template shared by the charts that give every architecture a
 * column. Below `lg` a row's heading spans the full width above its cells, so
 * six columns fit a phone without a sideways scroll; from `lg` the heading
 * takes a column of its own on the left. `--arch-count` is set on the grid.
 */
export function architectureGridClass(lead: string): string {
  return `grid grid-cols-[repeat(var(--arch-count),minmax(0,1fr))] ${lead}`;
}

/**
 * One architecture's column heading: its glyph and name on a wide screen, the
 * glyph alone on a phone, where six names do not fit across. The name stays
 * for screen readers and as a tooltip, and an `ArchitectureKey` on the page
 * says which glyph is which.
 */
export function ArchitectureColumnHeader({ id, glyphWidth = 34 }: { id: string; glyphWidth?: number }) {
  const name = architectureName(id);
  return (
    <div role="columnheader" title={name} className="flex flex-col items-center justify-end gap-1.5 px-1 py-3 text-center">
      <ArchitectureGlyph id={id} width={glyphWidth} decorative />
      <span className="sr-only text-[0.75rem] leading-tight text-ink-2 lg:not-sr-only">{name}</span>
    </div>
  );
}

/**
 * Which glyph is which, shown only where columns are headed by glyphs alone.
 * Hidden from screen readers, which get each column's name from its heading.
 */
export function ArchitectureKey({
  architectures,
  className = '',
}: {
  architectures: readonly string[];
  className?: string;
}) {
  return (
    <ul
      aria-hidden
      className={`grid grid-cols-2 gap-x-4 gap-y-2 text-[0.8125rem] text-ink-2 sm:grid-cols-3 lg:hidden ${className}`}
    >
      {architectures.map((id) => (
        <li key={id} className="flex min-w-0 items-center gap-2">
          <ArchitectureGlyph id={id} width={26} decorative className="shrink-0" />
          <span className="truncate">{architectureName(id)}</span>
        </li>
      ))}
    </ul>
  );
}
