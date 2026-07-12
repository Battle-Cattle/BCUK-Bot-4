import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../commands/commandMonitorStore', () => ({
  getRecentCommandTestEntries: vi.fn().mockReturnValue([]),
}));

vi.mock('../csrf', () => ({
  csrfProtection: (req: any, _res: any, next: any) => {
    req.csrfToken = () => 'test-csrf-token';
    next();
  },
}));

vi.mock('../middleware', () => ({
  requireManager: (_req: any, _res: any, next: any) => next(),
}));

vi.mock('../../shared/logger', () => ({
  createLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn() }),
}));

import supertest from 'supertest';
import router from './commandMonitor';
import { getRecentCommandTestEntries } from '../../commands/commandMonitorStore';
import { buildTestApp } from '../../test-utils/expressTestApp';

/** Builds a minimal Express app wired with the command-monitor router and a fake session user. */
function buildApp() {
  return buildTestApp({ router, sessionUser: { discordId: '1', discordName: 'TestUser' }, mockRender: 'nested' });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /command-monitor', () => {
  it('renders the command-monitor view with recent entries', async () => {
    const entries = [{ id: '1', source: 'discord', command: '!clap' }];
    vi.mocked(getRecentCommandTestEntries).mockReturnValue(entries as any);

    const res = await supertest(buildApp()).get('/command-monitor');

    expect(res.status).toBe(200);
    expect(res.body.view).toBe('command-monitor');
    expect(res.body.locals.recentEntries).toEqual(entries);
    expect(res.body.locals.csrfToken).toBe('test-csrf-token');
  });

  it('renders a 500 error page when loading entries throws', async () => {
    vi.mocked(getRecentCommandTestEntries).mockImplementation(() => {
      throw new Error('boom');
    });

    const res = await supertest(buildApp()).get('/command-monitor');

    expect(res.status).toBe(500);
    expect(res.body.view).toBe('error');
  });
});

describe('GET /command-monitor/recent', () => {
  it('returns recent entries as JSON', async () => {
    const entries = [{ id: '1', source: 'twitch', command: '!hype' }];
    vi.mocked(getRecentCommandTestEntries).mockReturnValue(entries as any);

    const res = await supertest(buildApp()).get('/command-monitor/recent');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ entries });
  });

  it('returns 500 with an empty entries array when the store throws', async () => {
    vi.mocked(getRecentCommandTestEntries).mockImplementation(() => {
      throw new Error('boom');
    });

    const res = await supertest(buildApp()).get('/command-monitor/recent');

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ entries: [] });
  });
});
