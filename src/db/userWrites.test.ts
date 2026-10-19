import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./users', () => ({
  upsertUserRecord: vi.fn(),
  setTwitchBotEnabledRecord: vi.fn(),
  deleteUnlinkedUserRecord: vi.fn(),
}));
vi.mock('./customCommandCache', () => ({ invalidateCustomCommandLookupCache: vi.fn() }));
vi.mock('./advancedCommandCache', () => ({ invalidateAdvancedCommandLookupCache: vi.fn() }));
vi.mock('./timerCommandCache', () => ({ invalidateTimerCommandCache: vi.fn() }));

import { upsertUserRecord, setTwitchBotEnabledRecord, deleteUnlinkedUserRecord } from './users';
import { invalidateCustomCommandLookupCache } from './customCommandCache';
import { invalidateAdvancedCommandLookupCache } from './advancedCommandCache';
import { invalidateTimerCommandCache } from './timerCommandCache';
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

describe('advanced command cache invalidation', () => {
  it('invalidates the advanced command cache alongside the custom command cache on a Twitch name change', async () => {
    vi.mocked(upsertUserRecord).mockResolvedValue(true);
    await upsertUser('1', 'Alice', 0, 'alice_chan');
    expect(invalidateAdvancedCommandLookupCache).toHaveBeenCalledOnce();
  });

  it('does not invalidate the advanced command cache when the Twitch name is untouched', async () => {
    await upsertUser('1', 'Alice', 0);
    expect(invalidateAdvancedCommandLookupCache).not.toHaveBeenCalled();
  });

  it('invalidates the advanced command cache when the Twitch bot is toggled or a user deleted', async () => {
    vi.mocked(deleteUnlinkedUserRecord).mockResolvedValue(true);
    await updateTwitchBotEnabled('1', true);
    await deleteUnlinkedUser('1');
    expect(invalidateAdvancedCommandLookupCache).toHaveBeenCalledTimes(2);
  });
});

describe('timer command cache invalidation', () => {
  it('invalidates the timer command cache on a Twitch name change, including a Twitch unlink (null)', async () => {
    vi.mocked(upsertUserRecord).mockResolvedValue(true);
    await upsertUser('1', 'Alice', 0, 'alice_chan');
    await upsertUser('1', 'Alice', 0, null);
    expect(invalidateTimerCommandCache).toHaveBeenCalledTimes(2);
  });

  it('does not invalidate the timer command cache when the Twitch name is untouched', async () => {
    await upsertUser('1', 'Alice', 0);
    expect(invalidateTimerCommandCache).not.toHaveBeenCalled();
  });

  it('invalidates the timer command cache when the Twitch bot is toggled or a user deleted', async () => {
    vi.mocked(deleteUnlinkedUserRecord).mockResolvedValue(true);
    await updateTwitchBotEnabled('1', false);
    await deleteUnlinkedUser('1');
    expect(invalidateTimerCommandCache).toHaveBeenCalledTimes(2);
  });

  it('does not invalidate the timer command cache when disabling the Twitch bot fails', async () => {
    vi.mocked(setTwitchBotEnabledRecord).mockRejectedValue(new Error('DB error'));
    await expect(updateTwitchBotEnabled('1', false)).rejects.toThrow('DB error');
    expect(invalidateTimerCommandCache).not.toHaveBeenCalled();
  });
});
