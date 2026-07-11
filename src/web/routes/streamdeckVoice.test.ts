import { describe, it, expect, vi, beforeEach } from 'vitest';

const API_KEY_OWNER = 'user-1';

vi.mock('../middleware', () => ({
  requireApiKey: (req: any, _res: any, next: any) => {
    req.apiKeyOwner = API_KEY_OWNER;
    next();
  },
}));

vi.mock('../../db', () => ({
  isKeyApprovedForGuild: vi.fn(),
  getApprovedGuildIdsForKey: vi.fn(),
}));

vi.mock('../../discord/discordUtils', () => ({
  getAvailableVoiceChannels: vi.fn(),
}));

vi.mock('../../audio/audioPlayer', () => ({
  connect: vi.fn(),
  disconnect: vi.fn(),
}));

vi.mock('../../discord/discordBot', () => ({
  getDiscordClient: vi.fn(),
}));

vi.mock('../../shared/logger', () => ({
  createLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn() }),
}));

import express from 'express';
import supertest from 'supertest';
import router from './streamdeckVoice';
import { isKeyApprovedForGuild, getApprovedGuildIdsForKey } from '../../db';
import { getAvailableVoiceChannels } from '../../discord/discordUtils';
import { connect, disconnect } from '../../audio/audioPlayer';
import { getDiscordClient } from '../../discord/discordBot';

/** Fake Discord client whose channels.fetch resolves any channel to the given guildId. */
function makeClient(channelGuildId: string | null = 'guild-123') {
  return {
    channels: {
      fetch: vi.fn(async (channelId: string) =>
        channelGuildId ? { id: channelId, guildId: channelGuildId } : null,
      ),
    },
  } as any;
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(router);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getDiscordClient).mockReturnValue(makeClient());
  vi.mocked(connect).mockResolvedValue(undefined);
  vi.mocked(getAvailableVoiceChannels).mockResolvedValue([]);
  vi.mocked(isKeyApprovedForGuild).mockResolvedValue(true);
  vi.mocked(getApprovedGuildIdsForKey).mockResolvedValue(['guild-123']);
});

describe('GET /voice/channels', () => {
  it('returns voice channels grouped by every guild the key is approved for', async () => {
    vi.mocked(getApprovedGuildIdsForKey).mockResolvedValue(['guild-123', '900000000000000002']);
    const channelsA = [{ id: 'ch1', name: 'General' }];
    const channelsB = [{ id: 'ch2', name: 'Hangout' }];
    vi.mocked(getAvailableVoiceChannels).mockImplementation(async (guildId: string) =>
      (guildId === 'guild-123' ? channelsA : channelsB) as any,
    );

    const res = await supertest(buildApp()).get('/voice/channels').expect(200);

    expect(res.body).toEqual({
      ok: true,
      guilds: [
        { guildId: 'guild-123', channels: channelsA },
        { guildId: '900000000000000002', channels: channelsB },
      ],
    });
  });

  it('returns 500 on error', async () => {
    vi.mocked(getApprovedGuildIdsForKey).mockRejectedValue(new Error('DB down'));

    const res = await supertest(buildApp()).get('/voice/channels').expect(500);

    expect(res.body).toMatchObject({ ok: false });
  });

  it('reports an empty channel list for a guild whose fetch fails, without failing the other guilds', async () => {
    vi.mocked(getApprovedGuildIdsForKey).mockResolvedValue(['guild-123', '900000000000000002']);
    const channelsB = [{ id: 'ch2', name: 'Hangout' }];
    vi.mocked(getAvailableVoiceChannels).mockImplementation(async (guildId: string) => {
      if (guildId === 'guild-123') throw new Error('Unknown Guild');
      return channelsB as any;
    });

    const res = await supertest(buildApp()).get('/voice/channels').expect(200);

    expect(res.body).toEqual({
      ok: true,
      guilds: [
        { guildId: 'guild-123', channels: [] },
        { guildId: '900000000000000002', channels: channelsB },
      ],
    });
  });
});

