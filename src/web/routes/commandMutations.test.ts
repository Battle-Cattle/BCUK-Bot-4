import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockLogger } from '../../test-utils/loggerMock';
import { ACCESS_LEVEL_MOCK } from '../../test-utils/accessLevelMock';

vi.mock('../../db', () => {
  class CommandConflictError extends Error {}
  class CommandNotFoundError extends Error {}
  class CommandSelfServiceDeniedError extends Error {}
  class ReservedCommandError extends Error {}
  return {
    addCustomCommand: vi.fn().mockResolvedValue(1),
    updateCustomCommand: vi.fn().mockResolvedValue(undefined),
    removeCustomCommand: vi.fn().mockResolvedValue(undefined),
    assignUsersToCommand: vi.fn().mockResolvedValue(undefined),
    findUsersByIds: vi.fn().mockResolvedValue(new Map()),
    findUser: vi.fn().mockResolvedValue(null),
    getMemberAccessLevel: vi.fn().mockResolvedValue(0),
    updateOwnCustomCommand: vi.fn().mockResolvedValue(undefined),
    removeOwnCustomCommand: vi.fn().mockResolvedValue(undefined),
    discardOwnNewCustomCommand: vi.fn().mockResolvedValue(undefined),
    CommandConflictError,
    CommandNotFoundError,
    CommandSelfServiceDeniedError,
    ReservedCommandError,
    isMysqlDuplicateEntryError: vi.fn().mockReturnValue(false),
    AccessLevel: ACCESS_LEVEL_MOCK,
  };
});
vi.mock('../csrf', () => ({ csrfProtection: (_req: any, _res: any, next: any) => next() }));
const { middlewareCallOrder } = vi.hoisted(() => ({ middlewareCallOrder: [] as string[] }));
vi.mock('../middleware', () => ({
  requireGuildContext: (_req: any, _res: any, next: any) => { middlewareCallOrder.push('requireGuildContext'); next(); },
  requireMod: (_req: any, _res: any, next: any) => { middlewareCallOrder.push('requireMod'); next(); },
}));
vi.mock('../../shared/logger', () => ({ createLogger: mockLogger }));

import supertest from 'supertest';
import router from './commandMutations';
import {
  addCustomCommand, updateCustomCommand, removeCustomCommand,
  assignUsersToCommand, findUsersByIds, findUser, getMemberAccessLevel, updateOwnCustomCommand, removeOwnCustomCommand, discardOwnNewCustomCommand, CommandSelfServiceDeniedError,
  CommandConflictError, CommandNotFoundError, ReservedCommandError,
  isMysqlDuplicateEntryError,
} from '../../db';
import { AccessLevel } from '../../db';
import { buildTestApp } from '../../test-utils/expressTestApp';

const GUILD_ID = '900000000000000001';
const MOD_SESSION_USER = { discordId: '1', discordName: 'Mod', accessLevel: ACCESS_LEVEL_MOCK.MOD, currentGuildId: GUILD_ID };

/** Builds a supertest-ready app: the command mutations router with a urlencoded body parser and a Mod session user by default. */
function buildApp(sessionUser: unknown = MOD_SESSION_USER) {
  return buildTestApp({ router, bodyParser: 'urlencoded', sessionUser });
}

const VALID_DISCORD_ID = '123456789012345678';

beforeEach(() => {
  vi.clearAllMocks();
  middlewareCallOrder.length = 0;
  vi.mocked(addCustomCommand).mockResolvedValue(1);
  vi.mocked(updateCustomCommand).mockResolvedValue(undefined);
  vi.mocked(removeCustomCommand).mockResolvedValue(undefined);
  vi.mocked(assignUsersToCommand).mockResolvedValue(undefined);
  vi.mocked(findUsersByIds).mockResolvedValue(new Map());
  vi.mocked(findUser).mockResolvedValue(null);
  vi.mocked(getMemberAccessLevel).mockResolvedValue(0);
  vi.mocked(updateOwnCustomCommand).mockResolvedValue(undefined);
  vi.mocked(removeOwnCustomCommand).mockResolvedValue(undefined);
  vi.mocked(discardOwnNewCustomCommand).mockResolvedValue(undefined);
  vi.mocked(isMysqlDuplicateEntryError).mockReturnValue(false);
});

