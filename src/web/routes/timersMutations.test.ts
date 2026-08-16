import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockLogger } from '../../test-utils/loggerMock';
import { ACCESS_LEVEL_MOCK } from '../../test-utils/accessLevelMock';

vi.mock('../../db', () => {
  class TimerCommandNotFoundError extends Error {}
  return {
    addTimerCommand: vi.fn().mockResolvedValue(1),
    updateTimerCommand: vi.fn().mockResolvedValue(undefined),
    removeTimerCommand: vi.fn().mockResolvedValue(undefined),
    setTimerCommandEnabled: vi.fn().mockResolvedValue(undefined),
    assignUsersToTimer: vi.fn().mockResolvedValue(undefined),
    findUsersByIds: vi.fn().mockResolvedValue(new Map()),
    TimerCommandNotFoundError,
    AccessLevel: ACCESS_LEVEL_MOCK,
  };
});
vi.mock('../csrf', () => ({ csrfProtection: (_req: any, _res: any, next: any) => next() }));
const { middlewareCallOrder } = vi.hoisted(() => ({ middlewareCallOrder: [] as string[] }));
vi.mock('../middleware', () => ({
  requireGuildContext: (_req: any, _res: any, next: any) => { middlewareCallOrder.push('requireGuildContext'); next(); },
  requireMod: (_req: any, _res: any, next: any) => { middlewareCallOrder.push('requireMod'); next(); },
}));
vi.mock('../../shared/logger', () => ({ createLogger: mockLogger }));

import supertest from 'supertest';
import router from './timersMutations';
import {
  addTimerCommand, updateTimerCommand, removeTimerCommand, setTimerCommandEnabled,
  assignUsersToTimer, findUsersByIds, TimerCommandNotFoundError,
} from '../../db';
import { AccessLevel } from '../../db';
import { buildTestApp } from '../../test-utils/expressTestApp';

/** Builds a supertest-ready app: the timer mutations router with a urlencoded body parser (no session or render stub needed). */
function buildApp() {
  return buildTestApp({ router, bodyParser: 'urlencoded' });
}

const VALID_DISCORD_ID = '123456789012345678';

beforeEach(() => {
  vi.clearAllMocks();
  middlewareCallOrder.length = 0;
  vi.mocked(addTimerCommand).mockResolvedValue(1);
  vi.mocked(updateTimerCommand).mockResolvedValue(undefined);
  vi.mocked(removeTimerCommand).mockResolvedValue(undefined);
  vi.mocked(setTimerCommandEnabled).mockResolvedValue(undefined);
  vi.mocked(assignUsersToTimer).mockResolvedValue(undefined);
  vi.mocked(findUsersByIds).mockResolvedValue(new Map());
});

const VALID_FIELDS = 'name=Discord+plug&message=Join+our+Discord&interval_seconds=600&min_messages=0';

// ─── POST /timers/add ─────────────────────────────────────────────────────────

