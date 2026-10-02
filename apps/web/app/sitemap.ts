import type { MetadataRoute } from 'next';

import { EMPTY_PARAM, loadRunSet } from '../lib/server/runSet';
import { absoluteUrl } from '../lib/site';

export const dynamic = 'force-static';

/** Every page a reader should find; run pages are reachable from them and left out. */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const data = await loadRunSet();
  const pages = ['/', '/results/', '/matrix/', '/pareto/', '/live/'];
  const models = data?.models ?? [];
  // Per-model pages exist only for the models in the run set, as generateStaticParams exports them.
  const perModel = [
    ...models.map((model) => `/results/${model}/`),
    ...(models.length > 0 ? ['/results/scale/'] : []),
    ...models.map((model) => `/matrix/${model}/`),
  ];
  const tasks = (data?.catalog.tasks ?? [])
    .map((task) => task.id)
    .filter((id) => id !== EMPTY_PARAM)
    .map((id) => `/tasks/${id}/`);
  return [...pages, ...perModel, ...tasks].map((pathname) => ({ url: absoluteUrl(pathname) }));
}
