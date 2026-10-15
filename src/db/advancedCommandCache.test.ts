import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./advancedCommands', () => ({ getAllAdvancedCommandChatRoutes: vi.fn() }));

import { getAllAdvancedCommandChatRoutes } from './advancedCommands';
import { getAdvancedCommandForTwitchChannel, invalidateAdvancedCommandLookupCache } from './advancedCommandCache';

beforeEach(() => {
  vi.clearAllMocks();
  invalidateAdvancedCommandLookupCache();
});

describe('getAdvancedCommandForTwitchChannel', () => {
  it('finds a command by channel and trigger, case-insensitively', async () => {
    vi.mocked(getAllAdvancedCommandChatRoutes).mockResolvedValue([
      { commandId: 7, streamerId: 3, triggerString: '!hydrate', twitchName: 'Streamer', discordId: '1' },
    ]);
    expect(await getAdvancedCommandForTwitchChannel('#streamer', '!HYDRATE')).toEqual({
      commandId: 7, streamerId: 3, triggerString: '!hydrate', twitchName: 'Streamer', discordId: '1',
    });
    expect(await getAdvancedCommandForTwitchChannel('other', '!hydrate')).toBeNull();
  });

  it('returns null for blank input without loading', async () => {
    expect(await getAdvancedCommandForTwitchChannel('streamer', '  ')).toBeNull();
    expect(getAllAdvancedCommandChatRoutes).not.toHaveBeenCalled();
  });

  it('reloads after invalidation', async () => {
    vi.mocked(getAllAdvancedCommandChatRoutes).mockResolvedValueOnce([]);
    expect(await getAdvancedCommandForTwitchChannel('streamer', '!hydrate')).toBeNull();
    invalidateAdvancedCommandLookupCache();
    vi.mocked(getAllAdvancedCommandChatRoutes).mockResolvedValueOnce([
      { commandId: 7, streamerId: 3, triggerString: '!hydrate', twitchName: 'streamer', discordId: '1' },
    ]);
    expect(await getAdvancedCommandForTwitchChannel('streamer', '!hydrate')).not.toBeNull();
  });
});
