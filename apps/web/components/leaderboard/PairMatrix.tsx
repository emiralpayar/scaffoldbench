import type { ModelAnalysis } from '../../lib/analysis';
import { architectureName } from '../../lib/architectures';
import { formatDelta } from '../../lib/format';
import { ArchitectureGlyph } from '../ArchitectureGlyph';
import { ScrollRegion } from '../ScrollRegion';

/**
 * The evidence behind the ranks: every pair of architectures on this model,
 * the paired score difference (row minus column) and whether its widened
 * interval excludes zero. A rank is one plus the number of ▼ in its row.
 */
export function PairMatrix({ model, order }: { model: ModelAnalysis; order: string[] }) {
  const lookup = (row: string, column: string) => {
    const direct = model.pairwise.find((pair) => pair.a === row && pair.b === column);
    if (direct) return { delta: direct.scoreDelta, winner: direct.winner === 'a' ? 'row' : direct.winner === 'b' ? 'column' : 'tie' };
    const flipped = model.pairwise.find((pair) => pair.a === column && pair.b === row);
    if (!flipped) return null;
    return {
      delta: { mean: -flipped.scoreDelta.mean, low: -flipped.scoreDelta.high, high: -flipped.scoreDelta.low },
      winner: flipped.winner === 'b' ? 'row' : flipped.winner === 'a' ? 'column' : 'tie',
    };
  };

  return (
    <ScrollRegion label="Paired score differences between every two architectures" className="rounded-[14px] border border-rule bg-surface">
      <table className="w-full border-collapse text-[0.8125rem]">
        <caption className="sr-only">
          Paired score difference, row architecture minus column architecture, and whether the row scores reliably
          above, below, or is not separable from the column.
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
                const words =
                  cell.winner === 'row'
                    ? 'reliably above'
                    : cell.winner === 'column'
                      ? 'reliably below'
                      : 'not separable';
                return (
                  <td
                    key={column}
                    className={`px-2 py-2 text-center ${
                      cell.winner === 'row' ? 'text-good' : cell.winner === 'column' ? 'text-bad' : 'text-muted'
                    }`}
                    title={`${architectureName(row)} minus ${architectureName(column)}: ${formatDelta(cell.delta.mean)} [${formatDelta(cell.delta.low)}, ${formatDelta(cell.delta.high)}], ${words}`}
                  >
                    <span className="num whitespace-nowrap">
                      <span aria-hidden>{cell.winner === 'row' ? '▲ ' : cell.winner === 'column' ? '▼ ' : ''}</span>
                      {formatDelta(cell.delta.mean, 2)}
                    </span>
                    <span className="sr-only"> {words}</span>
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
