import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./guildCommandOverrides', () => ({ upsertOverride: vi.fn(), removeOverride: vi.fn() }));
vi.mock('./customCommandCache', () => ({ invalidateCustomCommandLookupCache: vi.fn() }));

import { upsertOverride as upsertOverrideRecord, removeOverride as removeOverrideRecord } from './guildCommandOverrides';
import { invalidateCustomCommandLookupCache } from './customCommandCache';
import { upsertOverride, removeOverride } from './guildCommandOverrideWrites';

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(upsertOverrideRecord).mockResolvedValue(undefined);
  vi.mocked(removeOverrideRecord).mockResolvedValue(undefined);
});

// ─── upsertOverride ─────────────────────────────────────────────────────────

describe('upsertOverride', () => {
  it('always calls invalidateCustomCommandLookupCache on success', async () => {
    await upsertOverride('1', 5, { isDisabled: false, output: null });
    expect(upsertOverrideRecord).toHaveBeenCalledWith('1', 5, { isDisabled: false, output: null });
    expect(invalidateCustomCommandLookupCache).toHaveBeenCalledOnce();
  });

  it('propagates errors from upsertOverrideRecord without calling invalidate', async () => {
    vi.mocked(upsertOverrideRecord).mockRejectedValue(new Error('DB error'));
    await expect(upsertOverride('1', 5, { isDisabled: true, output: 'hi' })).rejects.toThrow('DB error');
    expect(invalidateCustomCommandLookupCache).not.toHaveBeenCalled();
  });
});

// ─── removeOverride ─────────────────────────────────────────────────────────

describe('removeOverride', () => {
  it('always calls invalidateCustomCommandLookupCache on success', async () => {
    await removeOverride('1', 5);
    expect(removeOverrideRecord).toHaveBeenCalledWith('1', 5);
    expect(invalidateCustomCommandLookupCache).toHaveBeenCalledOnce();
  });

  it('propagates errors from removeOverrideRecord without calling invalidate', async () => {
    vi.mocked(removeOverrideRecord).mockRejectedValue(new Error('DB error'));
    await expect(removeOverride('1', 5)).rejects.toThrow('DB error');
    expect(invalidateCustomCommandLookupCache).not.toHaveBeenCalled();
  });
});
