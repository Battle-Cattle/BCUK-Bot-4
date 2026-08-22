import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockLogger } from '../../test-utils/loggerMock';

const { middlewareCallOrder } = vi.hoisted(() => ({ middlewareCallOrder: [] as string[] }));
vi.mock('../middleware', () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
  requireGuildContext: (_req: any, _res: any, next: any) => { middlewareCallOrder.push('requireGuildContext'); next(); },
  requireModJson: (_req: any, _res: any, next: any) => { middlewareCallOrder.push('requireModJson'); next(); },
}));

vi.mock('../csrf', () => ({
  csrfProtection: (_req: any, _res: any, next: any) => next(),
}));

vi.mock('../guildScopedStatus', () => ({
  getGuildScopedStatus: vi.fn(),
}));

vi.mock('../../audio/audioPlayer', () => ({
  connect: vi.fn(),
  disconnect: vi.fn(),
  getCurrentChannelId: vi.fn(),
}));

vi.mock('../../discord/discordBot', () => ({
  getDiscordClient: vi.fn(),
}));

vi.mock('../../discord/discordUtils', () => ({
  getAvailableVoiceChannels: vi.fn(),
}));

vi.mock('../../db', () => ({
  getGuildById: vi.fn(),
}));

vi.mock('./shared', () => ({
  normalizeDiscordId: (s: string) => (/^\d{17,20}$/.test(s) ? s : null),
}));

vi.mock('../../shared/logger', () => ({ createLogger: mockLogger }));

import supertest from 'supertest';
import router from './api';
import { getGuildScopedStatus } from '../guildScopedStatus';
import { connect, disconnect, getCurrentChannelId } from '../../audio/audioPlayer';
import { getDiscordClient } from '../../discord/discordBot';
import { getAvailableVoiceChannels } from '../../discord/discordUtils';
import { getGuildById } from '../../db';
import { buildTestApp } from '../../test-utils/expressTestApp';

const GUILD_ID = '900000000000000001';

/** Builds a supertest-ready app: the API router with a session injecting the current guild so the guild-scoped voice routes resolve. */
function buildApp(currentGuildId: string | null = GUILD_ID) {
  return buildTestApp({ router, bodyParser: 'json', sessionUser: { discordId: 'u1', currentGuildId } });
}

beforeEach(() => {
  vi.clearAllMocks();
  middlewareCallOrder.length = 0;
  vi.mocked(getGuildScopedStatus).mockResolvedValue({ discord: {}, voice: {}, twitch: {} } as never);
  vi.mocked(getDiscordClient).mockReturnValue({} as never);
  vi.mocked(connect).mockResolvedValue(undefined);
  vi.mocked(getCurrentChannelId).mockReturnValue('current-vc');
  vi.mocked(getAvailableVoiceChannels).mockResolvedValue([]);
  vi.mocked(getGuildById).mockResolvedValue({ guild_id: GUILD_ID, name: 'Guild', voice_channel_id: 'default-vc' });
});

describe('GET /status', () => {
  it('returns the status snapshot for the session guild', async () => {
    const res = await supertest(buildApp()).get('/status').expect(200);
    expect(res.body).toEqual({ discord: {}, voice: {}, twitch: {} });
    expect(vi.mocked(getGuildScopedStatus)).toHaveBeenCalledWith(GUILD_ID);
  });

  it('returns 400 when no guild is selected', async () => {
    const res = await supertest(buildApp(null)).get('/status').expect(400);
    expect(res.body).toEqual({ ok: false, error: 'No guild selected' });
    expect(vi.mocked(getGuildScopedStatus)).not.toHaveBeenCalled();
  });

  it('returns 500 when the status lookup fails', async () => {
    vi.mocked(getGuildScopedStatus).mockRejectedValue(new Error('DB down'));
    const res = await supertest(buildApp()).get('/status').expect(500);
    expect(res.body).toEqual({ ok: false, error: 'Failed to fetch status' });
  });
});

