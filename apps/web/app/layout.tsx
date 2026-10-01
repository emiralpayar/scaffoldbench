import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import { RunSetFooter } from '../components/RunSetMeta';
import { SiteNav } from '../components/SiteNav';
import './globals.css';

export const metadata: Metadata = {
  title: {
    default: 'Agent Arena — harness architectures, measured',
    template: '%s · Agent Arena',
  },
  description:
    'A benchmark of agent harness architectures — single agent, plan-execute, orchestrator with workers, plan-execute-verify, propose-select — on one task set, reported with score, cost, latency and bootstrap confidence intervals.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-dvh">
        <SiteNav />
        <main className="mx-auto w-full max-w-[80rem] px-5 pb-8 pt-8 sm:px-8">{children}</main>
        <RunSetFooter />
      </body>
    </html>
  );
}
