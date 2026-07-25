const COMMANDS = [
  'npm run arena -- run --strategies single,plan-execute --tasks airline-easy --repeats 1',
  'npm run demo:data   # synthetic numbers, clearly labelled, for reviewing the interface',
];

/**
 * `results/` is empty on a fresh clone. Saying so plainly is the honest state:
 * the site has no placeholder numbers to fall back on, by design.
 */
export function EmptyState({ note }: { note?: string }) {
  return (
    <div className="rounded-[3px] border border-rule bg-surface p-8">
      <p className="eyebrow">No data</p>
      <h1 className="mt-2 font-serif text-[26px] leading-tight text-ink">
        Nothing has been benchmarked in this checkout.
      </h1>
      <p className="prose-serif mt-3 max-w-2xl">
        {note ??
          'This site renders whatever is in results/ and ships no placeholder numbers. Run the benchmark and the leaderboard, the score-versus-cost plane, the matrix and the trace viewer all fill in from the same files.'}
      </p>

      <div className="scroll-x mt-6 rounded-[2px] border border-rule bg-sunken">
        <pre className="w-max p-4 font-mono text-[12px] leading-relaxed text-ink-2">
          {COMMANDS.join('\n')}
        </pre>
      </div>

      <p className="mt-4 text-[12px] text-muted">
        Results are written to <span className="font-mono">results/&lt;runSetId&gt;/</span> and the
        site reads whichever set{' '}
        <span className="font-mono">results/latest.json</span> points at.
      </p>
    </div>
  );
}
