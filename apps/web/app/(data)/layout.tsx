import type { ReactNode } from 'react';

import { RunSetFooter } from '../../components/RunSetMeta';

/**
 * The pages that render a run set share one frame: the page container and,
 * under it, the provenance of every number shown.
 */
export default function DataLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <div className="container-page pb-16 pt-10 sm:pt-14">{children}</div>
      <RunSetFooter />
    </>
  );
}
