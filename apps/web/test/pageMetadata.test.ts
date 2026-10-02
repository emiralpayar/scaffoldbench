import { describe, expect, it } from 'vitest';

import { SOCIAL_CARD, pageMetadata } from '../lib/pageMetadata';
import { SITE_URL } from '../lib/site';

describe('pageMetadata', () => {
  const meta = pageMetadata({
    title: 'Post-mortem: the run set that tied',
    description: 'What the traces showed.',
    path: '/postmortem/',
  });

  it('gives the page its own address, in the canonical link and the unfurl alike', () => {
    const url = `${SITE_URL}/postmortem/`;
    expect(meta.alternates?.canonical).toBe(url);
    expect(meta.openGraph?.url).toBe(url);
  });

  it('puts the page, not the home page, in the Open Graph and Twitter titles', () => {
    expect(meta.title).toBe('Post-mortem: the run set that tied');
    expect(meta.openGraph?.title).toBe('Post-mortem: the run set that tied · ScaffoldBench');
    expect(meta.openGraph?.description).toBe('What the traces showed.');
    expect(meta.twitter?.title).toBe(meta.openGraph?.title);
  });

  it('keeps the social card, which Next would otherwise drop with the layout’s block', () => {
    expect(meta.openGraph?.images).toEqual([SOCIAL_CARD]);
    expect(meta.twitter?.images).toEqual([SOCIAL_CARD]);
    expect(SOCIAL_CARD.url).toBe(`${SITE_URL}/og.png`);
  });

  it('can name a card of the page’s own', () => {
    const own = pageMetadata({
      title: 'Post-mortem',
      description: 'd',
      path: '/postmortem/',
      image: { path: '/postmortem/og.png', alt: 'The scores, struck through.' },
    });
    expect(own.openGraph?.images).toEqual([
      { url: `${SITE_URL}/postmortem/og.png`, width: 1200, height: 630, alt: 'The scores, struck through.' },
    ]);
    expect(own.twitter?.images).toEqual(own.openGraph?.images);
  });
});
