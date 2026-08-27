import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockLogger } from '../../test-utils/loggerMock';

vi.mock('../../shared/logger', () => ({ createLogger: mockLogger }));

vi.mock('../../shared/healthStore', () => ({
  getHealthSnapshot: vi.fn(),
}));

// viewHelpers.ts (used by health.ts for renderView/renderError) imports `getStreamerByDiscordId`
// from '../../db' at module load — mocked here purely so that transitive import doesn't pull in
// the real db/pool module, which requires DB_* env vars to be set.
vi.mock('../../db', () => ({
  getStreamerByDiscordId: vi.fn(),
}));

vi.mock('../csrf', () => ({
  csrfProtection: (req: any, _res: any, next: any) => {
    req.csrfToken = () => 'test-token';
    next();
  },
}));

vi.mock('../middleware', () => ({
  requireOwner: (req: any, res: any, next: any) => {
    if (req.session?.user?.isOwner) return next();
    res.status(403).json({ error: 'forbidden' });
  },
}));

import supertest from 'supertest';
import router from './health';
import { getHealthSnapshot } from '../../shared/healthStore';
import { buildTestApp } from '../../test-utils/expressTestApp';

const OWNER_SESSION_USER = {
  discordId: '1',
  discordName: 'Owner',
  accessLevel: 3,
  currentGuildId: null,
  isOwner: true,
  guilds: [],
};

const NON_OWNER_SESSION_USER = { ...OWNER_SESSION_USER, isOwner: false };

const SNAPSHOT = {
  discordConnected: true,
  twitchChatConnected: true,
  db: { lastPingOk: true, lastPingAt: null, lastError: null },
  eventsub: {},
  monitor: { lastPollOk: true, lastPollAt: null, lastError: null },
  schedulers: {},
  errors: [],
};

function buildApp(sessionUser: unknown) {
  return buildTestApp({ router, sessionUser, mockRender: 'nested' });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getHealthSnapshot).mockReturnValue(SNAPSHOT as any);
});

describe('GET /admin/health', () => {
  it('renders the health view with a snapshot for the owner', async () => {
    const res = await supertest(buildApp(OWNER_SESSION_USER)).get('/');
    expect(res.status).toBe(200);
    const body = res.body as any;
    expect(body.view).toBe('health');
    expect(body.locals.health).toEqual(SNAPSHOT);
  });

  it('blocks a non-owner with a 403', async () => {
    const res = await supertest(buildApp(NON_OWNER_SESSION_USER)).get('/');
    expect(res.status).toBe(403);
  });

  it('blocks an unauthenticated request with a 403', async () => {
    const res = await supertest(buildApp(undefined)).get('/');
    expect(res.status).toBe(403);
  });
});
