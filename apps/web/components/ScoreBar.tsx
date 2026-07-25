/**
 * Mean score as a bar, with the bootstrap interval drawn on top of it.
 *
 * The interval is the point of the chart: a bar alone invites the reader to
 * rank two strategies that a handful of repeats cannot separate.
 *
 * Deliberately free of imports from lib/data — this renders inside the
 * interactive leaderboard, which is a client component.
 */

function clamp(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

export function ScoreBar({
  mean,
  ciLow,
  ciHigh,
  width = 'w-32',
}: {
  mean: number;
  ciLow: number;
  ciHigh: number;
  width?: string;
}) {
  const m = clamp(mean);
  const lo = clamp(Math.min(ciLow, ciHigh));
  const hi = clamp(Math.max(ciLow, ciHigh));
  const label = `mean ${m.toFixed(3)}, 95% CI ${lo.toFixed(3)} to ${hi.toFixed(3)}`;

  return (
    <div
      role="img"
      aria-label={label}
      title={label}
      className={`relative h-[18px] shrink-0 rounded-[2px] bg-sunken ${width}`}
    >
      <div
        className="absolute inset-y-[3px] left-0 rounded-r-[4px] bg-accent/25"
        style={{ width: `${m * 100}%` }}
      />
      <span
        className="absolute top-1/2 h-[2px] -translate-y-1/2 bg-accent/70"
        style={{ left: `${lo * 100}%`, width: `${(hi - lo) * 100}%` }}
      />
      {[lo, hi].map((edge, index) => (
        <span
          key={index}
          className="absolute top-1/2 h-[9px] w-[2px] -translate-y-1/2 bg-accent/70"
          style={{ left: `calc(${edge * 100}% - 1px)` }}
        />
      ))}
      <span
        className="absolute inset-y-0 w-[2px] bg-accent"
        style={{ left: `calc(${m * 100}% - 1px)` }}
      />
    </div>
  );
}

/** A plain 0..1 magnitude bar for places where no interval exists. */
export function MiniBar({ value, tone = 'accent' }: { value: number; tone?: 'accent' | 'muted' }) {
  return (
    <div className="relative h-[6px] w-16 shrink-0 rounded-[2px] bg-sunken">
      <div
        className={`absolute inset-y-0 left-0 rounded-[2px] ${
          tone === 'accent' ? 'bg-accent/55' : 'bg-muted/55'
        }`}
        style={{ width: `${clamp(value) * 100}%` }}
      />
    </div>
  );
}
