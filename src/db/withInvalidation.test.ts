import { describe, it, expect, vi } from 'vitest';
import { withInvalidation } from './withInvalidation';

describe('withInvalidation', () => {
  it('returns the operation result and invalidates after it resolves', async () => {
    const calls: string[] = [];
    const invalidate = vi.fn(() => calls.push('invalidate'));
    const result = await withInvalidation(async () => {
      calls.push('operation');
      return 42;
    }, invalidate);
    expect(result).toBe(42);
    expect(calls).toEqual(['operation', 'invalidate']);
  });

  it('propagates a rejected operation without invalidating', async () => {
    const invalidate = vi.fn();
    await expect(withInvalidation(() => Promise.reject(new Error('DB error')), invalidate)).rejects.toThrow('DB error');
    expect(invalidate).not.toHaveBeenCalled();
  });
});
