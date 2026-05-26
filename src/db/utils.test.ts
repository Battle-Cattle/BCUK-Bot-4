import { describe, it, expect } from 'vitest';
import { fromBit } from './utils';

describe('fromBit', () => {
  it('returns true for Buffer with first byte 1', () => {
    expect(fromBit(Buffer.from([1]))).toBe(true);
  });

  it('returns false for Buffer with first byte 0', () => {
    expect(fromBit(Buffer.from([0]))).toBe(false);
  });

  it('returns true for numeric 1', () => {
    expect(fromBit(1)).toBe(true);
  });

  it('returns false for numeric 0', () => {
    expect(fromBit(0)).toBe(false);
  });

  it('returns true for string "1" (loose equality)', () => {
    expect(fromBit('1')).toBe(true);
  });

  it('returns false for null', () => {
    expect(fromBit(null)).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(fromBit(undefined)).toBe(false);
  });
});
