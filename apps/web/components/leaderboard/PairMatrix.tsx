import type { ContrastCaveat, Estimate, ModelAnalysis, PairedVerdict } from '../../lib/analysis';
import { architectureName } from '../../lib/architectures';
import { caveatText, formatBracket, formatDelta } from '../../lib/format';
import { ArchitectureGlyph } from '../ArchitectureGlyph';
import { ScrollRegion } from '../ScrollRegion';

/** How the row stands against the column, in words a screen reader can say. */
const WORDS: Record<PairedVerdict, string> = {
  better: 'reliably above',
  worse: 'reliably below',
  equivalent: 'equivalent within the margin',
  inconclusive: 'not separable',
};

interface Cell {
  delta: Estimate;
  /** From the row's side. */
  verdict: PairedVerdict;
  caveat?: ContrastCaveat;
}

/**
 * The evidence behind the ranks: every pair of architectures on this model,
 * the paired score difference (row minus column) and the verdict of the
 * paired test, adjusted for the pairs compared. A rank is one plus the number
 * of ▼ in its row. A * marks a pair the data withheld something from: hover
 * for what.
 */
export function PairMatrix({ model, order }: { model: ModelAnalysis; order: string[] }) {
  const lookup = (row: string, column: string): Cell | null => {
    const direct = model.pairwise.find((pair) => pair.a === row && pair.b === column);
    if (direct) return { delta: direct.scoreDelta, verdict: direct.verdict, ...(direct.caveat ? { caveat: direct.caveat } : {}) };
    const flipped = model.pairwise.find((pair) => pair.a === column && pair.b === row);
    if (!flipped) return null;
    const { scoreDelta } = flipped;
    return {
      delta: {
        mean: scoreDelta.mean === 0 ? 0 : -scoreDelta.mean,
        ci: scoreDelta.ci && { low: -scoreDelta.ci.high, high: -scoreDelta.ci.low },
      },
      verdict: flipped.verdict === 'better' ? 'worse' : flipped.verdict === 'worse' ? 'better' : flipped.verdict,
      ...(flipped.caveat ? { caveat: flipped.caveat } : {}),
    };
  };

  return (
    <ScrollRegion label="Paired score differences between every two architectures" className="rounded-[14px] border border-rule bg-surface">
      <table className="w-full border-collapse text-[0.8125rem]">
        <caption className="sr-only">
          Paired score difference, row architecture minus column architecture, and whether the row scores reliably
          above, reliably below, equivalent within the margin, or is not separable from the column.
        </caption>
        <thead>
          <tr className="border-b border-rule">
            <th scope="col" className="sticky left-0 z-[1] bg-surface px-4 py-2.5 text-left">
              <span className="eyebrow !text-[0.6875rem]">Row vs column</span>
            </th>
            {order.map((id) => (
              <th key={id} scope="col" className="px-2 py-2.5 font-normal">
                <span className="flex flex-col items-center gap-1">
                  <ArchitectureGlyph id={id} width={30} />
                  <span className="whitespace-nowrap text-[0.6875rem] text-ink-2">{architectureName(id)}</span>
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {order.map((row) => (
            <tr key={row} className="border-b border-rule last:border-0">
              <th scope="row" className="sticky left-0 z-[1] whitespace-nowrap bg-surface px-4 py-2 text-left font-normal text-ink">
                {architectureName(row)}
              </th>
              {order.map((column) => {
                if (row === column) {
                  return (
                    <td key={column} className="px-2 py-2 text-center text-muted">
                      ·
                    </td>
                  );
                }
                const cell = lookup(row, column);
                if (!cell) {
                  return (
                    <td key={column} className="px-2 py-2 text-center text-muted">
                      –
                    </td>
                  );
                }
                const words = WORDS[cell.verdict];
                const caveat = cell.caveat ? `; ${caveatText(cell.caveat)}` : '';
                return (
                  <td
                    key={column}
                    className={`px-2 py-2 text-center ${
                      cell.verdict === 'better' ? 'text-good' : cell.verdict === 'worse' ? 'text-bad' : 'text-muted'
                    }`}
                    title={`${architectureName(row)} minus ${architectureName(column)}: ${formatDelta(cell.delta.mean)} ${formatBracket(cell.delta, formatDelta)}, ${words}${caveat}`}
                  >
                    <span className="num whitespace-nowrap">
                      <span aria-hidden>
                        {cell.verdict === 'better' ? '▲ ' : cell.verdict === 'worse' ? '▼ ' : cell.verdict === 'equivalent' ? '≈ ' : ''}
                      </span>
                      {formatDelta(cell.delta.mean, 2)}
                      {cell.caveat ? <span aria-hidden>*</span> : null}
                    </span>
                    <span className="sr-only">
                      {' '}
                      {words}
                      {caveat}
                    </span>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </ScrollRegion>
  );
}
