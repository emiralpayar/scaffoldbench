/**
 * Literal colour values for renderers that cannot read CSS variables: the
 * social card (Satori) and the favicon. They are the dark theme's tokens,
 * copied — `test/tokens.test.ts` fails if they drift from `globals.css`.
 */
export const DARK = {
  plane: '#0b0c0e',
  surface: '#131417',
  ink: '#f1efe9',
  'ink-2': '#c5c2b9',
  muted: '#98958b',
  rule: '#25262a',
  good: '#4cc06a',
  bad: '#f2756a',
  'arch-single': '#bcbab5',
  'arch-plan-execute': '#5994e0',
  'arch-orchestrator-workers': '#c05101',
  'arch-plan-execute-verify': '#18895b',
  'arch-propose-select': '#7852bb',
  'arch-gated-execute': '#c176a4',
} as const;
