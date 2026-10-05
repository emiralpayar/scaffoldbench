import type { PairedVerdict, SiteAnalysis } from '../../lib/analysis';
import { architectureName } from '../../lib/architectures';
import { caveatShort, caveatText, formatDelta, formatMultiple, formatRange } from '../../lib/format';
import { modelShortName } from '../../lib/models';
import { ArchitectureGlyph } from '../ArchitectureGlyph';
import { ScrollRegion } from '../ScrollRegion';

const VERDICT: Record<PairedVerdict, { text: string; className: string }> = {
  better: { text: 'scaffold wins', className: 'chip-good' },
  worse: { text: 'scale wins', className: 'chip-bad' },
  equivalent: { text: 'equivalent', className: 'chip-quiet' },
  inconclusive: { text: 'not separable', className: 'chip-quiet' },
};

/**
 * Every "scaffold or scale" contrast: an architecture on one model against
 * a plain agent on the next model up, paired by task and repeat.
 */
export function ScaleTable({ analysis, verified }: { analysis: SiteAnalysis; verified: boolean }) {
  const groups = [...new Set(analysis.scale.map((s) => `${s.model}\u0000${s.nextModel}`))];
  if (groups.length === 0) {
    return <p className="text-[0.9375rem] text-muted">No architecture shares tasks and repeats with the next model up.</p>;
  }
  return (
    <div className="flex flex-col gap-8">
      {groups.map((key) => {
        const [model, next] = key.split('\u0000') as [string, string];
        const rows = analysis.scale.filter((s) => s.model === model && s.nextModel === next);
        return (
          <div key={key} className="overflow-hidden rounded-[14px] border border-rule bg-surface">
            <p className="border-b border-rule px-4 py-3 text-[0.9375rem] text-ink sm:px-5">
              Each architecture on <strong className="font-medium">{modelShortName(model)}</strong> against a single
              agent on <strong className="font-medium">{modelShortName(next)}</strong>
            </p>
            <ScrollRegion label={`Each architecture on ${modelShortName(model)} against a single agent on ${modelShortName(next)}`}>
              <table className="w-full min-w-[34rem] border-collapse text-[0.875rem]">
                <thead>
                  <tr className="border-b border-rule text-left">
                    <th scope="col" className="eyebrow px-4 py-2.5 font-normal !text-[0.6875rem] sm:px-5">
                      On {modelShortName(model)}
                    </th>
                    <th scope="col" className="eyebrow px-3 py-2.5 text-right font-normal !text-[0.6875rem]">
                      Δ score
                    </th>
                    <th scope="col" className="eyebrow px-3 py-2.5 text-right font-normal !text-[0.6875rem]">
                      Cost ×
                    </th>
                    <th scope="col" className="eyebrow px-3 py-2.5 text-right font-normal !text-[0.6875rem]">
                      Pairs
                    </th>
                    <th scope="col" className="eyebrow px-4 py-2.5 text-right font-normal !text-[0.6875rem] sm:px-5">
                      Verdict
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => {
                    const plain = row.strategyId === analysis.baselineId;
                    const verdict = !verified
                      ? { text: 'no verdict', className: 'chip-quiet' }
                      : plain && row.verdict === 'better'
                        ? { text: 'smaller model wins', className: 'chip-good' }
                        : VERDICT[row.verdict];
                    return (
                      <tr key={row.strategyId} className="border-b border-rule last:border-0">
                        <th scope="row" className="px-4 py-2.5 text-left font-normal sm:px-5">
                          <span className="flex items-center gap-2.5">
                            <ArchitectureGlyph id={row.strategyId} width={32} />
                            <span className="text-ink">{architectureName(row.strategyId)}</span>
                            {plain ? <span className="text-[0.75rem] text-muted">no scaffold: the upgrade alone</span> : null}
                          </span>
                        </th>
                        <td className="num px-3 py-2.5 text-right">
                          <span className="text-ink">{formatDelta(row.scoreDelta.mean)}</span>
                          <span className="block text-[0.6875rem] text-muted">
                            {formatRange(row.scoreDelta, formatDelta, ' to ')}
                          </span>
                        </td>
                        <td className="num px-3 py-2.5 text-right">
                          <span className="text-ink-2">{formatMultiple(row.costRatio.mean)}</span>
                          <span className="block text-[0.6875rem] text-muted">
                            {formatRange(row.costRatio, formatMultiple)}
                            {row.costVerdict === 'better' ? ' · cheaper' : row.costVerdict === 'worse' ? ' · costlier' : ''}
                          </span>
                        </td>
                        <td className="num px-3 py-2.5 text-right text-ink-2">{row.pairs}</td>
                        <td className="px-4 py-2.5 text-right sm:px-5">
                          <span className={verdict.className}>{verdict.text}</span>
                          {verified && row.caveat ? (
                            <span className="mt-1 block text-[0.6875rem] text-muted" title={caveatText(row.caveat)}>
                              {caveatShort(row.caveat)}
                            </span>
                          ) : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </ScrollRegion>
          </div>
        );
      })}
    </div>
  );
}
