import { ImageResponse } from 'next/og';

import { CARD_SIZE, SocialCard, cardFonts } from '../../components/og/SocialCard';
import { socialCardText } from '../../lib/socialCard';

/**
 * The social card, as `/og.png`. A route handler rather than the
 * `opengraph-image` file convention because a static export writes that
 * convention to a file with no extension, which GitHub Pages serves as
 * `application/octet-stream`; link unfurlers want `image/png`.
 */
export const dynamic = 'force-static';

export async function GET() {
  const text = await socialCardText();
  return new ImageResponse(<SocialCard {...text} />, { ...CARD_SIZE, fonts: await cardFonts() });
}
