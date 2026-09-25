import { describe, it, expect, vi, beforeEach } from 'vitest';

/** Hoisted so the `vi.mock('../../db', ...)` factory below can safely reference it — `vi.mock` factories are hoisted above imports, so a plain imported binding could throw `ReferenceError` depending on import order. */
const { ACCESS_LEVEL_MOCK } = vi.hoisted(() => ({
  ACCESS_LEVEL_MOCK: { USER: 0, MOD: 1, MANAGER: 2, ADMIN: 3 },
}));

vi.mock('../../db', () => {
  class CommandConflictError extends Error {}
  class CommandNotFoundError extends Error {}
  class ReservedCommandError extends Error {}
  return {
    getAllCustomCommandsWithAssignments: vi.fn().mockResolvedValue([]),
    getAllUsers: vi.fn().mockResolvedValue([]),
    getOverridesForGuild: vi.fn().mockResolvedValue([]),
    addCustomCommand: vi.fn().mockResolvedValue(1),
    updateCustomCommand: vi.fn().mockResolvedValue(undefined),
    removeCustomCommand: vi.fn().mockResolvedValue(undefined),
    assignUserToCommand: vi.fn().mockResolvedValue(undefined),
    assignUsersToCommand: vi.fn().mockResolvedValue(undefined),
    unassignUserFromCommand: vi.fn().mockResolvedValue(undefined),
    findUser: vi.fn().mockResolvedValue(null),
    findUsersByIds: vi.fn().mockResolvedValue(new Map()),
    upsertOverride: vi.fn().mockResolvedValue(undefined),
    removeOverride: vi.fn().mockResolvedValue(undefined),
    CommandConflictError,
    CommandNotFoundError,
    ReservedCommandError,
    isMysqlDuplicateEntryError: vi.fn().mockReturnValue(false),
    AccessLevel: ACCESS_LEVEL_MOCK,
  };
});

vi.mock('../csrf', () => ({
  csrfProtection: (req: any, res: any, next: any) => {
    req.csrfToken = () => 'test-csrf-token';
    next();
  },
}));

vi.mock('../middleware', () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
  requireMod: (_req: any, _res: any, next: any) => next(),
  requireManager: (_req: any, _res: any, next: any) => next(),
  requireGuildContext: (_req: any, _res: any, next: any) => next(),
}));

vi.mock('../../shared/logger', () => ({
  createLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn() }),
}));

import express from 'express';
import supertest from 'supertest';
import router from './commands';
import {
  addCustomCommand,
  updateCustomCommand,
  removeCustomCommand,
  assignUserToCommand,
  assignUsersToCommand,
  unassignUserFromCommand,
  findUser,
  findUsersByIds,
  getAllCustomCommandsWithAssignments,
  getAllUsers,
  getOverridesForGuild,
  isMysqlDuplicateEntryError,
  removeOverride,
} from '../../db';
import { AccessLevel } from '../../db';
import { buildTestApp } from '../../test-utils/expressTestApp';

/** Builds a supertest-ready app: the commands router with a stubbed session and a render mock that sends `rendered:<view>` (locals ignored). */
function buildApp() {
  return buildTestApp({
    router,
    bodyParser: 'urlencoded',
    sessionUser: { discord_id: '1', discord_name: 'TestUser', access_level: AccessLevel.MANAGER },
    mockRender: 'text',
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getAllCustomCommandsWithAssignments).mockResolvedValue([]);
  vi.mocked(getAllUsers).mockResolvedValue([]);
  vi.mocked(getOverridesForGuild).mockResolvedValue([]);
  vi.mocked(addCustomCommand).mockResolvedValue(1);
  vi.mocked(updateCustomCommand).mockResolvedValue(undefined);
  vi.mocked(removeCustomCommand).mockResolvedValue(undefined);
  vi.mocked(assignUserToCommand).mockResolvedValue(undefined);
  vi.mocked(assignUsersToCommand).mockResolvedValue(undefined);
  vi.mocked(unassignUserFromCommand).mockResolvedValue(undefined);
  vi.mocked(findUser).mockResolvedValue(null);
  vi.mocked(findUsersByIds).mockResolvedValue(new Map());
  vi.mocked(isMysqlDuplicateEntryError).mockReturnValue(false);
});

// --- GET /commands ---

