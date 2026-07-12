import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockLogger } from '../../test-utils/loggerMock';

const API_KEY_OWNER = 'user-1';

vi.mock('../middleware', () => ({
  requireApiKey: (req: any, _res: any, next: any) => {
    req.apiKeyOwner = API_KEY_OWNER;
    next();
  },
}));

vi.mock('../../db', () => ({
  getAllSfxTriggers: vi.fn(),
  isKeyApprovedForGuild: vi.fn(),
  getApprovedGuildIdsForKey: vi.fn(),
  findTrigger: vi.fn(),
  findSoundFiles: vi.fn(),
}));

vi.mock('../../commands/soundSelector', () => ({
  pickWeightedRandom: vi.fn(),
}));

vi.mock('../../audio/sfxPlayer', () => ({
  playFile: vi.fn(),
  VoiceNotConnectedError: class VoiceNotConnectedError extends Error {
    constructor() { super('Not connected to a voice channel'); this.name = 'VoiceNotConnectedError'; }
  },
}));

vi.mock('../../shared/statusStore', () => ({
  setVoicePlaying: vi.fn(),
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

vi.mock('../../discord/voicePresence', () => ({
  getActiveGuildForUser: vi.fn(),
}));

vi.mock('../../shared/logger', () => ({ createLogger: mockLogger }));

import express from 'express';
import supertest from 'supertest';
import router from './streamdeck';
import { getAllSfxTriggers, getApprovedGuildIdsForKey } from '../../db';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(router);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getAllSfxTriggers).mockResolvedValue([]);
  vi.mocked(getApprovedGuildIdsForKey).mockResolvedValue([]);
});

describe('streamdeck router composition', () => {
  it('mounts the SFX sub-router', async () => {
    vi.mocked(getApprovedGuildIdsForKey).mockResolvedValue(['guild-123']);
    const res = await supertest(buildApp()).get('/sfx').expect(200);
    expect(res.body).toEqual({ ok: true, triggers: [] });
  });

  it('mounts the voice sub-router', async () => {
    const res = await supertest(buildApp()).get('/voice/channels').expect(200);
    expect(res.body).toEqual({ ok: true, guilds: [] });
  });
});
