import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockLogger } from '../../test-utils/loggerMock';
import type { DbStreamerEventSub } from '../../db';
import type { TwitchCustomReward } from '../../twitch/twitchApi';

const DISCORD_ID = 'user-1';

vi.mock('../middleware', () => ({
  requireCompanionKey: (req: any, _res: any, next: any) => {
    req.companionDiscordId = DISCORD_ID;
    next();
  },
}));

vi.mock('../../db', () => ({
  getStreamerByDiscordId: vi.fn(),
  getRedemptionAckStreamerId: vi.fn(),
  listCompanionConfirmationRewardIds: vi.fn(),
}));

vi.mock('../../twitch/eventsub/twitchEventSubRedemptionAcks', () => ({
  acknowledgeRedemption: vi.fn(),
  extendRedemptionAck: vi.fn(),
}));

vi.mock('../../twitch/twitchApi', () => ({
  getCustomRewards: vi.fn(),
}));

vi.mock('../../twitch/twitchUserTokens', () => ({
  getValidToken: vi.fn(),
}));

vi.mock('../../shared/logger', () => ({ createLogger: mockLogger }));

import supertest from 'supertest';
import router from './companionRewards';
import { getStreamerByDiscordId, getRedemptionAckStreamerId, listCompanionConfirmationRewardIds } from '../../db';
import { acknowledgeRedemption, extendRedemptionAck } from '../../twitch/eventsub/twitchEventSubRedemptionAcks';
import { getCustomRewards } from '../../twitch/twitchApi';
import { getValidToken } from '../../twitch/twitchUserTokens';
import { buildTestApp } from '../../test-utils/expressTestApp';

/** Builds a supertest-ready app: the companion-rewards router with a JSON body parser and no session stub (key-authenticated). */
function buildApp() {
  return buildTestApp({ router, bodyParser: 'json' });
}

const STREAMER = { id: 1, twitch_user_id: 'twitch-1' } as DbStreamerEventSub;

const REWARD: TwitchCustomReward = {
  id: 'r1',
  title: 'Hydrate',
  cost: 500,
  is_enabled: true,
  prompt: 'Drink water on stream',
  is_user_input_required: false,
  background_color: '#ff0000',
  is_paused: false,
  is_in_stock: true,
  should_redemptions_skip_request_queue: false,
  max_per_stream_setting: { is_enabled: false, max_per_stream: 0 },
  max_per_user_per_stream_setting: { is_enabled: false, max_per_user_per_stream: 0 },
  global_cooldown_setting: { is_enabled: false, global_cooldown_seconds: 0 },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getStreamerByDiscordId).mockResolvedValue(STREAMER);
  vi.mocked(getValidToken).mockResolvedValue('valid-token');
  vi.mocked(getCustomRewards).mockResolvedValue([REWARD]);
  vi.mocked(listCompanionConfirmationRewardIds).mockResolvedValue(new Set());
  vi.mocked(getRedemptionAckStreamerId).mockResolvedValue(STREAMER.id);
  vi.mocked(acknowledgeRedemption).mockResolvedValue(true);
});

