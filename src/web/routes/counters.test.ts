import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../db', () => {
  class CommandConflictError extends Error {}
  class CounterNotFoundError extends Error {}
  class ReservedCommandError extends Error {}
  return {
    getAllCounters: vi.fn().mockResolvedValue([]),
    getCounterHistory: vi.fn().mockResolvedValue(null),
    addCounter: vi.fn().mockResolvedValue(undefined),
    updateCounter: vi.fn().mockResolvedValue(undefined),
    removeCounter: vi.fn().mockResolvedValue(undefined),
    resetCounterCurrentValue: vi.fn().mockResolvedValue(undefined),
    isCounterCommandTaken: vi.fn().mockResolvedValue(false),
    CommandConflictError,
    CounterNotFoundError,
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

vi.mock('../../db/users', () => ({ AccessLevel: { USER: 0, MOD: 1, MANAGER: 2, ADMIN: 3 } }));

import express from 'express';
import supertest from 'supertest';
import router from './counters';
import {
  getAllCounters,
  getCounterHistory,
  addCounter,
  updateCounter,
  removeCounter,
  resetCounterCurrentValue,
  isCounterCommandTaken,
  isMysqlDuplicateEntryError,
  CommandConflictError,
  CounterNotFoundError,
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

const VALID_ADD = {
  trigger_command: '!hits',
  check_command: '!count',
  message: 'Count: %d',
  increment_message: 'Now %d!',
};

const VALID_UPDATE = {
  id: '42',
  trigger_command: '!hits',
  check_command: '!count',
  message: 'Count: %d',
  increment_message: 'Now %d!',
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getAllCounters).mockResolvedValue([]);
  vi.mocked(getCounterHistory).mockResolvedValue(null);
  vi.mocked(addCounter).mockResolvedValue(undefined);
  vi.mocked(updateCounter).mockResolvedValue(undefined);
  vi.mocked(removeCounter).mockResolvedValue(undefined);
  vi.mocked(resetCounterCurrentValue).mockResolvedValue(undefined);
  vi.mocked(isCounterCommandTaken).mockResolvedValue(false);
  vi.mocked(isMysqlDuplicateEntryError).mockReturnValue(false);
});

// --- GET /counters ---

describe('GET /counters', () => {
  it('renders the counters view with the loaded counters', async () => {
    const counters = [{ id: 1, trigger_command: '!hits', check_command: '!count' }];
    vi.mocked(getAllCounters).mockResolvedValue(counters as any);

    const res = await supertest(buildApp()).get('/counters');

    expect(res.status).toBe(200);
    expect(res.text).toBe('rendered:counters');
  });

  it('renders a 500 error page when loading counters fails', async () => {
    vi.mocked(getAllCounters).mockRejectedValue(new Error('db down'));

    const res = await supertest(buildApp()).get('/counters');

    expect(res.status).toBe(500);
    expect(res.text).toBe('rendered:error');
  });
});

// --- GET /counters/:id/history ---

describe('GET /counters/:id/history', () => {
  it('renders the counterHistory view with the counter and history data', async () => {
    vi.mocked(getCounterHistory).mockResolvedValue({
      counter: { id: 1, trigger_command: '!hits', check_command: '!checkhits', message: 'm', increment_message: 'i', reset_yearly: false, current_value: 5 } as any,
      history: [{ year: 2024, value: 20 }, { year: 2023, value: 10 }],
    });

    const res = await supertest(buildApp()).get('/counters/1/history');

    expect(res.status).toBe(200);
    expect(res.text).toBe('rendered:counterHistory');
    expect(getCounterHistory).toHaveBeenCalledWith(1);
  });

  it('renders a 404 error page when id is non-numeric', async () => {
    const res = await supertest(buildApp()).get('/counters/notanumber/history');

    expect(res.status).toBe(404);
    expect(res.text).toBe('rendered:error');
    expect(getCounterHistory).not.toHaveBeenCalled();
  });

  it('renders a 404 error page when the counter does not exist', async () => {
    vi.mocked(getCounterHistory).mockResolvedValue(null);

    const res = await supertest(buildApp()).get('/counters/99/history');

    expect(res.status).toBe(404);
    expect(res.text).toBe('rendered:error');
  });

  it('renders a 500 error page when loading history fails', async () => {
    vi.mocked(getCounterHistory).mockRejectedValue(new Error('db down'));

    const res = await supertest(buildApp()).get('/counters/1/history');

    expect(res.status).toBe(500);
    expect(res.text).toBe('rendered:error');
  });
});

// --- POST /counters/add ---

