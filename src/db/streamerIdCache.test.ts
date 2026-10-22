import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockLogger } from '../test-utils/loggerMock';

// The real lookupCache (not a fake), so these tests exercise its actual load-once and
// invalidate-then-reload behaviour.
vi.mock('../shared/logger', () => ({ createLogger: mockLogger }));
vi.mock('./streamMonitor', () => ({ getAllStreamerIds: vi.fn() }));

import { findStreamerIdByDiscordId, invalidateStreamerIdLookupCache } from './streamerIdCache';
import { getAllStreamerIds } from './streamMonitor';

beforeEach(() => {
  vi.clearAllMocks();
  invalidateStreamerIdLookupCache();
  vi.mocked(getAllStreamerIds).mockResolvedValue([
    { id: 42, discordId: '111' },
    { id: 7, discordId: '222' },
  ]);
});

describe('findStreamerIdByDiscordId', () => {
  it('returns the streamer id linked to a Discord ID', async () => {
    expect(await findStreamerIdByDiscordId('111')).toBe(42);
    expect(await findStreamerIdByDiscordId('222')).toBe(7);
  });

  it('returns null for a Discord user with no streamer row', async () => {
    expect(await findStreamerIdByDiscordId('999')).toBeNull();
  });

  it('serves repeated lookups from one bulk load instead of querying per call', async () => {
    await findStreamerIdByDiscordId('111');
    await findStreamerIdByDiscordId('111');
    await findStreamerIdByDiscordId('999');
    expect(getAllStreamerIds).toHaveBeenCalledOnce();
  });
});

describe('invalidateStreamerIdLookupCache', () => {
  it('makes the next lookup reload, so a just-added streamer is found straight away', async () => {
    expect(await findStreamerIdByDiscordId('333')).toBeNull();

    vi.mocked(getAllStreamerIds).mockResolvedValue([{ id: 42, discordId: '111' }, { id: 9, discordId: '333' }]);
    invalidateStreamerIdLookupCache();

    expect(await findStreamerIdByDiscordId('333')).toBe(9);
    expect(getAllStreamerIds).toHaveBeenCalledTimes(2);
  });

  it('makes the next lookup reload, so a just-removed streamer is no longer found', async () => {
    expect(await findStreamerIdByDiscordId('111')).toBe(42);

    vi.mocked(getAllStreamerIds).mockResolvedValue([{ id: 7, discordId: '222' }]);
    invalidateStreamerIdLookupCache();

    expect(await findStreamerIdByDiscordId('111')).toBeNull();
  });
});
