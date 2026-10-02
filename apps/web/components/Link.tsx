import NextLink from 'next/link';
import type { ComponentProps } from 'react';

/**
 * `next/link` with prefetching off.
 *
 * In a production build Next fetches the page behind every link that scrolls
 * into view. On a site of 900 static pages that is the wrong default: the
 * matrix alone links to 270 runs and three other matrices, and a visit to it
 * downloaded some 8 MB of pages nobody opened (about 1 MB compressed). A click
 * costs one small request on a static host instead.
 */
export default function Link(props: ComponentProps<typeof NextLink>) {
  return <NextLink prefetch={false} {...props} />;
}
