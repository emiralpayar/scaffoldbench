'use client';

import type { ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';

/**
 * Content that scrolls sideways on a narrow screen, reachable by keyboard.
 *
 * A region that scrolls but holds nothing focusable cannot be scrolled with
 * the keyboard at all, so while it overflows it takes a tab stop itself and
 * is named, so a screen reader says what it has landed on. Once it fits, as
 * on a wide screen, it takes none: a tab stop that scrolls nothing is noise.
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
  const ref = useRef<HTMLDivElement>(null);
  const [overflows, setOverflows] = useState(false);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => setOverflows(element.scrollWidth > element.clientWidth + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    // The first child is what overflows; its size changes without the box's.
    if (element.firstElementChild) observer.observe(element.firstElementChild);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      className={`scroll-x ${className}`}
      {...(overflows ? { role: 'region', 'aria-label': label, tabIndex: 0 } : {})}
    >
      {children}
    </div>
  );
}
