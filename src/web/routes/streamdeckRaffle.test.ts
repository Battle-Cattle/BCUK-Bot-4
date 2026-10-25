import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockLogger } from '../../test-utils/loggerMock';

vi.mock('../middleware', () => ({
  requireApiKey: (req: any, _res: any, next: any) => {
    req.apiKeyOwner = 'owner-1';
    next();
  },
}));
vi.mock('../../db', () => ({
  getApprovedGuildIdsForKey: vi.fn(),
  getStreamerByDiscordId: vi.fn(),
}));
// The real handler pulls in the chat runtime; the amount parser is stood in for by the shared
// points parser plus the >= 1 check, which is all the route relies on.
vi.mock('../../commands/raffle/raffleHandler', async () => {
  const { parsePointsAmount } = await vi.importActual<typeof import('../../commands/gambleAmount')>('../../commands/gambleAmount');
  return {
    parseRaffleAmount: (input: string) => {
      const amount = parsePointsAmount(input);
      return amount !== null && amount >= 1 ? amount : null;
    },
    startRaffle: vi.fn(),
  };
});
vi.mock('../../shared/logger', () => ({ createLogger: mockLogger }));

import supertest from 'supertest';
import router from './streamdeckRaffle';
import { getApprovedGuildIdsForKey, getStreamerByDiscordId } from '../../db';
import { startRaffle } from '../../commands/raffle/raffleHandler';
import { buildTestApp } from '../../test-utils/expressTestApp';

const app = () => buildTestApp({ router, bodyParser: 'json' });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getApprovedGuildIdsForKey).mockResolvedValue(['g1']);
  vi.mocked(getStreamerByDiscordId).mockResolvedValue({ id: 3, discord_id: 'owner-1', twitch_name: 'Streamer' } as any);
  vi.mocked(startRaffle).mockResolvedValue('ok');
});

describe('POST /raffle', () => {
  it.each([['1K', 1000], ['1,000', 1000], [250, 250]])('starts a raffle for %j in the key owner\'s channel', async (amount, expected) => {
    const res = await supertest(app()).post('/raffle').send({ amount }).expect(200);
    expect(res.body).toEqual({ ok: true, amount: expected });
    expect(startRaffle).toHaveBeenCalledWith('Streamer', 3, expected);
  });

  it.each([[{}], [{ amount: '' }], [{ amount: 'lots' }], [{ amount: 0 }], [{ amount: 1.5 }], [{ amount: true }]])(
    'rejects %j with 400',
    async (body) => {
      const res = await supertest(app()).post('/raffle').send(body).expect(400);
      expect(res.body).toEqual({ ok: false, error: 'invalid_amount' });
      expect(startRaffle).not.toHaveBeenCalled();
    },
  );

  it('refuses a non-streamer', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValueOnce({ id: 3, twitch_name: null } as any);
    const res = await supertest(app()).post('/raffle').send({ amount: '100' }).expect(403);
    expect(res.body.error).toBe('not_a_streamer');
  });

  it.each([
    ['already_running', 409, 'raffle_already_running'],
    ['points_disabled', 409, 'points_disabled'],
    ['chat_unavailable', 503, 'chat_unavailable'],
  ] as const)('maps %s to %d %s', async (result, status, error) => {
    vi.mocked(startRaffle).mockResolvedValueOnce(result);
    const res = await supertest(app()).post('/raffle').send({ amount: '100' }).expect(status);
    expect(res.body).toEqual({ ok: false, error });
  });

  it('returns 500 on an error', async () => {
    vi.mocked(startRaffle).mockRejectedValueOnce(new Error('boom'));
    const res = await supertest(app()).post('/raffle').send({ amount: '100' });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ ok: false, error: 'Failed to start raffle' });
  });
});
