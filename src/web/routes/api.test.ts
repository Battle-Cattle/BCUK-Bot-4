import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../middleware', () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
  requireMod: (_req: any, _res: any, next: any) => next(),
}));

vi.mock('../csrf', () => ({
  csrfProtection: (_req: any, _res: any, next: any) => next(),
}));

vi.mock('../../shared/statusStore', () => ({
  getStatus: vi.fn(),
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

vi.mock('../../shared/config', () => ({
  DISCORD_GUILD_ID: 'guild-123',
  DISCORD_VOICE_CHANNEL_ID: 'default-vc',
}));

vi.mock('./shared', () => ({
  normalizeDiscordId: (s: string) => (/^\d{17,20}$/.test(s) ? s : null),
}));

vi.mock('../../shared/logger', () => ({
  createLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn() }),
}));

import express from 'express';
import supertest from 'supertest';
import router from './api';
import { getStatus } from '../../shared/statusStore';
import { connect, disconnect, getCurrentChannelId } from '../../audio/audioPlayer';
import { getDiscordClient } from '../../discord/discordBot';
import { getAvailableVoiceChannels } from '../../discord/discordUtils';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(router);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getStatus).mockReturnValue({ discord: {}, voice: {}, twitch: {}, tiktok: {} } as never);
  vi.mocked(getDiscordClient).mockReturnValue({} as never);
  vi.mocked(connect).mockResolvedValue(undefined);
  vi.mocked(getCurrentChannelId).mockReturnValue('current-vc');
  vi.mocked(getAvailableVoiceChannels).mockResolvedValue([]);
});

describe('GET /status', () => {
  it('returns the status snapshot', async () => {
    const res = await supertest(buildApp()).get('/status').expect(200);
    expect(res.body).toEqual({ discord: {}, voice: {}, twitch: {}, tiktok: {} });
  });
});

describe('GET /voice/channels', () => {
  it('reports the current channel for the configured guild', async () => {
    const res = await supertest(buildApp()).get('/voice/channels').expect(200);
    expect(res.body).toMatchObject({
      ok: true,
      defaultChannelId: 'default-vc',
      currentChannelId: 'current-vc',
    });
    expect(vi.mocked(getCurrentChannelId)).toHaveBeenCalledWith('guild-123');
  });

  it('returns 500 when channel lookup fails', async () => {
    vi.mocked(getAvailableVoiceChannels).mockRejectedValue(new Error('Discord down'));
    const res = await supertest(buildApp()).get('/voice/channels').expect(500);
    expect(res.body).toMatchObject({ ok: false });
  });
});

describe('POST /voice/join', () => {
  it('disconnects then joins the requested channel for the configured guild', async () => {
    const res = await supertest(buildApp())
      .post('/voice/join')
      .send({ channelId: '123456789012345678' })
      .expect(200);

    expect(res.body).toEqual({ ok: true });
    expect(vi.mocked(disconnect)).toHaveBeenCalledWith('guild-123');
    expect(vi.mocked(connect)).toHaveBeenCalledWith({}, 'guild-123', '123456789012345678');
  });

  it('falls back to the default channel when no channelId is given', async () => {
    await supertest(buildApp()).post('/voice/join').send({}).expect(200);
    expect(vi.mocked(connect)).toHaveBeenCalledWith({}, 'guild-123', undefined);
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
  it('disconnects the configured guild and returns ok', async () => {
    const res = await supertest(buildApp()).post('/voice/leave').expect(200);
    expect(res.body).toEqual({ ok: true });
    expect(vi.mocked(disconnect)).toHaveBeenCalledWith('guild-123');
  });
});
