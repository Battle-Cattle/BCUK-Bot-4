import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./loyaltyPointsExclusions', () => ({ addExclusion: vi.fn(), removeExclusion: vi.fn() }));
vi.mock('./loyaltyPointsExclusionCache', () => ({ invalidateLoyaltyPointsExclusionLookupCache: vi.fn() }));

import { addExclusion, removeExclusion } from './loyaltyPointsExclusions';
import { invalidateLoyaltyPointsExclusionLookupCache } from './loyaltyPointsExclusionCache';
import { addLoyaltyPointsExclusion, removeLoyaltyPointsExclusion } from './loyaltyPointsExclusionWrites';

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(addExclusion).mockResolvedValue(undefined);
  vi.mocked(removeExclusion).mockResolvedValue(undefined);
});

describe.each([
  ['addLoyaltyPointsExclusion', addLoyaltyPointsExclusion, addExclusion],
  ['removeLoyaltyPointsExclusion', removeLoyaltyPointsExclusion, removeExclusion],
])('%s', (_name, wrapper, record) => {
  it('calls the record function and invalidates the cache on success', async () => {
    await wrapper(1, 'somebot');
    expect(record).toHaveBeenCalledWith(1, 'somebot');
    expect(invalidateLoyaltyPointsExclusionLookupCache).toHaveBeenCalledOnce();
  });

  it('propagates errors without calling invalidate', async () => {
    vi.mocked(record).mockRejectedValue(new Error('DB error'));
    await expect(wrapper(1, 'somebot')).rejects.toThrow('DB error');
    expect(invalidateLoyaltyPointsExclusionLookupCache).not.toHaveBeenCalled();
  });
});
