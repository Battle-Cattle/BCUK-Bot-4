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
    updateCustomCommand: vi.fn().mockResolvedValue(undefined),
    updateOwnCustomCommand: vi.fn().mockResolvedValue(undefined),
    removeCustomCommand: vi.fn().mockResolvedValue(undefined),
    removeOwnCustomCommand: vi.fn().mockResolvedValue(undefined),
  };
});

import {
  commandAccessErrorCode,
  readCommandForm,
  removeCommandAsSessionUser,
  resolveNewCommandAssignees,
  updateCommandAsSessionUser,
} from './commandWriteAccess';
import {
  CommandNotFoundError,
  CommandSelfServiceDeniedError,
  findUser,
  removeCustomCommand,
  removeOwnCustomCommand,
  updateCustomCommand,
  updateOwnCustomCommand,
} from '../../db';

const STREAMER_ID = '111111111111111111';
const OTHER_ID = '222222222222222222';

function req(accessLevel: number, body: Record<string, unknown> = {}): any {
  return { body, session: { user: { discordId: STREAMER_ID, accessLevel } } };
}

const FORM = { triggerString: '!hi', output: 'hi', isDiscordEnabled: true, isMultiTwitch: true };

beforeEach(() => {
  vi.clearAllMocks();
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

describe('resolveNewCommandAssignees', () => {
  it('uses the submitted discord_ids for a Mod', async () => {
    expect(await resolveNewCommandAssignees(req(ACCESS_LEVEL_MOCK.MOD, { discord_ids: [OTHER_ID] }))).toEqual({ discordIds: [OTHER_ID] });
    expect(findUser).not.toHaveBeenCalled();
  });

  it("assigns a streamer's command to themselves only, ignoring discord_ids", async () => {
    vi.mocked(findUser).mockResolvedValue({ discord_id: STREAMER_ID, twitch_name: 'streamer' } as any);
    expect(await resolveNewCommandAssignees(req(ACCESS_LEVEL_MOCK.USER, { discord_ids: [OTHER_ID] }))).toEqual({ discordIds: [STREAMER_ID] });
  });

  it('returns twitch_not_linked for a streamer without a Twitch account', async () => {
    vi.mocked(findUser).mockResolvedValue({ discord_id: STREAMER_ID, twitch_name: null } as any);
    expect(await resolveNewCommandAssignees(req(ACCESS_LEVEL_MOCK.USER))).toEqual({ error: 'twitch_not_linked' });
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