// ─── POST /commands/add ───────────────────────────────────────────────────────

describe('POST /commands/add', () => {
  it('runs requireGuildContext (not requireMod), so the handler sees a fresh access level and can allow streamer self-service', async () => {
    await supertest(buildApp())
      .post('/commands/add')
      .send('trigger_string=!clap&output=Clap%21');
    expect(middlewareCallOrder).toEqual(['requireGuildContext']);
  });

  it('redirects to /commands on success', async () => {
    const res = await supertest(buildApp())
      .post('/commands/add')
      .send('trigger_string=!clap&output=Clap%21');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/commands');
  });

  it('redirects to ?error=missing_fields when trigger_string is absent', async () => {
    const res = await supertest(buildApp()).post('/commands/add').send('output=out');
    expect(res.headers.location).toBe('/commands?error=missing_fields');
  });

  it('redirects to ?error=missing_fields when trigger_string has whitespace only', async () => {
    const res = await supertest(buildApp()).post('/commands/add').send('trigger_string=%20&output=out');
    expect(res.headers.location).toBe('/commands?error=missing_fields');
  });

  it('redirects to ?error=missing_fields without adding when trigger_string contains internal whitespace', async () => {
    const res = await supertest(buildApp()).post('/commands/add').send('trigger_string=!hello%20world&output=out');
    expect(res.headers.location).toBe('/commands?error=missing_fields');
    expect(addCustomCommand).not.toHaveBeenCalled();
  });

  it('redirects to ?error=missing_fields when output is absent', async () => {
    const res = await supertest(buildApp()).post('/commands/add').send('trigger_string=!clap');
    expect(res.headers.location).toBe('/commands?error=missing_fields');
  });

  it('redirects to ?error=reserved_command when ReservedCommandError is thrown', async () => {
    vi.mocked(addCustomCommand).mockRejectedValueOnce(new (ReservedCommandError as any)('reserved'));
    const res = await supertest(buildApp()).post('/commands/add').send('trigger_string=!sfx&output=out');
    expect(res.headers.location).toBe('/commands?error=reserved_command');
  });

  it('redirects to ?error=command_taken when CommandConflictError is thrown', async () => {
    vi.mocked(addCustomCommand).mockRejectedValueOnce(new (CommandConflictError as any)('conflict'));
    const res = await supertest(buildApp()).post('/commands/add').send('trigger_string=!clap&output=out');
    expect(res.headers.location).toBe('/commands?error=command_taken');
  });

  it('redirects to ?error=add_failed on unexpected error', async () => {
    vi.mocked(addCustomCommand).mockRejectedValueOnce(new Error('DB down'));
    const res = await supertest(buildApp()).post('/commands/add').send('trigger_string=!clap&output=out');
    expect(res.headers.location).toBe('/commands?error=add_failed');
  });

  it('redirects to ?error=assignee_not_in_guild without creating anything when a discord_id is not a member of the current guild', async () => {
    vi.mocked(getMemberAccessLevel).mockResolvedValue(null);
    const res = await supertest(buildApp())
      .post('/commands/add').send(`trigger_string=!clap&output=Clap&discord_ids=${VALID_DISCORD_ID}`);
    expect(res.headers.location).toBe('/commands?error=assignee_not_in_guild');
    expect(getMemberAccessLevel).toHaveBeenCalledWith(GUILD_ID, VALID_DISCORD_ID);
    expect(addCustomCommand).not.toHaveBeenCalled();
    expect(assignUsersToCommand).not.toHaveBeenCalled();
  });

  it('assigns users when discord_ids are provided and user has twitch_name', async () => {
    vi.mocked(findUsersByIds).mockResolvedValue(new Map([
      [VALID_DISCORD_ID, { discord_id: VALID_DISCORD_ID, discord_name: 'Alice', is_twitch_bot_enabled: false, twitch_name: 'alice', access_level: AccessLevel.USER } as any],
    ]));
    const res = await supertest(buildApp())
      .post('/commands/add')
      .send(`trigger_string=!clap&output=Clap&discord_ids=${VALID_DISCORD_ID}`);
    expect(res.headers.location).toBe('/commands');
    expect(assignUsersToCommand).toHaveBeenCalledWith(1, [VALID_DISCORD_ID]);
    expect(getMemberAccessLevel).toHaveBeenCalledWith(GUILD_ID, VALID_DISCORD_ID);
  });

  it('assigns every valid user when discord_ids is sent as a repeated field (array)', async () => {
    const OTHER_DISCORD_ID = '223456789012345678';
    vi.mocked(findUsersByIds).mockResolvedValue(new Map([
      [VALID_DISCORD_ID, { discord_id: VALID_DISCORD_ID, twitch_name: 'alice' } as any],
      [OTHER_DISCORD_ID, { discord_id: OTHER_DISCORD_ID, twitch_name: 'bob' } as any],
    ]));
    const res = await supertest(buildApp())
      .post('/commands/add')
      .send(`trigger_string=!clap&output=Clap&discord_ids=${VALID_DISCORD_ID}&discord_ids=${OTHER_DISCORD_ID}`);
    expect(res.headers.location).toBe('/commands');
    expect(assignUsersToCommand).toHaveBeenCalledWith(1, [VALID_DISCORD_ID, OTHER_DISCORD_ID]);
  });

  it('skips assigning a user who exists but has no twitch_name', async () => {
    vi.mocked(findUsersByIds).mockResolvedValue(new Map([
      [VALID_DISCORD_ID, { discord_id: VALID_DISCORD_ID, twitch_name: null } as any],
    ]));
    const res = await supertest(buildApp())
      .post('/commands/add')
      .send(`trigger_string=!clap&output=Clap&discord_ids=${VALID_DISCORD_ID}`);
    expect(res.headers.location).toBe('/commands');
    expect(assignUsersToCommand).toHaveBeenCalledWith(1, []);
  });

  it('skips assigning user when findUsersByIds does not return a matching entry', async () => {
    vi.mocked(findUsersByIds).mockResolvedValue(new Map());
    const res = await supertest(buildApp())
      .post('/commands/add')
      .send(`trigger_string=!clap&output=Clap&discord_ids=${VALID_DISCORD_ID}`);
    expect(res.headers.location).toBe('/commands');
    expect(assignUsersToCommand).toHaveBeenCalledWith(1, []);
  });

  it('redirects to ?error=command_taken when assignUsersToCommand throws CommandConflictError', async () => {
    vi.mocked(findUsersByIds).mockResolvedValue(new Map([
      [VALID_DISCORD_ID, { discord_id: VALID_DISCORD_ID, twitch_name: 'alice', discord_name: null, is_twitch_bot_enabled: false, access_level: AccessLevel.USER } as any],
    ]));
    vi.mocked(assignUsersToCommand).mockRejectedValueOnce(new (CommandConflictError as any)('conflict'));
    const res = await supertest(buildApp())
      .post('/commands/add')
      .send(`trigger_string=!clap&output=Clap&discord_ids=${VALID_DISCORD_ID}`);
    expect(res.headers.location).toBe('/commands?error=command_taken');
    expect(removeCustomCommand).toHaveBeenCalledWith(1); // cleanup
  });

  it('redirects to ?error=assign_failed on unexpected assign error', async () => {
    vi.mocked(findUsersByIds).mockResolvedValue(new Map([
      [VALID_DISCORD_ID, { discord_id: VALID_DISCORD_ID, twitch_name: 'alice', discord_name: null, is_twitch_bot_enabled: false, access_level: AccessLevel.USER } as any],
    ]));
    vi.mocked(assignUsersToCommand).mockRejectedValueOnce(new Error('DB error'));
    const res = await supertest(buildApp())
      .post('/commands/add')
      .send(`trigger_string=!clap&output=Clap&discord_ids=${VALID_DISCORD_ID}`);
    expect(res.headers.location).toBe('/commands?error=assign_failed');
  });

  it('redirects to ?error=assign_failed when findUsersByIds itself throws', async () => {
    vi.mocked(findUsersByIds).mockRejectedValueOnce(new Error('DB down'));
    const res = await supertest(buildApp())
      .post('/commands/add')
      .send(`trigger_string=!clap&output=Clap&discord_ids=${VALID_DISCORD_ID}`);
    expect(res.headers.location).toBe('/commands?error=assign_failed');
    expect(removeCustomCommand).toHaveBeenCalledWith(1); // cleanup
  });

  it('still redirects to ?error=assign_failed when the cleanup delete itself also fails', async () => {
    vi.mocked(findUsersByIds).mockRejectedValueOnce(new Error('DB down'));
    vi.mocked(removeCustomCommand).mockRejectedValueOnce(new Error('cleanup also failed'));
    const res = await supertest(buildApp())
      .post('/commands/add')
      .send(`trigger_string=!clap&output=Clap&discord_ids=${VALID_DISCORD_ID}`);
    expect(res.headers.location).toBe('/commands?error=assign_failed');
    expect(removeCustomCommand).toHaveBeenCalledWith(1);
  });
});

