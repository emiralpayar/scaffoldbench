import Link from 'next/link';

import type { RunSetHealth } from '../../lib/analysis';
import { formatInt } from '../../lib/format';

/**
 * What the numbers below are computed over, said first: how many runs there
 * were, how many were ranked, and why the rest were not.
 */
export function HealthStrip({
  health,
  verified,
  retried,
}: {
  health: RunSetHealth;
  verified: boolean;
  /** Runs that needed more than one attempt (API errors, retried). */
  retried: number;
}) {
  const items: { label: string; value: string; tone?: 'bad' | 'warn'; hint: string }[] = [
    { label: 'Runs', value: formatInt(health.total), hint: 'recorded on this model' },
    verified
      ? { label: 'Ranked', value: formatInt(health.rankable), hint: 'design verified, no API loss' }
      : { label: 'Unverified', value: formatInt(health.withoutIntegrity), hint: 'recorded before the fidelity gate', tone: 'warn' },
    {
      label: 'Excluded: fidelity',
      value: formatInt(health.integrityFailed),
      hint: 'the design did not run as designed',
      ...(health.integrityFailed > 0 ? { tone: 'bad' as const } : {}),
    },
    {
      label: 'Excluded: API',
      value: formatInt(health.apiErrors),
      hint: 'lost to the API after retries',
      ...(health.apiErrors > 0 ? { tone: 'warn' as const } : {}),
    },
    { label: 'Retried', value: formatInt(retried), hint: 'needed a second attempt' },
  ];

  return (
    <section aria-label="What these numbers are computed over" className="mb-10">
      <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-[14px] border border-rule bg-rule sm:grid-cols-6 lg:grid-cols-5">
        {items.map((item, index) => (
          // Five cells: 2 + 2 + 1 on a phone, 3 + 2 on a tablet, one row on a desktop.
          <div
            key={item.label}
            className={`bg-surface px-4 py-3.5 lg:col-span-1 ${index < 3 ? 'sm:col-span-2' : 'sm:col-span-3'} ${
              index === items.length - 1 ? 'col-span-2' : ''
            }`}
          >
            <dt className="eyebrow !text-[0.6875rem]">{item.label}</dt>
            <dd
              className={`num mt-1 text-[1.375rem] leading-none ${
                item.tone === 'bad' ? 'text-bad' : item.tone === 'warn' ? 'text-warn' : 'text-ink'
              }`}
            >
              {item.value}
            </dd>
            <dd className="mt-1.5 text-[0.75rem] leading-snug text-muted">{item.hint}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-2.5 text-right text-[0.8125rem]">
        <Link href="/health/" className="link">
          Harness health, check by check →
        </Link>
      </p>
    </section>
  );
}
