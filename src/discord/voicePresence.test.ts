import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./guildRegistry', () => ({ getRegisteredGuildIds: vi.fn() }));

import { getRegisteredGuildIds } from './guildRegistry';
import { getActiveGuildForUser } from './voicePresence';

function makeClient(guildVoiceChannels: Record<string, Record<string, string>>) {
  const cache = new Map(
    Object.entries(guildVoiceChannels).map(([guildId, voiceStatesByUser]) => [
      guildId,
      {
        voiceStates: {
          cache: {
            get: (discordId: string) => {
              const channelId = voiceStatesByUser[discordId];
              return channelId ? { channelId } : undefined;
            },
          },
        },
      },
    ]),
  );
  return { guilds: { cache } } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getActiveGuildForUser', () => {
  it('returns the guild where the user has a live voice channel', () => {
    vi.mocked(getRegisteredGuildIds).mockReturnValue(['guild-A', 'guild-B']);
    const client = makeClient({ 'guild-B': { 'user-1': 'chan-1' } });

    expect(getActiveGuildForUser(client, 'user-1')).toBe('guild-B');
  });

  it('returns the first matching registered guild when scanning in order', () => {
    vi.mocked(getRegisteredGuildIds).mockReturnValue(['guild-A', 'guild-B']);
    const client = makeClient({
      'guild-A': { 'user-1': 'chan-a' },
      'guild-B': { 'user-1': 'chan-b' },
    });

    expect(getActiveGuildForUser(client, 'user-1')).toBe('guild-A');
  });

  it('returns null when the user is not in voice in any registered guild', () => {
    vi.mocked(getRegisteredGuildIds).mockReturnValue(['guild-A', 'guild-B']);
    const client = makeClient({ 'guild-A': { 'user-2': 'chan-a' } });

    expect(getActiveGuildForUser(client, 'user-1')).toBeNull();
  });

  it('returns null when a registered guild is not present in the client cache', () => {
    vi.mocked(getRegisteredGuildIds).mockReturnValue(['guild-unknown']);
    const client = makeClient({});

    expect(getActiveGuildForUser(client, 'user-1')).toBeNull();
  });

  it('returns null when there are no registered guilds', () => {
    vi.mocked(getRegisteredGuildIds).mockReturnValue([]);
    const client = makeClient({});

    expect(getActiveGuildForUser(client, 'user-1')).toBeNull();
  });
});