// ─── POST /commands/update ────────────────────────────────────────────────────

describe('POST /commands/update', () => {
  it('runs requireGuildContext (not requireMod), so the handler sees a fresh access level and can allow streamer self-service', async () => {
    await supertest(buildApp())
      .post('/commands/update')
      .send('command_id=1&trigger_string=!clap&output=Clap');
    expect(middlewareCallOrder).toEqual(['requireGuildContext']);
  });

  it('redirects to /commands on success', async () => {
    const res = await supertest(buildApp())
      .post('/commands/update')
      .send('command_id=1&trigger_string=!clap&output=Clap');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/commands');
  });

  it('redirects to ?error=missing_fields when trigger_string is absent', async () => {
    const res = await supertest(buildApp()).post('/commands/update').send('command_id=1&output=out');
    expect(res.headers.location).toBe('/commands?error=missing_fields');
  });

  it('redirects to ?error=invalid_id when command_id is not a number', async () => {
    const res = await supertest(buildApp()).post('/commands/update').send('command_id=abc&trigger_string=!clap&output=out');
    expect(res.headers.location).toBe('/commands?error=invalid_id');
  });

  it('redirects to ?error=command_not_found when CommandNotFoundError is thrown', async () => {
    vi.mocked(updateCustomCommand).mockRejectedValueOnce(new (CommandNotFoundError as any)(1));
    const res = await supertest(buildApp()).post('/commands/update').send('command_id=1&trigger_string=!clap&output=out');
    expect(res.headers.location).toBe('/commands?error=command_not_found');
  });

  it('redirects to ?error=reserved_command when ReservedCommandError is thrown', async () => {
    vi.mocked(updateCustomCommand).mockRejectedValueOnce(new (ReservedCommandError as any)('reserved'));
    const res = await supertest(buildApp()).post('/commands/update').send('command_id=1&trigger_string=!sfx&output=out');
    expect(res.headers.location).toBe('/commands?error=reserved_command');
  });

  it('redirects to ?error=update_failed on unexpected error', async () => {
    vi.mocked(updateCustomCommand).mockRejectedValueOnce(new Error('DB error'));
    const res = await supertest(buildApp()).post('/commands/update').send('command_id=1&trigger_string=!clap&output=out');
    expect(res.headers.location).toBe('/commands?error=update_failed');
  });

  it('passes is_discord_enabled=true when checkbox is "on"', async () => {
    await supertest(buildApp()).post('/commands/update').send('command_id=1&trigger_string=!clap&output=out&is_discord_enabled=on');
    expect(updateCustomCommand).toHaveBeenCalledWith(1, '!clap', 'out', true, false);
  });

  it('passes is_multi_twitch=true when checkbox is "on"', async () => {
    await supertest(buildApp()).post('/commands/update').send('command_id=1&trigger_string=!clap&output=out&is_multi_twitch=on');
    expect(updateCustomCommand).toHaveBeenCalledWith(1, '!clap', 'out', false, true);
  });
});

