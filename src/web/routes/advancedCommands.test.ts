import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockLogger } from '../../test-utils/loggerMock';

vi.mock('../../shared/logger', () => ({ createLogger: mockLogger }));
vi.mock('../../db', async () => {
  const errors = await import('../../db/commandErrors.js');
  const reserved = await import('../../db/reservedCommands.js');
  class AdvancedCommandValidationError extends Error {
    constructor(readonly code: string, message: string) { super(message); }
  }
  class AdvancedCommandConflictError extends Error {
    constructor(readonly field: 'name' | 'trigger') { super(field); }
  }
  return {
    findUser: vi.fn(),
    getStreamerByDiscordId: vi.fn(),
    getLoyaltyPointsConfig: vi.fn(),
    getVideosForStreamer: vi.fn(),
    listAdvancedCommands: vi.fn(),
    listRecentAdvancedCommandUsage: vi.fn(),
    addAdvancedCommand: vi.fn(),
    updateAdvancedCommand: vi.fn(),
    setAdvancedCommandEnabled: vi.fn(),
    removeAdvancedCommand: vi.fn(),
    saveAdvancedCommandEffects: vi.fn(),
    setAdvancedCommandAlertAsset: vi.fn(),
    ADVANCED_COMMAND_ROLES: ['everyone', 'subscriber', 'vip', 'moderator'],
    ALERT_TEXT_ANIMATIONS: ['none', 'wave'],
    MAX_ADVANCED_COMMAND_PARAMS: 10,
    AdvancedCommandValidationError,
    AdvancedCommandConflictError,
    CommandConflictError: errors.CommandConflictError,
    ReservedCommandError: reserved.ReservedCommandError,
  };
});
vi.mock('../../shared/config', () => ({ ALERT_ASSETS_FOLDER: '/app/alert-assets', ALERT_MAX_IMAGE_MB: 1, ALERT_MAX_SOUND_MB: 1 }));
vi.mock('../csrf', () => ({
  csrfProtection: (req: any, _res: any, next: any) => {
    req.csrfToken = () => 'test-csrf-token';
    next();
  },
}));
vi.mock('../middleware', () => ({ requireAuth: (_req: any, _res: any, next: any) => next() }));
vi.mock('../../commands/advancedCommands/advancedCommandHandler', () => ({ triggerAdvancedCommandFromStreamDeck: vi.fn() }));
// renderView reads the views directory, so keep the real sync fs and fake only the async file writes.
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return { default: { ...actual, promises: { mkdir: vi.fn(), writeFile: vi.fn(), rm: vi.fn() } } };
});

import supertest from 'supertest';
import fs from 'fs';
import router from './advancedCommands';
import * as db from '../../db';
import { triggerAdvancedCommandFromStreamDeck } from '../../commands/advancedCommands/advancedCommandHandler';
import { buildTestApp } from '../../test-utils/expressTestApp';

const SESSION_USER = { discordId: '1', discordName: 'Streamer', discordAvatar: null, isOwner: false, accessLevel: 0, currentGuildId: null, guilds: [] };
const STREAMER = { id: 3, discord_id: '1', twitch_name: 'Streamer' };

const app = () => buildTestApp({ router, bodyParser: 'urlencoded', sessionUser: SESSION_USER, mockRender: 'spread' });
const post = (path: string, body: Record<string, string> = {}) => supertest(app()).post(path).type('form').send(body);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(db.getStreamerByDiscordId).mockResolvedValue(STREAMER as any);
  vi.mocked(db.findUser).mockResolvedValue({ twitch_name: 'streamer', is_twitch_bot_enabled: true } as any);
  vi.mocked(db.getLoyaltyPointsConfig).mockResolvedValue({ enabled: true } as any);
  vi.mocked(db.listAdvancedCommands).mockResolvedValue([]);
  vi.mocked(db.getVideosForStreamer).mockResolvedValue([{ id: 5 } as any]);
  vi.mocked(db.listRecentAdvancedCommandUsage).mockResolvedValue([]);
  vi.mocked(fs.promises.rm).mockResolvedValue(undefined);
});

