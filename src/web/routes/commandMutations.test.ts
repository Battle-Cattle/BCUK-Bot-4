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
  assignUsersToCommand, findUsersByIds,
  CommandConflictError, CommandNotFoundError, ReservedCommandError,
  isMysqlDuplicateEntryError,
} from '../../db';
import { AccessLevel } from '../../db';
import { buildTestApp } from '../../test-utils/expressTestApp';

/** Builds a supertest-ready app: the command mutations router with a urlencoded body parser (no session or render stub needed). */
function buildApp() {
  return buildTestApp({ router, bodyParser: 'urlencoded' });
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
  vi.mocked(isMysqlDuplicateEntryError).mockReturnValue(false);
});

// ─── POST /commands/add ───────────────────────────────────────────────────────

describe('POST /commands/add', () => {
  it('runs requireGuildContext before requireMod, so a demoted session is re-checked with a fresh access level', async () => {
    await supertest(buildApp())
      .post('/commands/add')
      .send('trigger_string=!clap&output=Clap%21');
    expect(middlewareCallOrder).toEqual(['requireGuildContext', 'requireMod']);
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
