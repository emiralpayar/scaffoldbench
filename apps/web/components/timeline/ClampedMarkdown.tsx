'use client';

import { useLayoutEffect, useRef, useState } from 'react';

import { Markdown } from '../Markdown';

/**
 * A reply in the event list, cut to a few lines with a fade only when there
 * is more to read. Whether it overflows depends on the rendered width, so it
 * is measured rather than guessed from the length of the text.
 */
export function ClampedMarkdown({ source }: { source: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [overflowing, setOverflowing] = useState(false);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => setOverflowing(element.scrollHeight > element.clientHeight + 2);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [source]);

  return (
    <span className="relative block min-w-0">
      <span ref={ref} className="block max-h-[8.25rem] overflow-hidden">
        <Markdown source={source} className="!text-[0.8125rem]" />
      </span>
      {overflowing ? (
        <span aria-hidden className="clamp-fade">
          <span className="clamp-more">more</span>
        </span>
      ) : null}
    </span>
  );
}
