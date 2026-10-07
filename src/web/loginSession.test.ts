import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockLogger } from '../test-utils/loggerMock';
import { ACCESS_LEVEL_MOCK } from '../test-utils/accessLevelMock';

vi.mock('../db', () => ({
  updateDiscordName: vi.fn().mockResolvedValue(undefined),
  getAllGuilds: vi.fn().mockResolvedValue([]),
  getGuildsForMember: vi.fn().mockResolvedValue([]),
  getEffectiveAccessLevelForUser: vi.fn().mockResolvedValue(0),
  AccessLevel: ACCESS_LEVEL_MOCK,
}));
vi.mock('../discord/discordApi', () => ({
  fetchMemberDisplayName: vi.fn().mockResolvedValue(null),
}));
vi.mock('../shared/logger', () => ({ createLogger: mockLogger }));

import { establishDashboardSession, resolveAccessibleGuilds } from './loginSession';
import { getAllGuilds, getGuildsForMember, getEffectiveAccessLevelForUser, updateDiscordName, AccessLevel } from '../db';
import { fetchMemberDisplayName } from '../discord/discordApi';

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(fetchMemberDisplayName).mockResolvedValue(null);
  vi.mocked(getEffectiveAccessLevelForUser).mockResolvedValue(0);
});

describe('establishDashboardSession', () => {
  it('rejects an empty guild list without touching the session', async () => {
    const regenerate = vi.fn();
    const req: any = { session: { regenerate } };
    const dbUser = { discord_id: '42', discord_name: 'Alice', is_owner: false } as any;
    await expect(establishDashboardSession(req, { id: '42', username: 'alice', avatar: null }, dbUser, []))
      .rejects.toThrow('accessibleGuilds must be non-empty');
    expect(regenerate).not.toHaveBeenCalled();
  });

  it('regenerates the session and stores the same user payload the Discord callback builds', async () => {
    const guild = { guild_id: 'g1', name: 'Guild One', voice_channel_id: null };
    vi.mocked(getEffectiveAccessLevelForUser).mockResolvedValue(AccessLevel.MANAGER);
    const dbUser = { discord_id: '42', discord_name: 'Alice', is_owner: false } as any;
    const regenerate = vi.fn((cb: (err: null) => void) => cb(null));
    const save = vi.fn((cb: (err: null) => void) => cb(null));
    const req: any = { session: { regenerate, save } };
    // regenerate() replaces req.session in real express-session; the stub keeps the same object.
    await establishDashboardSession(req, { id: '42', username: 'alice', avatar: 'abc' }, dbUser, [guild as any]);

    expect(regenerate).toHaveBeenCalled();
    expect(save).toHaveBeenCalled();
    // Only the Discord OAuth callback passes discordAuthAt; passkey sign-in leaves it unset.
    expect(req.session.discordAuthAt).toBeUndefined();
    expect(req.session.user).toEqual({
      discordId: '42',
      discordName: 'Alice',
      discordAvatar: 'https://cdn.discordapp.com/avatars/42/abc.png',
      isOwner: false,
      currentGuildId: 'g1',
      accessLevel: AccessLevel.MANAGER,
      guilds: [{ guildId: 'g1', name: 'Guild One' }],
    });
  });
});

describe('resolveAccessibleGuilds', () => {
  it('returns every guild for an owner and memberships otherwise', async () => {
    vi.mocked(getAllGuilds).mockResolvedValue([{ guild_id: 'all' }] as any);
    vi.mocked(getGuildsForMember).mockResolvedValue([{ guild_id: 'mine' }] as any);
    expect(await resolveAccessibleGuilds({ discord_id: '1', is_owner: true } as any)).toEqual([{ guild_id: 'all' }]);
    expect(await resolveAccessibleGuilds({ discord_id: '1', is_owner: false } as any)).toEqual([{ guild_id: 'mine' }]);
    expect(getGuildsForMember).toHaveBeenCalledWith('1');
  });
});

describe('establishDashboardSession — display-name sync', () => {
  function makeReq(): any {
    return { session: { regenerate: vi.fn((cb: (e: null) => void) => cb(null)), save: vi.fn((cb: (e: null) => void) => cb(null)) } };
  }
  const guild = { guild_id: 'g1', name: 'Guild One', voice_channel_id: null } as any;
  const twoGuilds = [guild, { guild_id: 'g2', name: 'Guild Two', voice_channel_id: null } as any];

  it('persists a changed per-guild display name and uses it for the session', async () => {
    vi.mocked(fetchMemberDisplayName).mockResolvedValue('  NewName ');
    const req = makeReq();
    await establishDashboardSession(req, { id: '42', username: 'alice', avatar: null }, { discord_id: '42', discord_name: 'Old', is_owner: false } as any, [guild]);
    expect(fetchMemberDisplayName).toHaveBeenCalledWith('42', 'g1', true);
    expect(updateDiscordName).toHaveBeenCalledWith('42', 'NewName');
    expect(req.session.user.discordName).toBe('NewName');
  });

  it('keeps the stored name when the Discord lookup fails', async () => {
    vi.mocked(fetchMemberDisplayName).mockRejectedValue(new Error('down'));
    const req = makeReq();
    await establishDashboardSession(req, { id: '42', username: 'alice', avatar: null }, { discord_id: '42', discord_name: 'Old', is_owner: false } as any, [guild]);
    expect(updateDiscordName).not.toHaveBeenCalled();
    expect(req.session.user.discordName).toBe('Old');
  });

  it('leaves the guild unpicked at User level when several guilds are accessible', async () => {
    const req = makeReq();
    await establishDashboardSession(req, { id: '42', username: 'alice', avatar: null }, { discord_id: '42', discord_name: 'Alice', is_owner: false } as any, twoGuilds);
    expect(req.session.user.currentGuildId).toBeNull();
    expect(req.session.user.accessLevel).toBe(AccessLevel.USER);
    expect(getEffectiveAccessLevelForUser).not.toHaveBeenCalled();
  });

  it('records discordAuthAt only when the caller passes it', async () => {
    const req = makeReq();
    await establishDashboardSession(req, { id: '42', username: 'alice', avatar: null }, { discord_id: '42', discord_name: 'Alice', is_owner: false } as any, [guild], { discordAuthAt: 123 });
    expect(req.session.discordAuthAt).toBe(123);
  });
});
