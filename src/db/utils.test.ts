import { describe, it, expect, vi } from 'vitest';
import { fromBit, affectedOrExists } from './utils';

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

describe('affectedOrExists', () => {
  it('returns true without calling existsCheck when affectedRows > 0', async () => {
    const existsCheck = vi.fn().mockResolvedValue(false);
    const result = await affectedOrExists(1, existsCheck);
    expect(result).toBe(true);
    expect(existsCheck).not.toHaveBeenCalled();
  });

  it('calls existsCheck and returns its result when affectedRows is 0', async () => {
    const existsCheck = vi.fn().mockResolvedValue(true);
    const result = await affectedOrExists(0, existsCheck);
    expect(result).toBe(true);
    expect(existsCheck).toHaveBeenCalledOnce();
  });

  it('returns false when affectedRows is 0 and existsCheck resolves false', async () => {
    const existsCheck = vi.fn().mockResolvedValue(false);
    const result = await affectedOrExists(0, existsCheck);
    expect(result).toBe(false);
  });
});
