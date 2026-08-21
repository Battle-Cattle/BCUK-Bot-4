import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ACCESS_LEVEL_MOCK } from '../test-utils/accessLevelMock';

vi.mock('../db', () => ({
  getAllGuilds: vi.fn(),
  getGuildsForMember: vi.fn(),
  getEffectiveAccessLevelForUser: vi.fn(),
  AccessLevel: ACCESS_LEVEL_MOCK,
}));

import { fetchLiveGuildsForUser, resolveAccessLevelForGuild } from './guildAccess';
import { getAllGuilds, getGuildsForMember, getEffectiveAccessLevelForUser, AccessLevel } from '../db';
import type { DbUser } from '../db';

function makeDbUser(overrides: Partial<DbUser> = {}): DbUser {
  return {
    discord_id: 'user-1',
    discord_name: 'Test User',
    is_twitch_bot_enabled: false,
    twitch_name: null,
    access_level: AccessLevel.USER,
    is_owner: false,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('fetchLiveGuildsForUser', () => {
  it('fetches every guild for an owner, with no per-guild access-level map', async () => {
    const owner = makeDbUser({ is_owner: true });
    const allGuilds = [{ guild_id: 'g1', name: 'Guild 1' }, { guild_id: 'g2', name: 'Guild 2' }];
    vi.mocked(getAllGuilds).mockResolvedValue(allGuilds as any);

    const result = await fetchLiveGuildsForUser(owner);

    expect(getAllGuilds).toHaveBeenCalledOnce();
    expect(getGuildsForMember).not.toHaveBeenCalled();
    expect(result.guilds).toBe(allGuilds);
    expect(result.accessLevelByGuildId).toBeNull();
  });

  it('fetches only the member guilds for a non-owner, with an access-level map', async () => {
    const member = makeDbUser({ is_owner: false });
    const memberships = [
      { guild_id: 'g1', name: 'Guild 1', access_level: AccessLevel.MOD },
      { guild_id: 'g2', name: 'Guild 2', access_level: AccessLevel.ADMIN },
    ];
    vi.mocked(getGuildsForMember).mockResolvedValue(memberships as any);

    const result = await fetchLiveGuildsForUser(member);

    expect(getGuildsForMember).toHaveBeenCalledWith('user-1');
    expect(getAllGuilds).not.toHaveBeenCalled();
    expect(result.guilds).toBe(memberships);
    expect(result.accessLevelByGuildId).toEqual(new Map([['g1', AccessLevel.MOD], ['g2', AccessLevel.ADMIN]]));
  });
});

describe('resolveAccessLevelForGuild', () => {
  it('reads the access level off the map when given (non-owner path)', async () => {
    const user = makeDbUser();
    const map = new Map([['g1', AccessLevel.MANAGER]]);

    const level = await resolveAccessLevelForGuild(user, 'g1', map);

    expect(level).toBe(AccessLevel.MANAGER);
    expect(getEffectiveAccessLevelForUser).not.toHaveBeenCalled();
  });

  it('defaults to USER when the guild is absent from the map', async () => {
    const user = makeDbUser();
    const map = new Map([['g1', AccessLevel.MANAGER]]);

    const level = await resolveAccessLevelForGuild(user, 'g2', map);

    expect(level).toBe(AccessLevel.USER);
  });

  it('falls back to getEffectiveAccessLevelForUser when no map is given (owner path)', async () => {
    const owner = makeDbUser({ is_owner: true });
    vi.mocked(getEffectiveAccessLevelForUser).mockResolvedValue(AccessLevel.ADMIN);

    const level = await resolveAccessLevelForGuild(owner, 'g1', null);

    expect(getEffectiveAccessLevelForUser).toHaveBeenCalledWith('g1', owner);
    expect(level).toBe(AccessLevel.ADMIN);
  });
});
