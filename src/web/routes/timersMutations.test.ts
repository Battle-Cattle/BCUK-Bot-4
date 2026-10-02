import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockLogger } from '../../test-utils/loggerMock';
import { ACCESS_LEVEL_MOCK } from '../../test-utils/accessLevelMock';

vi.mock('../../db', () => {
  class TimerCommandNotFoundError extends Error {}
  class TimerSelfServiceDeniedError extends Error {}
  return {
    addTimerCommand: vi.fn().mockResolvedValue(1),
    updateTimerCommand: vi.fn().mockResolvedValue(undefined),
    removeTimerCommand: vi.fn().mockResolvedValue(undefined),
    setTimerCommandEnabled: vi.fn().mockResolvedValue(undefined),
    assignUsersToTimer: vi.fn().mockResolvedValue(undefined),
    findUsersByIds: vi.fn().mockResolvedValue(new Map()),
    findUser: vi.fn().mockResolvedValue(null),
    getMemberAccessLevel: vi.fn().mockResolvedValue(0),
    updateOwnTimerCommand: vi.fn().mockResolvedValue(undefined),
    setOwnTimerCommandEnabled: vi.fn().mockResolvedValue(undefined),
    removeOwnTimerCommand: vi.fn().mockResolvedValue(undefined),
    discardOwnNewTimerCommand: vi.fn().mockResolvedValue(undefined),
    TimerCommandNotFoundError,
    TimerSelfServiceDeniedError,
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
  assignUsersToTimer, findUsersByIds, findUser, getMemberAccessLevel, TimerCommandNotFoundError, TimerSelfServiceDeniedError,
  updateOwnTimerCommand, setOwnTimerCommandEnabled, removeOwnTimerCommand, discardOwnNewTimerCommand,
} from '../../db';
import { AccessLevel } from '../../db';
import { buildTestApp } from '../../test-utils/expressTestApp';

const GUILD_ID = '900000000000000001';
const MOD_SESSION_USER = { discordId: '1', discordName: 'Mod', accessLevel: ACCESS_LEVEL_MOCK.MOD, currentGuildId: GUILD_ID };
const STREAMER_ID = '111111111111111111';
const STREAMER_SESSION_USER = { discordId: STREAMER_ID, discordName: 'Streamer', accessLevel: ACCESS_LEVEL_MOCK.USER };

/** Builds a supertest-ready app: the timer mutations router with a urlencoded body parser and a Mod session user by default. */
function buildApp(sessionUser: unknown = MOD_SESSION_USER) {
  return buildTestApp({ router, bodyParser: 'urlencoded', sessionUser });
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
  vi.mocked(findUser).mockResolvedValue(null);
  vi.mocked(getMemberAccessLevel).mockResolvedValue(0);
  vi.mocked(updateOwnTimerCommand).mockResolvedValue(undefined);
  vi.mocked(setOwnTimerCommandEnabled).mockResolvedValue(undefined);
  vi.mocked(removeOwnTimerCommand).mockResolvedValue(undefined);
  vi.mocked(discardOwnNewTimerCommand).mockResolvedValue(undefined);
});

const VALID_FIELDS = 'name=Discord+plug&message=Join+our+Discord&interval_seconds=600&min_messages=0';

// ─── POST /timers/add ─────────────────────────────────────────────────────────

describe('POST /timers/add', () => {
  it('runs requireGuildContext (not requireMod), so the handler sees a fresh access level and can allow streamer self-service', async () => {
    await supertest(buildApp()).post('/timers/add').send(VALID_FIELDS);
    expect(middlewareCallOrder).toEqual(['requireGuildContext']);
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

  it('redirects to ?error=assignee_not_in_guild without creating anything when a discord_id is not a member of the current guild', async () => {
    vi.mocked(getMemberAccessLevel).mockResolvedValue(null);
    const res = await supertest(buildApp())
      .post('/timers/add').send(`${VALID_FIELDS}&discord_ids=${VALID_DISCORD_ID}`);
    expect(res.headers.location).toBe('/timers?error=assignee_not_in_guild');
    expect(getMemberAccessLevel).toHaveBeenCalledWith(GUILD_ID, VALID_DISCORD_ID);
    expect(addTimerCommand).not.toHaveBeenCalled();
    expect(assignUsersToTimer).not.toHaveBeenCalled();
  });

  it('assigns users when discord_ids are provided and user has twitch_name', async () => {
    vi.mocked(findUsersByIds).mockResolvedValue(new Map([
      [VALID_DISCORD_ID, { discord_id: VALID_DISCORD_ID, discord_name: 'Alice', twitch_name: 'alice', access_level: AccessLevel.USER } as any],
    ]));
    const res = await supertest(buildApp()).post('/timers/add').send(`${VALID_FIELDS}&discord_ids=${VALID_DISCORD_ID}`);
    expect(res.headers.location).toBe('/timers');
    expect(assignUsersToTimer).toHaveBeenCalledWith(1, [VALID_DISCORD_ID]);
    expect(getMemberAccessLevel).toHaveBeenCalledWith(GUILD_ID, VALID_DISCORD_ID);
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

  it('assigns a streamer\'s new timer to their own channel only, ignoring discord_ids', async () => {
    vi.mocked(findUser).mockResolvedValue({ discord_id: STREAMER_ID, twitch_name: 'streamer' } as any);
    vi.mocked(findUsersByIds).mockResolvedValue(new Map([
      [STREAMER_ID, { discord_id: STREAMER_ID, twitch_name: 'streamer' } as any],
      [VALID_DISCORD_ID, { discord_id: VALID_DISCORD_ID, twitch_name: 'alice' } as any],
    ]));
    const res = await supertest(buildApp(STREAMER_SESSION_USER)).post('/timers/add').send(`${VALID_FIELDS}&discord_ids=${VALID_DISCORD_ID}`);
    expect(res.headers.location).toBe('/timers');
    expect(findUsersByIds).toHaveBeenCalledWith([STREAMER_ID]);
    expect(assignUsersToTimer).toHaveBeenCalledWith(1, [STREAMER_ID]);
  });

  it('redirects a streamer with no linked Twitch account to ?error=twitch_not_linked without creating a timer', async () => {
    vi.mocked(findUser).mockResolvedValue({ discord_id: STREAMER_ID, twitch_name: null } as any);
    const res = await supertest(buildApp(STREAMER_SESSION_USER)).post('/timers/add').send(VALID_FIELDS);
    expect(res.headers.location).toBe('/timers?error=twitch_not_linked');
    expect(addTimerCommand).not.toHaveBeenCalled();
  });

  it('cleans up a streamer\'s failed new timer with the unclaimed-only discard, not the unrestricted delete', async () => {
    vi.mocked(findUser).mockResolvedValue({ discord_id: STREAMER_ID, twitch_name: 'streamer' } as any);
    vi.mocked(findUsersByIds).mockRejectedValueOnce(new Error('DB down'));
    const res = await supertest(buildApp(STREAMER_SESSION_USER)).post('/timers/add').send(VALID_FIELDS);
    expect(res.headers.location).toBe('/timers?error=assign_failed');
    expect(discardOwnNewTimerCommand).toHaveBeenCalledWith(1, STREAMER_ID);
    expect(removeTimerCommand).not.toHaveBeenCalled();
  });
});

// ─── POST /timers/update ──────────────────────────────────────────────────────

describe('POST /timers/update', () => {
  it('runs requireGuildContext (not requireMod), so the handler sees a fresh access level and can allow streamer self-service', async () => {
    await supertest(buildApp()).post('/timers/update').send(`id=1&${VALID_FIELDS}`);
    expect(middlewareCallOrder).toEqual(['requireGuildContext']);
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

  it('routes a streamer\'s update through the owner-checked write', async () => {
    const res = await supertest(buildApp(STREAMER_SESSION_USER)).post('/timers/update').send(`id=1&${VALID_FIELDS}`);
    expect(res.headers.location).toBe('/timers');
    expect(updateOwnTimerCommand).toHaveBeenCalledWith(1, expect.objectContaining({ name: 'Discord plug' }), STREAMER_ID);
    expect(updateTimerCommand).not.toHaveBeenCalled();
  });

  it('redirects a streamer to ?error=forbidden when they don\'t own the timer outright', async () => {
    vi.mocked(updateOwnTimerCommand).mockRejectedValueOnce(new (TimerSelfServiceDeniedError as any)(1));
    const res = await supertest(buildApp(STREAMER_SESSION_USER)).post('/timers/update').send(`id=1&${VALID_FIELDS}`);
    expect(res.headers.location).toBe('/timers?error=forbidden');
  });
});

// ─── POST /timers/remove ──────────────────────────────────────────────────────

describe('POST /timers/remove', () => {
  it('runs requireGuildContext (not requireMod), so the handler sees a fresh access level and can allow streamer self-service', async () => {
    await supertest(buildApp()).post('/timers/remove').send('id=5');
    expect(middlewareCallOrder).toEqual(['requireGuildContext']);
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

  it('routes a streamer\'s delete through the owner-checked write', async () => {
    const res = await supertest(buildApp(STREAMER_SESSION_USER)).post('/timers/remove').send('id=5');
    expect(res.headers.location).toBe('/timers');
    expect(removeOwnTimerCommand).toHaveBeenCalledWith(5, STREAMER_ID);
    expect(removeTimerCommand).not.toHaveBeenCalled();
  });

  it('redirects a streamer to ?error=forbidden when they don\'t own the timer outright', async () => {
    vi.mocked(removeOwnTimerCommand).mockRejectedValueOnce(new (TimerSelfServiceDeniedError as any)(5));
    const res = await supertest(buildApp(STREAMER_SESSION_USER)).post('/timers/remove').send('id=5');
    expect(res.headers.location).toBe('/timers?error=forbidden');
  });

  it('redirects a streamer to ?error=timer_not_found when the timer is gone', async () => {
    vi.mocked(removeOwnTimerCommand).mockRejectedValueOnce(new (TimerCommandNotFoundError as any)(5));
    const res = await supertest(buildApp(STREAMER_SESSION_USER)).post('/timers/remove').send('id=5');
    expect(res.headers.location).toBe('/timers?error=timer_not_found');
  });
});

// ─── POST /timers/toggle ──────────────────────────────────────────────────────

describe('POST /timers/toggle', () => {
  it('runs requireGuildContext (not requireMod), so the handler sees a fresh access level and can allow streamer self-service', async () => {
    await supertest(buildApp()).post('/timers/toggle').send('id=1&enabled=true');
    expect(middlewareCallOrder).toEqual(['requireGuildContext']);
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

  it('routes a streamer\'s toggle through the owner-checked write', async () => {
    const res = await supertest(buildApp(STREAMER_SESSION_USER)).post('/timers/toggle').send('id=1&enabled=false');
    expect(res.headers.location).toBe('/timers');
    expect(setOwnTimerCommandEnabled).toHaveBeenCalledWith(1, false, STREAMER_ID);
    expect(setTimerCommandEnabled).not.toHaveBeenCalled();
  });

  it('redirects a streamer to ?error=forbidden when they don\'t own the timer outright', async () => {
    vi.mocked(setOwnTimerCommandEnabled).mockRejectedValueOnce(new (TimerSelfServiceDeniedError as any)(1));
    const res = await supertest(buildApp(STREAMER_SESSION_USER)).post('/timers/toggle').send('id=1&enabled=true');
    expect(res.headers.location).toBe('/timers?error=forbidden');
  });
});
