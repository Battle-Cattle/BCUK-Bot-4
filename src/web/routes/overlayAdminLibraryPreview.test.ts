import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { mockLogger } from '../../test-utils/loggerMock';
import { ACCESS_LEVEL_MOCK } from '../../test-utils/accessLevelMock';

// GET /overlay/library/videos/:filename, with the real requireAuth and a real library folder:
// this is about who may fetch a file and which files the route will hand out.

vi.mock('../../shared/config', async () => {
  const nodeOs = await import('os');
  const nodePath = await import('path');
  return {
    PUBLIC_URL: 'http://localhost:3000',
    OVERLAY_STATUS_MAX_SSE_PER_STREAMER: 3,
    OVERLAY_MAX_SSE_PER_CHANNEL: 10,
    SSE_MAX_TOTAL_CONNECTIONS: 1000,
    OVERLAY_FOLDER: nodePath.join(nodeOs.tmpdir(), `overlay-library-preview-${process.pid}-${Date.now()}`),
  };
});
vi.mock('../../shared/logger', () => ({ createLogger: mockLogger }));
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

import supertest from 'supertest';
import router from './overlayAdmin';
import { buildTestApp } from '../../test-utils/expressTestApp';
import { makeSessionUser } from '../../test-utils/fixtures';
import { OVERLAY_FOLDER as overlayFolder } from '../../shared/config';

const LIBRARY_DIR = path.join(overlayFolder, 'library');
const FILENAME = '0f8fad5b-d9cb-469f-a165-70867728950e.webm';
let outside: string;

beforeAll(async () => {
  await fs.promises.mkdir(LIBRARY_DIR, { recursive: true });
  await fs.promises.writeFile(path.join(LIBRARY_DIR, FILENAME), 'library video bytes');
  outside = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'overlay-library-preview-outside-'));
  await fs.promises.writeFile(path.join(outside, 'secret.webm'), 'secret');
  // A streamer folder next to the library, which the preview route must never reach into.
  await fs.promises.mkdir(path.join(overlayFolder, '5'), { recursive: true });
  await fs.promises.writeFile(path.join(overlayFolder, '5', 'own.webm'), 'streamer video');
});

afterAll(async () => {
  await fs.promises.rm(overlayFolder, { recursive: true, force: true });
  await fs.promises.rm(outside, { recursive: true, force: true });
});

/** A test app with the overlay admin router and a session holding `user` (none when omitted). */
function app(user?: ReturnType<typeof makeSessionUser>) {
  return buildTestApp({ router, session: user ? { user } : {} });
}

describe('GET /library/videos/:filename', () => {
  it('redirects to login without a session user, without sending the file', async () => {
    const res = await supertest(app()).get(`/library/videos/${FILENAME}`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/auth/login');
    expect(res.text).not.toContain('library video bytes');
  });

  it('serves an existing library file to a signed-in user', async () => {
    const res = await supertest(app(makeSessionUser())).get(`/library/videos/${FILENAME}`).buffer(true).parse((r, cb) => {
      let data = '';
      r.on('data', (c: Buffer) => { data += c.toString(); });
      r.on('end', () => cb(null, data));
    });
    expect(res.status).toBe(200);
    expect(res.body).toBe('library video bytes');
  });

  it('honours Range requests, which video previews rely on', async () => {
    const res = await supertest(app(makeSessionUser())).get(`/library/videos/${FILENAME}`).set('Range', 'bytes=0-6');
    expect(res.status).toBe(206);
    expect(res.headers['content-range']).toBe(`bytes 0-6/${'library video bytes'.length}`);
  });

  it('returns 404 for a missing library file', async () => {
    const res = await supertest(app(makeSessionUser())).get('/library/videos/missing.webm');
    expect(res.status).toBe(404);
  });

  it.each([
    ['an encoded traversal into a streamer folder', '..%2F5%2Fown.webm'],
    ['a non-video extension', 'notes.txt'],
  ])('refuses %s with 400', async (_label, filename) => {
    const res = await supertest(app(makeSessionUser())).get(`/library/videos/${filename}`);
    expect(res.status).toBe(400);
  });

  it('returns 404 for a library filename that is a symlink to a file outside the overlay folder', async () => {
    await fs.promises.symlink(path.join(outside, 'secret.webm'), path.join(LIBRARY_DIR, 'escape.webm'), 'file');
    const res = await supertest(app(makeSessionUser())).get('/library/videos/escape.webm');
    expect(res.status).toBe(404);
    expect(res.text).not.toContain('secret');
  });
});
