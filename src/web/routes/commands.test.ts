import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ACCESS_LEVEL_MOCK } from '../../test-utils/accessLevelMock';

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
    unassignUserFromCommand: vi.fn().mockResolvedValue(undefined),
    findUser: vi.fn().mockResolvedValue(null),
    upsertOverride: vi.fn().mockResolvedValue(undefined),
    removeOverride: vi.fn().mockResolvedValue(undefined),
    CommandConflictError,
    CommandNotFoundError,
    ReservedCommandError,
    isMysqlDuplicateEntryError: vi.fn().mockReturnValue(false),
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

vi.mock('../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn() }),
}));

vi.mock('../../db/users', () => ({ AccessLevel: ACCESS_LEVEL_MOCK }));

import express from 'express';
import supertest from 'supertest';
import router from './commands';
import {
  addCustomCommand,
  updateCustomCommand,
  removeCustomCommand,
  assignUserToCommand,
  unassignUserFromCommand,
  findUser,
  getAllCustomCommandsWithAssignments,
  getAllUsers,
  getOverridesForGuild,
  isMysqlDuplicateEntryError,
  CommandConflictError,
  CommandNotFoundError,
  ReservedCommandError,
} from '../../db';
import { AccessLevel } from '../../db/users';

function buildApp() {
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
  return app;
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
  vi.mocked(unassignUserFromCommand).mockResolvedValue(undefined);
  vi.mocked(findUser).mockResolvedValue(null);
  vi.mocked(isMysqlDuplicateEntryError).mockReturnValue(false);
});

// --- POST /commands/add ---

