import Link from 'next/link';

import { TAGLINE } from '../lib/site';

export default function HomePage() {
  return (
    <section className="py-16">
      <h1 className="font-serif text-[44px] leading-tight text-ink">{TAGLINE}</h1>
      <p className="mt-6">
        <Link href="/results/" className="link">
          See the results →
        </Link>
      </p>
    </section>
  );
}
