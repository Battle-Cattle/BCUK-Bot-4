import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ACCESS_LEVEL_MOCK } from '../../test-utils/accessLevelMock';

vi.mock('../../db', () => {
  class CommandNotFoundError extends Error {}
  class CommandSelfServiceDeniedError extends Error {}
  return {
    AccessLevel: ACCESS_LEVEL_MOCK,
    CommandNotFoundError,
    CommandSelfServiceDeniedError,
    findUser: vi.fn(),
    getMemberAccessLevel: vi.fn(),
    discardOwnNewCustomCommand: vi.fn().mockResolvedValue(undefined),
    updateCustomCommand: vi.fn().mockResolvedValue(undefined),
    updateOwnCustomCommand: vi.fn().mockResolvedValue(undefined),
    removeCustomCommand: vi.fn().mockResolvedValue(undefined),
    removeOwnCustomCommand: vi.fn().mockResolvedValue(undefined),
  };
});

import {
  commandAccessErrorCode,
  discardNewCommandAsSessionUser,
  readCommandForm,
  removeCommandAsSessionUser,
  updateCommandAsSessionUser,
} from './commandWriteAccess';
import {
  CommandNotFoundError,
  CommandSelfServiceDeniedError,
  discardOwnNewCustomCommand,
  getMemberAccessLevel,
  removeCustomCommand,
  removeOwnCustomCommand,
  updateCustomCommand,
  updateOwnCustomCommand,
} from '../../db';

const STREAMER_ID = '111111111111111111';
const GUILD_ID = '900000000000000001';

function req(accessLevel: number, body: Record<string, unknown> = {}): any {
  return { body, session: { user: { discordId: STREAMER_ID, accessLevel, currentGuildId: GUILD_ID } } };
}

const FORM = { triggerString: '!hi', output: 'hi', isDiscordEnabled: true, isMultiTwitch: true };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getMemberAccessLevel).mockResolvedValue(0);
});

describe('readCommandForm', () => {
  const body = { trigger_string: '!hi', output: 'hi', is_discord_enabled: 'on', is_multi_twitch: 'on' };

  it('keeps the Discord/multi-Twitch flags for a Mod', () => {
    expect(readCommandForm(req(ACCESS_LEVEL_MOCK.MOD, body))).toEqual(FORM);
  });

  it('forces the flags off for a streamer', () => {
    expect(readCommandForm(req(ACCESS_LEVEL_MOCK.USER, body))).toMatchObject({ isDiscordEnabled: false, isMultiTwitch: false });
  });

  it('returns null when the trigger or output is missing', () => {
    expect(readCommandForm(req(ACCESS_LEVEL_MOCK.MOD, { output: 'hi' }))).toBeNull();
    expect(readCommandForm(req(ACCESS_LEVEL_MOCK.MOD, { trigger_string: '!hi' }))).toBeNull();
  });
});

describe('commandAccessErrorCode', () => {
  it('maps not-found and self-service denials, and nothing else', () => {
    expect(commandAccessErrorCode(new CommandNotFoundError(5))).toBe('command_not_found');
    expect(commandAccessErrorCode(new CommandSelfServiceDeniedError(5))).toBe('forbidden');
    expect(commandAccessErrorCode(new Error('other'))).toBeNull();
  });
});

describe('updateCommandAsSessionUser', () => {
  it('uses the unrestricted update for a Mod', async () => {
    await updateCommandAsSessionUser(req(ACCESS_LEVEL_MOCK.MOD), 5, FORM);
    expect(updateCustomCommand).toHaveBeenCalledWith(5, '!hi', 'hi', true, true);
    expect(updateOwnCustomCommand).not.toHaveBeenCalled();
  });

  it("uses the owner-checked update with the streamer's ID for a streamer", async () => {
    await updateCommandAsSessionUser(req(ACCESS_LEVEL_MOCK.USER), 5, FORM);
    expect(updateOwnCustomCommand).toHaveBeenCalledWith(5, '!hi', 'hi', STREAMER_ID);
    expect(updateCustomCommand).not.toHaveBeenCalled();
  });
});

describe('removeCommandAsSessionUser', () => {
  it('uses the unrestricted delete for a Mod', async () => {
    await removeCommandAsSessionUser(req(ACCESS_LEVEL_MOCK.MOD), 5);
    expect(removeCustomCommand).toHaveBeenCalledWith(5);
    expect(removeOwnCustomCommand).not.toHaveBeenCalled();
  });

  it("uses the owner-checked delete with the streamer's ID for a streamer", async () => {
    await removeCommandAsSessionUser(req(ACCESS_LEVEL_MOCK.USER), 5);
    expect(removeOwnCustomCommand).toHaveBeenCalledWith(5, STREAMER_ID);
    expect(removeCustomCommand).not.toHaveBeenCalled();
  });
});

describe('discardNewCommandAsSessionUser', () => {
  it('uses the unrestricted delete for a Mod', async () => {
    await discardNewCommandAsSessionUser(req(ACCESS_LEVEL_MOCK.MOD), 5);
    expect(removeCustomCommand).toHaveBeenCalledWith(5);
    expect(discardOwnNewCustomCommand).not.toHaveBeenCalled();
  });

  it("uses the unclaimed-only cleanup with the streamer's ID for a streamer", async () => {
    await discardNewCommandAsSessionUser(req(ACCESS_LEVEL_MOCK.USER), 5);
    expect(discardOwnNewCustomCommand).toHaveBeenCalledWith(5, STREAMER_ID);
    expect(removeCustomCommand).not.toHaveBeenCalled();
  });
});
