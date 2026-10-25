import { describe, it, expect } from 'vitest';
import { parseGambleAmount, parsePointsAmount } from './gambleAmount';

describe('parseGambleAmount', () => {
  it('parses a plain integer', () => {
    expect(parseGambleAmount('100', 1000)).toBe(100);
  });

  it('parses a thousands-separated integer', () => {
    expect(parseGambleAmount('1,000', 2000)).toBe(1000);
  });

  it('parses a "k" suffix as ×1000', () => {
    expect(parseGambleAmount('5k', 10_000)).toBe(5000);
  });

  it('parses an uppercase "K" suffix as ×1000', () => {
    expect(parseGambleAmount('5K', 10_000)).toBe(5000);
  });

  it('parses a percentage of the balance, floored', () => {
    expect(parseGambleAmount('40%', 1000)).toBe(400);
    expect(parseGambleAmount('33%', 100)).toBe(33);
  });

  it('parses "all" (case-insensitive) as the full balance', () => {
    expect(parseGambleAmount('all', 250)).toBe(250);
    expect(parseGambleAmount('ALL', 250)).toBe(250);
    expect(parseGambleAmount('All', 250)).toBe(250);
  });

  it('trims surrounding whitespace', () => {
    expect(parseGambleAmount('  100  ', 1000)).toBe(100);
  });

  it('rejects an empty or whitespace-only string', () => {
    expect(parseGambleAmount('', 1000)).toBeNull();
    expect(parseGambleAmount('   ', 1000)).toBeNull();
  });

  it('rejects a non-numeric string', () => {
    expect(parseGambleAmount('abc', 1000)).toBeNull();
  });

  it('rejects zero', () => {
    expect(parseGambleAmount('0', 1000)).toBeNull();
  });

  it('rejects a negative number', () => {
    expect(parseGambleAmount('-50', 1000)).toBeNull();
  });

  it('rejects an amount above the current balance', () => {
    expect(parseGambleAmount('101', 100)).toBeNull();
  });

  it('accepts an amount exactly equal to the balance', () => {
    expect(parseGambleAmount('100', 100)).toBe(100);
  });

  it('rejects "all" when the balance is 0', () => {
    expect(parseGambleAmount('all', 0)).toBeNull();
  });

  it('rejects a percentage that floors to 0', () => {
    expect(parseGambleAmount('1%', 50)).toBeNull();
  });

  it('rejects a negative percentage', () => {
    expect(parseGambleAmount('-10%', 1000)).toBeNull();
  });

  it('rejects a zero percentage', () => {
    expect(parseGambleAmount('0%', 1000)).toBeNull();
  });

  it('rejects a decimal amount', () => {
    expect(parseGambleAmount('10.5', 1000)).toBeNull();
  });

  it('rejects a bare "k" with no digits', () => {
    expect(parseGambleAmount('k', 1000)).toBeNull();
  });

  it('rejects malformed input mixing letters and digits', () => {
    expect(parseGambleAmount('5kk', 10_000)).toBeNull();
    expect(parseGambleAmount('ab5k', 10_000)).toBeNull();
  });
});

describe('parsePointsAmount', () => {
  it.each([
    ['100', 100],
    [' 1,000 ', 1000],
    ['1k', 1000],
    ['1K', 1000],
    ['0', 0],
  ])('parses %j as %d', (input, expected) => {
    expect(parsePointsAmount(input)).toBe(expected);
  });

  it.each(['', 'all', '40%', '10.5', '-5', 'k', '1kk', 'abc'])('rejects %j', (input) => {
    expect(parsePointsAmount(input)).toBeNull();
  });
});
