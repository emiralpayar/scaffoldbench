import { describe, expect, it } from 'vitest';

import { formatBudget, formatDelta, formatDuration, formatUsd, shortModel } from '../src/format';

describe('formatDuration', () => {
  it('rounds to the unit it shows before splitting, so nothing carries into 60', () => {
    expect(formatDuration(999.4)).toBe('999ms');
    expect(formatDuration(999.6)).toBe('1.0s');
    expect(formatDuration(59_940)).toBe('59.9s');
    expect(formatDuration(59_950)).toBe('1m00s');
    expect(formatDuration(119_600)).toBe('2m00s');
    expect(formatDuration(3_599_400)).toBe('59m59s');
    expect(formatDuration(3_599_700)).toBe('1h00m');
    expect(formatDuration(7_200_000)).toBe('2h00m');
  });

  it('renders the common cases', () => {
    expect(formatDuration(0)).toBe('0ms');
    expect(formatDuration(22_400)).toBe('22.4s');
    expect(formatDuration(187_000)).toBe('3m07s');
    expect(formatDuration(7_500_000)).toBe('2h05m');
  });

  it('says nothing about a number it cannot read', () => {
    expect(formatDuration(Number.NaN)).toBe('-');
    expect(formatDuration(-5)).toBe('-');
  });
});

describe('formatUsd', () => {
  it('shows per-run amounts to a tenth of a cent and totals to the cent', () => {
    expect(formatUsd(0.0677)).toBe('$0.068');
    expect(formatUsd(0.5)).toBe('$0.500');
    expect(formatUsd(9.11279)).toBe('$9.11');
    expect(formatUsd(1234.5)).toBe('$1,234.50');
  });

  it('decides the precision on the rounded value', () => {
    expect(formatUsd(0.9996)).toBe('$1.00');
    expect(formatUsd(0.9994)).toBe('$0.999');
  });

  it('never prints a cost that rounds to zero as $0.000', () => {
    expect(formatUsd(0.00004)).toBe('<$0.001');
    expect(formatUsd(0)).toBe('$0.00');
    expect(formatUsd(0.0006)).toBe('$0.001');
  });

  it('formats a limit as dollars and cents unless it has more', () => {
    expect(formatBudget(0.75)).toBe('$0.75');
    expect(formatBudget(25)).toBe('$25.00');
    expect(formatBudget(0.125)).toBe('$0.125');
  });
});

describe('small formatters', () => {
  it('signs a difference and never prints -0.000', () => {
    expect(formatDelta(0.031)).toBe('+0.031');
    expect(formatDelta(-0.12)).toBe('-0.120');
    expect(formatDelta(-0.0001)).toBe('0.000');
  });

  it('shortens model ids for column headers', () => {
    expect(shortModel('claude-haiku-4-5-20251001')).toBe('haiku-4-5');
    expect(shortModel('claude-sonnet-5-5')).toBe('sonnet-5-5');
    expect(shortModel('gpt-x')).toBe('gpt-x');
  });
});
