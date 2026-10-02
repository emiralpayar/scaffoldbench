'use client';

import type { FocusEvent, MouseEvent, ReactNode } from 'react';
import { useState } from 'react';

/**
 * A status line that describes whatever mark the pointer or keyboard is on.
 *
 * Marks opt in with `data-readout-title` and `data-readout-detail`. One
 * sticky line under a large grid reads better than a tooltip per mark, which
 * a scrolling table would clip at its edges; it is also where a keyboard
 * user's focus is announced, politely.
 *
 * It floats at the bottom of the screen only while it has a mark to describe.
 * Idle, it sits under the grid as plain text: pinned, an instruction would
 * cover the last rows of a long grid for as long as the reader scrolls it.
 *
 * A device that cannot hover gets no line at all: a tap there opens the mark
 * straight away, so the line would rarely say anything and would cover the
 * grid while it scrolls.
 */
export function Readout({ children, prompt }: { children: ReactNode; prompt: string }) {
  const [current, setCurrent] = useState<{ title: string; detail: string } | null>(null);

  const pick = (event: MouseEvent<HTMLDivElement> | FocusEvent<HTMLDivElement>) => {
    const mark = (event.target as Element).closest('[data-readout-title]');
    if (!mark) return;
    setCurrent({
      title: mark.getAttribute('data-readout-title') ?? '',
      detail: mark.getAttribute('data-readout-detail') ?? '',
    });
  };

  // Focus moving from one mark to another is a blur then a focus; only focus
  // leaving the grid clears the line.
  const leaveFocus = (event: FocusEvent<HTMLDivElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget)) setCurrent(null);
  };

  return (
    <div onMouseOver={pick} onFocus={pick} onMouseLeave={() => setCurrent(null)} onBlur={leaveFocus}>
      {children}
      <div className={`z-10 mt-3 [@media(hover:none)]:hidden ${current ? 'sticky bottom-3' : ''}`}>
        <p
          aria-live="polite"
          className="flex min-h-[3.25rem] flex-col justify-center rounded-[12px] border border-rule-strong bg-surface/95 px-4 py-2 shadow-[var(--shadow-card)] backdrop-blur"
        >
          {current ? (
            <>
              <span className="text-[0.875rem] text-ink">{current.title}</span>
              <span className="num text-[0.75rem] text-ink-2">{current.detail}</span>
            </>
          ) : (
            <span className="text-[0.8125rem] text-muted">{prompt}</span>
          )}
        </p>
      </div>
    </div>
  );
}
