import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockLogger } from '../../test-utils/loggerMock';

vi.mock('../../shared/logger', () => ({ createLogger: mockLogger }));

vi.mock('../../db', () => ({
  getStreamerByDiscordId: vi.fn(),
  addTimerCommand: vi.fn(),
  updateTimerCommand: vi.fn(),
  removeTimerCommand: vi.fn(),
  setTimerCommandEnabled: vi.fn(),
  TimerCommandNotFoundError: class TimerCommandNotFoundError extends Error {},
}));

vi.mock('../csrf', () => ({
  csrfProtection: (req: any, _res: any, next: any) => {
    req.csrfToken = () => 'test-csrf-token';
    next();
  },
}));

vi.mock('../middleware', () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
}));

import supertest from 'supertest';
import router from './timersMutations';
import {
  getStreamerByDiscordId, addTimerCommand, updateTimerCommand, removeTimerCommand,
  setTimerCommandEnabled, TimerCommandNotFoundError,
} from '../../db';
import { buildTestApp } from '../../test-utils/expressTestApp';

type SessionUser = { discordId: string; discordName: string; discordAvatar: string | null; accessLevel: 0 | 1 | 2 | 3; isOwner: boolean };
const USER: SessionUser = { discordId: '100000000000000001', discordName: 'TestUser', discordAvatar: null, accessLevel: 0, isOwner: false };

const MOCK_STREAMER = { id: 123, discord_id: USER.discordId };

const VALID_TIMER_FORM = {
  name: 'Discord plug',
  message: 'Join our Discord!',
  interval_seconds: '600',
  min_messages: '0',
  require_live: 'on',
  enabled: 'on',
};

function buildApp(sessionUser: SessionUser = USER) {
  return buildTestApp({ router, bodyParser: 'urlencoded', sessionUser });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getStreamerByDiscordId).mockResolvedValue(null);
});

describe('POST /add', () => {
  it('redirects with error when user is not a streamer', async () => {
    const res = await supertest(buildApp()).post('/add').type('form').send(VALID_TIMER_FORM);
    expect(res.headers.location).toBe('/timers?error=not_a_streamer');
    expect(addTimerCommand).not.toHaveBeenCalled();
  });

  it.each([
    ['missing name', { name: '' }, 'missing_fields'],
    ['missing message', { message: '' }, 'missing_fields'],
    ['interval below the 60s floor', { interval_seconds: '59' }, 'invalid_interval'],
    ['non-numeric interval', { interval_seconds: 'abc' }, 'invalid_interval'],
    ['interval beyond the INT column range', { interval_seconds: '99999999999' }, 'invalid_interval'],
    ['negative min_messages', { min_messages: '-1' }, 'invalid_min_messages'],
    ['min_messages beyond the INT column range', { min_messages: '99999999999' }, 'invalid_min_messages'],
  ])('redirects with the specific error code when %s', async (_label, override, expectedErrorCode) => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
    const res = await supertest(buildApp()).post('/add').type('form').send({ ...VALID_TIMER_FORM, ...override });
    expect(res.headers.location).toBe(`/timers?error=${expectedErrorCode}`);
    expect(addTimerCommand).not.toHaveBeenCalled();
  });

  it('creates the timer and redirects to success', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
    vi.mocked(addTimerCommand).mockResolvedValue(1);

    const res = await supertest(buildApp()).post('/add').type('form').send(VALID_TIMER_FORM);

    expect(res.headers.location).toBe('/timers?success=timer_added');
    expect(addTimerCommand).toHaveBeenCalledWith(123, {
      name: 'Discord plug',
      message: 'Join our Discord!',
      intervalSeconds: 600,
      minMessages: 0,
      requireLive: true,
      enabled: true,
    });
  });

  it('redirects with add_failed when the insert throws', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
    vi.mocked(addTimerCommand).mockRejectedValue(new Error('db down'));

    const res = await supertest(buildApp()).post('/add').type('form').send(VALID_TIMER_FORM);
    expect(res.headers.location).toBe('/timers?error=add_failed');
  });
});

