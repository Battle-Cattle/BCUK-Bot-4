import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SfxTrigger, SfxFile } from '../../db';

const API_KEY_OWNER = 'user-1';

vi.mock('../middleware', () => ({
  requireApiKey: (req: any, _res: any, next: any) => {
    req.apiKeyOwner = API_KEY_OWNER;
    next();
  },
}));

vi.mock('../../db', () => ({
  findTrigger: vi.fn(),
  findSoundFiles: vi.fn(),
  getAllSfxTriggers: vi.fn(),
  isKeyApprovedForGuild: vi.fn(),
  getApprovedGuildIdsForKey: vi.fn(),
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

vi.mock('../../discord/discordBot', () => ({
  getDiscordClient: vi.fn(),
}));

vi.mock('../../discord/voicePresence', () => ({
  getActiveGuildForUser: vi.fn(),
}));

vi.mock('../../shared/logger', () => ({
  createLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn() }),
}));

import supertest from 'supertest';
import router from './streamdeckSfx';
import { findTrigger, findSoundFiles, getAllSfxTriggers, isKeyApprovedForGuild, getApprovedGuildIdsForKey } from '../../db';
import { pickWeightedRandom } from '../../commands/soundSelector';
import { playFile, VoiceNotConnectedError } from '../../audio/sfxPlayer';
import { setVoicePlaying } from '../../shared/statusStore';
import { getDiscordClient } from '../../discord/discordBot';
import { getActiveGuildForUser } from '../../discord/voicePresence';
import { buildTestApp } from '../../test-utils/expressTestApp';

const TRIGGER: SfxTrigger = {
  id: BigInt(1),
  trigger_command: '!ding',
  category_id: null,
  hidden: false,
  description: null,
};

const FILES: SfxFile[] = [
  { id: 1, trigger_id: BigInt(1), file: 'ding.mp3', trigger_command: null, weight: 1, hidden: false, category_id: null },
];

/** Fake Discord client; channel lookups aren't exercised by SFX routes. */
function makeClient() {
  return { channels: { fetch: vi.fn() } } as any;
}

function buildApp() {
  return buildTestApp({ router, bodyParser: 'json' });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getAllSfxTriggers).mockResolvedValue([]);
  vi.mocked(findTrigger).mockResolvedValue(null);
  vi.mocked(findSoundFiles).mockResolvedValue([]);
  vi.mocked(pickWeightedRandom).mockReturnValue('ding.mp3');
  vi.mocked(getDiscordClient).mockReturnValue(makeClient());
  vi.mocked(getActiveGuildForUser).mockReturnValue('guild-123');
  vi.mocked(isKeyApprovedForGuild).mockResolvedValue(true);
  vi.mocked(getApprovedGuildIdsForKey).mockResolvedValue(['guild-123']);
});

