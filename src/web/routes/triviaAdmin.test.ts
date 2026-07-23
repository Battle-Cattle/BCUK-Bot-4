import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../db', () => ({
  getStreamerByDiscordId: vi.fn(),
}));

vi.mock('../middleware', () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
}));

vi.mock('../../shared/config', () => ({
  PUBLIC_URL: 'http://localhost:3000',
}));

const { logMock } = vi.hoisted(() => ({
  logMock: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../shared/logger', () => ({
  createLogger: () => logMock,
}));

import supertest from 'supertest';
import router from './triviaAdmin';
import { getStreamerByDiscordId } from '../../db';
import { AccessLevel } from '../../db/users';
import { buildTestApp } from '../../test-utils/expressTestApp';
import { makeSessionUser, type SessionUserFixture } from '../../test-utils/fixtures';

const GUILD_ID = '900000000000000001';

/** Builds a supertest-ready app: the trivia admin router with a stubbed session and a render mock that flattens locals into the JSON body. */
function buildApp(sessionUser: SessionUserFixture = makeSessionUser({ accessLevel: AccessLevel.MOD })) {
  return buildTestApp({ router, bodyParser: 'urlencoded', sessionUser, mockRender: 'spread' });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getStreamerByDiscordId).mockResolvedValue(null);
});

describe('GET /settings', () => {
  it('renders with a null streamer when the user is not a monitored streamer', async () => {
    const res = await supertest(buildApp()).get('/settings');
    expect(res.status).toBe(200);
    expect(res.body.streamer).toBeNull();
  });

  it('passes the resolved streamer and configured baseUrl for a monitored streamer', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue({ id: 42, twitch_name: 'somestreamer' } as any);

    const res = await supertest(buildApp()).get('/settings');

    expect(res.status).toBe(200);
    expect(res.body.streamer).toMatchObject({ id: 42, twitch_name: 'somestreamer' });
    expect(res.body.baseUrl).toBe('http://localhost:3000');
  });

  it('passes the session currentGuildId when one is selected', async () => {
    const res = await supertest(buildApp(makeSessionUser({ accessLevel: AccessLevel.MOD, currentGuildId: GUILD_ID }))).get('/settings');
    expect(res.body.guildId).toBe(GUILD_ID);
  });

  it('passes null guildId when no guild is currently selected', async () => {
    const res = await supertest(buildApp(makeSessionUser({ accessLevel: AccessLevel.MOD, currentGuildId: undefined }))).get('/settings');
    expect(res.body.guildId).toBeNull();
  });

  it('returns 500 when getStreamerByDiscordId throws', async () => {
    vi.mocked(getStreamerByDiscordId).mockRejectedValue(new Error('DB down'));
    const res = await supertest(buildApp()).get('/settings');
    expect(res.status).toBe(500);
  });
});
