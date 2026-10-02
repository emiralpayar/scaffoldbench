import type { Metadata } from 'next';

import { ArchitectureGlyph } from '../components/ArchitectureGlyph';
import Link from '../components/Link';

export const metadata: Metadata = {
  title: 'Page not found',
};

/** A missing page, drawn as the one architecture whose every step is dead. */
export default function NotFound() {
  return (
    <section className="container-page flex min-h-[70vh] flex-col items-start justify-center py-20">
      <ArchitectureGlyph
        id="orchestrator-workers"
        width={132}
        dead={['orchestrate', 'w1', 'w2', 'w3', 'synthesize']}
        title="An orchestrator diagram with every step struck through"
      />
      <p className="eyebrow mt-10">404 · nothing ran here</p>
      <h1 className="h1 mt-4 max-w-[36rem] text-ink">This page did not run as designed.</h1>
      <p className="lede mt-5 max-w-[34rem]">
        The address does not match any page in this build. If you followed a link to a run or a
        task, it may belong to a run set that is no longer the published one.
      </p>
      <div className="mt-9 flex flex-wrap gap-3">
        <Link href="/" className="btn btn-primary">
          Back to the start
        </Link>
        <Link href="/results/" className="btn btn-secondary">
          See the results
        </Link>
      </div>
    </section>
  );
}
