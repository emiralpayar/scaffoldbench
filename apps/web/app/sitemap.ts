import type { MetadataRoute } from 'next';

import { EMPTY_PARAM, loadRunSet } from '../lib/server/runSet';
import { absoluteUrl } from '../lib/site';

export const dynamic = 'force-static';

/** Every page a reader should find; run pages are reachable from them and left out. */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const data = await loadRunSet();
  const pages = ['/', '/results/', '/matrix/', '/pareto/', '/live/'];
  const tasks = (data?.catalog.tasks ?? [])
    .map((task) => task.id)
    .filter((id) => id !== EMPTY_PARAM)
    .map((id) => `/tasks/${id}/`);
  return [...pages, ...tasks].map((pathname) => ({ url: absoluteUrl(pathname) }));
}
