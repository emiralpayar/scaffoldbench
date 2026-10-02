import type { TrapTable } from '../../lib/traps';
import { architectureName } from '../../lib/architectures';
import { FailureGrid } from './FailureGrid';

/**
 * How often each architecture fell into each of a task's declared traps; see
 * `FailureGrid` for how the cells are drawn.
 */
export function TrapHeatmap({
  table,
  title,
  href,
  architectures = table.architectures,
}: {
  table: TrapTable;
  title: string;
  href: string;
  architectures?: readonly string[];
}) {
  return (
    <FailureGrid
      title={title}
      href={href}
      summary={`${table.rows.length} trap${table.rows.length === 1 ? '' : 's'} · runs that fell in, of runs ranked`}
      rowHeading="Trap"
      ariaLabel={`Traps in ${title}, by architecture: runs that fell in, of runs ranked`}
      architectures={architectures}
      rows={table.rows.map((row) => ({
        id: row.trap.id,
        title: row.trap.id,
        mono: true,
        detail: row.trap.description,
        cells: Object.fromEntries(
          Object.entries(row.cells).map(([id, cell]) => [id, { count: cell.fired, runs: cell.runs }]),
        ),
      }))}
      describe={(id, row, cell) => `${architectureName(id)} fell into ${row.id} in ${cell.count} of ${cell.runs} runs`}
    />
  );
}
