import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { waitFor } from '../test-utils/waitFor';
import { mockLogger } from '../test-utils/loggerMock';

vi.mock('../shared/logger', () => ({ createLogger: mockLogger }));

// Uses the real createManagedLookupCache (not a fake) so tests below can
// exercise its actual TTL / stale-while-revalidate behaviour.
vi.mock('../db', async () => {
  const { createManagedLookupCache, DEFAULT_REFRESH_FAILURE_BACKOFF_MS, DEFAULT_REFRESH_FAILURE_MAX_BACKOFF_MS } =
    await vi.importActual<typeof import('../db/lookupCache')>('../db/lookupCache');
  return {
    getAllTwitchLinkedUsers: vi.fn(),
    findUserByTwitchName: vi.fn(),
    findStreamerIdByDiscordId: vi.fn(),
    createManagedLookupCache,
    DEFAULT_REFRESH_FAILURE_BACKOFF_MS,
    DEFAULT_REFRESH_FAILURE_MAX_BACKOFF_MS,
  };
});

import {
  resolveDiscordIdForTwitchChannel,
  resolveStreamerIdForDiscordId,
  __resetTwitchChannelDiscordIdCacheForTests,
} from './twitchChannelResolution';
import { getAllTwitchLinkedUsers, findUserByTwitchName, findStreamerIdByDiscordId } from '../db';

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.mocked(getAllTwitchLinkedUsers).mockResolvedValue([{ twitchName: 'streamer', discordId: 'streamer-discord-id' }]);
  vi.mocked(findUserByTwitchName).mockResolvedValue(null);
  __resetTwitchChannelDiscordIdCacheForTests();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('resolveDiscordIdForTwitchChannel', () => {
  it('resolves a linked channel from the bulk cache without a live lookup', async () => {
    expect(await resolveDiscordIdForTwitchChannel('streamer')).toBe('streamer-discord-id');
    expect(findUserByTwitchName).not.toHaveBeenCalled();
  });

  it('serves repeated lookups from one bulk load', async () => {
    await resolveDiscordIdForTwitchChannel('streamer');
    await resolveDiscordIdForTwitchChannel('streamer');
    expect(getAllTwitchLinkedUsers).toHaveBeenCalledOnce();
  });

  it('falls back to a live lookup when a channel is missing from the bulk cache, so a just-linked streamer works on the very next message', async () => {
    // Simulate a channel that was linked after the bulk cache's last load —
    // it's absent from the cached map even though the cache itself is fresh.
    vi.mocked(getAllTwitchLinkedUsers).mockResolvedValue([]);
    vi.mocked(findUserByTwitchName).mockResolvedValue({ discord_id: 'freshly-linked-discord-id' } as any);

    expect(await resolveDiscordIdForTwitchChannel('streamer')).toBe('freshly-linked-discord-id');
    expect(findUserByTwitchName).toHaveBeenCalledWith('streamer');
  });

  it('still resolves via the live lookup when the first bulk load fails, serving the empty fallback cache', async () => {
    vi.mocked(getAllTwitchLinkedUsers).mockRejectedValue(new Error('db down'));
    vi.mocked(findUserByTwitchName).mockResolvedValue({ discord_id: 'streamer-discord-id' } as any);

    expect(await resolveDiscordIdForTwitchChannel('streamer')).toBe('streamer-discord-id');
    expect(findUserByTwitchName).toHaveBeenCalledWith('streamer');
  });

  it('returns null for a channel no user has linked', async () => {
    expect(await resolveDiscordIdForTwitchChannel('nobody')).toBeNull();
    expect(findUserByTwitchName).toHaveBeenCalledWith('nobody');
  });

  it('re-resolves the linked discord_id after the cache TTL expires, picking up a relink', async () => {
    expect(await resolveDiscordIdForTwitchChannel('streamer')).toBe('streamer-discord-id');
    expect(getAllTwitchLinkedUsers).toHaveBeenCalledOnce();

    vi.mocked(getAllTwitchLinkedUsers).mockResolvedValue([{ twitchName: 'streamer', discordId: 'new-streamer-discord-id' }]);
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1);

    // The cache is now stale — this lookup kicks a background refresh but
    // (per the shared lookupCache's stale-while-revalidate strategy) still
    // serves the last-good mapping for this call.
    expect(await resolveDiscordIdForTwitchChannel('streamer')).toBe('streamer-discord-id');
    await waitFor(() => expect(getAllTwitchLinkedUsers).toHaveBeenCalledTimes(2));

    // A subsequent lookup picks up the refreshed mapping.
    expect(await resolveDiscordIdForTwitchChannel('streamer')).toBe('new-streamer-discord-id');
  });
});

describe('resolveStreamerIdForDiscordId', () => {
  it('returns the cached streamer id for a linked Discord user', async () => {
    vi.mocked(findStreamerIdByDiscordId).mockResolvedValue(42);
    expect(await resolveStreamerIdForDiscordId('streamer-discord-id')).toBe(42);
    expect(findStreamerIdByDiscordId).toHaveBeenCalledWith('streamer-discord-id');
  });

  it('returns null for a Discord user who isn\'t a streamer', async () => {
    vi.mocked(findStreamerIdByDiscordId).mockResolvedValue(null);
    expect(await resolveStreamerIdForDiscordId('streamer-discord-id')).toBeNull();
  });

  it('returns null without a lookup for an unlinked channel', async () => {
    expect(await resolveStreamerIdForDiscordId(null)).toBeNull();
    expect(findStreamerIdByDiscordId).not.toHaveBeenCalled();
  });
});
