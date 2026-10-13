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
  alt: `${SITE_NAME}: ${TAGLINE} The headline result and every architecture's score, model by model.`,
};

export interface PageMetadataInput {
  /** Without the site name: the layout's title template adds it. */
  title: string;
  description: string;
  /** The page's route, with the trailing slash the export uses: `/postmortem/`. */
  path: string;
  /** A card of the page's own, as a route under it (`/postmortem/og.png`), in place of the shared one. */
  image?: { path: string; alt: string };
}

export function pageMetadata({ title, description, path, image }: PageMetadataInput): Metadata {
  const url = absoluteUrl(path);
  const card = image ? { url: absoluteUrl(image.path), width: SOCIAL_CARD.width, height: SOCIAL_CARD.height, alt: image.alt } : SOCIAL_CARD;
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
      images: [card],
    },
    twitter: {
      card: 'summary_large_image',
      title: full,
      description,
      images: [card],
    },
  };
}
