import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../db', () => {
  class CommandConflictError extends Error {}
  class CommandNotFoundError extends Error {}
  class ReservedCommandError extends Error {}
  return {
    getAllCustomCommandsWithAssignments: vi.fn().mockResolvedValue([]),
    getAllUsers: vi.fn().mockResolvedValue([]),
    addCustomCommand: vi.fn().mockResolvedValue(1),
    updateCustomCommand: vi.fn().mockResolvedValue(undefined),
    removeCustomCommand: vi.fn().mockResolvedValue(undefined),
    assignUserToCommand: vi.fn().mockResolvedValue(undefined),
    unassignUserFromCommand: vi.fn().mockResolvedValue(undefined),
    findUser: vi.fn().mockResolvedValue(null),
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
}));

vi.mock('../../logger', () => ({
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
  unassignUserFromCommand,
  findUser,
  isMysqlDuplicateEntryError,
  CommandConflictError,
  CommandNotFoundError,
  ReservedCommandError,
} from '../../db';

function buildApp() {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use((_req: any, res: any, next: any) => {
    res.render = (view: string) => res.send(`rendered:${view}`);
    next();
  });
  app.use((req: any, _res: any, next: any) => {
    req.session = { user: { discord_id: '1', discord_name: 'TestUser', access_level: 2 } };
    next();
  });
  app.use(router);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
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

  it('11. returns 404 when updateCustomCommand throws CommandNotFoundError', async () => {
    vi.mocked(updateCustomCommand).mockRejectedValue(new CommandNotFoundError(1));
    const res = await supertest(buildApp())
      .post('/commands/update')
      .type('form')
      .send({ command_id: '1', trigger_string: '!hello', output: 'Hello!' });
    expect(res.status).toBe(404);
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
});
