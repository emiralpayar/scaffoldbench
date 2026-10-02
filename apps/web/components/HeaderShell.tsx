'use client';

import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';

/**
 * The site header. On the home page it joins the hero: the hero is a dark
 * stage in both themes, and a light bar across the top of it reads as a seam.
 * The header takes the stage's palette while it sits over the stage and the
 * page's own once the stage has scrolled under it.
 *
 * It starts on the stage's palette on the home page, so the static HTML
 * paints it right; only a reader who loads the page already scrolled past the
 * hero sees it correct itself after hydration.
 */
export function HeaderShell({ children }: { children: ReactNode }) {
  const home = usePathname() === '/';
  const [overStage, setOverStage] = useState(home);
  const header = useRef<HTMLElement>(null);

  useEffect(() => {
    const element = header.current;
    const stage = document.querySelector('.stage');
    if (!home || !element || !stage || typeof IntersectionObserver === 'undefined') {
      setOverStage(false);
      return;
    }
    // Watch the stage against a one-pixel line just under the header. The
    // stage touches that line when it sits right below the header, as it does
    // at the top of the page, and while it is scrolling under it.
    let observer: IntersectionObserver | undefined;
    const watch = () => {
      observer?.disconnect();
      const line = Math.ceil(element.getBoundingClientRect().height);
      observer = new IntersectionObserver(([entry]) => setOverStage(Boolean(entry?.isIntersecting)), {
        rootMargin: `-${line}px 0px -${Math.max(0, window.innerHeight - line - 1)}px 0px`,
      });
      observer.observe(stage);
    };
    watch();
    window.addEventListener('resize', watch);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', watch);
    };
  }, [home]);

  return (
    <header
      ref={header}
      // Opaque over the stage: translucent, it would show the light page behind it at the top.
      className={`z-40 border-b border-rule sm:sticky sm:top-0 ${
        overStage ? 'theme-dark bg-plane' : 'bg-plane/85 backdrop-blur-md backdrop-saturate-150'
      }`}
    >
      {children}
    </header>
  );
}
