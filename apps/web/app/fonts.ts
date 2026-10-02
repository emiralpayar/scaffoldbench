import localFont from 'next/font/local';

/**
 * Self-hosted type, so the brand looks the same on every OS and the static
 * export makes no third-party font request. All three faces are SIL OFL 1.1;
 * the licences sit next to the files.
 *
 * - Newsreader (Production Type): the display and reading serif. Its optical
 *   size axis is applied automatically, so the 88px headline uses the
 *   high-contrast display cut and body copy the sturdier text cut.
 * - Geist and Geist Mono (Vercel): interface text, and every figure, so
 *   columns of numbers align.
 */

export const serif = localFont({
  src: [
    { path: './fonts/Newsreader-Variable.woff2', style: 'normal', weight: '200 800' },
    { path: './fonts/Newsreader-Italic-Variable.woff2', style: 'italic', weight: '200 800' },
  ],
  variable: '--font-newsreader',
  display: 'swap',
  fallback: ['Georgia', 'Cambria', 'Times New Roman', 'serif'],
});

export const sans = localFont({
  src: './fonts/Geist-Variable.woff2',
  weight: '100 900',
  variable: '--font-geist',
  display: 'swap',
  fallback: ['system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'Helvetica Neue', 'Arial', 'sans-serif'],
});

export const mono = localFont({
  src: './fonts/GeistMono-Variable.woff2',
  weight: '100 900',
  variable: '--font-geist-mono',
  display: 'swap',
  fallback: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
});
