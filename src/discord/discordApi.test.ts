import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockLogger } from '../test-utils/loggerMock';

vi.mock('../shared/logger', () => ({ createLogger: mockLogger }));
vi.mock('./discordClientStore', () => ({ getDiscordClient: vi.fn().mockReturnValue(null) }));

import { Collection } from 'discord.js';
import { getDiscordClient } from './discordClientStore';
import { fetchMemberDisplayName, fetchAllMemberDisplayNames, fetchDiscordUserProfile, sendDiscordDirectMessage } from './discordApi';

let mockGuild: { members: { fetch: ReturnType<typeof vi.fn>; list: ReturnType<typeof vi.fn> } };
let client: {
  users: { fetch: ReturnType<typeof vi.fn> };
  guilds: { cache: { get: ReturnType<typeof vi.fn> }; fetch: ReturnType<typeof vi.fn> };
};

beforeEach(() => {
  vi.clearAllMocks();
  mockGuild = { members: { fetch: vi.fn().mockResolvedValue({ displayName: 'Alice' }), list: vi.fn() } };
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

  it('returns null when the client goes away between the readiness check and the guild lookup', async () => {
    vi.mocked(getDiscordClient).mockReturnValueOnce(client as any).mockReturnValueOnce(null);
    expect(await fetchMemberDisplayName('user123', 'guild-id', false)).toBeNull();
    expect(client.guilds.fetch).not.toHaveBeenCalled();
  });

  it('returns null when guild member fetch throws', async () => {
    readyClient();
    mockGuild.members.fetch.mockRejectedValueOnce(new Error('not found'));
    expect(await fetchMemberDisplayName('missing', 'guild-id', false)).toBeNull();
  });
});

/** Builds a members.list() page: a Collection of `count` members with ids `${start}`… and names `Name${id}`. */
function memberPage(start: number, count: number): Collection<string, { displayName: string }> {
  return new Collection(Array.from({ length: count }, (_, i) => {
    const id = String(start + i);
    return [id, { displayName: `Name${id}` }] as const;
  }));
}

describe('fetchAllMemberDisplayNames', () => {
  it('returns null when client is not ready', async () => {
    expect(await fetchAllMemberDisplayNames('guild-id')).toBeNull();
  });

  it('pages through the member list until a short page and maps id to display name, without caching', async () => {
    readyClient();
    mockGuild.members.list
      .mockResolvedValueOnce(memberPage(1, 1000))
      .mockResolvedValueOnce(memberPage(1001, 2));

    const names = await fetchAllMemberDisplayNames('guild-id');
    expect(names?.size).toBe(1002);
    expect(names?.get('1')).toBe('Name1');
    expect(names?.get('1002')).toBe('Name1002');
    expect(mockGuild.members.list).toHaveBeenNthCalledWith(1, { limit: 1000, after: undefined, cache: false });
    expect(mockGuild.members.list).toHaveBeenNthCalledWith(2, { limit: 1000, after: '1000', cache: false });
  });

  it('stops after an empty page', async () => {
    readyClient();
    mockGuild.members.list.mockResolvedValueOnce(memberPage(1, 0));
    expect(await fetchAllMemberDisplayNames('guild-id')).toEqual(new Map());
    expect(mockGuild.members.list).toHaveBeenCalledOnce();
  });

  it('returns null when Discord refuses the listing (Server Members intent not enabled)', async () => {
    readyClient();
    mockGuild.members.list.mockRejectedValueOnce(Object.assign(new Error('Missing Access'), { code: 50001 }));
    expect(await fetchAllMemberDisplayNames('guild-id')).toBeNull();
  });

  it('returns null when a later page fails, rather than a partial result', async () => {
    readyClient();
    mockGuild.members.list
      .mockResolvedValueOnce(memberPage(1, 1000))
      .mockRejectedValueOnce(new Error('network'));
    expect(await fetchAllMemberDisplayNames('guild-id')).toBeNull();
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
