import type { Estimate, PairedVerdict } from '../../lib/analysis';
import { verdictFor } from '../../lib/analysis';
import { formatDelta } from '../../lib/format';

const VERDICT: Record<PairedVerdict, { label: string; means: string; tone: string }> = {
  better: {
    label: 'better',
    means: 'The whole interval is above zero: it scores reliably higher than the control.',
    tone: 'var(--good)',
  },
  worse: {
    label: 'worse',
    means: 'The whole interval is below zero: it scores reliably lower.',
    tone: 'var(--bad)',
  },
  equivalent: {
    label: 'equivalent',
    means: 'The whole interval sits inside the margin: any difference is too small to matter.',
    tone: 'var(--focus)',
  },
  inconclusive: {
    label: 'not separable',
    means: 'The interval spans zero and is wider than the margin: the data cannot say.',
    tone: 'var(--muted)',
  },
};

/** One example interval per verdict, in units of the margin so the picture holds for any margin. */
const SAMPLES: { id: PairedVerdict; low: number; mean: number; high: number }[] = [
  { id: 'better', low: 1.4, mean: 2.4, high: 3.4 },
  { id: 'equivalent', low: -0.6, mean: 0.1, high: 0.8 },
  { id: 'inconclusive', low: -1.5, mean: 0.7, high: 2.8 },
  { id: 'worse', low: -3.4, mean: -2.3, high: -1.3 },
];

const SPAN = 4; // axis runs from -SPAN to +SPAN margins
const W = 480;
const ROW = 46;

/**
 * The four verdicts, drawn. Each example interval is a paired score
 * difference from the control; the shaded band is the equivalence margin.
 * The label on every row is not typed here: it is what `verdictFor`, the
 * rule the leaderboard uses, returns for that interval.
 */
export function VerdictDiagram({ margin }: { margin: number }) {
  const x = (units: number) => ((units + SPAN) / (2 * SPAN)) * W;
  const height = SAMPLES.length * ROW + 34;

  return (
    <figure className="card px-4 py-5 sm:px-6">
      <div>
        <svg viewBox={`-6 0 ${W + 12} ${height}`} role="img" aria-label="Four example intervals around zero, one for each verdict" className="block w-full">
          <rect x={x(-1)} y={0} width={x(1) - x(-1)} height={SAMPLES.length * ROW} fill="var(--band)" />
          <line x1={x(0)} x2={x(0)} y1={0} y2={SAMPLES.length * ROW} stroke="var(--axis)" strokeWidth={1.25} />
          {[-1, 1].map((m) => (
            <line key={m} x1={x(m)} x2={x(m)} y1={0} y2={SAMPLES.length * ROW} stroke="var(--axis)" strokeWidth={1} strokeDasharray="3 3" />
          ))}
          {SAMPLES.map((sample, index) => {
            const estimate: Estimate = { mean: sample.mean * margin, low: sample.low * margin, high: sample.high * margin };
            const verdict = verdictFor(estimate, margin);
            const tone = VERDICT[verdict].tone;
            const y = index * ROW + ROW / 2;
            return (
              <g key={sample.id}>
                <line x1={x(sample.low)} x2={x(sample.high)} y1={y} y2={y} stroke={tone} strokeWidth={2.5} strokeLinecap="round" />
                <line x1={x(sample.low)} x2={x(sample.low)} y1={y - 6} y2={y + 6} stroke={tone} strokeWidth={2} strokeLinecap="round" />
                <line x1={x(sample.high)} x2={x(sample.high)} y1={y - 6} y2={y + 6} stroke={tone} strokeWidth={2} strokeLinecap="round" />
                <circle cx={x(sample.mean)} cy={y} r={5} fill={tone} stroke="var(--surface)" strokeWidth={2} />
                <text x={x(-SPAN) + 2} y={y - 12} fontSize={11} fill="var(--ink-2)" fontFamily="var(--font-geist-mono), monospace">
                  {VERDICT[verdict].label}
                </text>
              </g>
            );
          })}
          {[-1, 0, 1].map((m) => (
            <text key={m} x={x(m)} y={SAMPLES.length * ROW + 16} textAnchor="middle" fontSize={11} fill="var(--muted)" fontFamily="var(--font-geist-mono), monospace">
              {m === 0 ? '0' : formatDelta(m * margin, 2)}
            </text>
          ))}
          <text x={x(0)} y={SAMPLES.length * ROW + 31} textAnchor="middle" fontSize={11} fill="var(--muted)">
            score difference from the control
          </text>
        </svg>
        <dl className="mt-6 grid gap-x-8 gap-y-4 border-t border-rule pt-5 text-[0.8125rem] leading-snug sm:grid-cols-2">
          {SAMPLES.map((sample) => {
            const verdict = verdictFor(
              { mean: sample.mean * margin, low: sample.low * margin, high: sample.high * margin },
              margin,
            );
            return (
              <div key={sample.id}>
                <dt className="font-mono text-[0.75rem] uppercase tracking-[0.08em] text-ink">{VERDICT[verdict].label}</dt>
                <dd className="text-ink-2">{VERDICT[verdict].means}</dd>
              </div>
            );
          })}
        </dl>
      </div>
      <figcaption className="mt-4 text-[0.8125rem] leading-relaxed text-muted">
        The shaded band is the equivalence margin, ±{margin.toFixed(2)} of score, fixed before the data is seen. Dot:
        the mean difference. Whisker: its interval.
      </figcaption>
    </figure>
  );
}
