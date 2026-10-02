import type { GlyphGeometry, GlyphNodeKind } from '../../lib/glyphs';
import { GlyphBody } from '../ArchitectureGlyph';

const NO_DEAD: ReadonlySet<string> = new Set();

const KINDS: { kind: GlyphNodeKind; name: string; means: string }[] = [
  { kind: 'agent', name: 'Agent', means: 'A model call that acts, with tools.' },
  { kind: 'worker', name: 'Worker', means: 'A smaller call in a parallel pool, or a state change.' },
  { kind: 'plan', name: 'Reasoner', means: 'A call with no tools: it can only think and reply.' },
  { kind: 'decide', name: 'Decision', means: 'A verifier or selector: it chooses and may send work back.' },
  { kind: 'gate', name: 'Gate', means: 'Every action passes through it before it runs.' },
  { kind: 'reviewer', name: 'Reviewer', means: 'A read-only call standing beside a gate.' },
];

function single(kind: GlyphNodeKind): GlyphGeometry {
  return { nodes: [{ id: kind, kind, x: 20, y: 12, role: kind }], edges: [] };
}

/**
 * The shapes every glyph on the site is built from. Drawn in ink rather than
 * an architecture's colour, because a shape means the same in all of them.
 */
export function GlyphLegend() {
  return (
    <dl className="grid gap-px overflow-hidden rounded-[14px] border border-rule bg-rule sm:grid-cols-2 lg:grid-cols-3">
      {KINDS.map(({ kind, name, means }) => (
        <div key={kind} className="flex items-center gap-4 bg-surface px-4 py-3.5">
          <dt className="shrink-0">
            <svg viewBox="8 2 24 20" width={56} height={46} aria-hidden>
              <GlyphBody geometry={single(kind)} color="var(--ink)" dead={NO_DEAD} />
            </svg>
            <span className="sr-only">{name}</span>
          </dt>
          <dd className="min-w-0">
            <span className="block text-[0.9375rem] text-ink">{name}</span>
            <span className="block text-[0.8125rem] leading-snug text-ink-2">{means}</span>
          </dd>
        </div>
      ))}
    </dl>
  );
}
