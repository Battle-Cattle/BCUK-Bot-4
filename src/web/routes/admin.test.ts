import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ACCESS_LEVEL_MOCK } from '../../test-utils/accessLevelMock';

vi.mock('../../db', () => ({
  getGuildMemberUsers: vi.fn(),
  ACCESS_LEVEL_LABELS: { 0: 'User', 1: 'Mod', 2: 'Manager', 3: 'Admin' },
  AccessLevel: ACCESS_LEVEL_MOCK,
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

vi.mock('./adminRefresh', async () => {
  const { Router } = await import('express');
  return {
    default: Router(),
  };
});

// The member-mutation routes are tested in adminUsersMutations.test.ts; this stub only answers
// one of their paths, so the mount test below can tell the router is reached.
vi.mock('./adminUsersMutations', async () => {
  const { Router } = await import('express');
  const router = Router();
  router.post('/users/add', (_req, res) => { res.status(204).end(); });
  return { router };
});

vi.mock('../../shared/logger', () => ({
  createLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));

import supertest from 'supertest';
import router from './admin';
import { getGuildMemberUsers, AccessLevel } from '../../db';
import { buildTestApp } from '../../test-utils/expressTestApp';

const GUILD_ID = '900000000000000001';
const ADMIN = { discordId: '100000000000000001', discordName: 'AdminUser', discordAvatar: null, isOwner: false, accessLevel: AccessLevel.ADMIN, currentGuildId: GUILD_ID };

/** Builds a supertest-ready app: the admin router with a stubbed session and a render mock that flattens locals into the JSON body. */
function buildApp() {
  return buildTestApp({ router, bodyParser: 'urlencoded', sessionUser: ADMIN, mockRender: 'spread' });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getGuildMemberUsers).mockResolvedValue([]);
});

// --- GET /users ---

describe('GET /users', () => {
  it('renders the admin view on success', async () => {
    const res = await supertest(buildApp()).get('/users');
    expect(res.status).toBe(200);
    expect(res.body.view).toBe('admin');
  });

  it('passes a known error query param to the template', async () => {
    const res = await supertest(buildApp()).get('/users?error=db_busy');
    expect(res.status).toBe(200);
    expect(res.body.error).toBe('db_busy');
  });

  it('passes null to the template for an unknown error query param', async () => {
    const res = await supertest(buildApp()).get('/users?error=made_up_error');
    expect(res.status).toBe(200);
    expect(res.body.error).toBeNull();
  });

  it('returns 500 when getGuildMemberUsers throws', async () => {
    vi.mocked(getGuildMemberUsers).mockRejectedValue(new Error('DB down'));
    const res = await supertest(buildApp()).get('/users');
    expect(res.status).toBe(500);
  });
});

describe('member-mutation routes', () => {
  it('mounts the member-mutation router under the same prefix', async () => {
    const res = await supertest(buildApp()).post('/users/add');
    expect(res.status).toBe(204);
  });
});
