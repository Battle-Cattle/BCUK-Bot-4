import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockLogger } from '../../test-utils/loggerMock';
import { ACCESS_LEVEL_MOCK } from '../../test-utils/accessLevelMock';

/** Mocks the shared logger so route handlers don't write real log output during tests. */
vi.mock('../../shared/logger', () => ({ createLogger: mockLogger }));

vi.mock('../../db', () => ({
  ALERT_EVENT_TYPES: ['follow', 'sub', 'resub', 'giftsub', 'raid'],
  getStreamerByDiscordId: vi.fn(),
  setAlertImage: vi.fn(),
  setAlertSound: vi.fn(),
  // Pulled in transitively via sfxFileUpload.ts (source of the shared detectAudioType).
  addSfxFile: vi.fn(),
  AccessLevel: ACCESS_LEVEL_MOCK,
}));

vi.mock('../csrf', () => ({
  csrfProtection: vi.fn((req: any, _res: any, next: any) => {
    req.csrfToken = () => 'test-csrf-token';
    next();
  }),
}));

vi.mock('../middleware', () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
  // Pulled in transitively via sfxFileUpload.ts — unused by the routes under test here.
  requireMod: (_req: any, _res: any, next: any) => next(),
}));

vi.mock('../../shared/config', () => ({
  ALERT_ASSETS_FOLDER: '/app/alert-assets',
  // Use 1 MB so the oversized-upload tests can trigger Multer's LIMIT_FILE_SIZE with a small buffer.
  ALERT_MAX_IMAGE_MB: 1,
  ALERT_MAX_SOUND_MB: 1,
  // Pulled in transitively via sfxFileUpload.ts (source of the shared detectAudioType).
  SFX_FOLDER: '/app/sfx',
  SFX_MAX_FILE_MB: 10,
}));

vi.mock('fs', () => ({
  default: {
    promises: {
      mkdir: vi.fn(),
      writeFile: vi.fn(),
      rm: vi.fn(),
    },
  },
}));

import supertest from 'supertest';
import { router, detectImageType } from './alertsAssetMutations';
import { getStreamerByDiscordId, setAlertImage, setAlertSound } from '../../db';
import { AccessLevel } from '../../db';
import fs from 'fs';
import { csrfProtection } from '../csrf';
import { buildTestApp } from '../../test-utils/expressTestApp';

// Minimal buffers with correct magic bytes for each format
const PNG_BUF = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
const MP3_BUF = Buffer.from([0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);

type SessionUser = { discordId: string; discordName: string; discordAvatar: string | null; accessLevel: 0 | 1 | 2 | 3 };
const USER: SessionUser = { discordId: '100000000000000001', discordName: 'TestUser', discordAvatar: null, accessLevel: AccessLevel.USER };

const MOCK_STREAMER = {
  id: 123,
  twitch_user_id: 'twitch123',
  twitch_name: 'teststreamer',
  discord_id: USER.discordId,
};

/** Builds a supertest-ready app: the alerts asset mutations router with a stubbed session (no render stub — these routes redirect). */
function buildApp(sessionUser: SessionUser = USER) {
  return buildTestApp({ router, bodyParser: 'urlencoded', sessionUser });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getStreamerByDiscordId).mockResolvedValue(null);
  vi.mocked(setAlertImage).mockResolvedValue(null);
  vi.mocked(setAlertSound).mockResolvedValue(null);
  vi.mocked(fs.promises.mkdir).mockResolvedValue(undefined);
  vi.mocked(fs.promises.writeFile).mockResolvedValue(undefined);
  vi.mocked(fs.promises.rm).mockResolvedValue(undefined);
});

// --- POST /settings/:eventType/image ---

