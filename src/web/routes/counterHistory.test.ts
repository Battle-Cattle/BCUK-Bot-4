import { describe, it, expect, vi, beforeEach } from 'vitest';

/** Hoisted so the `vi.mock` factories below can safely reference these — `vi.mock` factories are hoisted above imports, so plain imported bindings could throw `ReferenceError` depending on import order. */
const { mockLogger, ACCESS_LEVEL_MOCK } = vi.hoisted(() => ({
  mockLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  ACCESS_LEVEL_MOCK: { USER: 0, MOD: 1, MANAGER: 2, ADMIN: 3 },
}));

vi.mock('../../db', () => ({
  getCounterHistory: vi.fn().mockResolvedValue(null),
  AccessLevel: ACCESS_LEVEL_MOCK,
}));

vi.mock('../csrf', () => ({
  csrfProtection: (req: any, res: any, next: any) => {
    req.csrfToken = () => 'test-csrf-token';
    next();
  },
}));

vi.mock('../middleware', () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
}));

/** Mocks the shared logger so route handlers don't write real log output during tests. */
vi.mock('../../shared/logger', () => ({ createLogger: mockLogger }));

import supertest from 'supertest';
import router from './counterHistory';
import { getCounterHistory } from '../../db';
import { AccessLevel } from '../../db';
import { buildTestApp } from '../../test-utils/expressTestApp';

/** Builds a supertest-ready app: the counter history router with a stubbed session and a render mock that sends `rendered:<view>` (locals ignored). */
function buildApp() {
  return buildTestApp({
    router,
    bodyParser: 'urlencoded',
    sessionUser: { discord_id: '1', discord_name: 'TestUser', access_level: AccessLevel.USER },
    mockRender: 'text',
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getCounterHistory).mockResolvedValue(null);
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
