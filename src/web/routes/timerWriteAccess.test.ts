import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ACCESS_LEVEL_MOCK } from '../../test-utils/accessLevelMock';

vi.mock('../../db', () => {
  class TimerCommandNotFoundError extends Error {}
  class TimerSelfServiceDeniedError extends Error {}
  return {
    AccessLevel: ACCESS_LEVEL_MOCK,
    TimerCommandNotFoundError,
    TimerSelfServiceDeniedError,
    findUser: vi.fn(),
    getMemberAccessLevel: vi.fn(),
    updateTimerCommand: vi.fn().mockResolvedValue(undefined),
    updateOwnTimerCommand: vi.fn().mockResolvedValue(undefined),
    setTimerCommandEnabled: vi.fn().mockResolvedValue(undefined),
    setOwnTimerCommandEnabled: vi.fn().mockResolvedValue(undefined),
    removeTimerCommand: vi.fn().mockResolvedValue(undefined),
    removeOwnTimerCommand: vi.fn().mockResolvedValue(undefined),
    discardOwnNewTimerCommand: vi.fn().mockResolvedValue(undefined),
  };
});

import {
  discardNewTimerAsSessionUser,
  removeTimerAsSessionUser,
  resolveNewTimerAssignees,
  setTimerEnabledAsSessionUser,
  timerAccessErrorCode,
  updateTimerAsSessionUser,
} from './timerWriteAccess';
import {
  discardOwnNewTimerCommand,
  findUser,
  getMemberAccessLevel,
  removeOwnTimerCommand,
  removeTimerCommand,
  setOwnTimerCommandEnabled,
  setTimerCommandEnabled,
  TimerCommandNotFoundError,
  TimerSelfServiceDeniedError,
  updateOwnTimerCommand,
  updateTimerCommand,
} from '../../db';

const STREAMER_ID = '111111111111111111';
const OTHER_ID = '222222222222222222';
const THIRD_ID = '333333333333333333';
const GUILD_ID = '900000000000000001';

function req(accessLevel: number, body: Record<string, unknown> = {}): any {
  return { body, session: { user: { discordId: STREAMER_ID, accessLevel, currentGuildId: GUILD_ID } } };
}

const INPUT = { name: 'Plug', message: 'Hi', intervalSeconds: 600, minMessages: 0, requireLive: true, enabled: true };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getMemberAccessLevel).mockResolvedValue(0);
});

describe('timerAccessErrorCode', () => {
  it('maps not-found and denied errors to their redirect codes, and anything else to null', () => {
    expect(timerAccessErrorCode(new (TimerCommandNotFoundError as any)(1))).toBe('timer_not_found');
    expect(timerAccessErrorCode(new (TimerSelfServiceDeniedError as any)(1))).toBe('forbidden');
    expect(timerAccessErrorCode(new Error('boom'))).toBeNull();
  });
});

describe('resolveNewTimerAssignees', () => {
  it('checks every submitted discord_id for membership of the current guild', async () => {
    await expect(resolveNewTimerAssignees(req(ACCESS_LEVEL_MOCK.MOD, { discord_ids: [OTHER_ID, THIRD_ID] })))
      .resolves.toEqual({ discordIds: [OTHER_ID, THIRD_ID] });
    expect(getMemberAccessLevel).toHaveBeenCalledWith(GUILD_ID, OTHER_ID);
    expect(getMemberAccessLevel).toHaveBeenCalledWith(GUILD_ID, THIRD_ID);
  });

  it('returns assignee_not_in_guild when a Mod submits a discord_id outside the current guild', async () => {
    vi.mocked(getMemberAccessLevel).mockImplementation(async (_guildId, id) => (id === THIRD_ID ? null : 0));
    await expect(resolveNewTimerAssignees(req(ACCESS_LEVEL_MOCK.MOD, { discord_ids: [OTHER_ID, THIRD_ID] })))
      .resolves.toEqual({ error: 'assignee_not_in_guild' });
  });

  it('skips the membership lookup when a Mod submits no discord_ids', async () => {
    await expect(resolveNewTimerAssignees(req(ACCESS_LEVEL_MOCK.MOD))).resolves.toEqual({ discordIds: [] });
    expect(getMemberAccessLevel).not.toHaveBeenCalled();
  });

  it('lets a Mod pick any users from discord_ids', async () => {
    await expect(resolveNewTimerAssignees(req(ACCESS_LEVEL_MOCK.MOD, { discord_ids: OTHER_ID })))
      .resolves.toEqual({ discordIds: [OTHER_ID] });
    expect(findUser).not.toHaveBeenCalled();
  });

  it('assigns a linked streamer to themselves only, ignoring discord_ids', async () => {
    vi.mocked(findUser).mockResolvedValue({ discord_id: STREAMER_ID, twitch_name: 'streamer' } as any);
    await expect(resolveNewTimerAssignees(req(ACCESS_LEVEL_MOCK.USER, { discord_ids: OTHER_ID })))
      .resolves.toEqual({ discordIds: [STREAMER_ID] });
  });

  it('returns twitch_not_linked for a streamer with no Twitch account', async () => {
    vi.mocked(findUser).mockResolvedValue(null);
    await expect(resolveNewTimerAssignees(req(ACCESS_LEVEL_MOCK.USER))).resolves.toEqual({ error: 'twitch_not_linked' });
  });
});

describe('session-user timer writes', () => {
  it('use the unrestricted writes for a Mod', async () => {
    const modReq = req(ACCESS_LEVEL_MOCK.MOD);
    await updateTimerAsSessionUser(modReq, 1, INPUT);
    await setTimerEnabledAsSessionUser(modReq, 1, false);
    await removeTimerAsSessionUser(modReq, 1);
    await discardNewTimerAsSessionUser(modReq, 2);
    expect(updateTimerCommand).toHaveBeenCalledWith(1, INPUT);
    expect(setTimerCommandEnabled).toHaveBeenCalledWith(1, false);
    expect(removeTimerCommand).toHaveBeenNthCalledWith(1, 1);
    expect(removeTimerCommand).toHaveBeenNthCalledWith(2, 2);
    expect(updateOwnTimerCommand).not.toHaveBeenCalled();
  });

  it('use the owner-checked writes for a streamer below Mod', async () => {
    const streamerReq = req(ACCESS_LEVEL_MOCK.USER);
    await updateTimerAsSessionUser(streamerReq, 1, INPUT);
    await setTimerEnabledAsSessionUser(streamerReq, 1, true);
    await removeTimerAsSessionUser(streamerReq, 1);
    await discardNewTimerAsSessionUser(streamerReq, 2);
    expect(updateOwnTimerCommand).toHaveBeenCalledWith(1, INPUT, STREAMER_ID);
    expect(setOwnTimerCommandEnabled).toHaveBeenCalledWith(1, true, STREAMER_ID);
    expect(removeOwnTimerCommand).toHaveBeenCalledWith(1, STREAMER_ID);
    expect(discardOwnNewTimerCommand).toHaveBeenCalledWith(2, STREAMER_ID);
    expect(removeTimerCommand).not.toHaveBeenCalled();
  });
});