describe('POST /timers/add', () => {
  it('runs requireGuildContext before requireMod, so a demoted session is re-checked with a fresh access level', async () => {
    await supertest(buildApp()).post('/timers/add').send(VALID_FIELDS);
    expect(middlewareCallOrder).toEqual(['requireGuildContext', 'requireMod']);
  });

  it('redirects to /timers on success', async () => {
    const res = await supertest(buildApp()).post('/timers/add').send(VALID_FIELDS);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/timers');
  });

  it('redirects to ?error=missing_fields when name is absent', async () => {
    const res = await supertest(buildApp()).post('/timers/add').send('message=hi&interval_seconds=600&min_messages=0');
    expect(res.headers.location).toBe('/timers?error=missing_fields');
  });

  it('redirects to ?error=missing_fields when message is absent', async () => {
    const res = await supertest(buildApp()).post('/timers/add').send('name=Plug&interval_seconds=600&min_messages=0');
    expect(res.headers.location).toBe('/timers?error=missing_fields');
  });

  it('redirects to ?error=invalid_interval when interval_seconds is below the minimum', async () => {
    const res = await supertest(buildApp()).post('/timers/add').send('name=Plug&message=hi&interval_seconds=10&min_messages=0');
    expect(res.headers.location).toBe('/timers?error=invalid_interval');
  });

  it('redirects to ?error=invalid_interval when interval_seconds is non-numeric', async () => {
    const res = await supertest(buildApp()).post('/timers/add').send('name=Plug&message=hi&interval_seconds=abc&min_messages=0');
    expect(res.headers.location).toBe('/timers?error=invalid_interval');
  });

  it('redirects to ?error=invalid_min_messages when min_messages is non-numeric', async () => {
    const res = await supertest(buildApp()).post('/timers/add').send('name=Plug&message=hi&interval_seconds=600&min_messages=abc');
    expect(res.headers.location).toBe('/timers?error=invalid_min_messages');
  });

  it('redirects to ?error=add_failed on unexpected error', async () => {
    vi.mocked(addTimerCommand).mockRejectedValueOnce(new Error('DB down'));
    const res = await supertest(buildApp()).post('/timers/add').send(VALID_FIELDS);
    expect(res.headers.location).toBe('/timers?error=add_failed');
  });

  it('assigns users when discord_ids are provided and user has twitch_name', async () => {
    vi.mocked(findUsersByIds).mockResolvedValue(new Map([
      [VALID_DISCORD_ID, { discord_id: VALID_DISCORD_ID, discord_name: 'Alice', twitch_name: 'alice', access_level: AccessLevel.USER } as any],
    ]));
    const res = await supertest(buildApp()).post('/timers/add').send(`${VALID_FIELDS}&discord_ids=${VALID_DISCORD_ID}`);
    expect(res.headers.location).toBe('/timers');
    expect(assignUsersToTimer).toHaveBeenCalledWith(1, [VALID_DISCORD_ID]);
  });

  it('skips assigning user when findUsersByIds does not return a matching entry', async () => {
    vi.mocked(findUsersByIds).mockResolvedValue(new Map());
    const res = await supertest(buildApp()).post('/timers/add').send(`${VALID_FIELDS}&discord_ids=${VALID_DISCORD_ID}`);
    expect(res.headers.location).toBe('/timers');
    expect(assignUsersToTimer).toHaveBeenCalledWith(1, []);
  });

  it('drops a malformed discord_id before looking up eligibility', async () => {
    const res = await supertest(buildApp()).post('/timers/add').send(`${VALID_FIELDS}&discord_ids=not-a-snowflake`);
    expect(res.headers.location).toBe('/timers');
    expect(findUsersByIds).toHaveBeenCalledWith([]);
    expect(assignUsersToTimer).toHaveBeenCalledWith(1, []);
  });

  it('redirects to ?error=assign_failed on unexpected assign error, and cleans up the created timer', async () => {
    vi.mocked(findUsersByIds).mockResolvedValue(new Map([
      [VALID_DISCORD_ID, { discord_id: VALID_DISCORD_ID, twitch_name: 'alice', discord_name: null, access_level: AccessLevel.USER } as any],
    ]));
    vi.mocked(assignUsersToTimer).mockRejectedValueOnce(new Error('DB error'));
    const res = await supertest(buildApp()).post('/timers/add').send(`${VALID_FIELDS}&discord_ids=${VALID_DISCORD_ID}`);
    expect(res.headers.location).toBe('/timers?error=assign_failed');
    expect(removeTimerCommand).toHaveBeenCalledWith(1);
  });

  it('redirects to ?error=assign_failed when findUsersByIds itself throws, and cleans up the created timer', async () => {
    vi.mocked(findUsersByIds).mockRejectedValueOnce(new Error('DB down'));
    const res = await supertest(buildApp()).post('/timers/add').send(`${VALID_FIELDS}&discord_ids=${VALID_DISCORD_ID}`);
    expect(res.headers.location).toBe('/timers?error=assign_failed');
    expect(removeTimerCommand).toHaveBeenCalledWith(1);
  });

  it('still redirects to ?error=assign_failed when the cleanup delete itself also fails', async () => {
    vi.mocked(findUsersByIds).mockRejectedValueOnce(new Error('DB down'));
    vi.mocked(removeTimerCommand).mockRejectedValueOnce(new Error('cleanup also failed'));
    const res = await supertest(buildApp()).post('/timers/add').send(`${VALID_FIELDS}&discord_ids=${VALID_DISCORD_ID}`);
    expect(res.headers.location).toBe('/timers?error=assign_failed');
    expect(removeTimerCommand).toHaveBeenCalledWith(1);
  });
});

// ─── POST /timers/update ──────────────────────────────────────────────────────

