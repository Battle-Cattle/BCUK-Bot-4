import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockLogger } from '../../test-utils/loggerMock';
import { ACCESS_LEVEL_MOCK } from '../../test-utils/accessLevelMock';

vi.mock('../../db', () => ({
  findUser: vi.fn().mockResolvedValue(null),
  AccessLevel: ACCESS_LEVEL_MOCK,
}));
vi.mock('../csrf', () => ({
  csrfProtection: (_req: any, _res: any, next: any) => next(),
}));
vi.mock('../middleware', () => ({
  requireMod: (_req: any, _res: any, next: any) => next(),
}));

import supertest from 'supertest';
import { createAssignmentRouter } from './assignmentRoutes';
import { findUser } from '../../db';
import { buildTestApp } from '../../test-utils/expressTestApp';

/** Builds a supertest-ready app mounting a `createAssignmentRouter` instance with a urlencoded body parser. */
function buildApp(router: ReturnType<typeof createAssignmentRouter>) {
  return buildTestApp({ router, bodyParser: 'urlencoded' });
}

const VALID_ID = '5';
const VALID_DISCORD_ID = '123456789012345678'; // 18 digits

const parseId = (raw: string): number | null => {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(findUser).mockResolvedValue({ discord_id: VALID_DISCORD_ID, discord_name: 'Alice', twitch_name: 'alice' } as any);
});

