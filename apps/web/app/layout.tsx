import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';

import { SiteFooter, SiteHeader } from '../components/SiteChrome';
import { SOCIAL_CARD } from '../lib/pageMetadata';
import { SITE_DESCRIPTION, SITE_NAME, SITE_URL, TAGLINE, absoluteUrl, withBasePath } from '../lib/site';
import { THEME_BOOTSTRAP } from '../lib/theme';
import { mono, sans, serif } from './fonts';
import './globals.css';

export const metadata: Metadata = {
  // The origin only: Next adds the base path to file-convention URLs itself,
  // so a base path here would appear twice. Absolute URLs below carry it.
  metadataBase: new URL(new URL(SITE_URL).origin),
  title: {
    default: `${SITE_NAME} — ${TAGLINE}`,
    template: `%s · ${SITE_NAME}`,
  },
  description: SITE_DESCRIPTION,
  applicationName: SITE_NAME,
  openGraph: {
    type: 'website',
    siteName: SITE_NAME,
    title: `${SITE_NAME} — ${TAGLINE}`,
    description: SITE_DESCRIPTION,
    url: absoluteUrl('/'),
    locale: 'en_US',
    images: [SOCIAL_CARD],
  },
  twitter: {
    card: 'summary_large_image',
    title: `${SITE_NAME} — ${TAGLINE}`,
    description: SITE_DESCRIPTION,
    images: [SOCIAL_CARD],
  },
  // Declaring any icon in config replaces the file-convention links, so the
  // SVG favicon (app/icon.svg) is listed here too.
  icons: {
    icon: [{ url: withBasePath('/icon.svg'), type: 'image/svg+xml' }],
    apple: [{ url: withBasePath('/apple-touch-icon.png'), sizes: '180x180', type: 'image/png' }],
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f6f5f1' },
    { media: '(prefers-color-scheme: dark)', color: '#0b0c0e' },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="en"
      className={`${serif.variable} ${sans.variable} ${mono.variable}`}
      // The theme bootstrap sets data-theme before hydration, on purpose.
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
      </head>
      <body className="flex min-h-dvh flex-col">
        <a href="#main" className="skip-link">
          Skip to content
        </a>
        <SiteHeader />
        <main id="main" className="flex-1">
          {children}
        </main>
        <SiteFooter />
      </body>
    </html>
  );
}