describe('GET /voice/channels', () => {
  it('runs requireGuildContext before requireModJson, so a demoted session is re-checked with a fresh access level', async () => {
    await supertest(buildApp()).get('/voice/channels');
    expect(middlewareCallOrder).toEqual(['requireGuildContext', 'requireModJson']);
  });

  it('reports the current channel and DB default for the session guild', async () => {
    const res = await supertest(buildApp()).get('/voice/channels').expect(200);
    expect(res.body).toMatchObject({
      ok: true,
      defaultChannelId: 'default-vc',
      currentChannelId: 'current-vc',
    });
    expect(vi.mocked(getCurrentChannelId)).toHaveBeenCalledWith(GUILD_ID);
    expect(vi.mocked(getAvailableVoiceChannels)).toHaveBeenCalledWith(GUILD_ID);
  });

  it('returns null default when the guild has no configured voice channel', async () => {
    vi.mocked(getGuildById).mockResolvedValue({ guild_id: GUILD_ID, name: 'Guild', voice_channel_id: null });
    const res = await supertest(buildApp()).get('/voice/channels').expect(200);
    expect(res.body.defaultChannelId).toBeNull();
  });

  it('returns 400 when no guild is selected', async () => {
    const res = await supertest(buildApp(null)).get('/voice/channels').expect(400);
    expect(res.body).toMatchObject({ ok: false });
  });

  it('returns 500 when channel lookup fails', async () => {
    vi.mocked(getAvailableVoiceChannels).mockRejectedValue(new Error('Discord down'));
    const res = await supertest(buildApp()).get('/voice/channels').expect(500);
    expect(res.body).toMatchObject({ ok: false });
  });
});

describe('POST /voice/join', () => {
  it('runs requireGuildContext before requireModJson, so a demoted session is re-checked with a fresh access level', async () => {
    await supertest(buildApp()).post('/voice/join').send({ channelId: '123456789012345678' });
    expect(middlewareCallOrder).toEqual(['requireGuildContext', 'requireModJson']);
  });

  it('disconnects then joins the requested channel for the session guild', async () => {
    const res = await supertest(buildApp())
      .post('/voice/join')
      .send({ channelId: '123456789012345678' })
      .expect(200);

    expect(res.body).toEqual({ ok: true });
    expect(vi.mocked(disconnect)).toHaveBeenCalledWith(GUILD_ID);
    expect(vi.mocked(connect)).toHaveBeenCalledWith({}, GUILD_ID, '123456789012345678');
  });

  it('falls back to the guild default channel when no channelId is given', async () => {
    await supertest(buildApp()).post('/voice/join').send({}).expect(200);
    expect(vi.mocked(connect)).toHaveBeenCalledWith({}, GUILD_ID, 'default-vc');
  });

  it('returns 400 when no channelId is given and guild has no default', async () => {
    vi.mocked(getGuildById).mockResolvedValueOnce({ guild_id: GUILD_ID, name: 'Test', voice_channel_id: null } as any);
    await supertest(buildApp()).post('/voice/join').send({}).expect(400);
    expect(vi.mocked(disconnect)).not.toHaveBeenCalled();
    expect(vi.mocked(connect)).not.toHaveBeenCalled();
  });

  it('returns 400 when no guild is selected', async () => {
    await supertest(buildApp(null)).post('/voice/join').send({ channelId: '123456789012345678' }).expect(400);
    expect(vi.mocked(connect)).not.toHaveBeenCalled();
  });

  it('returns 400 for a non-string channelId', async () => {
    await supertest(buildApp()).post('/voice/join').send({ channelId: 123 }).expect(400);
    expect(vi.mocked(connect)).not.toHaveBeenCalled();
  });

  it('returns 400 for an invalid channel ID', async () => {
    await supertest(buildApp()).post('/voice/join').send({ channelId: 'not-a-snowflake' }).expect(400);
    expect(vi.mocked(connect)).not.toHaveBeenCalled();
  });

  it('returns 503 when the Discord client is not ready', async () => {
    vi.mocked(getDiscordClient).mockReturnValue(null as never);
    await supertest(buildApp()).post('/voice/join').send({ channelId: '123456789012345678' }).expect(503);
    expect(vi.mocked(connect)).not.toHaveBeenCalled();
  });

  it('returns 500 when connect throws', async () => {
    vi.mocked(connect).mockRejectedValue(new Error('No permission'));
    const res = await supertest(buildApp())
      .post('/voice/join')
      .send({ channelId: '123456789012345678' })
      .expect(500);
    expect(res.body).toMatchObject({ ok: false });
  });
});

describe('POST /voice/leave', () => {
  it('runs requireGuildContext before requireModJson, so a demoted session is re-checked with a fresh access level', async () => {
    await supertest(buildApp()).post('/voice/leave');
    expect(middlewareCallOrder).toEqual(['requireGuildContext', 'requireModJson']);
  });

  it('disconnects the session guild and returns ok', async () => {
    const res = await supertest(buildApp()).post('/voice/leave').expect(200);
    expect(res.body).toEqual({ ok: true });
    expect(vi.mocked(disconnect)).toHaveBeenCalledWith(GUILD_ID);
  });

  it('returns 400 when no guild is selected', async () => {
    await supertest(buildApp(null)).post('/voice/leave').expect(400);
    expect(vi.mocked(disconnect)).not.toHaveBeenCalled();
  });
});
