/**
 * Metadata for one page.
 *
 * The root layout describes the home page: its Open Graph and Twitter blocks
 * carry the home title, description and URL. Next replaces those blocks
 * wholesale when a page sets its own `title` and `description` alone, so
 * every page would still unfurl as the home page, and a link to the
 * post-mortem pasted into LinkedIn would show the landing headline and point
 * at `/`. This builds all three blocks from the one title and description, and
 * adds the canonical URL.
 */

import type { Metadata } from 'next';

import { SITE_NAME, TAGLINE, absoluteUrl } from './site';

/** The social card every page shares (`app/og.png/route.tsx`). */
export const SOCIAL_CARD = {
  url: absoluteUrl('/og.png'),
  width: 1200,
  height: 630,
  alt: `${SITE_NAME}: ${TAGLINE}`,
};

export interface PageMetadataInput {
  /** Without the site name: the layout's title template adds it. */
  title: string;
  description: string;
  /** The page's route, with the trailing slash the export uses: `/postmortem/`. */
  path: string;
}

export function pageMetadata({ title, description, path }: PageMetadataInput): Metadata {
  const url = absoluteUrl(path);
  const full = `${title} · ${SITE_NAME}`;
  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: {
      type: 'website',
      siteName: SITE_NAME,
      title: full,
      description,
      url,
      locale: 'en_US',
      images: [SOCIAL_CARD],
    },
    twitter: {
      card: 'summary_large_image',
      title: full,
      description,
      images: [SOCIAL_CARD],
    },
  };
}