describe('POST /update', () => {
  it('redirects with invalid_id when id is malformed', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
    const res = await supertest(buildApp()).post('/update').type('form').send({ ...VALID_TIMER_FORM, id: 'abc' });
    expect(res.headers.location).toBe('/timers?error=invalid_id');
    expect(updateTimerCommand).not.toHaveBeenCalled();
  });

  it('updates and redirects to success, scoped to the requesting streamer', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);

    const res = await supertest(buildApp()).post('/update').type('form').send({ ...VALID_TIMER_FORM, id: '5' });

    expect(res.headers.location).toBe('/timers?success=timer_updated');
    expect(updateTimerCommand).toHaveBeenCalledWith(5, 123, {
      name: 'Discord plug',
      message: 'Join our Discord!',
      intervalSeconds: 600,
      minMessages: 0,
      requireLive: true,
      enabled: true,
    });
  });

  it('redirects with timer_not_found when the id belongs to another streamer', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
    vi.mocked(updateTimerCommand).mockRejectedValue(new TimerCommandNotFoundError(5));

    const res = await supertest(buildApp()).post('/update').type('form').send({ ...VALID_TIMER_FORM, id: '5' });
    expect(res.headers.location).toBe('/timers?error=timer_not_found');
  });

  it('redirects with update_failed when the update throws a non-NotFound error', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
    vi.mocked(updateTimerCommand).mockRejectedValue(new Error('db down'));

    const res = await supertest(buildApp()).post('/update').type('form').send({ ...VALID_TIMER_FORM, id: '5' });
    expect(res.headers.location).toBe('/timers?error=update_failed');
  });
});

describe('POST /remove', () => {
  it('redirects with invalid_id when id is malformed', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
    const res = await supertest(buildApp()).post('/remove').type('form').send({ id: 'abc' });
    expect(res.headers.location).toBe('/timers?error=invalid_id');
    expect(removeTimerCommand).not.toHaveBeenCalled();
  });

  it('removes and redirects to success, scoped to the requesting streamer', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
    const res = await supertest(buildApp()).post('/remove').type('form').send({ id: '5' });
    expect(res.headers.location).toBe('/timers?success=timer_removed');
    expect(removeTimerCommand).toHaveBeenCalledWith(5, 123);
  });

  it('redirects with remove_failed when the delete throws', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
    vi.mocked(removeTimerCommand).mockRejectedValue(new Error('db down'));

    const res = await supertest(buildApp()).post('/remove').type('form').send({ id: '5' });
    expect(res.headers.location).toBe('/timers?error=remove_failed');
  });
});

describe('POST /toggle', () => {
  it('redirects with invalid_id when id is malformed', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
    const res = await supertest(buildApp()).post('/toggle').type('form').send({ id: 'abc', enabled: 'true' });
    expect(res.headers.location).toBe('/timers?error=invalid_id');
    expect(setTimerCommandEnabled).not.toHaveBeenCalled();
  });

  it('toggles and redirects, scoped to the requesting streamer', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
    const res = await supertest(buildApp()).post('/toggle').type('form').send({ id: '5', enabled: 'false' });
    expect(res.headers.location).toBe('/timers');
    expect(setTimerCommandEnabled).toHaveBeenCalledWith(5, 123, false);
  });

  it('redirects with timer_not_found when the id belongs to another streamer', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
    vi.mocked(setTimerCommandEnabled).mockRejectedValue(new TimerCommandNotFoundError(5));
    const res = await supertest(buildApp()).post('/toggle').type('form').send({ id: '5', enabled: 'true' });
    expect(res.headers.location).toBe('/timers?error=timer_not_found');
  });

  it('redirects with toggle_failed when the update throws a non-NotFound error', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
    vi.mocked(setTimerCommandEnabled).mockRejectedValue(new Error('db down'));
    const res = await supertest(buildApp()).post('/toggle').type('form').send({ id: '5', enabled: 'true' });
    expect(res.headers.location).toBe('/timers?error=toggle_failed');
  });
});
