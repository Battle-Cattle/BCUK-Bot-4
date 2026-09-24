import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockLogger } from '../../test-utils/loggerMock';
import { ACCESS_LEVEL_MOCK } from '../../test-utils/accessLevelMock';

vi.mock('../../db', () => {
  class CommandConflictError extends Error {}
  class CommandNotFoundError extends Error {}
  class ReservedCommandError extends Error {}
  return {
    addCustomCommand: vi.fn().mockResolvedValue(1),
    updateCustomCommand: vi.fn().mockResolvedValue(undefined),
    removeCustomCommand: vi.fn().mockResolvedValue(undefined),
    assignUsersToCommand: vi.fn().mockResolvedValue(undefined),
    findUsersByIds: vi.fn().mockResolvedValue(new Map()),
    findUser: vi.fn().mockResolvedValue(null),
    getCustomCommandWithAssignments: vi.fn().mockResolvedValue(null),
    CommandConflictError,
    CommandNotFoundError,
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
  assignUsersToCommand, findUsersByIds, findUser, getCustomCommandWithAssignments,
  CommandConflictError, CommandNotFoundError, ReservedCommandError,
  isMysqlDuplicateEntryError,
} from '../../db';
import { AccessLevel } from '../../db';
import { buildTestApp } from '../../test-utils/expressTestApp';

const MOD_SESSION_USER = { discordId: '1', discordName: 'Mod', accessLevel: ACCESS_LEVEL_MOCK.MOD };

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
  vi.mocked(getCustomCommandWithAssignments).mockResolvedValue(null);
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

  it('assigns users when discord_ids are provided and user has twitch_name', async () => {
    vi.mocked(findUsersByIds).mockResolvedValue(new Map([
      [VALID_DISCORD_ID, { discord_id: VALID_DISCORD_ID, discord_name: 'Alice', is_twitch_bot_enabled: false, twitch_name: 'alice', access_level: AccessLevel.USER } as any],
    ]));
    const res = await supertest(buildApp())
      .post('/commands/add')
      .send(`trigger_string=!clap&output=Clap&discord_ids=${VALID_DISCORD_ID}`);
    expect(res.headers.location).toBe('/commands');
    expect(assignUsersToCommand).toHaveBeenCalledWith(1, [VALID_DISCORD_ID]);
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

  /** A command assigned to `assignees`, Twitch-only unless overridden. */
  function commandFor(assignees: string[], overrides: Record<string, unknown> = {}): any {
    return {
      command_id: 5, trigger_string: '!hi', output: 'hi', is_discord_enabled: false, is_multi_twitch: false,
      assigned_users: assignees.map((discord_id) => ({ discord_id })), ...overrides,
    };
  }

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

    it('redirects to ?error=add_failed when the streamer lookup throws', async () => {
      vi.mocked(findUser).mockRejectedValueOnce(new Error('DB error'));
      const res = await supertest(streamerApp()).post('/commands/add').send('trigger_string=!hi&output=hi');
      expect(res.headers.location).toBe('/commands?error=add_failed');
    });
  });

  describe('POST /commands/update', () => {
    it('updates a command the streamer owns outright, forcing the Discord/multi-Twitch flags off', async () => {
      vi.mocked(getCustomCommandWithAssignments).mockResolvedValue(commandFor([STREAMER_ID]));
      const res = await supertest(streamerApp())
        .post('/commands/update')
        .send('command_id=5&trigger_string=!hey&output=hey&is_discord_enabled=on&is_multi_twitch=on');
      expect(res.headers.location).toBe('/commands');
      expect(getCustomCommandWithAssignments).toHaveBeenCalledWith(5);
      expect(updateCustomCommand).toHaveBeenCalledWith(5, '!hey', 'hey', false, false);
    });

    it('redirects to ?error=command_not_found when the command does not exist', async () => {
      const res = await supertest(streamerApp()).post('/commands/update').send('command_id=5&trigger_string=!hey&output=hey');
      expect(res.headers.location).toBe('/commands?error=command_not_found');
      expect(updateCustomCommand).not.toHaveBeenCalled();
    });

    it.each([
      ['shared with another channel', commandFor([STREAMER_ID, OTHER_ID])],
      ['assigned to someone else', commandFor([OTHER_ID])],
      ['Discord-enabled', commandFor([STREAMER_ID], { is_discord_enabled: true })],
      ['multi-Twitch', commandFor([STREAMER_ID], { is_multi_twitch: true })],
    ])('redirects to ?error=forbidden when the command is %s', async (_label, command) => {
      vi.mocked(getCustomCommandWithAssignments).mockResolvedValue(command);
      const res = await supertest(streamerApp()).post('/commands/update').send('command_id=5&trigger_string=!hey&output=hey');
      expect(res.headers.location).toBe('/commands?error=forbidden');
      expect(updateCustomCommand).not.toHaveBeenCalled();
    });

    it('does not look up ownership for a Mod', async () => {
      await supertest(buildApp()).post('/commands/update').send('command_id=5&trigger_string=!hey&output=hey');
      expect(getCustomCommandWithAssignments).not.toHaveBeenCalled();
      expect(updateCustomCommand).toHaveBeenCalled();
    });
  });

  describe('POST /commands/remove', () => {
    it('deletes a command the streamer owns outright', async () => {
      vi.mocked(getCustomCommandWithAssignments).mockResolvedValue(commandFor([STREAMER_ID]));
      const res = await supertest(streamerApp()).post('/commands/remove').send('command_id=5');
      expect(res.headers.location).toBe('/commands');
      expect(removeCustomCommand).toHaveBeenCalledWith(5);
    });

    it('redirects to ?error=forbidden for a shared command instead of deleting it', async () => {
      vi.mocked(getCustomCommandWithAssignments).mockResolvedValue(commandFor([STREAMER_ID, OTHER_ID]));
      const res = await supertest(streamerApp()).post('/commands/remove').send('command_id=5');
      expect(res.headers.location).toBe('/commands?error=forbidden');
      expect(removeCustomCommand).not.toHaveBeenCalled();
    });

    it('redirects to ?error=remove_failed when the ownership lookup throws', async () => {
      vi.mocked(getCustomCommandWithAssignments).mockRejectedValueOnce(new Error('DB error'));
      const res = await supertest(streamerApp()).post('/commands/remove').send('command_id=5');
      expect(res.headers.location).toBe('/commands?error=remove_failed');
    });
  });
});
