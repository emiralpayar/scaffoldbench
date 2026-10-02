import type { ReactNode } from 'react';

/**
 * Content that scrolls sideways on a narrow screen, reachable by keyboard.
 *
 * A region that scrolls but holds nothing focusable cannot be scrolled with
 * the keyboard at all, so it takes the tab stop itself, and is named so a
 * screen reader says what it has landed on.
 */
export function ScrollRegion({
  label,
  className = '',
  children,
}: {
  label: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div role="region" aria-label={label} tabIndex={0} className={`scroll-x ${className}`}>
      {children}
    </div>
  );
}