describe('POST /settings/:eventType/image', () => {
  it('redirects with error when user is not a streamer', async () => {
    const res = await supertest(buildApp())
      .post('/settings/follow/image')
      .attach('image', PNG_BUF, 'test.png');
    expect(res.headers.location).toBe('/alerts/settings?error=not_a_streamer');
  });

  it('redirects with error for an invalid event type', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
    const res = await supertest(buildApp())
      .post('/settings/bogus/image')
      .attach('image', PNG_BUF, 'test.png');
    expect(res.headers.location).toBe('/alerts/settings?error=invalid_event_type');
  });

  it('redirects with error when no file is uploaded', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
    const res = await supertest(buildApp()).post('/settings/follow/image');
    expect(res.headers.location).toBe('/alerts/settings?error=invalid_file');
  });

  it('rejects a file with no recognised magic bytes even if MIME type is correct', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
    const res = await supertest(buildApp())
      .post('/settings/follow/image')
      .attach('image', Buffer.from('not a real image'), { filename: 'evil.png', contentType: 'image/png' });
    expect(res.headers.location).toBe('/alerts/settings?error=invalid_file');
    expect(vi.mocked(fs.promises.writeFile)).not.toHaveBeenCalled();
  });

  it('rejects an SVG upload — not in the magic-byte allowlist', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    const res = await supertest(buildApp())
      .post('/settings/follow/image')
      .attach('image', svg, { filename: 'evil.svg', contentType: 'image/svg+xml' });
    expect(res.headers.location).toBe('/alerts/settings?error=invalid_file');
  });

  it('successfully uploads a valid png and removes the previous image', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
    vi.mocked(setAlertImage).mockResolvedValue('follow-old.png');
    const res = await supertest(buildApp())
      .post('/settings/follow/image')
      .attach('image', PNG_BUF, { filename: 'test.png', contentType: 'image/png' });
    expect(res.headers.location).toBe('/alerts/settings?success=image_uploaded');
    expect(vi.mocked(fs.promises.mkdir)).toHaveBeenCalled();
    expect(vi.mocked(fs.promises.writeFile)).toHaveBeenCalled();
    expect(vi.mocked(setAlertImage)).toHaveBeenCalledWith(MOCK_STREAMER.id, 'follow', expect.stringMatching(/^follow-.+\.png$/));
    expect(vi.mocked(fs.promises.rm)).toHaveBeenCalledWith('/app/alert-assets/123/follow-old.png', { force: true });
  });

  it('still reports success when removing the old file fails (post-commit cleanup, not rolled back)', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
    vi.mocked(setAlertImage).mockResolvedValue('follow-old.png');
    vi.mocked(fs.promises.rm).mockRejectedValueOnce(new Error('EACCES'));
    const res = await supertest(buildApp())
      .post('/settings/follow/image')
      .attach('image', PNG_BUF, { filename: 'test.png', contentType: 'image/png' });
    expect(res.headers.location).toBe('/alerts/settings?success=image_uploaded');
  });

  it('rolls back the written file when setAlertImage fails', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
    vi.mocked(setAlertImage).mockRejectedValue(new Error('DB error'));
    const res = await supertest(buildApp())
      .post('/settings/follow/image')
      .attach('image', PNG_BUF, { filename: 'test.png', contentType: 'image/png' });
    expect(res.headers.location).toBe('/alerts/settings?error=upload_failed');
    const writtenPath = vi.mocked(fs.promises.writeFile).mock.calls[0][0] as string;
    expect(vi.mocked(fs.promises.rm)).toHaveBeenCalledWith(writtenPath, { force: true });
  });

  it('redirects an oversized upload to file_too_large via the route middleware', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
    const oversized = Buffer.concat([PNG_BUF, Buffer.alloc(1024 * 1024 + 1024, 1)]);
    const res = await supertest(buildApp())
      .post('/settings/follow/image')
      .attach('image', oversized, { filename: 'big.png', contentType: 'image/png' });
    expect(res.headers.location).toBe('/alerts/settings?error=file_too_large');
    expect(vi.mocked(fs.promises.writeFile)).not.toHaveBeenCalled();
  });

  it('blocks path traversal via a malicious streamer id', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue({ ...MOCK_STREAMER, id: '../../../etc/passwd' } as any);
    const res = await supertest(buildApp())
      .post('/settings/follow/image')
      .attach('image', PNG_BUF, { filename: 'test.png', contentType: 'image/png' });
    expect(res.headers.location).toBe('/alerts/settings?error=invalid_path');
    expect(vi.mocked(fs.promises.writeFile)).not.toHaveBeenCalled();
  });
});

describe('POST /settings/:eventType/image — CSRF protection', () => {
  it('rejects with 403 and does not invoke Multer when CSRF token is invalid', async () => {
    vi.mocked(csrfProtection).mockImplementationOnce((_req, res, _next) => {
      res.status(403).send('invalid csrf token');
    });

    const res = await supertest(buildApp())
      .post('/settings/follow/image')
      .attach('image', PNG_BUF, { filename: 'test.png', contentType: 'image/png' });

    expect(res.status).toBe(403);
    expect(vi.mocked(fs.promises.writeFile)).not.toHaveBeenCalled();
  });
});

// --- POST /settings/:eventType/sound ---