// ─── POST /commands/remove ────────────────────────────────────────────────────

describe('POST /commands/remove', () => {
  it('runs requireGuildContext (not requireMod), so the handler sees a fresh access level and can allow streamer self-service', async () => {
    await supertest(buildApp()).post('/commands/remove').send('command_id=5');
    expect(middlewareCallOrder).toEqual(['requireGuildContext']);
  });

  it('redirects to /commands on success', async () => {
    const res = await supertest(buildApp()).post('/commands/remove').send('command_id=5');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/commands');
  });

  it('redirects to /commands when command_id is absent', async () => {
    const res = await supertest(buildApp()).post('/commands/remove').send('');
    expect(res.headers.location).toBe('/commands');
    expect(removeCustomCommand).not.toHaveBeenCalled();
  });

  it('redirects to ?error=invalid_id when command_id is non-numeric', async () => {
    const res = await supertest(buildApp()).post('/commands/remove').send('command_id=abc');
    expect(res.headers.location).toBe('/commands?error=invalid_id');
  });

  it('redirects to ?error=remove_failed on unexpected error', async () => {
    vi.mocked(removeCustomCommand).mockRejectedValueOnce(new Error('DB error'));
    const res = await supertest(buildApp()).post('/commands/remove').send('command_id=5');
    expect(res.headers.location).toBe('/commands?error=remove_failed');
  });
});

