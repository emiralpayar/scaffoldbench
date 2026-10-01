import { clamp01 } from '../lib/format';

/** A plain 0..1 magnitude bar for places where no interval exists. */
export function MiniBar({ value, tone = 'accent' }: { value: number; tone?: 'accent' | 'muted' }) {
  return (
    <div className="relative h-[6px] w-16 shrink-0 rounded-full bg-sunken">
      <div
        className={`absolute inset-y-0 left-0 rounded-full ${tone === 'accent' ? 'bg-ink-2' : 'bg-muted/55'}`}
        style={{ width: `${clamp01(value) * 100}%` }}
      />
    </div>
  );
}
