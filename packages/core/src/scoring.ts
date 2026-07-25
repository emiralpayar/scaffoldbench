import type { FailureMode, Penalty, ScoreItem, TaskScore, TraceEvent } from './types';

export const PASS_THRESHOLD = 0.999;

/**
 * Combine a weighted breakdown with multiplicative penalties.
 *
 * Penalties multiply rather than subtract so a hard rule (`multiplier: 0`)
 * cannot be offset by scoring well elsewhere: an agent that issues a refund
 * without checking the policy has failed the task regardless of what else it
 * got right.
 */
export function computeScore(
  breakdown: readonly ScoreItem[],
  penalties: readonly Penalty[],
): { raw: number; score: number } {
  const totalWeight = breakdown.reduce((acc, item) => acc + item.weight, 0);
  const raw =
    totalWeight === 0
      ? 0
      : breakdown.reduce((acc, item) => acc + item.weight * clamp01(item.earned), 0) / totalWeight;
  const multiplier = penalties.reduce((acc, p) => acc * clamp01(p.multiplier), 1);
  return { raw, score: clamp01(raw * multiplier) };
}

export function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

export interface BuildScoreOptions {
  breakdown: ScoreItem[];
  penalties?: Penalty[];
  metadata?: Record<string, unknown>;
  /** Overrides the inferred failure mode (e.g. the runner knows it timed out). */
  failureMode?: FailureMode;
}

export function buildScore(options: BuildScoreOptions): TaskScore {
  const penalties = options.penalties ?? [];
  const { score } = computeScore(options.breakdown, penalties);
  const passed = score >= PASS_THRESHOLD;

  let failureMode: FailureMode = options.failureMode ?? 'none';
  if (failureMode === 'none' && !passed) {
    const hardPenalty = penalties.find((p) => p.multiplier === 0);
    failureMode = hardPenalty ? mapPenaltyToFailure(hardPenalty) : 'wrong_answer';
  }

  return {
    score,
    passed,
    breakdown: options.breakdown,
    penalties,
    failureMode,
    metadata: options.metadata ?? {},
  };
}

function mapPenaltyToFailure(penalty: Penalty): FailureMode {
  switch (penalty.kind) {
    case 'policy_violation':
    case 'unsafe_action':
      return 'policy_violation';
    case 'hallucinated_citation':
      return 'wrong_answer';
    default:
      return 'wrong_answer';
  }
}

// ---------------------------------------------------------------------------
// Citation integrity
// ---------------------------------------------------------------------------

const URL_PATTERN = /https?:\/\/[^\s<>"')\]}]+/gi;

/** Strip fragments, trailing punctuation and default ports so URLs compare equal. */
export function normalizeUrl(raw: string): string {
  let candidate = raw.trim().replace(/[.,;:!?)\]}>'"]+$/, '');
  try {
    const url = new URL(candidate);
    url.hash = '';
    const host = url.host.toLowerCase().replace(/^www\./, '');
    const path = url.pathname.replace(/\/+$/, '');
    const search = url.search;
    return `${url.protocol}//${host}${path}${search}`;
  } catch {
    return candidate.toLowerCase();
  }
}

export function extractUrls(text: string): string[] {
  const matches = text.match(URL_PATTERN) ?? [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const match of matches) {
    const normalized = normalizeUrl(match);
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized);
      out.push(normalized);
    }
  }
  return out;
}

export interface CitationAudit {
  cited: string[];
  verified: string[];
  hallucinated: string[];
  /** 1 when every cited URL was actually retrieved; 1 when nothing was cited. */
  integrity: number;
}

/**
 * Cross-check the URLs an agent cited against the URLs it actually fetched.
 *
 * This is the deterministic half of research scoring: it needs no judge and
 * catches the single most common research-agent failure, a plausible citation
 * to a page the agent never opened.
 */
export function auditCitations(finalText: string, fetchedUrls: readonly string[]): CitationAudit {
  const cited = extractUrls(finalText);
  const fetched = new Set(fetchedUrls.map(normalizeUrl));

  const verified: string[] = [];
  const hallucinated: string[] = [];
  for (const url of cited) {
    if (fetched.has(url)) verified.push(url);
    else hallucinated.push(url);
  }

  return {
    cited,
    verified,
    hallucinated,
    integrity: cited.length === 0 ? 1 : verified.length / cited.length,
  };
}

/** URLs the agent retrieved, read from the recorded tool calls in the trace. */
export function fetchedUrlsFromTrace(trace: readonly TraceEvent[]): string[] {
  const urls: string[] = [];
  for (const event of trace) {
    if (event.kind !== 'tool_call') continue;
    const input = event.toolInput;
    if (typeof input !== 'object' || input === null) continue;
    const url = (input as Record<string, unknown>).url;
    if (typeof url === 'string') urls.push(normalizeUrl(url));
  }
  return urls;
}
