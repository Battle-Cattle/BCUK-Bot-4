import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockLogger } from '../../test-utils/loggerMock';

vi.mock('../../shared/logger', () => ({ createLogger: mockLogger }));
vi.mock('../../db', () => ({ getStreamerByDiscordId: vi.fn(), setAdvancedCommandAlertAsset: vi.fn(), addSfxFile: vi.fn() }));
vi.mock('../../shared/config', () => ({
  ALERT_ASSETS_FOLDER: '/app/alert-assets', ALERT_MAX_IMAGE_MB: 1, ALERT_MAX_SOUND_MB: 1, SFX_FOLDER: '/app/sfx', SFX_MAX_FILE_MB: 10,
}));
vi.mock('../csrf', () => ({ csrfProtection: (_req: any, _res: any, next: any) => next() }));
vi.mock('../middleware', () => ({ requireAuth: (_req: any, _res: any, next: any) => next(), requireMod: (_req: any, _res: any, next: any) => next() }));
vi.mock('fs', () => ({ default: { promises: { mkdir: vi.fn(), writeFile: vi.fn(), rm: vi.fn() } } }));

import supertest from 'supertest';
import fs from 'fs';
import { router, removeAlertAssetFiles } from './advancedCommandAlertAssets';
import { getStreamerByDiscordId, setAdvancedCommandAlertAsset } from '../../db';
import { buildTestApp } from '../../test-utils/expressTestApp';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
const MP3 = Buffer.from([0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
const SESSION_USER = { discordId: '1', discordName: 'S', discordAvatar: null, accessLevel: 0 };
const app = () => buildTestApp({ router, bodyParser: 'urlencoded', sessionUser: SESSION_USER as any });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getStreamerByDiscordId).mockResolvedValue({ id: 3, discord_id: '1', twitch_name: 's' } as any);
  vi.mocked(setAdvancedCommandAlertAsset).mockResolvedValue({ previous: 'old.png' });
  vi.mocked(fs.promises.mkdir).mockResolvedValue(undefined);
  vi.mocked(fs.promises.writeFile).mockResolvedValue(undefined);
  vi.mocked(fs.promises.rm).mockResolvedValue(undefined);
});

describe('alert asset uploads', () => {
  it('stores an image under a generated name and removes the one it replaces', async () => {
    const res = await supertest(app()).post('/advanced-commands/7/alert/image').attach('image', PNG, 'pic.png').expect(302);
    expect(res.headers.location).toBe('/advanced-commands?success=image_uploaded');
    const filename = vi.mocked(setAdvancedCommandAlertAsset).mock.calls[0]![3] as string;
    expect(filename).toMatch(/^command-7-[0-9a-f-]+\.png$/);
    expect(setAdvancedCommandAlertAsset).toHaveBeenCalledWith(3, 7, 'image', filename);
    expect(fs.promises.writeFile).toHaveBeenCalled();
    expect(fs.promises.rm).toHaveBeenCalledWith('/app/alert-assets/3/old.png', { force: true });
  });

  it('stores a sound', async () => {
    vi.mocked(setAdvancedCommandAlertAsset).mockResolvedValue({ previous: null });
    const res = await supertest(app()).post('/advanced-commands/7/alert/sound').attach('sound', MP3, 'a.mp3').expect(302);
    expect(res.headers.location).toBe('/advanced-commands?success=sound_uploaded');
    expect(fs.promises.rm).not.toHaveBeenCalled();
  });

  it('rejects a file that is not the right type', async () => {
    const res = await supertest(app()).post('/advanced-commands/7/alert/image').attach('image', MP3, 'x.png').expect(302);
    expect(res.headers.location).toBe('/advanced-commands?error=invalid_file');
    expect(setAdvancedCommandAlertAsset).not.toHaveBeenCalled();
  });

  it('removes the stored file when the command has no alert', async () => {
    vi.mocked(setAdvancedCommandAlertAsset).mockResolvedValue(null);
    const res = await supertest(app()).post('/advanced-commands/7/alert/image').attach('image', PNG, 'pic.png').expect(302);
    expect(res.headers.location).toBe('/advanced-commands?error=no_alert');
    expect(fs.promises.rm).toHaveBeenCalledOnce();
  });

  it('removes the stored file and reports a failed DB write', async () => {
    vi.mocked(setAdvancedCommandAlertAsset).mockRejectedValue(new Error('boom'));
    const res = await supertest(app()).post('/advanced-commands/7/alert/image').attach('image', PNG, 'pic.png').expect(302);
    expect(res.headers.location).toBe('/advanced-commands?error=upload_failed');
    expect(fs.promises.rm).toHaveBeenCalledOnce();
  });

  it('rejects a bad command id and a non-streamer', async () => {
    let res = await supertest(app()).post('/advanced-commands/x/alert/image').attach('image', PNG, 'pic.png').expect(302);
    expect(res.headers.location).toBe('/advanced-commands?error=not_found');
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(null);
    res = await supertest(app()).post('/advanced-commands/7/alert/image').attach('image', PNG, 'pic.png');
    expect(res.headers.location).toBe('/advanced-commands?error=not_a_streamer');
  });
});

describe('alert asset deletes', () => {
  it('clears the asset and deletes its file', async () => {
    const res = await supertest(app()).post('/advanced-commands/7/alert/sound/delete').expect(302);
    expect(res.headers.location).toBe('/advanced-commands?success=sound_deleted');
    expect(setAdvancedCommandAlertAsset).toHaveBeenCalledWith(3, 7, 'sound', null);
    expect(fs.promises.rm).toHaveBeenCalledWith('/app/alert-assets/3/old.png', { force: true });
  });

  it('reports a command with no alert, and a failed write', async () => {
    vi.mocked(setAdvancedCommandAlertAsset).mockResolvedValueOnce(null);
    expect((await supertest(app()).post('/advanced-commands/7/alert/image/delete')).headers.location).toBe('/advanced-commands?error=no_alert');
    expect((await supertest(app()).post('/advanced-commands/x/alert/image/delete')).headers.location).toBe('/advanced-commands?error=no_alert');
    vi.mocked(setAdvancedCommandAlertAsset).mockRejectedValueOnce(new Error('boom'));
    expect((await supertest(app()).post('/advanced-commands/7/alert/image/delete')).headers.location).toBe('/advanced-commands?error=save_failed');
  });
});

describe('removeAlertAssetFiles', () => {
  it('skips unsafe names and logs (not throws) a failed delete', async () => {
    vi.mocked(fs.promises.rm).mockRejectedValueOnce(new Error('EACCES'));
    await expect(removeAlertAssetFiles(3, ['../escape.png', 'ok.png'])).resolves.toBeUndefined();
    expect(fs.promises.rm).toHaveBeenCalledExactlyOnceWith('/app/alert-assets/3/ok.png', { force: true });
  });
});
