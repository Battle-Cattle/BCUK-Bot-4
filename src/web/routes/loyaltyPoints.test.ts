import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../db', () => ({
  getStreamerByDiscordId: vi.fn(),
  getLoyaltyPointsLeaderboard: vi.fn(),
  getLoyaltyPointsConfig: vi.fn(),
  setLoyaltyPointsConfig: vi.fn(),
  DEFAULT_POINTS_PER_MESSAGE: 1,
  DEFAULT_POINTS_COOLDOWN_SECONDS: 60,
  DEFAULT_POINTS_PER_SUB: 100,
  DEFAULT_POINTS_PER_GIFT_SUB: 100,
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

vi.mock('../../shared/logger', () => ({
  createLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn() }),
}));

import supertest from 'supertest';
import router from './loyaltyPoints';
import { getStreamerByDiscordId, getLoyaltyPointsLeaderboard, getLoyaltyPointsConfig, setLoyaltyPointsConfig } from '../../db';
import { buildTestApp } from '../../test-utils/expressTestApp';

const STREAMER = { id: 7, discord_id: '1', twitch_name: 'streamerchannel' };
const SESSION_USER = { discordId: '1', discordName: 'TestUser', discordAvatar: null, isOwner: false, accessLevel: 0, currentGuildId: null, guilds: [] };

/** Builds a supertest-ready app: the loyalty points router with a stubbed session and a JSON-echoing render stub. */
function buildApp() {
  return buildTestApp({
    router,
    bodyParser: 'urlencoded',
    sessionUser: SESSION_USER,
    mockRender: 'spread',
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getStreamerByDiscordId).mockResolvedValue(null);
  vi.mocked(getLoyaltyPointsLeaderboard).mockResolvedValue([]);
  vi.mocked(getLoyaltyPointsConfig).mockResolvedValue(null);
  vi.mocked(setLoyaltyPointsConfig).mockResolvedValue(undefined);
});

// ─── GET /loyalty-points ──────────────────────────────────────────────────────

describe('GET /loyalty-points', () => {
  it('shows the unlinked state for a signed-in user with no streamer record', async () => {
    const res = await supertest(buildApp()).get('/loyalty-points');

    expect(res.status).toBe(200);
    expect(res.body.isStreamer).toBe(false);
    expect(res.body.leaderboard).toEqual([]);
  });

  it('renders the leaderboard and config for a linked streamer', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(STREAMER as any);
    vi.mocked(getLoyaltyPointsLeaderboard).mockResolvedValue([{ twitchUsername: 'viewer1', balance: 50 }]);
    vi.mocked(getLoyaltyPointsConfig).mockResolvedValue({ pointsPerMessage: 2, cooldownSeconds: 30, pointsPerSub: 150, pointsPerGiftSub: 150 });

    const res = await supertest(buildApp()).get('/loyalty-points');

    expect(res.status).toBe(200);
    expect(res.body.isStreamer).toBe(true);
    expect(getLoyaltyPointsLeaderboard).toHaveBeenCalledWith(7, 50);
    expect(res.body.leaderboard).toEqual([{ twitchUsername: 'viewer1', balance: 50 }]);
    expect(res.body.config).toEqual({ pointsPerMessage: 2, cooldownSeconds: 30, pointsPerSub: 150, pointsPerGiftSub: 150 });
  });

  it('falls back to the app defaults when the streamer has no saved config', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(STREAMER as any);

    const res = await supertest(buildApp()).get('/loyalty-points');

    expect(res.body.config).toEqual({ pointsPerMessage: 1, cooldownSeconds: 60, pointsPerSub: 100, pointsPerGiftSub: 100 });
  });

  it('surfaces a known error code', async () => {
    const res = await supertest(buildApp()).get('/loyalty-points?error=save_failed');
    expect(res.body.error).toBe('save_failed');
  });

  it('renders a 500 error page when loading the page throws', async () => {
    vi.mocked(getStreamerByDiscordId).mockRejectedValue(new Error('db exploded'));

    const res = await supertest(buildApp()).get('/loyalty-points');

    expect(res.status).toBe(500);
    expect(res.body.view).toBe('error');
    expect(res.body.message).toBe('Failed to load loyalty points page.');
  });
});

