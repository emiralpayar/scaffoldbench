import { ImageResponse } from 'next/og';

import { PostmortemCard } from '../../../components/og/PostmortemCard';
import { CARD_SIZE, SocialCard, cardFonts } from '../../../components/og/SocialCard';
import { postmortemCardData, socialCardText } from '../../../lib/socialCard';

/**
 * The post-mortem's social card, as `/postmortem/og.png` (a route handler for
 * the reason given in `app/og.png/route.tsx`). A checkout without the first
 * run set's records has nothing to draw, and gets the site's card instead.
 */
export const dynamic = 'force-static';

export async function GET() {
  const data = await postmortemCardData();
  const fonts = await cardFonts();
  const card = data ? <PostmortemCard {...data} /> : <SocialCard {...(await socialCardText())} />;
  return new ImageResponse(card, { ...CARD_SIZE, fonts });
}
