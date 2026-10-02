import type { Metadata } from 'next';
import Link from 'next/link';

import { ArchitectureGlyph } from '../../../components/ArchitectureGlyph';
import { PageHeader } from '../../../components/Layout';
import { GlyphLegend } from '../../../components/strategies/GlyphLegend';
import { ARCHITECTURES } from '../../../lib/architectures';
import { DESIGNS, TOOL_EXPOSURE } from '../../../lib/designs';
import { pageMetadata } from '../../../lib/pageMetadata';

export const metadata: Metadata = pageMetadata({
  title: 'The six designs',
  description:
    'The six agent harness architectures ScaffoldBench compares: what each one is made of, which calls it makes, and the question it exists to answer.',
  path: '/strategies/',
});

export default function StrategiesPage() {
  return (
    <>
      <PageHeader
        eyebrow="The architectures"
        title="Six ways to put structure around a model."
        lede="Each is the same Claude model with the same tools and the same task. Only the harness around the model changes: how many calls it makes, what each call is shown, and who gets to say no."
      />

      <ul className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
        {ARCHITECTURES.map((info) => {
          const design = DESIGNS[info.id];
          return (
            <li key={info.id}>
              <Link
                href={`/strategies/${info.id}/`}
                className="card group flex h-full flex-col p-6 transition-colors hover:border-rule-strong"
              >
                <ArchitectureGlyph id={info.id} width={104} />
                <h2 className="h3 mt-5 text-ink group-hover:underline">{info.name}</h2>
                <p className="prose-serif mt-2 !text-[1rem]">{design.question}</p>
                <p className="mt-3 text-[0.875rem] leading-snug text-ink-2">{info.summary}</p>
                <p className="mt-auto flex flex-wrap gap-2 pt-5">
                  <span className="chip">
                    {design.stages.length} stage{design.stages.length === 1 ? '' : 's'}
                  </span>
                  {design.stages.some((stage) => stage.parallel) ? <span className="chip">parallel</span> : null}
                  {[...new Set(design.stages.map((stage) => stage.tools))].map((tools) => (
                    <span key={tools} className="chip">
                      {TOOL_EXPOSURE[tools].label}
                    </span>
                  ))}
                </p>
              </Link>
            </li>
          );
        })}
      </ul>

      <section aria-labelledby="legend-title" className="mt-20">
        <div className="max-w-3xl">
          <h2 id="legend-title" className="h2 text-ink">
            How to read a glyph
          </h2>
          <p className="prose-serif mt-4">
            Every architecture is drawn the same way on every page of this site: each call is a shape, and a line
            runs from the call that hands work on to the call that receives it. A shape means one thing in all six.
          </p>
        </div>
        <div className="mt-8">
          <GlyphLegend />
        </div>
      </section>
    </>
  );
}
