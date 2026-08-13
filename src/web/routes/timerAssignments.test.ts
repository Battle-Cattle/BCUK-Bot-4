import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockLogger } from '../../test-utils/loggerMock';
import { ACCESS_LEVEL_MOCK } from '../../test-utils/accessLevelMock';

vi.mock('../../db', () => ({
  assignUserToTimer: vi.fn().mockResolvedValue(undefined),
  unassignUserFromTimer: vi.fn().mockResolvedValue(undefined),
  findUser: vi.fn().mockResolvedValue(null),
  AccessLevel: ACCESS_LEVEL_MOCK,
}));
vi.mock('../csrf', () => ({
  csrfProtection: (_req: any, _res: any, next: any) => next(),
}));
vi.mock('../middleware', () => ({
  requireGuildContext: (_req: any, _res: any, next: any) => next(),
  requireMod: (_req: any, _res: any, next: any) => next(),
}));
vi.mock('../../shared/logger', () => ({ createLogger: mockLogger }));

import supertest from 'supertest';
import router from './timerAssignments';
import { assignUserToTimer, unassignUserFromTimer, findUser } from '../../db';
import { AccessLevel } from '../../db';
import { buildTestApp } from '../../test-utils/expressTestApp';

/** Builds a supertest-ready app: the timer assignments router with a urlencoded body parser (no session or render stub needed). */
function buildApp() {
  return buildTestApp({ router, bodyParser: 'urlencoded' });
}

const VALID_TIMER_ID = '5';
const VALID_DISCORD_ID = '123456789012345678'; // 18 digits

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(findUser).mockResolvedValue({ discord_id: VALID_DISCORD_ID, discord_name: 'Alice', twitch_name: 'alice', access_level: AccessLevel.USER } as any);
  vi.mocked(assignUserToTimer).mockResolvedValue(undefined);
  vi.mocked(unassignUserFromTimer).mockResolvedValue(undefined);
});

// ─── POST /timers/assign ──────────────────────────────────────────────────────

describe('POST /timers/assign', () => {
  it('redirects to /timers on success', async () => {
    const res = await supertest(buildApp())
      .post('/timers/assign')
      .send(`timer_id=${VALID_TIMER_ID}&discord_id=${VALID_DISCORD_ID}`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/timers');
    expect(vi.mocked(assignUserToTimer)).toHaveBeenCalledWith(5, VALID_DISCORD_ID);
  });

  it('redirects to ?error=missing_fields when fields are absent', async () => {
    const res = await supertest(buildApp()).post('/timers/assign').send('');
    expect(res.headers.location).toBe('/timers?error=missing_fields');
  });

  it('redirects to ?error=invalid_id for non-numeric timer_id', async () => {
    const res = await supertest(buildApp())
      .post('/timers/assign')
      .send(`timer_id=abc&discord_id=${VALID_DISCORD_ID}`);
    expect(res.headers.location).toBe('/timers?error=invalid_id');
  });

  it('redirects to ?error=invalid_id for invalid discord_id', async () => {
    const res = await supertest(buildApp())
      .post('/timers/assign')
      .send(`timer_id=${VALID_TIMER_ID}&discord_id=bad`);
    expect(res.headers.location).toBe('/timers?error=invalid_id');
  });

  it('redirects to ?error=invalid_assignment_user when user not found', async () => {
    vi.mocked(findUser).mockResolvedValue(null);
    const res = await supertest(buildApp())
      .post('/timers/assign')
      .send(`timer_id=${VALID_TIMER_ID}&discord_id=${VALID_DISCORD_ID}`);
    expect(res.headers.location).toBe('/timers?error=invalid_assignment_user');
  });

  it('redirects to ?error=invalid_assignment_user when user has no twitch_name', async () => {
    vi.mocked(findUser).mockResolvedValue({ discord_id: VALID_DISCORD_ID, discord_name: 'Alice', twitch_name: null, access_level: AccessLevel.USER } as any);
    const res = await supertest(buildApp())
      .post('/timers/assign')
      .send(`timer_id=${VALID_TIMER_ID}&discord_id=${VALID_DISCORD_ID}`);
    expect(res.headers.location).toBe('/timers?error=invalid_assignment_user');
  });

  it('redirects to ?error=assign_failed on unexpected error', async () => {
    vi.mocked(assignUserToTimer).mockRejectedValueOnce(new Error('unexpected'));
    const res = await supertest(buildApp())
      .post('/timers/assign')
      .send(`timer_id=${VALID_TIMER_ID}&discord_id=${VALID_DISCORD_ID}`);
    expect(res.headers.location).toBe('/timers?error=assign_failed');
  });
});

// ─── POST /timers/unassign ────────────────────────────────────────────────────

describe('POST /timers/unassign', () => {
  it('redirects to /timers on success', async () => {
    const res = await supertest(buildApp())
      .post('/timers/unassign')
      .send(`timer_id=${VALID_TIMER_ID}&discord_id=${VALID_DISCORD_ID}`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/timers');
    expect(vi.mocked(unassignUserFromTimer)).toHaveBeenCalledWith(5, VALID_DISCORD_ID);
  });

  it('redirects to ?error=missing_fields when fields are absent', async () => {
    const res = await supertest(buildApp()).post('/timers/unassign').send('');
    expect(res.headers.location).toBe('/timers?error=missing_fields');
  });

  it('redirects to ?error=invalid_id for non-numeric timer_id', async () => {
    const res = await supertest(buildApp())
      .post('/timers/unassign')
      .send(`timer_id=abc&discord_id=${VALID_DISCORD_ID}`);
    expect(res.headers.location).toBe('/timers?error=invalid_id');
  });

  it('redirects to ?error=invalid_id for malformed discord_id', async () => {
    const res = await supertest(buildApp())
      .post('/timers/unassign')
      .send(`timer_id=${VALID_TIMER_ID}&discord_id=bad`);
    expect(res.headers.location).toBe('/timers?error=invalid_id');
  });

  it('redirects to ?error=unassign_failed on unexpected error', async () => {
    vi.mocked(unassignUserFromTimer).mockRejectedValueOnce(new Error('db error'));
    const res = await supertest(buildApp())
      .post('/timers/unassign')
      .send(`timer_id=${VALID_TIMER_ID}&discord_id=${VALID_DISCORD_ID}`);
    expect(res.headers.location).toBe('/timers?error=unassign_failed');
  });
});
