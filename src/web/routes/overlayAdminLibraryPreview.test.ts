import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockLogger } from '../../test-utils/loggerMock';
import { ACCESS_LEVEL_MOCK } from '../../test-utils/accessLevelMock';

// GET /overlay/library/videos/:filename, with the real requireAuth. As in overlaySource.test.ts,
// realPathWithin and res.sendFile are stubbed: real symlink resolution is covered in
// pathUtils.test.ts, and the paths here are POSIX like the bot's Linux target.

vi.mock('../../shared/config', () => ({
  PUBLIC_URL: 'http://localhost:3000',
  OVERLAY_STATUS_MAX_SSE_PER_STREAMER: 3,
  OVERLAY_MAX_SSE_PER_CHANNEL: 10,
  SSE_MAX_TOTAL_CONNECTIONS: 1000,
  OVERLAY_FOLDER: '/app/overlay-videos',
}));
vi.mock('../../shared/logger', () => ({ createLogger: mockLogger }));
vi.mock('../../shared/pathUtils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../shared/pathUtils')>();
  return { ...actual, realPathWithin: vi.fn() };
});
vi.mock('../../db', () => ({
  AccessLevel: ACCESS_LEVEL_MOCK,
  getStreamerByDiscordId: vi.fn(),
  getVideosForStreamer: vi.fn(),
  getRewardsForStreamer: vi.fn(),
  getLibraryVideos: vi.fn(),
  findKeyByHash: vi.fn(),
  findDiscordIdByTokenHash: vi.fn(),
  findUser: vi.fn(),
}));
vi.mock('../guildAccess', () => ({ fetchLiveGuildsForUser: vi.fn(), resolveAccessLevelForGuild: vi.fn() }));
vi.mock('./overlayAdminMutations', async () => {
  const { Router } = await import('express');
  return { router: Router(), MAX_UPLOAD_MB: 100 };
});
vi.mock('./overlayAdminRewardMutations', async () => {
  const { Router } = await import('express');
  return { router: Router() };
});

import express from 'express';
import supertest from 'supertest';
import router from './overlayAdmin';
import { realPathWithin } from '../../shared/pathUtils';
import { makeSessionUser } from '../../test-utils/fixtures';

const LIBRARY_DIR = '/app/overlay-videos/library';
const FILENAME = '0f8fad5b-d9cb-469f-a165-70867728950e.webm';

/**
 * The overlay admin router behind a session holding `user` (none when omitted), with
 * `res.sendFile` stubbed to reply with the path it was given.
 */
function app(user?: ReturnType<typeof makeSessionUser>) {
  const a = express();
  a.use((req, res, next) => {
    (req as any).session = user ? { user } : {};
    (res as any).sendFile = (filePath: string) => { res.json({ sentFile: filePath }); };
    next();
  });
  a.use(router);
  return a;
}

beforeEach(() => {
  vi.mocked(realPathWithin).mockReset();
});

describe('GET /library/videos/:filename', () => {
  it('redirects to login without a session user, without looking at the file', async () => {
    const res = await supertest(app()).get(`/library/videos/${FILENAME}`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/auth/login');
    expect(realPathWithin).not.toHaveBeenCalled();
  });

  it('sends the real path of an existing library file to a signed-in user', async () => {
    vi.mocked(realPathWithin).mockResolvedValue(`${LIBRARY_DIR}/${FILENAME}`);
    const res = await supertest(app(makeSessionUser())).get(`/library/videos/${FILENAME}`);
    expect(res.status).toBe(200);
    expect(res.body.sentFile).toBe(`${LIBRARY_DIR}/${FILENAME}`);
    expect(realPathWithin).toHaveBeenCalledWith(LIBRARY_DIR, `${LIBRARY_DIR}/${FILENAME}`);
  });

  it('returns 404 for a missing library file, or one whose real path escapes the library folder', async () => {
    vi.mocked(realPathWithin).mockResolvedValue(null);
    const res = await supertest(app(makeSessionUser())).get(`/library/videos/${FILENAME}`);
    expect(res.status).toBe(404);
    expect(res.body.sentFile).toBeUndefined();
  });

  it.each([
    ['an encoded traversal into a streamer folder', '..%2F5%2Fown.webm'],
    ['a non-video extension', 'notes.txt'],
  ])('refuses %s with 400, without looking at the filesystem', async (_label, filename) => {
    const res = await supertest(app(makeSessionUser())).get(`/library/videos/${filename}`);
    expect(res.status).toBe(400);
    expect(realPathWithin).not.toHaveBeenCalled();
  });
});