describe('POST /sfx', () => {
  it('calls playFile with the bare filename and the presence-resolved guild', async () => {
    vi.mocked(findTrigger).mockResolvedValue(TRIGGER);
    vi.mocked(findSoundFiles).mockResolvedValue(FILES);
    vi.mocked(pickWeightedRandom).mockReturnValue('only1_v2.mp3');

    await supertest(buildApp())
      .post('/sfx')
      .send({ command: '!ding' })
      .expect(200);

    expect(vi.mocked(playFile)).toHaveBeenCalledWith('only1_v2.mp3', 'guild-123');
    expect(vi.mocked(playFile)).not.toHaveBeenCalledWith(expect.stringContaining('/'), expect.anything());
  });

  it('returns 200 and the filename on success', async () => {
    vi.mocked(findTrigger).mockResolvedValue(TRIGGER);
    vi.mocked(findSoundFiles).mockResolvedValue(FILES);
    vi.mocked(pickWeightedRandom).mockReturnValue('ding.mp3');

    const res = await supertest(buildApp())
      .post('/sfx')
      .send({ command: '!ding' })
      .expect(200);

    expect(res.body).toEqual({ ok: true, file: 'ding.mp3' });
    expect(vi.mocked(setVoicePlaying)).toHaveBeenCalledWith('guild-123', 'ding.mp3', '!ding', 'streamdeck');
  });

  it('normalises the command to lowercase before lookup', async () => {
    vi.mocked(findTrigger).mockResolvedValue(TRIGGER);
    vi.mocked(findSoundFiles).mockResolvedValue(FILES);

    await supertest(buildApp())
      .post('/sfx')
      .send({ command: '!DING' })
      .expect(200);

    expect(vi.mocked(findTrigger)).toHaveBeenCalledWith('!ding');
  });

  it('returns 400 when command field is missing', async () => {
    const res = await supertest(buildApp()).post('/sfx').send({}).expect(400);
    expect(res.body).toMatchObject({ ok: false });
    expect(vi.mocked(playFile)).not.toHaveBeenCalled();
  });

  it('returns 400 when command is whitespace only', async () => {
    const res = await supertest(buildApp()).post('/sfx').send({ command: '   ' }).expect(400);
    expect(res.body).toMatchObject({ ok: false });
    expect(vi.mocked(playFile)).not.toHaveBeenCalled();
  });

  it('returns 503 when the key owner is not connected to voice in any guild', async () => {
    vi.mocked(getActiveGuildForUser).mockReturnValue(null);

    const res = await supertest(buildApp()).post('/sfx').send({ command: '!ding' }).expect(503);

    expect(res.body).toMatchObject({ ok: false });
    expect(vi.mocked(playFile)).not.toHaveBeenCalled();
  });

  it('returns 403 when the key is not approved for the resolved guild', async () => {
    vi.mocked(isKeyApprovedForGuild).mockResolvedValue(false);

    const res = await supertest(buildApp()).post('/sfx').send({ command: '!ding' }).expect(403);

    expect(res.body).toMatchObject({ ok: false });
    expect(vi.mocked(playFile)).not.toHaveBeenCalled();
  });

  it('returns 503 when Discord client is not ready', async () => {
    vi.mocked(getDiscordClient).mockReturnValue(null);

    const res = await supertest(buildApp()).post('/sfx').send({ command: '!ding' }).expect(503);

    expect(res.body).toMatchObject({ ok: false });
  });

  it('returns 404 when trigger is not found', async () => {
    vi.mocked(findTrigger).mockResolvedValue(null);

    const res = await supertest(buildApp())
      .post('/sfx')
      .send({ command: '!unknown' })
      .expect(404);

    expect(res.body).toMatchObject({ ok: false, error: 'Unknown command' });
  });

  it('returns 404 when trigger has no sound files', async () => {
    vi.mocked(findTrigger).mockResolvedValue(TRIGGER);
    vi.mocked(findSoundFiles).mockResolvedValue([]);

    const res = await supertest(buildApp())
      .post('/sfx')
      .send({ command: '!ding' })
      .expect(404);

    expect(res.body).toMatchObject({ ok: false });
    expect(vi.mocked(playFile)).not.toHaveBeenCalled();
  });

  it('returns 503 when bot is not connected to a voice channel', async () => {
    vi.mocked(findTrigger).mockResolvedValue(TRIGGER);
    vi.mocked(findSoundFiles).mockResolvedValue(FILES);
    vi.mocked(playFile).mockImplementation(() => { throw new VoiceNotConnectedError(); });

    const res = await supertest(buildApp())
      .post('/sfx')
      .send({ command: '!ding' })
      .expect(503);

    expect(res.body).toMatchObject({ ok: false, error: 'Bot is not connected to a voice channel' });
  });

  it('returns 500 when playFile throws an unexpected error', async () => {
    vi.mocked(findTrigger).mockResolvedValue(TRIGGER);
    vi.mocked(findSoundFiles).mockResolvedValue(FILES);
    vi.mocked(playFile).mockImplementation(() => { throw new Error('FFMPEG crashed'); });

    const res = await supertest(buildApp())
      .post('/sfx')
      .send({ command: '!ding' })
      .expect(500);

    expect(res.body).toMatchObject({ ok: false });
  });

  it('returns 500 on DB error looking up trigger', async () => {
    vi.mocked(findTrigger).mockRejectedValue(new Error('DB gone'));

    const res = await supertest(buildApp())
      .post('/sfx')
      .send({ command: '!ding' })
      .expect(500);

    expect(res.body).toMatchObject({ ok: false });
  });

  it('returns 500 on DB error fetching sound files', async () => {
    vi.mocked(findTrigger).mockResolvedValue(TRIGGER);
    vi.mocked(findSoundFiles).mockRejectedValue(new Error('DB gone'));

    const res = await supertest(buildApp())
      .post('/sfx')
      .send({ command: '!ding' })
      .expect(500);

    expect(res.body).toMatchObject({ ok: false });
  });
});

describe('GET /sfx', () => {
  it('returns the list of SFX triggers', async () => {
    const triggers = [{ triggerId: '1', triggerCommand: '!ding', description: null, hidden: false, categoryName: null, files: [] }];
    vi.mocked(getAllSfxTriggers).mockResolvedValue(triggers as any);

    const res = await supertest(buildApp()).get('/sfx').expect(200);

    expect(res.body).toEqual({ ok: true, triggers });
  });

  it('returns 500 on DB error', async () => {
    vi.mocked(getAllSfxTriggers).mockRejectedValue(new Error('DB gone'));

    const res = await supertest(buildApp()).get('/sfx').expect(500);

    expect(res.body).toMatchObject({ ok: false });
  });

  it('returns 403 when the key is not approved for any guild', async () => {
    vi.mocked(getApprovedGuildIdsForKey).mockResolvedValue([]);

    const res = await supertest(buildApp()).get('/sfx').expect(403);

    expect(res.body).toMatchObject({ ok: false });
    expect(getAllSfxTriggers).not.toHaveBeenCalled();
  });
});