describe('createAssignmentRouter — assign', () => {
  it('redirects to basePath on success', async () => {
    const assign = vi.fn().mockResolvedValue(undefined);
    const router = createAssignmentRouter({
      basePath: '/things', idField: 'thing_id', parseId, assign, unassign: vi.fn(), log: mockLogger() as any,
    });
    const res = await supertest(buildApp(router))
      .post('/things/assign')
      .send(`thing_id=${VALID_ID}&discord_id=${VALID_DISCORD_ID}`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/things');
    expect(assign).toHaveBeenCalledWith(5, VALID_DISCORD_ID);
  });

  it('redirects to ?error=missing_fields when fields are absent', async () => {
    const router = createAssignmentRouter({
      basePath: '/things', idField: 'thing_id', parseId, assign: vi.fn(), unassign: vi.fn(), log: mockLogger() as any,
    });
    const res = await supertest(buildApp(router)).post('/things/assign').send('');
    expect(res.headers.location).toBe('/things?error=missing_fields');
  });

  it('redirects to ?error=invalid_id when parseId rejects the id', async () => {
    const router = createAssignmentRouter({
      basePath: '/things', idField: 'thing_id', parseId, assign: vi.fn(), unassign: vi.fn(), log: mockLogger() as any,
    });
    const res = await supertest(buildApp(router))
      .post('/things/assign')
      .send(`thing_id=abc&discord_id=${VALID_DISCORD_ID}`);
    expect(res.headers.location).toBe('/things?error=invalid_id');
  });

  it('redirects to ?error=invalid_id for a malformed discord_id', async () => {
    const router = createAssignmentRouter({
      basePath: '/things', idField: 'thing_id', parseId, assign: vi.fn(), unassign: vi.fn(), log: mockLogger() as any,
    });
    const res = await supertest(buildApp(router))
      .post('/things/assign')
      .send(`thing_id=${VALID_ID}&discord_id=bad`);
    expect(res.headers.location).toBe('/things?error=invalid_id');
  });

  it('redirects to ?error=invalid_assignment_user when the user does not exist', async () => {
    vi.mocked(findUser).mockResolvedValue(null);
    const router = createAssignmentRouter({
      basePath: '/things', idField: 'thing_id', parseId, assign: vi.fn(), unassign: vi.fn(), log: mockLogger() as any,
    });
    const res = await supertest(buildApp(router))
      .post('/things/assign')
      .send(`thing_id=${VALID_ID}&discord_id=${VALID_DISCORD_ID}`);
    expect(res.headers.location).toBe('/things?error=invalid_assignment_user');
  });

  it('redirects to ?error=invalid_assignment_user when the user has no twitch_name', async () => {
    vi.mocked(findUser).mockResolvedValue({ discord_id: VALID_DISCORD_ID, discord_name: 'Alice', twitch_name: null } as any);
    const router = createAssignmentRouter({
      basePath: '/things', idField: 'thing_id', parseId, assign: vi.fn(), unassign: vi.fn(), log: mockLogger() as any,
    });
    const res = await supertest(buildApp(router))
      .post('/things/assign')
      .send(`thing_id=${VALID_ID}&discord_id=${VALID_DISCORD_ID}`);
    expect(res.headers.location).toBe('/things?error=invalid_assignment_user');
  });

  it('redirects to the mapped error code without logging when mapAssignError handles the thrown error', async () => {
    const assign = vi.fn().mockRejectedValueOnce(new Error('conflict'));
    const log = mockLogger();
    const router = createAssignmentRouter({
      basePath: '/things',
      idField: 'thing_id',
      parseId,
      assign,
      unassign: vi.fn(),
      mapAssignError: () => 'thing_taken',
      log: log as any,
    });
    const res = await supertest(buildApp(router))
      .post('/things/assign')
      .send(`thing_id=${VALID_ID}&discord_id=${VALID_DISCORD_ID}`);
    expect(res.headers.location).toBe('/things?error=thing_taken');
    expect(log.error).not.toHaveBeenCalled();
  });

  it('redirects to ?error=assign_failed and logs when the error is unmapped', async () => {
    const assign = vi.fn().mockRejectedValueOnce(new Error('unexpected'));
    const log = mockLogger();
    const router = createAssignmentRouter({
      basePath: '/things',
      idField: 'thing_id',
      parseId,
      assign,
      unassign: vi.fn(),
      mapAssignError: () => null,
      log: log as any,
    });
    const res = await supertest(buildApp(router))
      .post('/things/assign')
      .send(`thing_id=${VALID_ID}&discord_id=${VALID_DISCORD_ID}`);
    expect(res.headers.location).toBe('/things?error=assign_failed');
    expect(log.error).toHaveBeenCalled();
  });
});

describe('createAssignmentRouter — unassign', () => {
  it('redirects to basePath on success', async () => {
    const unassign = vi.fn().mockResolvedValue(undefined);
    const router = createAssignmentRouter({
      basePath: '/things', idField: 'thing_id', parseId, assign: vi.fn(), unassign, log: mockLogger() as any,
    });
    const res = await supertest(buildApp(router))
      .post('/things/unassign')
      .send(`thing_id=${VALID_ID}&discord_id=${VALID_DISCORD_ID}`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/things');
    expect(unassign).toHaveBeenCalledWith(5, VALID_DISCORD_ID);
  });

  it('redirects to ?error=missing_fields when fields are absent', async () => {
    const router = createAssignmentRouter({
      basePath: '/things', idField: 'thing_id', parseId, assign: vi.fn(), unassign: vi.fn(), log: mockLogger() as any,
    });
    const res = await supertest(buildApp(router)).post('/things/unassign').send('');
    expect(res.headers.location).toBe('/things?error=missing_fields');
  });

  it('redirects to ?error=invalid_id when parseId rejects the id', async () => {
    const router = createAssignmentRouter({
      basePath: '/things', idField: 'thing_id', parseId, assign: vi.fn(), unassign: vi.fn(), log: mockLogger() as any,
    });
    const res = await supertest(buildApp(router))
      .post('/things/unassign')
      .send(`thing_id=abc&discord_id=${VALID_DISCORD_ID}`);
    expect(res.headers.location).toBe('/things?error=invalid_id');
  });

  it('redirects to ?error=unassign_failed and logs on unexpected error', async () => {
    const unassign = vi.fn().mockRejectedValueOnce(new Error('db error'));
    const log = mockLogger();
    const router = createAssignmentRouter({
      basePath: '/things', idField: 'thing_id', parseId, assign: vi.fn(), unassign, log: log as any,
    });
    const res = await supertest(buildApp(router))
      .post('/things/unassign')
      .send(`thing_id=${VALID_ID}&discord_id=${VALID_DISCORD_ID}`);
    expect(res.headers.location).toBe('/things?error=unassign_failed');
    expect(log.error).toHaveBeenCalled();
  });
});
