import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockLogger } from '../test-utils/loggerMock';

vi.mock('../shared/logger', () => ({ createLogger: mockLogger }));
vi.mock('./discordClientStore', () => ({ getDiscordClient: vi.fn().mockReturnValue(null) }));

import { getDiscordClient } from './discordClientStore';
import { fetchMemberDisplayName, fetchDiscordUserProfile, sendDiscordDirectMessage } from './discordApi';

let mockGuild: { members: { fetch: ReturnType<typeof vi.fn> } };
let client: {
  users: { fetch: ReturnType<typeof vi.fn> };
  guilds: { cache: { get: ReturnType<typeof vi.fn> }; fetch: ReturnType<typeof vi.fn> };
};

beforeEach(() => {
  vi.clearAllMocks();
  mockGuild = { members: { fetch: vi.fn().mockResolvedValue({ displayName: 'Alice' }) } };
  client = {
    users: { fetch: vi.fn().mockResolvedValue({ username: 'alice', avatar: 'abc123' }) },
    guilds: { cache: { get: vi.fn().mockReturnValue(undefined) }, fetch: vi.fn().mockResolvedValue(mockGuild) },
  };
  vi.mocked(getDiscordClient).mockReturnValue(null);
});

function readyClient(): void {
  vi.mocked(getDiscordClient).mockReturnValue(client as any);
}

describe('fetchMemberDisplayName', () => {
  it('returns null when client is not ready', async () => {
    expect(await fetchMemberDisplayName('123', 'guild-id', false)).toBeNull();
  });

  it('returns the member displayName when client is ready and fetch succeeds', async () => {
    readyClient();
    expect(await fetchMemberDisplayName('user123', 'guild-id', false)).toBe('Alice');
    expect(mockGuild.members.fetch).toHaveBeenCalledWith({ user: 'user123', force: false });
  });

  it('uses a cached guild without fetching it', async () => {
    readyClient();
    client.guilds.cache.get.mockReturnValue(mockGuild);
    expect(await fetchMemberDisplayName('user123', 'guild-id', true)).toBe('Alice');
    expect(client.guilds.fetch).not.toHaveBeenCalled();
    expect(mockGuild.members.fetch).toHaveBeenCalledWith({ user: 'user123', force: true });
  });

  it('returns null when guild member fetch throws', async () => {
    readyClient();
    mockGuild.members.fetch.mockRejectedValueOnce(new Error('not found'));
    expect(await fetchMemberDisplayName('missing', 'guild-id', false)).toBeNull();
  });
});

describe('fetchDiscordUserProfile', () => {
  it('returns null when client is not ready', async () => {
    expect(await fetchDiscordUserProfile('123')).toBeNull();
  });

  it('returns the username and avatar hash when the fetch succeeds', async () => {
    readyClient();
    expect(await fetchDiscordUserProfile('user123')).toEqual({ username: 'alice', avatar: 'abc123' });
    expect(client.users.fetch).toHaveBeenCalledWith('user123');
  });

  it('returns null when the user fetch throws', async () => {
    readyClient();
    client.users.fetch.mockRejectedValueOnce(new Error('unknown user'));
    expect(await fetchDiscordUserProfile('missing')).toBeNull();
  });
});

describe('sendDiscordDirectMessage', () => {
  it('returns false when client is not ready', async () => {
    expect(await sendDiscordDirectMessage('123', 'hi')).toBe(false);
  });

  it('DMs the user with mentions disabled', async () => {
    readyClient();
    const send = vi.fn().mockResolvedValue({});
    client.users.fetch.mockResolvedValueOnce({ send });
    expect(await sendDiscordDirectMessage('user123', 'your code')).toBe(true);
    expect(client.users.fetch).toHaveBeenCalledWith('user123');
    expect(send).toHaveBeenCalledWith({ content: 'your code', allowedMentions: { parse: [] } });
  });

  it('returns false when Discord refuses the DM', async () => {
    readyClient();
    client.users.fetch.mockResolvedValueOnce({ send: vi.fn().mockRejectedValue(new Error('Cannot send messages to this user')) });
    expect(await sendDiscordDirectMessage('user123', 'your code')).toBe(false);
  });
});
