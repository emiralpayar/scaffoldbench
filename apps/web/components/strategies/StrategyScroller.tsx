'use client';

import type { CSSProperties } from 'react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { architectureColor, architectureName } from '../../lib/architectures';
import type { ToolExposure } from '../../lib/designs';
import { TOOL_EXPOSURE } from '../../lib/designs';
import { GLYPH_HEIGHT, GLYPH_WIDTH, glyphFor } from '../../lib/glyphs';
import { GlyphBody } from '../ArchitectureGlyph';

export interface ScrollerStep {
  id: string;
  title: string;
  nodes: readonly string[];
  tools: ToolExposure;
  parallel: boolean;
  body: string;
}

type Entrance = 'static' | 'waiting' | 'running';

/**
 * An architecture drawn large, in the same glyph language as everywhere else
 * on the site, beside the steps of its design. As the steps scroll past, the
 * diagram lights the one in view: the nodes that step is, and the edges that
 * lead into it. Before the reader gets there it draws itself in once.
 *
 * Everything degrades to the static picture: with no script, or when the
 * reader prefers reduced motion, the whole diagram is simply drawn with every
 * step lit and the list reads on its own.
 */
export function StrategyScroller({ id, steps }: { id: string; steps: readonly ScrollerStep[] }) {
  const geometry = glyphFor(id);
  const color = architectureColor(id);
  const name = architectureName(id);
  const [activeStep, setActiveStep] = useState<number | null>(null);
  const [entrance, setEntrance] = useState<Entrance>('static');
  const figureRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLOListElement>(null);

  const labels = useMemo(() => {
    const map = new Map<string, string>();
    steps.forEach((step, index) => step.nodes.forEach((node) => map.set(node, String(index + 1))));
    return map;
  }, [steps]);
  const active = useMemo(
    () => (activeStep === null ? null : new Set(steps[activeStep]?.nodes ?? [])),
    [activeStep, steps],
  );

  // Hide the diagram before it first paints only if it is going to be drawn
  // in; one that starts on screen, or a reader who prefers less motion, gets
  // the finished picture straight away.
  useLayoutEffect(() => {
    const figure = figureRef.current;
    if (!figure || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    if (figure.getBoundingClientRect().top < window.innerHeight * 0.8) return;
    setEntrance('waiting');
    const watcher = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setEntrance('running');
          watcher.disconnect();
        }
      },
      { threshold: 0.35 },
    );
    watcher.observe(figure);
    return () => watcher.disconnect();
  }, []);

  useEffect(() => {
    const list = listRef.current;
    if (!list || steps.length < 2) return;
    const items = [...list.querySelectorAll<HTMLElement>('[data-step]')];
    const watcher = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) setActiveStep(Number((entry.target as HTMLElement).dataset.step));
        }
      },
      // A band across the middle of the screen: the step crossing it is "current".
      { rootMargin: '-38% 0px -50% 0px' },
    );
    items.forEach((item) => watcher.observe(item));
    return () => watcher.disconnect();
  }, [steps.length]);

  if (!geometry) return null;

  return (
    <div className="grid gap-x-12 gap-y-6 lg:grid-cols-[minmax(0,27rem)_minmax(0,1fr)]">
      <div className="sticky top-2 z-10 -mx-4 self-start bg-plane/90 px-4 py-2 backdrop-blur sm:top-16 sm:mx-0 sm:px-0 lg:top-24 lg:bg-transparent lg:py-0 lg:backdrop-blur-none">
        <div ref={figureRef} className="card mx-auto max-w-[17rem] p-4 sm:max-w-[27rem] sm:p-6">
          <svg
            viewBox={`-2 -3 ${GLYPH_WIDTH + 4} ${GLYPH_HEIGHT + 6}`}
            role="img"
            aria-label={`${name}, drawn as ${steps.length} step${steps.length === 1 ? '' : 's'}: ${steps.map((step) => step.title.toLowerCase()).join(', then ')}.`}
            className={`block w-full ${entrance === 'static' ? '' : 'glyph-animated'} ${entrance === 'waiting' ? 'glyph-waiting' : ''}`}
            style={{ '--glyph-delay': '80ms', overflow: 'visible' } as CSSProperties}
          >
            <GlyphBody geometry={geometry} color={color} dead={NONE} active={active} labels={labels} strokeScale={0.6} />
          </svg>
          <p aria-hidden className="mt-3 text-center font-mono text-[0.6875rem] uppercase tracking-[0.12em] text-muted">
            {activeStep === null ? `${steps.length} step${steps.length === 1 ? '' : 's'}` : `step ${activeStep + 1} of ${steps.length}`}
          </p>
        </div>
      </div>

      <ol ref={listRef} className="min-w-0">
        {steps.map((step, index) => (
          <li
            key={step.id}
            data-step={index}
            className={`relative border-t border-rule py-8 first:border-t-0 first:pt-0 lg:min-h-[17rem] ${
              activeStep === null || activeStep === index ? '' : 'lg:opacity-55'
            } transition-opacity duration-300`}
          >
            <p className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <span
                className="num inline-flex h-7 w-7 items-center justify-center rounded-full border text-[0.8125rem] text-ink"
                style={{ borderColor: color }}
              >
                {index + 1}
              </span>
              <span className="h3 text-ink">{step.title}</span>
            </p>
            <p className="mt-3 flex flex-wrap gap-2">
              <span className="chip" title={TOOL_EXPOSURE[step.tools].detail}>
                {TOOL_EXPOSURE[step.tools].label}
              </span>
              {step.parallel ? <span className="chip">runs in parallel</span> : null}
            </p>
            <p className="prose-serif mt-4 max-w-[34rem]">{step.body}</p>
          </li>
        ))}
      </ol>
    </div>
  );
}

const NONE: ReadonlySet<string> = new Set();