describe('POST /timers/update', () => {
  it('runs requireGuildContext before requireMod, so a demoted session is re-checked with a fresh access level', async () => {
    await supertest(buildApp()).post('/timers/update').send(`id=1&${VALID_FIELDS}`);
    expect(middlewareCallOrder).toEqual(['requireGuildContext', 'requireMod']);
  });

  it('redirects to /timers on success', async () => {
    const res = await supertest(buildApp()).post('/timers/update').send(`id=1&${VALID_FIELDS}`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/timers');
  });

  it('redirects to ?error=invalid_id when id is non-numeric', async () => {
    const res = await supertest(buildApp()).post('/timers/update').send(`id=abc&${VALID_FIELDS}`);
    expect(res.headers.location).toBe('/timers?error=invalid_id');
  });

  it('redirects to ?error=missing_fields when name is absent', async () => {
    const res = await supertest(buildApp()).post('/timers/update').send('id=1&message=hi&interval_seconds=600&min_messages=0');
    expect(res.headers.location).toBe('/timers?error=missing_fields');
  });

  it('redirects to ?error=timer_not_found when TimerCommandNotFoundError is thrown', async () => {
    vi.mocked(updateTimerCommand).mockRejectedValueOnce(new (TimerCommandNotFoundError as any)(1));
    const res = await supertest(buildApp()).post('/timers/update').send(`id=1&${VALID_FIELDS}`);
    expect(res.headers.location).toBe('/timers?error=timer_not_found');
  });

  it('redirects to ?error=update_failed on unexpected error', async () => {
    vi.mocked(updateTimerCommand).mockRejectedValueOnce(new Error('DB error'));
    const res = await supertest(buildApp()).post('/timers/update').send(`id=1&${VALID_FIELDS}`);
    expect(res.headers.location).toBe('/timers?error=update_failed');
  });

  it('passes require_live=true and enabled=true when checkboxes are "on"', async () => {
    await supertest(buildApp()).post('/timers/update').send(`id=1&${VALID_FIELDS}&require_live=on&enabled=on`);
    expect(updateTimerCommand).toHaveBeenCalledWith(1, {
      name: 'Discord plug', message: 'Join our Discord', intervalSeconds: 600, minMessages: 0,
      requireLive: true, enabled: true,
    });
  });
});

// ─── POST /timers/remove ──────────────────────────────────────────────────────

describe('POST /timers/remove', () => {
  it('runs requireGuildContext before requireMod, so a demoted session is re-checked with a fresh access level', async () => {
    await supertest(buildApp()).post('/timers/remove').send('id=5');
    expect(middlewareCallOrder).toEqual(['requireGuildContext', 'requireMod']);
  });

  it('redirects to /timers on success', async () => {
    const res = await supertest(buildApp()).post('/timers/remove').send('id=5');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/timers');
  });

  it('redirects to ?error=invalid_id when id is non-numeric', async () => {
    const res = await supertest(buildApp()).post('/timers/remove').send('id=abc');
    expect(res.headers.location).toBe('/timers?error=invalid_id');
  });

  it('redirects to ?error=remove_failed on unexpected error', async () => {
    vi.mocked(removeTimerCommand).mockRejectedValueOnce(new Error('DB error'));
    const res = await supertest(buildApp()).post('/timers/remove').send('id=5');
    expect(res.headers.location).toBe('/timers?error=remove_failed');
  });
});

// ─── POST /timers/toggle ──────────────────────────────────────────────────────

describe('POST /timers/toggle', () => {
  it('runs requireGuildContext before requireMod, so a demoted session is re-checked with a fresh access level', async () => {
    await supertest(buildApp()).post('/timers/toggle').send('id=1&enabled=true');
    expect(middlewareCallOrder).toEqual(['requireGuildContext', 'requireMod']);
  });

  it('redirects to /timers on success', async () => {
    const res = await supertest(buildApp()).post('/timers/toggle').send('id=1&enabled=true');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/timers');
    expect(setTimerCommandEnabled).toHaveBeenCalledWith(1, true);
  });

  it('redirects to ?error=invalid_id when id is non-numeric', async () => {
    const res = await supertest(buildApp()).post('/timers/toggle').send('id=abc&enabled=true');
    expect(res.headers.location).toBe('/timers?error=invalid_id');
  });

  it('redirects to ?error=timer_not_found when TimerCommandNotFoundError is thrown', async () => {
    vi.mocked(setTimerCommandEnabled).mockRejectedValueOnce(new (TimerCommandNotFoundError as any)(1));
    const res = await supertest(buildApp()).post('/timers/toggle').send('id=1&enabled=true');
    expect(res.headers.location).toBe('/timers?error=timer_not_found');
  });

  it('redirects to ?error=toggle_failed on unexpected error', async () => {
    vi.mocked(setTimerCommandEnabled).mockRejectedValueOnce(new Error('DB error'));
    const res = await supertest(buildApp()).post('/timers/toggle').send('id=1&enabled=true');
    expect(res.headers.location).toBe('/timers?error=toggle_failed');
  });
});