describe('GET /advanced-commands', () => {
  it('renders the streamer\'s commands, videos, usage and prerequisites, filtering unknown codes', async () => {
    const res = await supertest(app()).get('/advanced-commands?error=duplicate_name&success=bogus').expect(200);
    expect(res.body).toMatchObject({
      isStreamer: true, streamerId: 3, twitchLinked: true, chatBotEnabled: true, loyaltyPointsEnabled: true,
      commands: [], videos: [{ id: 5 }], usage: [], error: 'duplicate_name', success: null, maxParams: 10,
    });
    expect(db.listRecentAdvancedCommandUsage).toHaveBeenCalledWith(3, 50);
  });

  it('renders the explanation for a non-streamer without loading commands', async () => {
    vi.mocked(db.getStreamerByDiscordId).mockResolvedValue(null);
    vi.mocked(db.findUser).mockResolvedValue(null);
    const res = await supertest(app()).get('/advanced-commands').expect(200);
    expect(res.body).toMatchObject({ isStreamer: false, streamerId: null, commands: [], loyaltyPointsEnabled: false });
    expect(db.listAdvancedCommands).not.toHaveBeenCalled();
  });

  it('shows the error page when loading fails', async () => {
    vi.mocked(db.listAdvancedCommands).mockRejectedValue(new Error('boom'));
    {
      const r = await supertest(app()).get('/advanced-commands');
      expect(r.status).toBe(500);
    }
  });
});

describe('POST /advanced-commands/add', () => {
  it('adds a command for the streamer', async () => {
    const res = await post('/advanced-commands/add', { name: 'Hydrate', trigger: '!hydrate', point_cost: '100' }).expect(302);
    expect(res.headers.location).toBe('/advanced-commands?success=added');
    expect(db.addAdvancedCommand).toHaveBeenCalledWith(3, expect.objectContaining({ name: 'Hydrate', triggerString: '!hydrate', pointCost: 100 }));
  });

  it('redirects a non-streamer', async () => {
    vi.mocked(db.getStreamerByDiscordId).mockResolvedValue(null);
    const res = await post('/advanced-commands/add', { name: 'x' }).expect(302);
    expect(res.headers.location).toBe('/advanced-commands?error=not_a_streamer');
    expect(db.addAdvancedCommand).not.toHaveBeenCalled();
  });

  it.each([
    [() => new db.AdvancedCommandConflictError('name'), 'duplicate_name'],
    [() => new db.CommandConflictError(['!x']), 'trigger_taken'],
    [() => new db.ReservedCommandError('!so'), 'reserved_trigger'],
    [() => new db.AdvancedCommandValidationError('invalid_max_cost', 'x'), 'invalid_max_cost'],
    [() => new Error('boom'), 'save_failed'],
  ])('maps a write error to ?error=%s', async (makeError, code) => {
    vi.mocked(db.addAdvancedCommand).mockRejectedValue(makeError());
    const res = await post('/advanced-commands/add', { name: 'x' }).expect(302);
    expect(res.headers.location).toBe(`/advanced-commands?error=${code}`);
  });

  it('rejects a non-numeric field before writing', async () => {
    const res = await post('/advanced-commands/add', { name: 'x', point_cost: 'lots' }).expect(302);
    expect(res.headers.location).toBe('/advanced-commands?error=invalid_number');
  });

  it('rejects a number too large to parse exactly before writing', async () => {
    const res = await post('/advanced-commands/add', { name: 'x', point_cost: '99999999999999999999' }).expect(302);
    expect(res.headers.location).toBe('/advanced-commands?error=invalid_number');
    expect(db.addAdvancedCommand).not.toHaveBeenCalled();
  });
});