describe('POST /counters/add', () => {
  it('1. redirects ?error=missing_fields when trigger_command is absent', async () => {
    const res = await supertest(buildApp())
      .post('/counters/add')
      .type('form')
      .send({ check_command: '!count', message: 'Count: %d', increment_message: 'Now %d!' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/counters?error=missing_fields');
  });

  it('2. redirects ?error=missing_fields when check_command is absent', async () => {
    const res = await supertest(buildApp())
      .post('/counters/add')
      .type('form')
      .send({ trigger_command: '!hits', message: 'Count: %d', increment_message: 'Now %d!' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/counters?error=missing_fields');
  });

  it('3. redirects ?error=same_commands when trigger_command === check_command', async () => {
    const res = await supertest(buildApp())
      .post('/counters/add')
      .type('form')
      .send({ trigger_command: '!hits', check_command: '!hits', message: 'Count: %d', increment_message: 'Now %d!' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/counters?error=same_commands');
  });

  it('4. redirects ?error=missing_fields when trigger_command contains whitespace', async () => {
    const res = await supertest(buildApp())
      .post('/counters/add')
      .type('form')
      .send({ ...VALID_ADD, trigger_command: '!hi there' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/counters?error=missing_fields');
  });

  it('5. redirects ?error=duplicate_command when isCounterCommandTaken returns true', async () => {
    vi.mocked(isCounterCommandTaken).mockResolvedValue(true);
    const res = await supertest(buildApp())
      .post('/counters/add')
      .type('form')
      .send(VALID_ADD);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/counters?error=duplicate_command');
  });

  it('6. redirects ?error=reserved_command when addCounter throws ReservedCommandError', async () => {
    vi.mocked(addCounter).mockRejectedValue(new ReservedCommandError('reserved'));
    const res = await supertest(buildApp())
      .post('/counters/add')
      .type('form')
      .send(VALID_ADD);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/counters?error=reserved_command');
  });

  it('7. redirects ?error=duplicate_command when addCounter throws CommandConflictError', async () => {
    vi.mocked(addCounter).mockRejectedValue(new CommandConflictError(['conflict']));
    const res = await supertest(buildApp())
      .post('/counters/add')
      .type('form')
      .send(VALID_ADD);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/counters?error=duplicate_command');
  });

  it('8. redirects ?error=duplicate_command when isMysqlDuplicateEntryError returns true', async () => {
    vi.mocked(addCounter).mockRejectedValue(new Error('ER_DUP_ENTRY'));
    vi.mocked(isMysqlDuplicateEntryError).mockReturnValue(true);
    const res = await supertest(buildApp())
      .post('/counters/add')
      .type('form')
      .send(VALID_ADD);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/counters?error=duplicate_command');
  });

  it('9. redirects ?error=add_failed when addCounter throws unknown error', async () => {
    vi.mocked(addCounter).mockRejectedValue(new Error('unknown db error'));
    const res = await supertest(buildApp())
      .post('/counters/add')
      .type('form')
      .send(VALID_ADD);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/counters?error=add_failed');
  });

  it('10. redirects /counters on valid form data', async () => {
    const res = await supertest(buildApp())
      .post('/counters/add')
      .type('form')
      .send(VALID_ADD);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/counters');
  });
});

// --- POST /counters/update ---

describe('POST /counters/update', () => {
  it('11. redirects ?error=missing_fields when required fields are absent', async () => {
    const res = await supertest(buildApp())
      .post('/counters/update')
      .type('form')
      .send({ id: '42' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/counters?error=missing_fields');
  });

  it('12. redirects ?error=invalid_id when id is non-numeric', async () => {
    const res = await supertest(buildApp())
      .post('/counters/update')
      .type('form')
      .send({ ...VALID_UPDATE, id: 'abc' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/counters?error=invalid_id');
  });

  it('13. redirects ?error=same_commands when trigger_command === check_command', async () => {
    const res = await supertest(buildApp())
      .post('/counters/update')
      .type('form')
      .send({ ...VALID_UPDATE, trigger_command: '!same', check_command: '!same' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/counters?error=same_commands');
  });

  it('14. redirects ?error=counter_not_found when updateCounter throws CounterNotFoundError', async () => {
    vi.mocked(updateCounter).mockRejectedValue(new CounterNotFoundError(1));
    const res = await supertest(buildApp())
      .post('/counters/update')
      .type('form')
      .send(VALID_UPDATE);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/counters?error=counter_not_found');
  });

  it('15. redirects ?error=reserved_command when updateCounter throws ReservedCommandError', async () => {
    vi.mocked(updateCounter).mockRejectedValue(new ReservedCommandError('reserved'));
    const res = await supertest(buildApp())
      .post('/counters/update')
      .type('form')
      .send(VALID_UPDATE);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/counters?error=reserved_command');
  });

  it('16. redirects /counters on valid update', async () => {
    const res = await supertest(buildApp())
      .post('/counters/update')
      .type('form')
      .send(VALID_UPDATE);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/counters');
  });
});

// --- POST /counters/remove ---

describe('POST /counters/remove', () => {
  it('17. redirects ?error=invalid_id when id is non-numeric', async () => {
    const res = await supertest(buildApp())
      .post('/counters/remove')
      .type('form')
      .send({ id: 'notanumber' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/counters?error=invalid_id');
  });

  it('18. redirects ?error=counter_not_found when removeCounter throws CounterNotFoundError', async () => {
    vi.mocked(removeCounter).mockRejectedValue(new CounterNotFoundError(1));
    const res = await supertest(buildApp())
      .post('/counters/remove')
      .type('form')
      .send({ id: '5' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/counters?error=counter_not_found');
  });

  it('19. redirects /counters on valid remove', async () => {
    const res = await supertest(buildApp())
      .post('/counters/remove')
      .type('form')
      .send({ id: '5' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/counters');
  });
});

// --- POST /counters/reset/:id ---

describe('POST /counters/reset/:id', () => {
  it('20. redirects ?error=invalid_id when :id is non-numeric', async () => {
    const res = await supertest(buildApp())
      .post('/counters/reset/notanumber');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/counters?error=invalid_id');
  });

  it('21. redirects /counters?reset=1 on valid reset', async () => {
    const res = await supertest(buildApp())
      .post('/counters/reset/7');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/counters?reset=1');
  });
});
