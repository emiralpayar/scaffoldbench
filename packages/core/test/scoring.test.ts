import { describe, expect, it } from 'vitest';
import {
  auditCitations,
  buildScore,
  computeScore,
  extractUrls,
  fetchedUrlsFromTrace,
  normalizeUrl,
} from '@scaffoldbench/core';
import type { Penalty, ScoreItem, TraceEvent } from '@scaffoldbench/core';

const item = (id: string, weight: number, earned: number): ScoreItem => ({
  id,
  label: id,
  weight,
  earned,
});

describe('computeScore', () => {
  it('returns 0 for an empty breakdown', () => {
    expect(computeScore([], []).score).toBe(0);
  });

  it('weights items proportionally', () => {
    const breakdown = [item('a', 3, 1), item('b', 1, 0)];
    expect(computeScore(breakdown, []).raw).toBeCloseTo(0.75);
  });

  it('supports partial credit', () => {
    expect(computeScore([item('a', 1, 0.5)], []).score).toBeCloseTo(0.5);
  });

  it('applies penalties multiplicatively', () => {
    const penalties: Penalty[] = [
      { id: 'p', label: 'p', kind: 'policy_violation', multiplier: 0.5 },
    ];
    expect(computeScore([item('a', 1, 1)], penalties).score).toBeCloseTo(0.5);
  });

  it('a zero-multiplier penalty is a hard fail even at full marks', () => {
    const penalties: Penalty[] = [
      { id: 'refund', label: 'refund without policy check', kind: 'policy_violation', multiplier: 0 },
    ];
    expect(computeScore([item('a', 1, 1), item('b', 1, 1)], penalties).score).toBe(0);
  });

  it('clamps out-of-range earned values', () => {
    expect(computeScore([item('a', 1, 5)], []).score).toBe(1);
    expect(computeScore([item('a', 1, -3)], []).score).toBe(0);
  });
});

describe('buildScore', () => {
  it('passes only when everything is earned', () => {
    expect(buildScore({ breakdown: [item('a', 1, 1)] }).passed).toBe(true);
    expect(buildScore({ breakdown: [item('a', 1, 0.99)] }).passed).toBe(false);
  });

  it('infers policy_violation from a hard penalty', () => {
    const score = buildScore({
      breakdown: [item('a', 1, 1)],
      penalties: [{ id: 'x', label: 'x', kind: 'policy_violation', multiplier: 0 }],
    });
    expect(score.failureMode).toBe('policy_violation');
    expect(score.passed).toBe(false);
  });

  it('infers wrong_answer for an ordinary miss', () => {
    expect(buildScore({ breakdown: [item('a', 1, 0)] }).failureMode).toBe('wrong_answer');
  });

  it('blames a soft penalty when it alone cost the pass', () => {
    const citation: Penalty = {
      id: 'citation-integrity',
      label: 'cited unopened pages',
      kind: 'hallucinated_citation',
      multiplier: 0.75,
    };
    const rule: Penalty = { id: 'r', label: 'r', kind: 'unsafe_action', multiplier: 0.5 };

    expect(buildScore({ breakdown: [item('a', 1, 1)], penalties: [citation] }).failureMode).toBe(
      'hallucinated_citation',
    );
    // The heaviest penalty names the failure.
    expect(
      buildScore({ breakdown: [item('a', 1, 1)], penalties: [citation, rule] }).failureMode,
    ).toBe('policy_violation');
  });

  it('calls it a wrong answer when assertions were missed as well as penalised', () => {
    const score = buildScore({
      breakdown: [item('a', 1, 1), item('b', 1, 0)],
      penalties: [{ id: 'c', label: 'c', kind: 'hallucinated_citation', multiplier: 0.75 }],
    });
    expect(score.failureMode).toBe('wrong_answer');
  });

  it('honours an explicit failure mode from the runner', () => {
    const score = buildScore({ breakdown: [item('a', 1, 0)], failureMode: 'timeout' });
    expect(score.failureMode).toBe('timeout');
  });

  it('reports none when the task is fully solved', () => {
    expect(buildScore({ breakdown: [item('a', 1, 1)] }).failureMode).toBe('none');
  });
});

describe('normalizeUrl', () => {
  it('drops fragments, www, trailing slash and trailing punctuation', () => {
    expect(normalizeUrl('https://WWW.Example.com/docs/#intro')).toBe('https://example.com/docs');
    expect(normalizeUrl('https://example.com/a/b/,')).toBe('https://example.com/a/b');
  });

  it('preserves the query string', () => {
    expect(normalizeUrl('https://example.com/s?q=1')).toBe('https://example.com/s?q=1');
  });

  it('falls back to lowercasing for non-URLs', () => {
    expect(normalizeUrl('NOT A URL')).toBe('not a url');
  });
});

describe('extractUrls', () => {
  it('pulls urls out of prose and de-duplicates', () => {
    const text = 'See https://a.com/x and https://a.com/x/ plus (https://b.com/y).';
    expect(extractUrls(text)).toEqual(['https://a.com/x', 'https://b.com/y']);
  });

  it('returns an empty list when there are no urls', () => {
    expect(extractUrls('no links here')).toEqual([]);
  });
});

describe('auditCitations', () => {
  it('scores 1 when every citation was fetched', () => {
    const audit = auditCitations('Per https://a.com/x it is so.', ['https://a.com/x']);
    expect(audit.integrity).toBe(1);
    expect(audit.hallucinated).toEqual([]);
  });

  it('flags a citation the agent never retrieved', () => {
    const audit = auditCitations('From https://a.com/x and https://fake.com/y', ['https://a.com/x']);
    expect(audit.integrity).toBeCloseTo(0.5);
    expect(audit.hallucinated).toEqual(['https://fake.com/y']);
  });

  it('treats an uncited answer as integrity 1 (rubric handles the miss)', () => {
    expect(auditCitations('No sources given.', ['https://a.com/x']).integrity).toBe(1);
  });

  it('matches across url formatting differences', () => {
    const audit = auditCitations('See https://WWW.A.com/x/#top.', ['https://a.com/x']);
    expect(audit.integrity).toBe(1);
  });
});

describe('fetchedUrlsFromTrace', () => {
  const ev = (partial: Partial<TraceEvent>): TraceEvent => ({
    seq: 0,
    tMs: 0,
    phase: 'main',
    depth: 0,
    kind: 'tool_call',
    ...partial,
  });

  it('collects url arguments from tool calls only', () => {
    const trace: TraceEvent[] = [
      ev({ toolName: 'fetch', toolInput: { url: 'https://a.com/x/' } }),
      ev({ kind: 'tool_result', text: 'https://ignored.com' }),
      ev({ toolName: 'search', toolInput: { query: 'no url here' } }),
      ev({ toolName: 'fetch', toolInput: { url: 'https://b.com/y' } }),
    ];
    expect(fetchedUrlsFromTrace(trace)).toEqual(['https://a.com/x', 'https://b.com/y']);
  });

  it('tolerates malformed tool input', () => {
    expect(fetchedUrlsFromTrace([ev({ toolInput: null })])).toEqual([]);
  });
});
