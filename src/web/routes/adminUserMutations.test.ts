import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ACCESS_LEVEL_MOCK } from '../../test-utils/accessLevelMock';

vi.mock('../../db', () => ({
  findUser: vi.fn(),
  findUserByTwitchName: vi.fn(),
  upsertUser: vi.fn(),
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

vi.mock('../../db/users', () => ({ AccessLevel: ACCESS_LEVEL_MOCK }));

import {
  addOrUpdateUserMutation,
  toggleTwitchMutation,
  DuplicateTwitchNameError,
  isLockWaitTimeoutDbError,
  isDuplicateTwitchNameDbError,
} from './adminUserMutations';
import {
  findUser,
  findUserByTwitchName,
  upsertUser,
  updateTwitchBotEnabled,
  getTwitchEnabledChannels,
} from '../../db';
import { joinTwitchChannel, partTwitchChannel } from '../../twitch/twitchChannelMembership';
import { normalizeTwitchChannelName } from '../../twitch/twitchChannelName';
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

describe('toggleTwitchMutation — validation and no-op', () => {
  it('throws when the target user does not exist', async () => {
    vi.mocked(findUser).mockResolvedValue(null as any);

    await expect(toggleTwitchMutation('111', true)).rejects.toThrow(
      'Toggle target user is missing or has no Twitch channel',
    );
  });

  it('throws when the target user has no Twitch channel', async () => {
    vi.mocked(findUser).mockResolvedValue({ ...BASE_USER, twitch_name: null } as any);

    await expect(toggleTwitchMutation('111', true)).rejects.toThrow(
      'Toggle target user is missing or has no Twitch channel',
    );
  });

  it('throws when the Twitch channel normalizes to an invalid value', async () => {
    vi.mocked(findUser).mockResolvedValue({ ...BASE_USER, twitch_name: 'bad chan!!' } as any);
    vi.mocked(normalizeTwitchChannelName).mockReturnValueOnce(null);

    await expect(toggleTwitchMutation('111', true)).rejects.toThrow(
      'Toggle target user has an invalid Twitch channel',
    );
  });

  it('is a no-op when the requested state matches the current state', async () => {
    vi.mocked(findUser).mockResolvedValue({
      ...BASE_USER,
      twitch_name: 'streamerchan',
      is_twitch_bot_enabled: true,
    } as any);

    await expect(toggleTwitchMutation('111', true)).resolves.toBeUndefined();

    expect(vi.mocked(updateTwitchBotEnabled)).not.toHaveBeenCalled();
    expect(vi.mocked(getTwitchEnabledChannels)).not.toHaveBeenCalled();
  });

  it('parts the channel when it is not in the enabled list', async () => {
    vi.mocked(findUser).mockResolvedValue({
      ...BASE_USER,
      twitch_name: 'streamerchan',
      is_twitch_bot_enabled: false,
    } as any);
    vi.mocked(getTwitchEnabledChannels).mockResolvedValue([]);

    await expect(toggleTwitchMutation('111', true)).resolves.toBeUndefined();

    expect(vi.mocked(partTwitchChannel)).toHaveBeenCalledWith('streamerchan');
    expect(vi.mocked(joinTwitchChannel)).not.toHaveBeenCalled();
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

  it('logs when the rollback updateTwitchBotEnabled call also fails, and still rethrows the original error', async () => {
    const user: MockDbUser = {
      ...BASE_USER,
      twitch_name: 'streamerchan',
      is_twitch_bot_enabled: false,
    };

    vi.mocked(findUser).mockResolvedValue(user as any);
    vi.mocked(getTwitchEnabledChannels).mockResolvedValue(['streamerchan']);
    vi.mocked(joinTwitchChannel).mockRejectedValue(new Error('Join failed'));
    vi.mocked(updateTwitchBotEnabled)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('Rollback update failed'));

    await expect(toggleTwitchMutation('111', true)).rejects.toThrow('Join failed');

    expect(vi.mocked(updateTwitchBotEnabled)).toHaveBeenNthCalledWith(1, '111', true);
    expect(vi.mocked(updateTwitchBotEnabled)).toHaveBeenNthCalledWith(2, '111', false);
  });
});

describe('addOrUpdateUserMutation — DuplicateTwitchNameError', () => {
  it('throws DuplicateTwitchNameError when another user already has the given Twitch name', async () => {
    vi.mocked(findUser)
      .mockResolvedValueOnce(null); // no pre-existing user for this discordId

    // findUserByTwitchName returns a conflicting user
    vi.mocked(findUserByTwitchName).mockResolvedValue({ discord_id: '999' } as any);

    await expect(
      addOrUpdateUserMutation({
        discordId: '111',
        discordName: 'TestUser',
        level: AccessLevel.USER,
        normalizedTwitchName: 'taken_chan',
        shouldClearTwitchName: false,
      }),
    ).rejects.toBeInstanceOf(DuplicateTwitchNameError);

    expect(vi.mocked(upsertUser)).not.toHaveBeenCalled();
  });
});

describe('addOrUpdateUserMutation — upsertUser throws', () => {
  it('does not attempt Twitch channel changes when upsertUser throws', async () => {
    vi.mocked(findUser)
      .mockResolvedValueOnce({
        ...BASE_USER,
        twitch_name: 'existing_chan',
        is_twitch_bot_enabled: true,
      } as any);

    // No conflict on the Twitch name check
    vi.mocked(findUserByTwitchName).mockResolvedValue(null);

    vi.mocked(upsertUser).mockRejectedValue(new Error('DB write failed'));

    await expect(
      addOrUpdateUserMutation({
        discordId: '111',
        discordName: 'TestUser',
        level: AccessLevel.USER,
        normalizedTwitchName: 'new_chan',
        shouldClearTwitchName: false,
      }),
    ).rejects.toThrow('DB write failed');

    expect(vi.mocked(joinTwitchChannel)).not.toHaveBeenCalled();
    expect(vi.mocked(partTwitchChannel)).not.toHaveBeenCalled();
  });
});

describe('isLockWaitTimeoutDbError', () => {
  it('returns false for non-object errors', () => {
    expect(isLockWaitTimeoutDbError(null)).toBe(false);
    expect(isLockWaitTimeoutDbError('boom')).toBe(false);
  });

  it('returns true when errno is 1205', () => {
    expect(isLockWaitTimeoutDbError({ errno: 1205 })).toBe(true);
  });

  it('returns true when code is ER_LOCK_WAIT_TIMEOUT', () => {
    expect(isLockWaitTimeoutDbError({ code: 'ER_LOCK_WAIT_TIMEOUT' })).toBe(true);
  });

  it('returns false for an unrelated error object', () => {
    expect(isLockWaitTimeoutDbError({ errno: 500, code: 'OTHER' })).toBe(false);
  });
});

describe('isDuplicateTwitchNameDbError', () => {
  it('returns false for non-object errors', () => {
    expect(isDuplicateTwitchNameDbError(null)).toBe(false);
    expect(isDuplicateTwitchNameDbError('boom')).toBe(false);
  });

  it('returns true when code is ER_DUP_ENTRY and message references the Twitch name index', () => {
    expect(
      isDuplicateTwitchNameDbError({ code: 'ER_DUP_ENTRY', message: "Duplicate entry for key 'ux_user_twitch_name'" }),
    ).toBe(true);
  });

  it('returns false when code is ER_DUP_ENTRY but message references a different index', () => {
    expect(
      isDuplicateTwitchNameDbError({ code: 'ER_DUP_ENTRY', message: "Duplicate entry for key 'other_index'" }),
    ).toBe(false);
  });

  it('returns false when code is ER_DUP_ENTRY but message is missing', () => {
    expect(isDuplicateTwitchNameDbError({ code: 'ER_DUP_ENTRY' })).toBe(false);
  });

  it('returns false when code is not ER_DUP_ENTRY', () => {
    expect(isDuplicateTwitchNameDbError({ code: 'ER_OTHER', message: 'ux_user_twitch_name' })).toBe(false);
  });
});

describe('addOrUpdateUserMutation — successful Twitch channel clear (no rollback)', () => {
  it('resolves without throwing and skips partTwitchChannel when the channel is still enabled elsewhere', async () => {
    const existingUser: MockDbUser = {
      ...BASE_USER,
      twitch_name: 'oldchan',
      is_twitch_bot_enabled: true,
    };

    vi.mocked(findUser)
      .mockResolvedValueOnce(existingUser as any)
      .mockResolvedValueOnce({ ...existingUser, twitch_name: null } as any);
    vi.mocked(getTwitchEnabledChannels).mockResolvedValue(['oldchan']);

    await expect(
      addOrUpdateUserMutation({
        discordId: '111',
        discordName: 'TestUser',
        level: AccessLevel.USER,
        normalizedTwitchName: null,
        shouldClearTwitchName: true,
      }),
    ).resolves.toBeUndefined();

    expect(vi.mocked(partTwitchChannel)).not.toHaveBeenCalled();
    expect(vi.mocked(updateTwitchBotEnabled)).toHaveBeenCalledWith('111', false);
  });
});

describe('addOrUpdateUserMutation — brand new user with a Twitch channel', () => {
  it('joins the channel for a newly created user (no previous channel to part)', async () => {
    vi.mocked(findUser)
      .mockResolvedValueOnce(null) // no pre-existing user
      .mockResolvedValueOnce({ ...BASE_USER, twitch_name: 'newchan', is_twitch_bot_enabled: true } as any);
    vi.mocked(findUserByTwitchName).mockResolvedValue(null);
    vi.mocked(getTwitchEnabledChannels).mockResolvedValue(['newchan']);

    await expect(
      addOrUpdateUserMutation({
        discordId: '111',
        discordName: 'TestUser',
        level: AccessLevel.USER,
        normalizedTwitchName: 'newchan',
        shouldClearTwitchName: false,
      }),
    ).resolves.toBeUndefined();

    expect(vi.mocked(joinTwitchChannel)).toHaveBeenCalledWith('newchan');
    expect(vi.mocked(partTwitchChannel)).not.toHaveBeenCalled();
  });
});

describe('addOrUpdateUserMutation — updating a user without touching the Twitch name', () => {
  it('passes undefined for the Twitch name to upsertUser and leaves Twitch channels untouched', async () => {
    const existingUser: MockDbUser = {
      ...BASE_USER,
      twitch_name: null,
      is_twitch_bot_enabled: false,
    };
    vi.mocked(findUser)
      .mockResolvedValueOnce(existingUser as any)
      .mockResolvedValueOnce(existingUser as any);

    await expect(
      addOrUpdateUserMutation({
        discordId: '111',
        discordName: 'TestUser',
        level: AccessLevel.MOD,
        normalizedTwitchName: null,
        shouldClearTwitchName: false,
      }),
    ).resolves.toBeUndefined();

    expect(vi.mocked(upsertUser)).toHaveBeenCalledWith('111', 'TestUser', AccessLevel.MOD, undefined);
    expect(vi.mocked(joinTwitchChannel)).not.toHaveBeenCalled();
    expect(vi.mocked(partTwitchChannel)).not.toHaveBeenCalled();
  });
});

describe('addOrUpdateUserMutation — successful Twitch channel change (no rollback)', () => {
  it('joins the new channel and parts the old one when both succeed', async () => {
    const existingUser: MockDbUser = {
      ...BASE_USER,
      twitch_name: 'oldchan',
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
    vi.mocked(findUserByTwitchName).mockResolvedValue(null);
    vi.mocked(getTwitchEnabledChannels).mockResolvedValue(['newchan']);

    await expect(
      addOrUpdateUserMutation({
        discordId: '111',
        discordName: 'TestUser',
        level: AccessLevel.USER,
        normalizedTwitchName: 'newchan',
        shouldClearTwitchName: false,
      }),
    ).resolves.toBeUndefined();

    expect(vi.mocked(joinTwitchChannel)).toHaveBeenCalledWith('newchan');
    expect(vi.mocked(partTwitchChannel)).toHaveBeenCalledWith('oldchan');
  });

  it('does not part the previous channel when it is still enabled for another user', async () => {
    const existingUser: MockDbUser = {
      ...BASE_USER,
      twitch_name: 'oldchan',
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
    vi.mocked(findUserByTwitchName).mockResolvedValue(null);
    vi.mocked(getTwitchEnabledChannels).mockResolvedValue(['newchan', 'oldchan']);

    await expect(
      addOrUpdateUserMutation({
        discordId: '111',
        discordName: 'TestUser',
        level: AccessLevel.USER,
        normalizedTwitchName: 'newchan',
        shouldClearTwitchName: false,
      }),
    ).resolves.toBeUndefined();

    expect(vi.mocked(joinTwitchChannel)).toHaveBeenCalledWith('newchan');
    expect(vi.mocked(partTwitchChannel)).not.toHaveBeenCalled();
  });
});

describe('addOrUpdateUserMutation — handleChangeTwitchChannel rollback also fails', () => {
  it('rejoins the previous channel, reparts the committed channel, logs when that rollback also fails, and rethrows the original error', async () => {
    const existingUser: MockDbUser = {
      ...BASE_USER,
      twitch_name: 'oldchan',
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
    vi.mocked(findUserByTwitchName).mockResolvedValue(null);

    // Main try: newchan not enabled (no join), oldchan not enabled either => part(oldchan) is attempted and fails.
    // Rollback: oldchan is enabled (rejoin) and newchan is not (repart), but the repart also fails.
    vi.mocked(getTwitchEnabledChannels)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(['oldchan']);
    vi.mocked(partTwitchChannel)
      .mockRejectedValueOnce(new Error('Part failed'))
      .mockRejectedValueOnce(new Error('Rollback part failed'));
    vi.mocked(joinTwitchChannel).mockResolvedValue(undefined);

    await expect(
      addOrUpdateUserMutation({
        discordId: '111',
        discordName: 'TestUser',
        level: AccessLevel.USER,
        normalizedTwitchName: 'newchan',
        shouldClearTwitchName: false,
      }),
    ).rejects.toThrow('Part failed');

    expect(vi.mocked(joinTwitchChannel)).toHaveBeenCalledWith('oldchan');
    expect(vi.mocked(partTwitchChannel)).toHaveBeenNthCalledWith(1, 'oldchan');
    expect(vi.mocked(partTwitchChannel)).toHaveBeenNthCalledWith(2, 'newchan');
  });
});

describe('addOrUpdateUserMutation — rollback failure does not mask original error', () => {
  it('propagates the original partTwitchChannel error even when the rollback upsertUser also throws', async () => {
    const existingUser: MockDbUser = {
      ...BASE_USER,
      twitch_name: 'streamerchan',
      is_twitch_bot_enabled: true,
    };

    vi.mocked(findUser)
      .mockResolvedValueOnce(existingUser as any)
      .mockResolvedValueOnce({ ...existingUser, twitch_name: null } as any);

    vi.mocked(partTwitchChannel).mockRejectedValue(new Error('Part failed'));
    // The rollback upsertUser also fails
    vi.mocked(upsertUser)
      .mockResolvedValueOnce(undefined) // first call (main upsert) succeeds
      .mockRejectedValueOnce(new Error('Rollback DB error')); // second call (rollback) fails

    // The original "Part failed" error must be thrown, not the rollback error
    await expect(
      addOrUpdateUserMutation({
        discordId: '111',
        discordName: 'TestUser',
        level: AccessLevel.USER,
        normalizedTwitchName: null,
        shouldClearTwitchName: true,
      }),
    ).rejects.toThrow('Part failed');
  });
});
