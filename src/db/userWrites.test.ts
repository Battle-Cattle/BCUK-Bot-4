import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./users', () => ({
  upsertUserRecord: vi.fn(),
  setTwitchBotEnabledRecord: vi.fn(),
  deleteUnlinkedUserRecord: vi.fn(),
}));
vi.mock('./customCommandCache', () => ({ invalidateCustomCommandLookupCache: vi.fn() }));

import { upsertUserRecord, setTwitchBotEnabledRecord, deleteUnlinkedUserRecord } from './users';
import { invalidateCustomCommandLookupCache } from './customCommandCache';
import { upsertUser, updateTwitchBotEnabled, deleteUnlinkedUser } from './userWrites';

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(upsertUserRecord).mockResolvedValue(false);
  vi.mocked(setTwitchBotEnabledRecord).mockResolvedValue(undefined);
});

// ─── upsertUser ───────────────────────────────────────────────────────────────

describe('upsertUser', () => {
  it('calls invalidateCustomCommandLookupCache when twitchName is a non-null string', async () => {
    vi.mocked(upsertUserRecord).mockResolvedValue(true);
    await upsertUser('1', 'Alice', 0, 'alice_chan');
    expect(invalidateCustomCommandLookupCache).toHaveBeenCalledOnce();
  });

  it('calls invalidateCustomCommandLookupCache when twitchName is explicitly null', async () => {
    vi.mocked(upsertUserRecord).mockResolvedValue(true);
    await upsertUser('1', 'Alice', 0, null);
    expect(invalidateCustomCommandLookupCache).toHaveBeenCalledOnce();
  });

  it('does NOT call invalidateCustomCommandLookupCache when twitchName is omitted (undefined)', async () => {
    vi.mocked(upsertUserRecord).mockResolvedValue(false);
    await upsertUser('1', 'Alice', 0);
    expect(invalidateCustomCommandLookupCache).not.toHaveBeenCalled();
  });

  it('propagates errors from upsertUserRecord without calling invalidate', async () => {
    vi.mocked(upsertUserRecord).mockRejectedValue(new Error('DB error'));
    await expect(upsertUser('1', 'Alice', 0, 'alice')).rejects.toThrow('DB error');
    expect(invalidateCustomCommandLookupCache).not.toHaveBeenCalled();
  });
});

// ─── deleteUnlinkedUser ───────────────────────────────────────────────────────

describe('deleteUnlinkedUser', () => {
  it('returns the record-layer result and invalidates the custom-command cache', async () => {
    vi.mocked(deleteUnlinkedUserRecord).mockResolvedValue(true);
    await expect(deleteUnlinkedUser('1')).resolves.toBe(true);
    expect(deleteUnlinkedUserRecord).toHaveBeenCalledWith('1');
    expect(invalidateCustomCommandLookupCache).toHaveBeenCalledOnce();
  });

  it('passes through false when the row was not deleted', async () => {
    vi.mocked(deleteUnlinkedUserRecord).mockResolvedValue(false);
    await expect(deleteUnlinkedUser('1')).resolves.toBe(false);
  });

  it('propagates errors without invalidating', async () => {
    vi.mocked(deleteUnlinkedUserRecord).mockRejectedValue(new Error('DB error'));
    await expect(deleteUnlinkedUser('1')).rejects.toThrow('DB error');
    expect(invalidateCustomCommandLookupCache).not.toHaveBeenCalled();
  });
});

// ─── updateTwitchBotEnabled ───────────────────────────────────────────────────

describe('updateTwitchBotEnabled', () => {
  it('always calls invalidateCustomCommandLookupCache on success', async () => {
    await updateTwitchBotEnabled('1', true);
    expect(invalidateCustomCommandLookupCache).toHaveBeenCalledOnce();
  });

  it('also calls invalidate when disabling', async () => {
    await updateTwitchBotEnabled('1', false);
    expect(invalidateCustomCommandLookupCache).toHaveBeenCalledOnce();
  });

  it('propagates errors from setTwitchBotEnabledRecord', async () => {
    vi.mocked(setTwitchBotEnabledRecord).mockRejectedValue(new Error('DB error'));
    await expect(updateTwitchBotEnabled('1', true)).rejects.toThrow('DB error');
    expect(invalidateCustomCommandLookupCache).not.toHaveBeenCalled();
  });
});