describe('POST /settings/:eventType/sound', () => {
  it('redirects with error when user is not a streamer', async () => {
    const res = await supertest(buildApp())
      .post('/settings/raid/sound')
      .attach('sound', MP3_BUF, 'test.mp3');
    expect(res.headers.location).toBe('/alerts/settings?error=not_a_streamer');
  });

  it('redirects with error for an invalid event type', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
    const res = await supertest(buildApp())
      .post('/settings/bogus/sound')
      .attach('sound', MP3_BUF, 'test.mp3');
    expect(res.headers.location).toBe('/alerts/settings?error=invalid_event_type');
  });

  it('successfully uploads a valid mp3 using the shared detectAudioType', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
    const res = await supertest(buildApp())
      .post('/settings/raid/sound')
      .attach('sound', MP3_BUF, { filename: 'test.mp3', contentType: 'audio/mpeg' });
    expect(res.headers.location).toBe('/alerts/settings?success=sound_uploaded');
    expect(vi.mocked(setAlertSound)).toHaveBeenCalledWith(MOCK_STREAMER.id, 'raid', expect.stringMatching(/^raid-.+\.mp3$/));
  });

  it('rejects a file with no recognised audio magic bytes', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
    const res = await supertest(buildApp())
      .post('/settings/raid/sound')
      .attach('sound', Buffer.from('not audio'), { filename: 'evil.mp3', contentType: 'audio/mpeg' });
    expect(res.headers.location).toBe('/alerts/settings?error=invalid_file');
  });
});

// --- POST /settings/:eventType/image/delete & sound/delete ---

describe('POST /settings/:eventType/image/delete', () => {
  it('redirects with error when user is not a streamer', async () => {
    const res = await supertest(buildApp()).post('/settings/follow/image/delete');
    expect(res.headers.location).toBe('/alerts/settings?error=not_a_streamer');
  });

  it('redirects with error for an invalid event type', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
    const res = await supertest(buildApp()).post('/settings/bogus/image/delete');
    expect(res.headers.location).toBe('/alerts/settings?error=invalid_event_type');
  });

  it('clears the image and removes the file on disk', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
    vi.mocked(setAlertImage).mockResolvedValue('follow-old.png');
    const res = await supertest(buildApp()).post('/settings/follow/image/delete');
    expect(res.headers.location).toBe('/alerts/settings?success=image_deleted');
    expect(vi.mocked(setAlertImage)).toHaveBeenCalledWith(MOCK_STREAMER.id, 'follow', null);
    expect(vi.mocked(fs.promises.rm)).toHaveBeenCalledWith('/app/alert-assets/123/follow-old.png', { force: true });
  });

  it('still reports success when removing the file fails (post-commit cleanup, not rolled back)', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
    vi.mocked(setAlertImage).mockResolvedValue('follow-old.png');
    vi.mocked(fs.promises.rm).mockRejectedValueOnce(new Error('EACCES'));
    const res = await supertest(buildApp()).post('/settings/follow/image/delete');
    expect(res.headers.location).toBe('/alerts/settings?success=image_deleted');
  });

  it('skips rm when there was no previous image', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
    vi.mocked(setAlertImage).mockResolvedValue(null);
    const res = await supertest(buildApp()).post('/settings/follow/image/delete');
    expect(res.headers.location).toBe('/alerts/settings?success=image_deleted');
    expect(vi.mocked(fs.promises.rm)).not.toHaveBeenCalled();
  });
});

describe('POST /settings/:eventType/sound/delete', () => {
  it('clears the sound and removes the file on disk', async () => {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(MOCK_STREAMER as any);
    vi.mocked(setAlertSound).mockResolvedValue('raid-old.mp3');
    const res = await supertest(buildApp()).post('/settings/raid/sound/delete');
    expect(res.headers.location).toBe('/alerts/settings?success=sound_deleted');
    expect(vi.mocked(setAlertSound)).toHaveBeenCalledWith(MOCK_STREAMER.id, 'raid', null);
    expect(vi.mocked(fs.promises.rm)).toHaveBeenCalledWith('/app/alert-assets/123/raid-old.mp3', { force: true });
  });
});

// --- detectImageType unit tests ---

describe('detectImageType', () => {
  it('detects PNG by signature', () => {
    expect(detectImageType(PNG_BUF)).toBe('png');
  });

  it('detects GIF87a and GIF89a by signature', () => {
    expect(detectImageType(Buffer.from('GIF87a', 'ascii'))).toBe('gif');
    expect(detectImageType(Buffer.from('GIF89a', 'ascii'))).toBe('gif');
  });

  it('detects JPEG by signature', () => {
    expect(detectImageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('jpeg');
  });

  it('detects WEBP by RIFF/WEBP container', () => {
    const buf = Buffer.concat([Buffer.from('RIFF', 'ascii'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBP', 'ascii')]);
    expect(detectImageType(buf)).toBe('webp');
  });

  it('returns null for unrecognised bytes', () => {
    expect(detectImageType(Buffer.from('not an image'))).toBeNull();
  });

  it('returns null for SVG (deliberately not in the allowlist)', () => {
    expect(detectImageType(Buffer.from('<svg></svg>'))).toBeNull();
  });
});
