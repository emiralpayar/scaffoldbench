/**
 * The Claude models ScaffoldBench knows how to label, in capability order.
 *
 * Prices are Anthropic first-party list prices in USD per million tokens, as
 * published for these models in October 2026. They label the live demo's
 * model picker and nothing else: every cost on the site is the cost the SDK
 * reported for a run, never a recomputation from these numbers.
 */

export interface ModelInfo {
  id: string;
  /** Full product name. */
  label: string;
  /** Compact name for chart labels and table cells. */
  short: string;
  /** Capability order: a higher tier is the "scale up" move. */
  tier: number;
  inputUsdPerMTok: number;
  outputUsdPerMTok: number;
}

export const MODELS: readonly ModelInfo[] = [
  {
    id: 'claude-haiku-4-5-20251001',
    label: 'Claude Haiku 4.5',
    short: 'Haiku 4.5',
    tier: 1,
    inputUsdPerMTok: 1,
    outputUsdPerMTok: 5,
  },
  {
    id: 'claude-sonnet-5-5',
    label: 'Claude Sonnet 5.5',
    short: 'Sonnet 5.5',
    tier: 2,
    inputUsdPerMTok: 2,
    outputUsdPerMTok: 10,
  },
  {
    id: 'claude-opus-5-5',
    label: 'Claude Opus 5.5',
    short: 'Opus 5.5',
    tier: 3,
    inputUsdPerMTok: 4,
    outputUsdPerMTok: 20,
  },
  {
    id: 'claude-fable-5-1',
    label: 'Claude Fable 5.1',
    short: 'Fable 5.1',
    tier: 4,
    inputUsdPerMTok: 10,
    outputUsdPerMTok: 50,
  },
];

/**
 * Older ids that appear in committed run sets. They are labelled so a legacy
 * run set reads correctly; they are never offered for a new run.
 */
const LEGACY_MODELS: readonly ModelInfo[] = [
  {
    id: 'claude-haiku-4-5',
    label: 'Claude Haiku 4.5',
    short: 'Haiku 4.5',
    tier: 1,
    inputUsdPerMTok: 1,
    outputUsdPerMTok: 5,
  },
  {
    id: 'claude-sonnet-5',
    label: 'Claude Sonnet 5',
    short: 'Sonnet 5',
    tier: 2,
    inputUsdPerMTok: 2,
    outputUsdPerMTok: 10,
  },
  {
    id: 'claude-opus-5',
    label: 'Claude Opus 5',
    short: 'Opus 5',
    tier: 3,
    inputUsdPerMTok: 5,
    outputUsdPerMTok: 25,
  },
];

const BY_ID = new Map<string, ModelInfo>(
  [...MODELS, ...LEGACY_MODELS].map((model) => [model.id, model]),
);

export function modelInfo(id: string): ModelInfo | undefined {
  return BY_ID.get(id);
}

export function modelShortName(id: string): string {
  return BY_ID.get(id)?.short ?? id;
}

export function modelLabel(id: string): string {
  return BY_ID.get(id)?.label ?? id;
}

/** Capability order, unknown models last and alphabetical. */
export function compareModels(a: string, b: string): number {
  const ta = BY_ID.get(a)?.tier ?? Number.POSITIVE_INFINITY;
  const tb = BY_ID.get(b)?.tier ?? Number.POSITIVE_INFINITY;
  if (ta !== tb) return ta - tb;
  return a.localeCompare(b);
}

/** "$2 / $10 per MTok" — the price note on the live demo's model picker. */
export function formatModelPrice(model: ModelInfo): string {
  return `$${model.inputUsdPerMTok} / $${model.outputUsdPerMTok} per MTok`;
}