// ─── POST /loyalty-points/config ──────────────────────────────────────────────

const VALID_CONFIG_BODY = {
  points_per_message: '2',
  cooldown_seconds: '30',
  points_per_sub: '150',
  points_per_gift_sub: '150',
};

describe('POST /loyalty-points/config', () => {
  it('redirects with not_a_streamer when the requester has no streamer record', async () => {
    const res = await supertest(buildApp()).post('/loyalty-points/config').type('form').send(VALID_CONFIG_BODY);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/loyalty-points?error=not_a_streamer');
    expect(setLoyaltyPointsConfig).not.toHaveBeenCalled();
  });

  it('saves a valid config and redirects to the page', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(STREAMER as any);

    const res = await supertest(buildApp()).post('/loyalty-points/config').type('form').send(VALID_CONFIG_BODY);

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/loyalty-points');
    expect(setLoyaltyPointsConfig).toHaveBeenCalledWith(7, { pointsPerMessage: 2, cooldownSeconds: 30, pointsPerSub: 150, pointsPerGiftSub: 150 });
  });

  it('rejects a missing field', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(STREAMER as any);

    const res = await supertest(buildApp()).post('/loyalty-points/config').type('form').send({ ...VALID_CONFIG_BODY, cooldown_seconds: '' });

    expect(res.headers.location).toBe('/loyalty-points?error=invalid_config');
    expect(setLoyaltyPointsConfig).not.toHaveBeenCalled();
  });

  it('rejects a negative value', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(STREAMER as any);

    const res = await supertest(buildApp()).post('/loyalty-points/config').type('form').send({ ...VALID_CONFIG_BODY, points_per_sub: '-5' });

    expect(res.headers.location).toBe('/loyalty-points?error=invalid_config');
  });

  it('rejects a value above the signed INT column maximum', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(STREAMER as any);

    const res = await supertest(buildApp()).post('/loyalty-points/config').type('form').send({ ...VALID_CONFIG_BODY, points_per_sub: '2147483648' });

    expect(res.headers.location).toBe('/loyalty-points?error=invalid_config');
    expect(setLoyaltyPointsConfig).not.toHaveBeenCalled();
  });

  it('accepts a value exactly at the signed INT column maximum', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(STREAMER as any);

    const res = await supertest(buildApp()).post('/loyalty-points/config').type('form').send({ ...VALID_CONFIG_BODY, points_per_sub: '2147483647' });

    expect(res.status).toBe(302);
    expect(setLoyaltyPointsConfig).toHaveBeenCalledWith(7, expect.objectContaining({ pointsPerSub: 2147483647 }));
  });

  it('accepts a zero value', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(STREAMER as any);

    const res = await supertest(buildApp()).post('/loyalty-points/config').type('form').send({ ...VALID_CONFIG_BODY, cooldown_seconds: '0' });

    expect(res.status).toBe(302);
    expect(setLoyaltyPointsConfig).toHaveBeenCalledWith(7, expect.objectContaining({ cooldownSeconds: 0 }));
  });

  it('rejects a non-numeric value', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(STREAMER as any);

    const res = await supertest(buildApp()).post('/loyalty-points/config').type('form').send({ ...VALID_CONFIG_BODY, points_per_message: 'abc' });

    expect(res.headers.location).toBe('/loyalty-points?error=invalid_config');
  });

  it('redirects with save_failed when the write throws', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(STREAMER as any);
    vi.mocked(setLoyaltyPointsConfig).mockRejectedValue(new Error('db exploded'));

    const res = await supertest(buildApp()).post('/loyalty-points/config').type('form').send(VALID_CONFIG_BODY);

    expect(res.headers.location).toBe('/loyalty-points?error=save_failed');
  });
});