describe('POST /commands/add', () => {
  it('1. redirects ?error=missing_fields when trigger_string is absent', async () => {
    const res = await supertest(buildApp())
      .post('/commands/add')
      .type('form')
      .send({ output: 'Hello!' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/commands?error=missing_fields');
  });

  it('2. redirects ?error=missing_fields when output is absent', async () => {
    const res = await supertest(buildApp())
      .post('/commands/add')
      .type('form')
      .send({ trigger_string: '!hello' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/commands?error=missing_fields');
  });

  it('3. redirects ?error=missing_fields when trigger_string contains whitespace', async () => {
    const res = await supertest(buildApp())
      .post('/commands/add')
      .type('form')
      .send({ trigger_string: '!hello world', output: 'Hello!' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/commands?error=missing_fields');
  });

  it('4. redirects ?error=reserved_command when addCustomCommand throws ReservedCommandError', async () => {
    vi.mocked(addCustomCommand).mockRejectedValue(new ReservedCommandError('reserved'));
    const res = await supertest(buildApp())
      .post('/commands/add')
      .type('form')
      .send({ trigger_string: '!hello', output: 'Hello!' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/commands?error=reserved_command');
  });

  it('5. redirects ?error=command_taken when addCustomCommand throws CommandConflictError', async () => {
    vi.mocked(addCustomCommand).mockRejectedValue(new CommandConflictError(['conflict']));
    const res = await supertest(buildApp())
      .post('/commands/add')
      .type('form')
      .send({ trigger_string: '!hello', output: 'Hello!' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/commands?error=command_taken');
  });

  it('6. redirects /commands when valid and no discord_ids', async () => {
    const res = await supertest(buildApp())
      .post('/commands/add')
      .type('form')
      .send({ trigger_string: '!hello', output: 'Hello!' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/commands');
  });

  it('7. skips assignment and redirects /commands when user has no twitch_name', async () => {
    vi.mocked(findUser).mockResolvedValue({ discord_id: '123456789012345678', twitch_name: null } as any);
    const res = await supertest(buildApp())
      .post('/commands/add')
      .type('form')
      .send({ trigger_string: '!hello', output: 'Hello!', discord_ids: '123456789012345678' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/commands');
    expect(vi.mocked(assignUserToCommand)).not.toHaveBeenCalled();
  });

  it('8. calls assignUserToCommand and redirects /commands when user has twitch_name', async () => {
    vi.mocked(findUser).mockResolvedValue({ discord_id: '123456789012345678', twitch_name: 'streamer' } as any);
    const res = await supertest(buildApp())
      .post('/commands/add')
      .type('form')
      .send({ trigger_string: '!hello', output: 'Hello!', discord_ids: '123456789012345678' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/commands');
    expect(vi.mocked(assignUserToCommand)).toHaveBeenCalledWith(1, '123456789012345678');
  });
});

// --- POST /commands/update ---

describe('POST /commands/update', () => {
  it('9. redirects ?error=missing_fields when trigger_string is absent', async () => {
    const res = await supertest(buildApp())
      .post('/commands/update')
      .type('form')
      .send({ command_id: '1', output: 'Hello!' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/commands?error=missing_fields');
  });

  it('10. redirects ?error=invalid_id when command_id is non-numeric', async () => {
    const res = await supertest(buildApp())
      .post('/commands/update')
      .type('form')
      .send({ command_id: 'abc', trigger_string: '!hello', output: 'Hello!' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/commands?error=invalid_id');
  });

  it('11. redirects ?error=command_not_found when updateCustomCommand throws CommandNotFoundError', async () => {
    vi.mocked(updateCustomCommand).mockRejectedValue(new CommandNotFoundError(1));
    const res = await supertest(buildApp())
      .post('/commands/update')
      .type('form')
      .send({ command_id: '1', trigger_string: '!hello', output: 'Hello!' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/commands?error=command_not_found');
  });

  it('12. redirects ?error=reserved_command when updateCustomCommand throws ReservedCommandError', async () => {
    vi.mocked(updateCustomCommand).mockRejectedValue(new ReservedCommandError('reserved'));
    const res = await supertest(buildApp())
      .post('/commands/update')
      .type('form')
      .send({ command_id: '1', trigger_string: '!hello', output: 'Hello!' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/commands?error=reserved_command');
  });

  it('13. redirects /commands on valid update', async () => {
    const res = await supertest(buildApp())
      .post('/commands/update')
      .type('form')
      .send({ command_id: '1', trigger_string: '!hello', output: 'Hello!' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/commands');
  });
});

// --- POST /commands/remove ---

describe('POST /commands/remove', () => {
  it('14. redirects ?error=invalid_id when command_id is non-numeric', async () => {
    const res = await supertest(buildApp())
      .post('/commands/remove')
      .type('form')
      .send({ command_id: 'notanumber' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/commands?error=invalid_id');
  });

  it('15. redirects /commands on valid remove', async () => {
    const res = await supertest(buildApp())
      .post('/commands/remove')
      .type('form')
      .send({ command_id: '3' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/commands');
  });
});

// --- POST /commands/assign ---

describe('POST /commands/assign', () => {
  it('16. redirects ?error=missing_fields when fields are absent', async () => {
    const res = await supertest(buildApp())
      .post('/commands/assign')
      .type('form')
      .send({});
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/commands?error=missing_fields');
  });

  it('17. redirects ?error=invalid_assignment_user when user not found or has no twitch_name', async () => {
    vi.mocked(findUser).mockResolvedValue(null);
    const res = await supertest(buildApp())
      .post('/commands/assign')
      .type('form')
      .send({ command_id: '1', discord_id: '123456789012345678' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/commands?error=invalid_assignment_user');
  });

  it('17b. redirects ?error=invalid_assignment_user when user exists but has no twitch_name', async () => {
    vi.mocked(findUser).mockResolvedValue({ discord_id: '123456789012345678', twitch_name: null } as any);
    const res = await supertest(buildApp())
      .post('/commands/assign')
      .type('form')
      .send({ command_id: '1', discord_id: '123456789012345678' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/commands?error=invalid_assignment_user');
  });

  it('18. redirects /commands on valid assign', async () => {
    vi.mocked(findUser).mockResolvedValue({ discord_id: '123456789012345678', twitch_name: 'streamer' } as any);
    const res = await supertest(buildApp())
      .post('/commands/assign')
      .type('form')
      .send({ command_id: '1', discord_id: '123456789012345678' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/commands');
    expect(vi.mocked(assignUserToCommand)).toHaveBeenCalledWith(1, '123456789012345678');
  });
});

// --- POST /commands/unassign ---

describe('POST /commands/unassign', () => {
  it('19. redirects ?error=missing_fields when fields are absent', async () => {
    const res = await supertest(buildApp())
      .post('/commands/unassign')
      .type('form')
      .send({});
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/commands?error=missing_fields');
  });

  it('20. redirects /commands on valid unassign', async () => {
    const res = await supertest(buildApp())
      .post('/commands/unassign')
      .type('form')
      .send({ command_id: '1', discord_id: '123456789012345678' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/commands');
    expect(vi.mocked(unassignUserFromCommand)).toHaveBeenCalledWith(1, '123456789012345678');
  });

  it('21. redirects ?error=invalid_id when discord_id is non-numeric', async () => {
    const res = await supertest(buildApp())
      .post('/commands/unassign')
      .type('form')
      .send({ command_id: '1', discord_id: 'not-a-snowflake' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/commands?error=invalid_id');
  });

  it('22. redirects ?error=unassign_failed when unassignUserFromCommand throws', async () => {
    vi.mocked(unassignUserFromCommand).mockRejectedValue(new Error('db error'));
    const res = await supertest(buildApp())
      .post('/commands/unassign')
      .type('form')
      .send({ command_id: '1', discord_id: '123456789012345678' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/commands?error=unassign_failed');
  });
});

// --- POST /commands/assign (additional coverage) ---

describe('POST /commands/assign — additional coverage', () => {
  it('23. redirects ?error=invalid_id when discord_id is non-numeric', async () => {
    const res = await supertest(buildApp())
      .post('/commands/assign')
      .type('form')
      .send({ command_id: '1', discord_id: 'not-a-snowflake' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/commands?error=invalid_id');
  });

  it('24. redirects ?error=command_taken when assignUserToCommand throws CommandConflictError', async () => {
    vi.mocked(findUser).mockResolvedValue({ discord_id: '123456789012345678', twitch_name: 'streamer' } as any);
    vi.mocked(assignUserToCommand).mockRejectedValue(new CommandConflictError(['conflict']));
    const res = await supertest(buildApp())
      .post('/commands/assign')
      .type('form')
      .send({ command_id: '1', discord_id: '123456789012345678' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/commands?error=command_taken');
  });

  it('25. redirects ?error=command_taken when assignUserToCommand triggers isMysqlDuplicateEntryError', async () => {
    vi.mocked(findUser).mockResolvedValue({ discord_id: '123456789012345678', twitch_name: 'streamer' } as any);
    vi.mocked(assignUserToCommand).mockRejectedValue(new Error('ER_DUP_ENTRY'));
    vi.mocked(isMysqlDuplicateEntryError).mockReturnValue(true);
    const res = await supertest(buildApp())
      .post('/commands/assign')
      .type('form')
      .send({ command_id: '1', discord_id: '123456789012345678' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/commands?error=command_taken');
  });

  it('26. redirects ?error=assign_failed when assignUserToCommand throws generic error', async () => {
    vi.mocked(findUser).mockResolvedValue({ discord_id: '123456789012345678', twitch_name: 'streamer' } as any);
    vi.mocked(assignUserToCommand).mockRejectedValue(new Error('db error'));
    const res = await supertest(buildApp())
      .post('/commands/assign')
      .type('form')
      .send({ command_id: '1', discord_id: '123456789012345678' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/commands?error=assign_failed');
  });
});

// --- POST /commands/add (additional coverage) ---

describe('POST /commands/add — additional coverage', () => {
  it('27. redirects ?error=add_failed when addCustomCommand throws a generic error', async () => {
    vi.mocked(addCustomCommand).mockRejectedValue(new Error('db error'));
    const res = await supertest(buildApp())
      .post('/commands/add')
      .type('form')
      .send({ trigger_string: '!hello', output: 'Hello!' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/commands?error=add_failed');
  });

  it('28. redirects ?error=command_taken when assignUserToCommand throws CommandConflictError during add', async () => {
    vi.mocked(findUser).mockResolvedValue({ discord_id: '123456789012345678', twitch_name: 'streamer' } as any);
    vi.mocked(assignUserToCommand).mockRejectedValue(new CommandConflictError(['conflict']));
    const res = await supertest(buildApp())
      .post('/commands/add')
      .type('form')
      .send({ trigger_string: '!hello', output: 'Hello!', discord_ids: '123456789012345678' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/commands?error=command_taken');
  });

  it('29. redirects ?error=assign_failed when assignUserToCommand throws generic error during add', async () => {
    vi.mocked(findUser).mockResolvedValue({ discord_id: '123456789012345678', twitch_name: 'streamer' } as any);
    vi.mocked(assignUserToCommand).mockRejectedValue(new Error('db error'));
    const res = await supertest(buildApp())
      .post('/commands/add')
      .type('form')
      .send({ trigger_string: '!hello', output: 'Hello!', discord_ids: '123456789012345678' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/commands?error=assign_failed');
  });
});

// --- POST /commands/update (additional coverage) ---

describe('POST /commands/update — additional coverage', () => {
  it('30. redirects ?error=update_failed when updateCustomCommand throws a generic error', async () => {
    vi.mocked(updateCustomCommand).mockRejectedValue(new Error('db error'));
    const res = await supertest(buildApp())
      .post('/commands/update')
      .type('form')
      .send({ command_id: '1', trigger_string: '!hello', output: 'Hello!' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/commands?error=update_failed');
  });
});

// --- POST /commands/remove (additional coverage) ---

describe('POST /commands/remove — additional coverage', () => {
  it('31. redirects /commands (no error) when command_id is absent from body', async () => {
    const res = await supertest(buildApp())
      .post('/commands/remove')
      .type('form')
      .send({});
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/commands');
    expect(vi.mocked(removeCustomCommand)).not.toHaveBeenCalled();
  });

  it('32. redirects ?error=remove_failed when removeCustomCommand throws', async () => {
    vi.mocked(removeCustomCommand).mockRejectedValue(new Error('db error'));
    const res = await supertest(buildApp())
      .post('/commands/remove')
      .type('form')
      .send({ command_id: '3' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/commands?error=remove_failed');
  });
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

// --- POST /commands/add (array discord_ids) ---

describe('POST /commands/add — array discord_ids', () => {
  it('38. handles multiple discord_ids sent as an array and assigns each valid user', async () => {
    vi.mocked(findUser)
      .mockResolvedValueOnce({ discord_id: '111111111111111111', twitch_name: 'user1' } as any)
      .mockResolvedValueOnce({ discord_id: '222222222222222222', twitch_name: 'user2' } as any);
    const res = await supertest(buildApp())
      .post('/commands/add')
      .type('form')
      .send('trigger_string=!hello&output=Hello!&discord_ids=111111111111111111&discord_ids=222222222222222222');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/commands');
    expect(vi.mocked(assignUserToCommand)).toHaveBeenCalledTimes(2);
  });
});
