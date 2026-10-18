import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockLogger } from '../test-utils/loggerMock';

vi.mock('../shared/logger', () => ({ createLogger: mockLogger }));
vi.mock('./discordClientStore', () => ({ getDiscordClient: vi.fn().mockReturnValue(null) }));

import { getDiscordClient } from './discordClientStore';
import { fetchMemberDisplayName, fetchAllMemberDisplayNames, fetchDiscordUserProfile, sendDiscordDirectMessage } from './discordApi';

let mockGuild: { members: { fetch: ReturnType<typeof vi.fn> } };
let client: {
  rest: { get: ReturnType<typeof vi.fn> };
  users: { fetch: ReturnType<typeof vi.fn> };
  guilds: { cache: { get: ReturnType<typeof vi.fn> }; fetch: ReturnType<typeof vi.fn> };
};

beforeEach(() => {
  vi.clearAllMocks();
  mockGuild = { members: { fetch: vi.fn().mockResolvedValue({ displayName: 'Alice' }) } };
  client = {
    rest: { get: vi.fn() },
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

/** Builds a raw List Guild Members page: `count` members with ids `${start}`… and nicknames `Name${id}`. */
function memberPage(start: number, count: number) {
  return Array.from({ length: count }, (_, i) => {
    const id = String(start + i);
    return { nick: `Name${id}`, user: { id, username: `user${id}`, global_name: null } };
  });
}

/** The query string of the nth `client.rest.get` call, as a plain object. */
function queryOfCall(n: number): Record<string, string> {
  const options = client.rest.get.mock.calls[n]![1] as { query: URLSearchParams };
  return Object.fromEntries(options.query);
}

describe('fetchAllMemberDisplayNames', () => {
  it('returns null when client is not ready', async () => {
    expect(await fetchAllMemberDisplayNames('guild-id')).toBeNull();
  });

  it('pages through the raw member list until a short page and maps id to display name', async () => {
    readyClient();
    client.rest.get
      .mockResolvedValueOnce(memberPage(1, 1000))
      .mockResolvedValueOnce(memberPage(1001, 2));

    const names = await fetchAllMemberDisplayNames('guild-id');
    expect(names?.size).toBe(1002);
    expect(names?.get('1')).toBe('Name1');
    expect(names?.get('1002')).toBe('Name1002');
    expect(client.rest.get.mock.calls[0]![0]).toBe('/guilds/guild-id/members');
    expect(queryOfCall(0)).toEqual({ limit: '1000', after: '0' });
    expect(queryOfCall(1)).toEqual({ limit: '1000', after: '1000' });
  });

  it('uses the same display-name precedence as GuildMember#displayName', async () => {
    readyClient();
    client.rest.get.mockResolvedValueOnce([
      { nick: 'Nick', user: { id: '1', username: 'u1', global_name: 'Global1' } },
      { nick: null, user: { id: '2', username: 'u2', global_name: 'Global2' } },
      { user: { id: '3', username: 'u3', global_name: null } },
    ]);
    expect(await fetchAllMemberDisplayNames('guild-id')).toEqual(new Map([['1', 'Nick'], ['2', 'Global2'], ['3', 'u3']]));
  });

  it('stops after an empty page', async () => {
    readyClient();
    client.rest.get.mockResolvedValueOnce([]);
    expect(await fetchAllMemberDisplayNames('guild-id')).toEqual(new Map());
    expect(client.rest.get).toHaveBeenCalledOnce();
  });

  it('returns null rather than looping forever when a full page does not advance the cursor', async () => {
    readyClient();
    // The second request asks for after=1000 but gets the same page back, so the cursor stays at 1000.
    client.rest.get.mockResolvedValue(memberPage(1, 1000));
    expect(await fetchAllMemberDisplayNames('guild-id')).toBeNull();
    expect(client.rest.get).toHaveBeenCalledTimes(2);
  });

  it('returns null when Discord refuses the listing (Server Members intent not enabled)', async () => {
    readyClient();
    client.rest.get.mockRejectedValueOnce(Object.assign(new Error('Missing Access'), { code: 50001 }));
    expect(await fetchAllMemberDisplayNames('guild-id')).toBeNull();
  });

  it('returns null when a later page fails, rather than a partial result', async () => {
    readyClient();
    client.rest.get
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