describe('command routes', () => {
  it('updates, reporting a missing command', async () => {
    vi.mocked(db.updateAdvancedCommand).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect((await post('/advanced-commands/7/update', { name: 'x' })).headers.location).toBe('/advanced-commands?success=saved');
    expect(db.updateAdvancedCommand).toHaveBeenCalledWith(3, 7, expect.objectContaining({ name: 'x' }));
    expect((await post('/advanced-commands/7/update', { name: 'x' })).headers.location).toBe('/advanced-commands?error=not_found');
  });

  it('maps errors thrown by a command route to their page codes', async () => {
    vi.mocked(db.updateAdvancedCommand).mockRejectedValueOnce(new db.AdvancedCommandConflictError('trigger'));
    expect((await post('/advanced-commands/7/update', { name: 'x' })).headers.location).toBe('/advanced-commands?error=duplicate_trigger');
    vi.mocked(db.setAdvancedCommandEnabled).mockRejectedValueOnce(new Error('boom'));
    expect((await post('/advanced-commands/7/toggle')).headers.location).toBe('/advanced-commands?error=save_failed');
  });

  it('rejects a non-numeric id', async () => {
    expect((await post('/advanced-commands/abc/toggle')).headers.location).toBe('/advanced-commands?error=not_found');
    expect(db.setAdvancedCommandEnabled).not.toHaveBeenCalled();
  });

  it('toggles', async () => {
    vi.mocked(db.setAdvancedCommandEnabled).mockResolvedValueOnce(false).mockResolvedValueOnce(null);
    expect((await post('/advanced-commands/7/toggle')).headers.location).toBe('/advanced-commands?success=toggled');
    expect(db.setAdvancedCommandEnabled).toHaveBeenCalledWith(3, 7);
    expect((await post('/advanced-commands/7/toggle')).headers.location).toBe('/advanced-commands?error=not_found');
  });

  it('removes the command and its alert files', async () => {
    vi.mocked(db.removeAdvancedCommand).mockResolvedValueOnce(['a.png']).mockResolvedValueOnce(null);
    expect((await post('/advanced-commands/7/remove')).headers.location).toBe('/advanced-commands?success=removed');
    expect(fs.promises.rm).toHaveBeenCalledWith('/app/alert-assets/3/a.png', { force: true });
    expect((await post('/advanced-commands/7/remove')).headers.location).toBe('/advanced-commands?error=not_found');
  });

  it('saves effects, offering only the streamer\'s videos, and deletes orphaned alert files', async () => {
    vi.mocked(db.saveAdvancedCommandEffects).mockResolvedValueOnce(['s.mp3']);
    const res = await post('/advanced-commands/7/effects', { params: 'color=red', video_5: 'on', video_6: 'on' });
    expect(res.headers.location).toBe('/advanced-commands?success=effects_saved');
    expect(db.saveAdvancedCommandEffects).toHaveBeenCalledWith(3, 7, {
      params: [{ key: 'color', value: 'red' }], videos: [{ videoId: 5, weight: 1 }], alert: null,
    });
    expect(fs.promises.rm).toHaveBeenCalledWith('/app/alert-assets/3/s.mp3', { force: true });

    vi.mocked(db.saveAdvancedCommandEffects).mockResolvedValueOnce(null);
    expect((await post('/advanced-commands/7/effects')).headers.location).toBe('/advanced-commands?error=not_found');
  });

  it('sends a test like the Stream Deck would', async () => {
    vi.mocked(triggerAdvancedCommandFromStreamDeck)
      .mockResolvedValueOnce('ok').mockResolvedValueOnce('command_disabled').mockResolvedValueOnce('command_not_found');
    expect((await post('/advanced-commands/7/test')).headers.location).toBe('/advanced-commands?success=test_sent');
    expect(triggerAdvancedCommandFromStreamDeck).toHaveBeenCalledWith({ id: 3, discordId: '1', twitchName: 'Streamer' }, 7);
    expect((await post('/advanced-commands/7/test')).headers.location).toBe('/advanced-commands?error=command_disabled');
    expect((await post('/advanced-commands/7/test')).headers.location).toBe('/advanced-commands?error=not_found');
  });

  it('refuses a test for a streamer with no Twitch login', async () => {
    vi.mocked(db.getStreamerByDiscordId).mockResolvedValue({ ...STREAMER, twitch_name: null } as any);
    expect((await post('/advanced-commands/7/test')).headers.location).toBe('/advanced-commands?error=not_a_streamer');
  });
});
