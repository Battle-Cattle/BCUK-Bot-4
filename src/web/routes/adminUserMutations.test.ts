import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../db', () => ({
  findUser: vi.fn(),
  findUserByTwitchName: vi.fn(),
  upsertUser: vi.fn(),
  removeUser: vi.fn(),
  updateTwitchBotEnabled: vi.fn(),
  getTwitchEnabledChannels: vi.fn(),
}));

vi.mock('../../twitch/twitchChannelMembership', () => ({
  joinTwitchChannel: vi.fn(),
  partTwitchChannel: vi.fn(),
}));

vi.mock('../../twitch/twitchChannelName', () => ({
  normalizeTwitchChannelName: vi.fn((name: string | null) => name?.toLowerCase() ?? null),
}));

vi.mock('../../db/users', () => ({ AccessLevel: { USER: 0, MOD: 1, MANAGER: 2, ADMIN: 3 } }));

import {
  addOrUpdateUserMutation,
  removeUserMutation,
  toggleTwitchMutation,
} from './adminUserMutations';
import {
  findUser,
  upsertUser,
  removeUser,
  updateTwitchBotEnabled,
  getTwitchEnabledChannels,
} from '../../db';
import { joinTwitchChannel, partTwitchChannel } from '../../twitch/twitchChannelMembership';
import { AccessLevel } from '../../db/users';

type MockDbUser = {
  discord_id: string;
  discord_name: string;
  access_level: number;
  twitch_name: string | null;
  is_twitch_bot_enabled: boolean;
};

const BASE_USER: MockDbUser = {
  discord_id: '111',
  discord_name: 'TestUser',
  access_level: AccessLevel.USER,
  twitch_name: null,
  is_twitch_bot_enabled: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(upsertUser).mockResolvedValue(undefined);
  vi.mocked(updateTwitchBotEnabled).mockResolvedValue(undefined);
  vi.mocked(removeUser).mockResolvedValue(undefined);
  vi.mocked(joinTwitchChannel).mockResolvedValue(undefined);
  vi.mocked(partTwitchChannel).mockResolvedValue(undefined);
  vi.mocked(getTwitchEnabledChannels).mockResolvedValue([]);
});

describe('addOrUpdateUserMutation — shouldClearTwitchName', () => {
  it('passes null (not empty string) to upsertUser when clearing the Twitch name', async () => {
    vi.mocked(findUser)
      .mockResolvedValueOnce(null) // no pre-existing user
      .mockResolvedValueOnce({ ...BASE_USER, twitch_name: null } as any);

    await addOrUpdateUserMutation({
      discordId: '111',
      discordName: 'TestUser',
      level: 0,
      normalizedTwitchName: null,
      shouldClearTwitchName: true,
    });

    expect(vi.mocked(upsertUser)).toHaveBeenCalledWith('111', 'TestUser', 0, null);
  });
});

describe('addOrUpdateUserMutation — handleClearTwitchChannel rollback', () => {
  it('calls upsertUser with the previous channel name when partTwitchChannel throws', async () => {
    const existingUser: MockDbUser = {
      ...BASE_USER,
      twitch_name: 'streamerchan',
      is_twitch_bot_enabled: true,
    };

    vi.mocked(findUser)
      .mockResolvedValueOnce(existingUser as any) // existing state
      .mockResolvedValueOnce({ ...existingUser, twitch_name: null } as any); // after upsert

    vi.mocked(partTwitchChannel).mockRejectedValue(new Error('Part failed'));

    await expect(
      addOrUpdateUserMutation({
        discordId: '111',
        discordName: 'TestUser',
        level: 0,
        normalizedTwitchName: null,
        shouldClearTwitchName: true,
      }),
    ).rejects.toThrow('Part failed');

    const upsertCalls = vi.mocked(upsertUser).mock.calls;
    // First call: the main upsert (null to clear); second call: rollback (restores channel)
    expect(upsertCalls.length).toBeGreaterThanOrEqual(2);
    const rollbackCall = upsertCalls[upsertCalls.length - 1];
    expect(rollbackCall[3]).toBe('streamerchan');
  });
});

describe('addOrUpdateUserMutation — handleChangeTwitchChannel rollback', () => {
  it('calls upsertUser with null when previousChannel was null and joinTwitchChannel throws', async () => {
    const existingUser: MockDbUser = {
      ...BASE_USER,
      twitch_name: null,
      is_twitch_bot_enabled: true,
    };
    const afterUpsert: MockDbUser = {
      ...BASE_USER,
      twitch_name: 'newchan',
      is_twitch_bot_enabled: true,
    };

    vi.mocked(findUser)
      .mockResolvedValueOnce(existingUser as any)
      .mockResolvedValueOnce(afterUpsert as any);

    // newchan is in the enabled list so joinTwitchChannel is called
    vi.mocked(getTwitchEnabledChannels).mockResolvedValue(['newchan']);
    vi.mocked(joinTwitchChannel).mockRejectedValue(new Error('Join failed'));

    await expect(
      addOrUpdateUserMutation({
        discordId: '111',
        discordName: 'TestUser',
        level: 0,
        normalizedTwitchName: 'newchan',
        shouldClearTwitchName: false,
      }),
    ).rejects.toThrow('Join failed');

    const upsertCalls = vi.mocked(upsertUser).mock.calls;
    const rollbackCall = upsertCalls[upsertCalls.length - 1];
    // previousChannel was null — rollback must use null, not ''
    expect(rollbackCall[3]).toBeNull();
  });
});

describe('removeUserMutation — rollback on partTwitchChannel failure', () => {
  it('re-inserts the user when partTwitchChannel throws during removal', async () => {
    const existingUser: MockDbUser = {
      ...BASE_USER,
      twitch_name: 'streamerchan',
      is_twitch_bot_enabled: true,
    };

    vi.mocked(findUser).mockResolvedValue(existingUser as any);
    vi.mocked(partTwitchChannel).mockRejectedValue(new Error('Part failed'));

    await expect(removeUserMutation('111')).rejects.toThrow('Part failed');

    expect(vi.mocked(upsertUser)).toHaveBeenCalledWith(
      existingUser.discord_id,
      existingUser.discord_name,
      existingUser.access_level,
      existingUser.twitch_name,
    );
    expect(vi.mocked(updateTwitchBotEnabled)).toHaveBeenCalledWith(
      existingUser.discord_id,
      existingUser.is_twitch_bot_enabled,
    );
  });
});

describe('toggleTwitchMutation — rollback on join/part failure', () => {
  it('reverts updateTwitchBotEnabled when joinTwitchChannel throws', async () => {
    const user: MockDbUser = {
      ...BASE_USER,
      twitch_name: 'streamerchan',
      is_twitch_bot_enabled: false,
    };

    vi.mocked(findUser).mockResolvedValue(user as any);
    vi.mocked(getTwitchEnabledChannels).mockResolvedValue(['streamerchan']);
    vi.mocked(joinTwitchChannel).mockRejectedValue(new Error('Join failed'));

    await expect(toggleTwitchMutation('111', true)).rejects.toThrow('Join failed');

    expect(vi.mocked(updateTwitchBotEnabled)).toHaveBeenNthCalledWith(1, '111', true);
    expect(vi.mocked(updateTwitchBotEnabled)).toHaveBeenNthCalledWith(2, '111', false);
  });
});