describe('POST /voice/join', () => {
  it('returns 400 when channelId is missing', async () => {
    const res = await supertest(buildApp()).post('/voice/join').send({}).expect(400);
    expect(res.body).toMatchObject({ ok: false });
  });

  it('returns 400 when channelId is not a valid Discord snowflake', async () => {
    const res = await supertest(buildApp()).post('/voice/join').send({ channelId: 'not-a-snowflake' }).expect(400);
    expect(res.body).toMatchObject({ ok: false });
  });

  it('returns 503 when Discord client is not ready', async () => {
    vi.mocked(getDiscordClient).mockReturnValue(null);

    const res = await supertest(buildApp())
      .post('/voice/join')
      .send({ channelId: '123456789012345678' })
      .expect(503);

    expect(res.body).toMatchObject({ ok: false });
  });

  it('disconnects and then joins the channel, resolving the guild from the channel ID', async () => {
    const client = makeClient('guild-123');
    vi.mocked(getDiscordClient).mockReturnValue(client);

    const res = await supertest(buildApp())
      .post('/voice/join')
      .send({ channelId: '123456789012345678' })
      .expect(200);

    expect(res.body).toEqual({ ok: true });
    expect(vi.mocked(disconnect)).toHaveBeenCalledWith('guild-123');
    expect(vi.mocked(connect)).toHaveBeenCalledWith(client, 'guild-123', '123456789012345678');
    expect(vi.mocked(isKeyApprovedForGuild)).toHaveBeenCalledWith(API_KEY_OWNER, 'guild-123');
    expect(vi.mocked(disconnect).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(connect).mock.invocationCallOrder[0]);
  });

  it('returns 400 when the channel does not resolve to any guild', async () => {
    vi.mocked(getDiscordClient).mockReturnValue(makeClient(null));

    const res = await supertest(buildApp())
      .post('/voice/join')
      .send({ channelId: '123456789012345678' })
      .expect(400);

    expect(res.body).toMatchObject({ ok: false });
    expect(vi.mocked(connect)).not.toHaveBeenCalled();
  });

  it('returns 403 when the key is not approved for the channel\'s guild', async () => {
    vi.mocked(isKeyApprovedForGuild).mockResolvedValue(false);

    const res = await supertest(buildApp())
      .post('/voice/join')
      .send({ channelId: '123456789012345678' })
      .expect(403);

    expect(res.body).toMatchObject({ ok: false });
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
  it('returns 400 when both channelId and guildId are missing', async () => {
    const res = await supertest(buildApp()).post('/voice/leave').send({}).expect(400);
    expect(res.body).toMatchObject({ ok: false });
  });

  it('resolves the guild from channelId and disconnects', async () => {
    const client = makeClient('guild-123');
    vi.mocked(getDiscordClient).mockReturnValue(client);

    const res = await supertest(buildApp())
      .post('/voice/leave')
      .send({ channelId: '123456789012345678' })
      .expect(200);

    expect(res.body).toEqual({ ok: true });
    expect(vi.mocked(disconnect)).toHaveBeenCalledWith('guild-123');
  });

  it('uses an explicit guildId directly, bypassing channel resolution entirely', async () => {
    const res = await supertest(buildApp())
      .post('/voice/leave')
      .send({ guildId: '900000000000000002' })
      .expect(200);

    expect(res.body).toEqual({ ok: true });
    expect(vi.mocked(disconnect)).toHaveBeenCalledWith('900000000000000002');
    expect(vi.mocked(isKeyApprovedForGuild)).toHaveBeenCalledWith(API_KEY_OWNER, '900000000000000002');
  });

  it('falls back to an explicit guildId when the channel no longer exists (e.g. deleted while connected)', async () => {
    vi.mocked(getDiscordClient).mockReturnValue(makeClient(null));

    const res = await supertest(buildApp())
      .post('/voice/leave')
      .send({ channelId: '123456789012345678', guildId: '900000000000000002' })
      .expect(200);

    expect(res.body).toEqual({ ok: true });
    expect(vi.mocked(disconnect)).toHaveBeenCalledWith('900000000000000002');
    expect(vi.mocked(isKeyApprovedForGuild)).toHaveBeenCalledWith(API_KEY_OWNER, '900000000000000002');
  });

  it('returns 400 when only channelId is given and the channel no longer exists', async () => {
    vi.mocked(getDiscordClient).mockReturnValue(makeClient(null));

    const res = await supertest(buildApp())
      .post('/voice/leave')
      .send({ channelId: '123456789012345678' })
      .expect(400);

    expect(res.body).toMatchObject({ ok: false });
    expect(vi.mocked(disconnect)).not.toHaveBeenCalled();
  });

  it('returns 403 when the key is not approved for the channel\'s guild', async () => {
    vi.mocked(isKeyApprovedForGuild).mockResolvedValue(false);

    const res = await supertest(buildApp())
      .post('/voice/leave')
      .send({ channelId: '123456789012345678' })
      .expect(403);

    expect(res.body).toMatchObject({ ok: false });
    expect(vi.mocked(disconnect)).not.toHaveBeenCalled();
  });

  it('returns 503 when Discord client is not ready and only channelId is given', async () => {
    vi.mocked(getDiscordClient).mockReturnValue(null);

    const res = await supertest(buildApp())
      .post('/voice/leave')
      .send({ channelId: '123456789012345678' })
      .expect(503);

    expect(res.body).toMatchObject({ ok: false });
  });

  it('does not require the Discord client when guildId is given explicitly', async () => {
    vi.mocked(getDiscordClient).mockReturnValue(null);

    const res = await supertest(buildApp())
      .post('/voice/leave')
      .send({ guildId: '900000000000000002' })
      .expect(200);

    expect(res.body).toEqual({ ok: true });
    expect(vi.mocked(disconnect)).toHaveBeenCalledWith('900000000000000002');
  });
});