describe('GET /commands', () => {
  it('33. renders the commands view on success', async () => {
    const res = await supertest(buildApp()).get('/commands');
    expect(res.status).toBe(200);
    expect(res.text).toBe('rendered:commands');
  });

  it('34. passes a known error param to the view', async () => {
    let capturedError: unknown;
    const app = express();
    app.use(express.urlencoded({ extended: false }));
    app.use((_req: any, res: any, next: any) => {
      res.render = (_view: string, locals: any) => {
        capturedError = locals.error;
        res.send('ok');
      };
      next();
    });
    app.use((req: any, _res: any, next: any) => {
      req.session = { user: { discord_id: '1', discord_name: 'TestUser', access_level: AccessLevel.MANAGER } };
      next();
    });
    app.use(router);
    await supertest(app).get('/commands?error=add_failed');
    expect(capturedError).toBe('add_failed');
  });

  it('35. passes null to the view for an unknown error param', async () => {
    let capturedError: unknown;
    const app = express();
    app.use(express.urlencoded({ extended: false }));
    app.use((_req: any, res: any, next: any) => {
      res.render = (_view: string, locals: any) => {
        capturedError = locals.error;
        res.send('ok');
      };
      next();
    });
    app.use((req: any, _res: any, next: any) => {
      req.session = { user: { discord_id: '1', discord_name: 'TestUser', access_level: AccessLevel.MANAGER } };
      next();
    });
    app.use(router);
    await supertest(app).get('/commands?error=totally_unknown');
    expect(capturedError).toBeNull();
  });

  it('36. returns 500 when the db call throws', async () => {
    vi.mocked(getAllCustomCommandsWithAssignments).mockRejectedValue(new Error('db error'));
    const app = express();
    app.use(express.urlencoded({ extended: false }));
    app.use((_req: any, res: any, next: any) => {
      res.render = (view: string) => res.send(`rendered:${view}`);
      next();
    });
    app.use((req: any, _res: any, next: any) => {
      req.session = { user: { discord_id: '1', discord_name: 'TestUser', access_level: AccessLevel.MANAGER } };
      next();
    });
    app.use(router);
    const res = await supertest(app).get('/commands');
    expect(res.status).toBe(500);
  });

  it("36b. resolves the current guild's override onto the matching command and skips the lookup without a current guild", async () => {
    vi.mocked(getAllCustomCommandsWithAssignments).mockResolvedValue([
      { command_id: 1, trigger_string: '!hello', output: 'Hello!', is_discord_enabled: true, is_multi_twitch: false, assigned_users: [] } as any,
      { command_id: 2, trigger_string: '!bye', output: 'Bye!', is_discord_enabled: true, is_multi_twitch: false, assigned_users: [] } as any,
    ]);
    vi.mocked(getOverridesForGuild).mockResolvedValue([
      { guild_id: '900000000000000001', command_id: 1, is_disabled: true, output: null } as any,
    ]);

    let capturedLocals: any;
    const app = express();
    app.use(express.urlencoded({ extended: false }));
    app.use((_req: any, res: any, next: any) => {
      res.render = (_view: string, locals: any) => {
        capturedLocals = locals;
        res.send('ok');
      };
      next();
    });
    app.use((req: any, _res: any, next: any) => {
      req.session = { user: { discord_id: '1', discord_name: 'TestUser', access_level: AccessLevel.MANAGER, currentGuildId: '900000000000000001' } };
      next();
    });
    app.use(router);

    await supertest(app).get('/commands');
    expect(vi.mocked(getOverridesForGuild)).toHaveBeenCalledWith('900000000000000001');
    expect(capturedLocals.commands[0].guildOverride).toMatchObject({ command_id: 1, is_disabled: true });
    expect(capturedLocals.commands[1].guildOverride).toBeNull();

    vi.mocked(getOverridesForGuild).mockClear();
    await supertest(buildApp()).get('/commands');
    expect(vi.mocked(getOverridesForGuild)).not.toHaveBeenCalled();
  });

  it('37. computes unassigned_users correctly when commands and users are present', async () => {
    vi.mocked(getAllCustomCommandsWithAssignments).mockResolvedValue([
      {
        id: 1,
        trigger_string: '!hello',
        output: 'Hello!',
        is_discord_enabled: true,
        is_multi_twitch: false,
        assigned_users: [{ discord_id: '111', twitch_name: 'assigned_user' }],
      } as any,
    ]);
    vi.mocked(getAllUsers).mockResolvedValue([
      { discord_id: '111', twitch_name: 'assigned_user' } as any,
      { discord_id: '222', twitch_name: 'other_user' } as any,
      { discord_id: '333', twitch_name: null } as any,
    ]);

    let capturedLocals: any;
    const app = express();
    app.use(express.urlencoded({ extended: false }));
    app.use((_req: any, res: any, next: any) => {
      res.render = (_view: string, locals: any) => {
        capturedLocals = locals;
        res.send('ok');
      };
      next();
    });
    app.use((req: any, _res: any, next: any) => {
      req.session = { user: { discord_id: '1', discord_name: 'TestUser', access_level: AccessLevel.MANAGER } };
      next();
    });
    app.use(router);

    await supertest(app).get('/commands');
    expect(capturedLocals.commands).toHaveLength(1);
    // only discord_id '222' (twitch_name present, not already assigned) should be unassigned
    expect(capturedLocals.commands[0].unassigned_users).toEqual([
      { discord_id: '222', twitch_name: 'other_user' },
    ]);
    // assignableUsers excludes the null-twitch_name entry
    expect(capturedLocals.assignableUsers).toHaveLength(2);
  });
});

// --- Sub-router composition ---
// The POST handlers themselves are covered in commandMutations.test.ts, commandAssignments.test.ts
// and commandGuildOverrides.test.ts — these only confirm each sub-router is mounted here.

describe('commands router composition', () => {
  it('mounts the mutations sub-router', async () => {
    const res = await supertest(buildApp()).post('/commands/add').type('form').send('trigger_string=!hello&output=Hello!');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/commands');
    expect(vi.mocked(addCustomCommand)).toHaveBeenCalled();
  });

  it('mounts the assignments sub-router', async () => {
    const res = await supertest(buildApp())
      .post('/commands/unassign')
      .type('form')
      .send('command_id=1&discord_id=111111111111111111');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/commands');
    expect(vi.mocked(unassignUserFromCommand)).toHaveBeenCalled();
  });

  it('mounts the guild-overrides sub-router', async () => {
    const app = buildTestApp({
      router,
      bodyParser: 'urlencoded',
      sessionUser: { discord_id: '1', discord_name: 'TestUser', access_level: AccessLevel.MANAGER, currentGuildId: '900000000000000001' },
    });
    const res = await supertest(app).post('/commands/guild-override/reset').type('form').send('command_id=1');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/commands');
    expect(vi.mocked(removeOverride)).toHaveBeenCalledWith('900000000000000001', 1);
  });
});
