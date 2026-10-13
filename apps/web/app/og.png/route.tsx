import { ImageResponse } from 'next/og';

import { ResultCard } from '../../components/og/ResultCard';
import { CARD_SIZE, SocialCard, cardFonts } from '../../components/og/SocialCard';
import { resultCardData, socialCardText } from '../../lib/socialCard';

/**
 * The social card, as `/og.png`. A route handler rather than the
 * `opengraph-image` file convention because a static export writes that
 * convention to a file with no extension, which GitHub Pages serves as
 * `application/octet-stream`; link unfurlers want `image/png`.
 */
export const dynamic = 'force-static';

export async function GET() {
  // The result once a verified run set is published; until then, the question.
  const result = await resultCardData();
  const card = result ? <ResultCard {...result} /> : <SocialCard {...await socialCardText()} />;
  return new ImageResponse(card, { ...CARD_SIZE, fonts: await cardFonts() });
}