describe('GET /rewards', () => {
  it('returns the mapped list of known rewards', async () => {
    const res = await supertest(buildApp()).get('/rewards').expect(200);

    expect(res.body).toEqual({
      ok: true,
      rewards: [{
        id: 'r1',
        title: 'Hydrate',
        prompt: 'Drink water on stream',
        cost: 500,
        backgroundColor: '#ff0000',
        isEnabled: true,
        isUserInputRequired: false,
        companionConfirmationRequired: false,
      }],
    });
    expect(getCustomRewards).toHaveBeenCalledWith('twitch-1', 'valid-token');
  });

  it('flags the rewards that require companion confirmation', async () => {
    vi.mocked(listCompanionConfirmationRewardIds).mockResolvedValue(new Set(['r1']));

    const res = await supertest(buildApp()).get('/rewards').expect(200);

    expect(res.body.rewards[0].companionConfirmationRequired).toBe(true);
    expect(listCompanionConfirmationRewardIds).toHaveBeenCalledWith(STREAMER.id);
  });

  it('returns an empty list when the discord ID has no streamer', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(null);

    const res = await supertest(buildApp()).get('/rewards').expect(200);

    expect(res.body).toEqual({ ok: true, rewards: [] });
    expect(getCustomRewards).not.toHaveBeenCalled();
  });

  it('returns an empty list when the streamer has no twitch_user_id', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue({ ...STREAMER, twitch_user_id: null });

    const res = await supertest(buildApp()).get('/rewards').expect(200);

    expect(res.body).toEqual({ ok: true, rewards: [] });
    expect(getCustomRewards).not.toHaveBeenCalled();
  });

  it('returns an empty list when there is no valid Twitch token', async () => {
    vi.mocked(getValidToken).mockResolvedValue(null);

    const res = await supertest(buildApp()).get('/rewards').expect(200);

    expect(res.body).toEqual({ ok: true, rewards: [] });
    expect(getCustomRewards).not.toHaveBeenCalled();
  });

  it('returns 500 when the streamer lookup throws', async () => {
    vi.mocked(getStreamerByDiscordId).mockRejectedValue(new Error('DB gone'));

    const res = await supertest(buildApp()).get('/rewards').expect(500);

    expect(res.body).toMatchObject({ ok: false });
  });

  it('returns 500 when the Twitch fetch throws', async () => {
    vi.mocked(getCustomRewards).mockRejectedValue(new Error('Twitch down'));

    const res = await supertest(buildApp()).get('/rewards').expect(500);

    expect(res.body).toMatchObject({ ok: false });
  });
});

describe('POST /rewards/ack', () => {
  const REDEMPTION_ID = '17fa2df1-ad76-4804-bfa5-a40ef63efe63';

  it('passes the acknowledgement on for the streamer\'s own redemption', async () => {
    const res = await supertest(buildApp()).post('/rewards/ack').send({ eventId: REDEMPTION_ID, ok: false, error: 'bulb offline' }).expect(200);

    expect(res.body).toEqual({ ok: true, resolved: true });
    expect(getRedemptionAckStreamerId).toHaveBeenCalledWith(REDEMPTION_ID);
    expect(acknowledgeRedemption).toHaveBeenCalledWith(REDEMPTION_ID, { ok: false, error: 'bulb offline' });
  });

  it('refuses another streamer\'s redemption', async () => {
    vi.mocked(getRedemptionAckStreamerId).mockResolvedValueOnce(99);

    await supertest(buildApp()).post('/rewards/ack').send({ eventId: REDEMPTION_ID, ok: true }).expect(404);

    expect(acknowledgeRedemption).not.toHaveBeenCalled();
  });

  it('rejects a malformed body', async () => {
    await supertest(buildApp()).post('/rewards/ack').send({ eventId: 'nope', ok: true }).expect(400);
    expect(acknowledgeRedemption).not.toHaveBeenCalled();
  });

  it('returns 500 when acknowledging fails', async () => {
    vi.mocked(acknowledgeRedemption).mockRejectedValueOnce(new Error('boom'));
    const res = await supertest(buildApp()).post('/rewards/ack').send({ eventId: REDEMPTION_ID, ok: true });
    expect(res.status).toBe(500);
  });
});

describe('POST /rewards/progress', () => {
  const REDEMPTION_ID = '17fa2df1-ad76-4804-bfa5-a40ef63efe63';

  it('restarts the timeout for the streamer\'s own redemption', async () => {
    vi.mocked(extendRedemptionAck).mockReturnValueOnce(true);
    const res = await supertest(buildApp()).post('/rewards/progress').send({ eventId: REDEMPTION_ID }).expect(200);
    expect(res.body).toEqual({ ok: true, extended: true });
    expect(extendRedemptionAck).toHaveBeenCalledWith(REDEMPTION_ID);
  });

  it('reports a redemption that is no longer waiting', async () => {
    vi.mocked(extendRedemptionAck).mockReturnValueOnce(false);
    const res = await supertest(buildApp()).post('/rewards/progress').send({ eventId: REDEMPTION_ID }).expect(200);
    expect(res.body).toEqual({ ok: true, extended: false });
  });

  it('refuses another streamer\'s redemption and a malformed body', async () => {
    vi.mocked(getRedemptionAckStreamerId).mockResolvedValueOnce(99);
    await supertest(buildApp()).post('/rewards/progress').send({ eventId: REDEMPTION_ID }).expect(404);
    await supertest(buildApp()).post('/rewards/progress').send({ eventId: 'nope' }).expect(400);
    expect(extendRedemptionAck).not.toHaveBeenCalled();
  });
});