// ─── Streamer self-service (below Mod) ────────────────────────────────────────

describe('streamer self-service (below Mod)', () => {
  const STREAMER_ID = '111111111111111111';
  const OTHER_ID = '222222222222222222';
  const STREAMER_SESSION = { discordId: STREAMER_ID, discordName: 'Streamer', accessLevel: AccessLevel.USER };
  const streamerApp = () => buildApp(STREAMER_SESSION);

  describe('POST /commands/add', () => {
    it('redirects to ?error=twitch_not_linked without creating anything when the streamer has no Twitch account', async () => {
      vi.mocked(findUser).mockResolvedValue({ discord_id: STREAMER_ID, twitch_name: null } as any);
      const res = await supertest(streamerApp()).post('/commands/add').send('trigger_string=!hi&output=hi');
      expect(res.headers.location).toBe('/commands?error=twitch_not_linked');
      expect(addCustomCommand).not.toHaveBeenCalled();
    });

    it('creates a Twitch-only command assigned to the streamer alone, ignoring flags and discord_ids', async () => {
      vi.mocked(findUser).mockResolvedValue({ discord_id: STREAMER_ID, twitch_name: 'streamer' } as any);
      vi.mocked(findUsersByIds).mockResolvedValue(new Map([[STREAMER_ID, { discord_id: STREAMER_ID, twitch_name: 'streamer' } as any]]));
      const res = await supertest(streamerApp())
        .post('/commands/add')
        .send(`trigger_string=!hi&output=hi&is_discord_enabled=on&is_multi_twitch=on&discord_ids=${OTHER_ID}`);
      expect(res.headers.location).toBe('/commands');
      expect(addCustomCommand).toHaveBeenCalledWith('!hi', 'hi', false, false);
      expect(findUsersByIds).toHaveBeenCalledWith([STREAMER_ID]);
      expect(assignUsersToCommand).toHaveBeenCalledWith(1, [STREAMER_ID]);
    });

    it('cleans up with the unclaimed-only discard (not the unrestricted delete) when self-assignment fails', async () => {
      vi.mocked(findUser).mockResolvedValue({ discord_id: STREAMER_ID, twitch_name: 'streamer' } as any);
      vi.mocked(findUsersByIds).mockResolvedValue(new Map([[STREAMER_ID, { discord_id: STREAMER_ID, twitch_name: 'streamer' } as any]]));
      vi.mocked(assignUsersToCommand).mockRejectedValueOnce(new Error('DB error'));
      const res = await supertest(streamerApp()).post('/commands/add').send('trigger_string=!hi&output=hi');
      expect(res.headers.location).toBe('/commands?error=assign_failed');
      expect(discardOwnNewCustomCommand).toHaveBeenCalledWith(1, STREAMER_ID);
      expect(removeCustomCommand).not.toHaveBeenCalled();
    });

    it('redirects to ?error=add_failed when the streamer lookup throws', async () => {
      vi.mocked(findUser).mockRejectedValueOnce(new Error('DB error'));
      const res = await supertest(streamerApp()).post('/commands/add').send('trigger_string=!hi&output=hi');
      expect(res.headers.location).toBe('/commands?error=add_failed');
    });
  });

  describe('POST /commands/update', () => {
    it("updates through updateOwnCustomCommand with the streamer's ID, so ownership is checked inside the write", async () => {
      const res = await supertest(streamerApp())
        .post('/commands/update')
        .send('command_id=5&trigger_string=!hey&output=hey&is_discord_enabled=on&is_multi_twitch=on');
      expect(res.headers.location).toBe('/commands');
      expect(updateOwnCustomCommand).toHaveBeenCalledWith(5, '!hey', 'hey', STREAMER_ID);
      expect(updateCustomCommand).not.toHaveBeenCalled();
    });

    it('redirects to ?error=forbidden when the locked ownership check denies the update', async () => {
      vi.mocked(updateOwnCustomCommand).mockRejectedValueOnce(new CommandSelfServiceDeniedError(5));
      const res = await supertest(streamerApp()).post('/commands/update').send('command_id=5&trigger_string=!hey&output=hey');
      expect(res.headers.location).toBe('/commands?error=forbidden');
    });

    it('redirects to ?error=command_not_found when the command does not exist', async () => {
      vi.mocked(updateOwnCustomCommand).mockRejectedValueOnce(new CommandNotFoundError(5));
      const res = await supertest(streamerApp()).post('/commands/update').send('command_id=5&trigger_string=!hey&output=hey');
      expect(res.headers.location).toBe('/commands?error=command_not_found');
    });

    it('uses the unrestricted updateCustomCommand for a Mod', async () => {
      await supertest(buildApp()).post('/commands/update').send('command_id=5&trigger_string=!hey&output=hey');
      expect(updateOwnCustomCommand).not.toHaveBeenCalled();
      expect(updateCustomCommand).toHaveBeenCalled();
    });
  });

  describe('POST /commands/remove', () => {
    it("deletes through removeOwnCustomCommand with the streamer's ID", async () => {
      const res = await supertest(streamerApp()).post('/commands/remove').send('command_id=5');
      expect(res.headers.location).toBe('/commands');
      expect(removeOwnCustomCommand).toHaveBeenCalledWith(5, STREAMER_ID);
      expect(removeCustomCommand).not.toHaveBeenCalled();
    });

    it('redirects to ?error=forbidden when the locked ownership check denies the delete', async () => {
      vi.mocked(removeOwnCustomCommand).mockRejectedValueOnce(new CommandSelfServiceDeniedError(5));
      const res = await supertest(streamerApp()).post('/commands/remove').send('command_id=5');
      expect(res.headers.location).toBe('/commands?error=forbidden');
    });

    it('redirects to ?error=command_not_found when the command does not exist', async () => {
      vi.mocked(removeOwnCustomCommand).mockRejectedValueOnce(new CommandNotFoundError(5));
      const res = await supertest(streamerApp()).post('/commands/remove').send('command_id=5');
      expect(res.headers.location).toBe('/commands?error=command_not_found');
    });

    it('redirects to ?error=remove_failed on an unexpected error', async () => {
      vi.mocked(removeOwnCustomCommand).mockRejectedValueOnce(new Error('DB error'));
      const res = await supertest(streamerApp()).post('/commands/remove').send('command_id=5');
      expect(res.headers.location).toBe('/commands?error=remove_failed');
    });
  });
});
