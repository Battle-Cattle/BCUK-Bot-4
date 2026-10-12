import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./loyaltyPoints', () => ({ setConfig: vi.fn() }));
vi.mock('./loyaltyPointsCache', () => ({ invalidateLoyaltyPointsConfigLookupCache: vi.fn() }));

import { setConfig as setConfigRecord } from './loyaltyPoints';
import { invalidateLoyaltyPointsConfigLookupCache } from './loyaltyPointsCache';
import { setLoyaltyPointsConfig } from './loyaltyPointsWrites';

const CONFIG = { enabled: true, pointsPerMessage: 1, cooldownSeconds: 60, pointsPerSub: 100, pointsPerGiftSub: 100 };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(setConfigRecord).mockResolvedValue(undefined);
});

describe('setLoyaltyPointsConfig', () => {
  it('calls the record function and invalidates the cache on success', async () => {
    await setLoyaltyPointsConfig(1, CONFIG);
    expect(setConfigRecord).toHaveBeenCalledWith(1, CONFIG);
    expect(invalidateLoyaltyPointsConfigLookupCache).toHaveBeenCalledOnce();
  });

  it('propagates errors without calling invalidate', async () => {
    vi.mocked(setConfigRecord).mockRejectedValue(new Error('DB error'));
    await expect(setLoyaltyPointsConfig(1, CONFIG)).rejects.toThrow('DB error');
    expect(invalidateLoyaltyPointsConfigLookupCache).not.toHaveBeenCalled();
  });
});
