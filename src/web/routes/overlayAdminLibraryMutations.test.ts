import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { ACCESS_LEVEL_MOCK } from '../../test-utils/accessLevelMock';

// POST /settings/library/:id/remove through the real requireAuth → requireGuildContext →
// requireAdmin chain (only the DB calls under it are mocked), with a real overlay folder so the
// library file and a streamer's imported copy are real files.

vi.mock('../../shared/config', async () => {
  const nodeOs = await import('os');
  const nodePath = await import('path');
  return { OVERLAY_FOLDER: nodePath.join(nodeOs.tmpdir(), `overlay-library-remove-${process.pid}-${Date.now()}`) };
});
const { logMock } = vi.hoisted(() => ({
  logMock: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../shared/logger', () => ({ createLogger: () => logMock }));
vi.mock('../csrf', () => ({
  csrfProtection: (_req: unknown, _res: unknown, next: () => void) => next(),
  ensureSessionCsrfToken: () => 'tok',
}));
vi.mock('../../db', () => ({
  AccessLevel: ACCESS_LEVEL_MOCK,
  removeLibraryVideo: vi.fn(),
  deleteVideo: vi.fn(),
  addVideoToLibrary: vi.fn(),
  getVideosForStreamer: vi.fn(),
  getLibraryVideoFilename: vi.fn(),
  importLibraryVideo: vi.fn(),
  getStreamerByDiscordId: vi.fn(),
  findUser: vi.fn(),
  getGuildsForMember: vi.fn(),
  getAllGuilds: vi.fn(),
  getEffectiveAccessLevelForUser: vi.fn(),
  findKeyByHash: vi.fn(),
  findDiscordIdByTokenHash: vi.fn(),
}));

import supertest from 'supertest';
import { router } from './overlayAdminLibraryMutations';
import {
  removeLibraryVideo, deleteVideo, findUser, getGuildsForMember,
  addVideoToLibrary, getVideosForStreamer, getStreamerByDiscordId, getLibraryVideoFilename, importLibraryVideo,
} from '../../db';
import { LIBRARY_IMPORT_LIMIT, LIBRARY_PUBLISH_LIMIT } from '../rateLimits';
import { AccessLevel } from '../../db';
import { buildTestApp } from '../../test-utils/expressTestApp';
import { makeSessionUser } from '../../test-utils/fixtures';
import { linkVideoFile, LIBRARY_FOLDER, streamerFolder } from './overlayVideoLibraryFiles';
import { OVERLAY_FOLDER as overlayFolder } from '../../shared/config';

const GUILD = '900000000000000001';
const LIBRARY_FILE = 'lib.webm';

/**
 * A test app whose session user claims `sessionLevel`, while the database says `dbLevel` for
 * the current guild — so the test sees which one the route trusts.
 */
function app(dbLevel: number, sessionLevel: number = dbLevel) {
  vi.mocked(findUser).mockResolvedValue({ discord_id: '100000000000000001', is_owner: false } as any);
  vi.mocked(getGuildsForMember).mockResolvedValue([{ guild_id: GUILD, name: 'G', access_level: dbLevel }] as any);
  const user = makeSessionUser({ accessLevel: sessionLevel as any, currentGuildId: GUILD } as any);
  return buildTestApp({ router, session: { user }, mockRender: 'text' });
}

/** Path of a file in an OVERLAY_FOLDER subfolder. */
function file(folder: string, filename: string) {
  return path.join(overlayFolder, folder, filename);
}

beforeEach(async () => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  await fs.promises.rm(overlayFolder, { recursive: true, force: true });
  await fs.promises.mkdir(path.join(overlayFolder, LIBRARY_FOLDER), { recursive: true });
  await fs.promises.writeFile(file(LIBRARY_FOLDER, LIBRARY_FILE), 'library video');
});

afterAll(async () => {
  await fs.promises.rm(overlayFolder, { recursive: true, force: true });
});

describe('POST /settings/library/:id/remove — access', () => {
  it.each([
    ['a User (e.g. the contributor)', AccessLevel.USER],
    ['a Mod', AccessLevel.MOD],
    ['a Manager', AccessLevel.MANAGER],
  ])('refuses %s with 403 and deletes nothing', async (_label, level) => {
    const res = await supertest(app(level)).post('/settings/library/4/remove');
    expect(res.status).toBe(403);
    expect(removeLibraryVideo).not.toHaveBeenCalled();
    expect(fs.existsSync(file(LIBRARY_FOLDER, LIBRARY_FILE))).toBe(true);
  });

  it('trusts the access level re-derived for the guild, not a stale Admin level in the session', async () => {
    const res = await supertest(app(AccessLevel.MANAGER, AccessLevel.ADMIN)).post('/settings/library/4/remove');
    expect(res.status).toBe(403);
    expect(removeLibraryVideo).not.toHaveBeenCalled();
  });

  it('redirects to login without a session user', async () => {
    const res = await supertest(buildTestApp({ router, session: {}, mockRender: 'text' })).post('/settings/library/4/remove');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/auth/login');
    expect(removeLibraryVideo).not.toHaveBeenCalled();
  });
});

describe('POST /settings/library/:id/remove — as an Admin', () => {
  it('removes the row and the library file, keeping a streamer\'s imported copy, and logs who did it', async () => {
    // The imported copy is a second link to the same file, as importing creates it.
    const imported = (await linkVideoFile({ folder: LIBRARY_FOLDER, filename: LIBRARY_FILE }, streamerFolder(9)))!;
    vi.mocked(removeLibraryVideo).mockResolvedValue(LIBRARY_FILE);

    const res = await supertest(app(AccessLevel.ADMIN)).post('/settings/library/4/remove');

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/overlay/settings?success=library_video_removed');
    expect(removeLibraryVideo).toHaveBeenCalledWith(4);
    expect(deleteVideo).not.toHaveBeenCalled();
    expect(fs.existsSync(file(LIBRARY_FOLDER, LIBRARY_FILE))).toBe(false);
    expect(await fs.promises.readFile(file('9', imported), 'utf8')).toBe('library video');
    expect(logMock.info).toHaveBeenCalledWith('Admin 100000000000000001 removed library video 4 (lib.webm)');
  });

  it('still redirects with success, and logs, when removing the file fails', async () => {
    vi.mocked(removeLibraryVideo).mockResolvedValue(LIBRARY_FILE);
    vi.spyOn(fs.promises, 'rm').mockRejectedValueOnce(Object.assign(new Error('busy'), { code: 'EBUSY' }));

    const res = await supertest(app(AccessLevel.ADMIN)).post('/settings/library/4/remove');

    expect(res.headers.location).toBe('/overlay/settings?success=library_video_removed');
    expect(logMock.error).toHaveBeenCalledWith(expect.stringContaining('Failed to remove overlay video file'), expect.anything());
  });

  it.each([['abc'], ['0'], ['-1'], ['1.5']])('redirects with invalid_id for a malformed id %s', async (id) => {
    const res = await supertest(app(AccessLevel.ADMIN)).post(`/settings/library/${id}/remove`);
    expect(res.headers.location).toBe('/overlay/settings?error=invalid_id');
    expect(removeLibraryVideo).not.toHaveBeenCalled();
  });

  it('redirects with not_found when the entry no longer exists, leaving files alone', async () => {
    vi.mocked(removeLibraryVideo).mockResolvedValue(null);
    const res = await supertest(app(AccessLevel.ADMIN)).post('/settings/library/4/remove');
    expect(res.headers.location).toBe('/overlay/settings?error=not_found');
    expect(fs.existsSync(file(LIBRARY_FOLDER, LIBRARY_FILE))).toBe(true);
  });

  it('redirects with delete_failed, keeping the file, when the DB delete fails', async () => {
    vi.mocked(removeLibraryVideo).mockRejectedValue(new Error('db down'));
    const res = await supertest(app(AccessLevel.ADMIN)).post('/settings/library/4/remove');
    expect(res.headers.location).toBe('/overlay/settings?error=delete_failed');
    expect(logMock.error).toHaveBeenCalledWith('Overlay library remove error:', expect.any(Error));
    expect(fs.existsSync(file(LIBRARY_FOLDER, LIBRARY_FILE))).toBe(true);
  });
});

// ─── Publishing ─────────────────────────────────────────────────────────────

describe('POST /settings/videos/:id/publish', () => {
  const STREAMER_ID = 5;
  const SOURCE_FILE = 'own.webm';
  const UUID_WEBM = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.webm$/;
  let accounts = 0;

  /**
   * A test app for a fresh streamer account (its own rate-limit bucket), owning video 3 with a
   * real file in its folder.
   */
  async function publishApp(user = makeSessionUser({ discordId: `2000000000000000${String(accounts++).padStart(2, '0')}` })) {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue({ id: STREAMER_ID } as any);
    vi.mocked(getVideosForStreamer).mockResolvedValue([
      { id: 3, streamer_id: STREAMER_ID, name: 'Clap', filename: SOURCE_FILE, created_at: new Date() },
    ]);
    await fs.promises.mkdir(path.join(overlayFolder, streamerFolder(STREAMER_ID)), { recursive: true });
    await fs.promises.writeFile(file(streamerFolder(STREAMER_ID), SOURCE_FILE), 'streamer video');
    return buildTestApp({ router, session: { user }, mockRender: 'text' });
  }

  /** Files currently in the library folder, other than the one the outer beforeEach puts there. */
  async function newLibraryFiles() {
    return (await fs.promises.readdir(path.join(overlayFolder, LIBRARY_FOLDER))).filter((f) => f !== LIBRARY_FILE);
  }

  it('links the file into the library and records the entry, which outlives the contributor\'s video', async () => {
    vi.mocked(addVideoToLibrary).mockResolvedValue({ status: 'added', libraryId: 7, sourceFilename: SOURCE_FILE });

    const res = await supertest(await publishApp()).post('/settings/videos/3/publish');

    expect(res.headers.location).toBe('/overlay/settings?success=video_published');
    const [libraryFile] = await newLibraryFiles();
    expect(libraryFile).toMatch(UUID_WEBM);
    expect(addVideoToLibrary).toHaveBeenCalledWith(3, STREAMER_ID, libraryFile);
    expect(logMock.info).toHaveBeenCalledWith(`Streamer ${STREAMER_ID} added video 3 to the public library as entry 7`);

    // The contributor deleting their own video removes only their link; the library copy plays on.
    await fs.promises.rm(file(streamerFolder(STREAMER_ID), SOURCE_FILE));
    expect(await fs.promises.readFile(file(LIBRARY_FOLDER, libraryFile!), 'utf8')).toBe('streamer video');
  });

  it('refuses another streamer\'s video before creating any file', async () => {
    const app = await publishApp();
    const res = await supertest(app).post('/settings/videos/99/publish');
    expect(res.headers.location).toBe('/overlay/settings?error=not_your_video');
    expect(addVideoToLibrary).not.toHaveBeenCalled();
    expect(await newLibraryFiles()).toEqual([]);
  });

  it.each([
    ['not_owner', 'not_your_video'],
    ['already_in_library', 'already_in_library'],
  ] as const)('removes the new library file when the DB step returns %s', async (status, code) => {
    vi.mocked(addVideoToLibrary).mockResolvedValue({ status } as any);
    const res = await supertest(await publishApp()).post('/settings/videos/3/publish');
    expect(res.headers.location).toBe(`/overlay/settings?error=${code}`);
    expect(addVideoToLibrary).toHaveBeenCalledTimes(1);
    expect(await newLibraryFiles()).toEqual([]);
  });

  it('removes the new library file and redirects with publish_failed when the DB step fails', async () => {
    vi.mocked(addVideoToLibrary).mockRejectedValue(new Error('db down'));
    const res = await supertest(await publishApp()).post('/settings/videos/3/publish');
    expect(res.headers.location).toBe('/overlay/settings?error=publish_failed');
    expect(logMock.error).toHaveBeenCalledWith('Overlay library publish error:', expect.any(Error));
    expect(await newLibraryFiles()).toEqual([]);
  });

  it('redirects with publish_failed, and logs, when the video has no file on disk', async () => {
    const app = await publishApp();
    await fs.promises.rm(file(streamerFolder(STREAMER_ID), SOURCE_FILE));
    const res = await supertest(app).post('/settings/videos/3/publish');
    expect(res.headers.location).toBe('/overlay/settings?error=publish_failed');
    expect(addVideoToLibrary).not.toHaveBeenCalled();
    expect(logMock.error).toHaveBeenCalledWith(`Overlay video 3 of streamer ${STREAMER_ID} has no file to publish (${SOURCE_FILE})`);
  });

  it.each([['abc'], ['0'], ['-1']])('redirects with invalid_id for a malformed id %s', async (id) => {
    const res = await supertest(await publishApp()).post(`/settings/videos/${id}/publish`);
    expect(res.headers.location).toBe('/overlay/settings?error=invalid_id');
    expect(addVideoToLibrary).not.toHaveBeenCalled();
  });

  it('redirects a non-streamer to the not_a_streamer error', async () => {
    const app = await publishApp();
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(null);
    const res = await supertest(app).post('/settings/videos/3/publish');
    expect(res.headers.location).toBe('/overlay/settings?error=not_a_streamer');
    expect(addVideoToLibrary).not.toHaveBeenCalled();
  });

  it('redirects to login without a session user', async () => {
    const res = await supertest(buildTestApp({ router, session: {}, mockRender: 'text' })).post('/settings/videos/3/publish');
    expect(res.headers.location).toBe('/auth/login');
    expect(addVideoToLibrary).not.toHaveBeenCalled();
  });

  it(`stops one account after ${LIBRARY_PUBLISH_LIMIT} publishes in the window, without affecting others`, async () => {
    vi.mocked(addVideoToLibrary).mockResolvedValue({ status: 'already_in_library' });
    const app = await publishApp(makeSessionUser({ discordId: '300000000000000001' }));
    for (let i = 0; i < LIBRARY_PUBLISH_LIMIT; i++) {
      expect((await supertest(app).post('/settings/videos/3/publish')).status).toBe(302);
    }
    const blocked = await supertest(app).post('/settings/videos/3/publish');
    expect(blocked.status).toBe(429);
    // Every request counts, failed ones included, so the message speaks of requests, not videos added.
    expect(blocked.text).toBe('Too many requests to add videos to the public library. Please try again in an hour.');
    expect(addVideoToLibrary).toHaveBeenCalledTimes(LIBRARY_PUBLISH_LIMIT);

    const other = await supertest(await publishApp(makeSessionUser({ discordId: '300000000000000002' }))).post('/settings/videos/3/publish');
    expect(other.status).toBe(302);
  });
});

// ─── Importing ──────────────────────────────────────────────────────────────

describe('POST /settings/library/:id/import', () => {
  const STREAMER_ID = 9;
  const UUID_WEBM = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.webm$/;
  let importAccounts = 0;

  /**
   * A test app for streamer 9 on a fresh account (its own import rate-limit bucket), where library
   * entry 4 exists (backed by the real library file) and any other id doesn't.
   */
  function importApp(user = makeSessionUser({ discordId: `4000000000000000${String(importAccounts++).padStart(2, '0')}` })) {
    vi.mocked(getStreamerByDiscordId).mockResolvedValue({ id: STREAMER_ID } as any);
    vi.mocked(getLibraryVideoFilename).mockImplementation(async (id) => (id === 4 ? LIBRARY_FILE : null));
    return buildTestApp({ router, session: { user }, mockRender: 'text' });
  }

  /** Files currently in the importing streamer's folder. */
  async function streamerFiles() {
    return fs.promises.readdir(path.join(overlayFolder, streamerFolder(STREAMER_ID))).catch(() => [] as string[]);
  }

  it('creates the streamer\'s own copy and row, independent of the library entry', async () => {
    vi.mocked(importLibraryVideo).mockResolvedValue(31);

    const res = await supertest(importApp()).post('/settings/library/4/import');

    expect(res.headers.location).toBe('/overlay/settings?success=video_imported');
    const [copy] = await streamerFiles();
    expect(copy).toMatch(UUID_WEBM);
    expect(importLibraryVideo).toHaveBeenCalledWith(4, STREAMER_ID, copy);
    expect(await fs.promises.readFile(file(streamerFolder(STREAMER_ID), copy!), 'utf8')).toBe('library video');
    expect(logMock.info).toHaveBeenCalledWith(`Streamer ${STREAMER_ID} imported library video 4 as video 31`);

    // Deleting the imported copy keeps the library file.
    await fs.promises.rm(file(streamerFolder(STREAMER_ID), copy!));
    expect(await fs.promises.readFile(file(LIBRARY_FOLDER, LIBRARY_FILE), 'utf8')).toBe('library video');
  });

  it('keeps the imported copy when an Admin then removes the library entry', async () => {
    vi.mocked(importLibraryVideo).mockResolvedValue(31);
    await supertest(importApp()).post('/settings/library/4/import');
    const [copy] = await streamerFiles();

    vi.mocked(removeLibraryVideo).mockResolvedValue(LIBRARY_FILE);
    const removed = await supertest(app(AccessLevel.ADMIN)).post('/settings/library/4/remove');

    expect(removed.headers.location).toBe('/overlay/settings?success=library_video_removed');
    expect(fs.existsSync(file(LIBRARY_FOLDER, LIBRARY_FILE))).toBe(false);
    expect(await fs.promises.readFile(file(streamerFolder(STREAMER_ID), copy!), 'utf8')).toBe('library video');
  });

  it('makes a second, independent copy when the same entry is imported twice', async () => {
    vi.mocked(importLibraryVideo).mockResolvedValueOnce(31).mockResolvedValueOnce(32);
    const app = importApp();

    await supertest(app).post('/settings/library/4/import');
    const second = await supertest(app).post('/settings/library/4/import');

    expect(second.headers.location).toBe('/overlay/settings?success=video_imported');
    const copies = await streamerFiles();
    expect(copies).toHaveLength(2);
    expect(copies[0]).not.toBe(copies[1]);
  });

  it('redirects with not_found, creating no file, for an entry that is not in the library', async () => {
    const res = await supertest(importApp()).post('/settings/library/99/import');
    expect(res.headers.location).toBe('/overlay/settings?error=not_found');
    expect(importLibraryVideo).not.toHaveBeenCalled();
    expect(await streamerFiles()).toEqual([]);
  });

  it('removes the new file and redirects with not_found when the entry is removed mid-import', async () => {
    vi.mocked(importLibraryVideo).mockResolvedValue(null);
    const res = await supertest(importApp()).post('/settings/library/4/import');
    expect(res.headers.location).toBe('/overlay/settings?error=not_found');
    expect(importLibraryVideo).toHaveBeenCalledTimes(1);
    expect(await streamerFiles()).toEqual([]);
  });

  it('removes the new file and redirects with import_failed when the DB step fails', async () => {
    vi.mocked(importLibraryVideo).mockRejectedValue(new Error('db down'));
    const res = await supertest(importApp()).post('/settings/library/4/import');
    expect(res.headers.location).toBe('/overlay/settings?error=import_failed');
    expect(logMock.error).toHaveBeenCalledWith('Overlay library import error:', expect.any(Error));
    expect(await streamerFiles()).toEqual([]);
  });

  it('redirects with not_found when an Admin removes the entry and its file mid-import', async () => {
    const app = importApp();
    // The first lookup still finds the entry; by the time the file is linked, both are gone.
    vi.mocked(getLibraryVideoFilename).mockResolvedValueOnce(LIBRARY_FILE).mockResolvedValueOnce(null);
    await fs.promises.rm(file(LIBRARY_FOLDER, LIBRARY_FILE));

    const res = await supertest(app).post('/settings/library/4/import');

    expect(res.headers.location).toBe('/overlay/settings?error=not_found');
    expect(importLibraryVideo).not.toHaveBeenCalled();
    expect(logMock.error).not.toHaveBeenCalled();
    expect(await streamerFiles()).toEqual([]);
  });

  it('redirects with import_failed, and logs, when the library file is missing on disk', async () => {
    await fs.promises.rm(file(LIBRARY_FOLDER, LIBRARY_FILE));
    const res = await supertest(importApp()).post('/settings/library/4/import');
    expect(res.headers.location).toBe('/overlay/settings?error=import_failed');
    expect(importLibraryVideo).not.toHaveBeenCalled();
    expect(logMock.error).toHaveBeenCalledWith(`Library video 4 has no file to import (${LIBRARY_FILE})`);
  });

  it.each([['abc'], ['0'], ['-1']])('redirects with invalid_id for a malformed id %s', async (id) => {
    const res = await supertest(importApp()).post(`/settings/library/${id}/import`);
    expect(res.headers.location).toBe('/overlay/settings?error=invalid_id');
    expect(importLibraryVideo).not.toHaveBeenCalled();
  });

  it('redirects a non-streamer to the not_a_streamer error', async () => {
    const app = importApp();
    vi.mocked(getStreamerByDiscordId).mockResolvedValue(null);
    const res = await supertest(app).post('/settings/library/4/import');
    expect(res.headers.location).toBe('/overlay/settings?error=not_a_streamer');
    expect(importLibraryVideo).not.toHaveBeenCalled();
  });

  it(`stops one account after ${LIBRARY_IMPORT_LIMIT} imports in the window, without affecting others`, async () => {
    let nextId = 100;
    vi.mocked(importLibraryVideo).mockImplementation(async () => nextId++);
    const app = importApp(makeSessionUser({ discordId: '500000000000000001' }));
    for (let i = 0; i < LIBRARY_IMPORT_LIMIT; i++) {
      expect((await supertest(app).post('/settings/library/4/import')).status).toBe(302);
    }
    const blocked = await supertest(app).post('/settings/library/4/import');
    expect(blocked.status).toBe(429);
    expect(blocked.text).toBe('Too many requests to add library videos to your videos. Please try again in an hour.');
    expect(importLibraryVideo).toHaveBeenCalledTimes(LIBRARY_IMPORT_LIMIT);
    // Every allowed import made a copy; the blocked one made none.
    expect(await streamerFiles()).toHaveLength(LIBRARY_IMPORT_LIMIT);
    // Pinned separately, so changing the limit is a deliberate edit to this test too.
    expect(LIBRARY_IMPORT_LIMIT).toBe(20);

    const other = await supertest(importApp(makeSessionUser({ discordId: '500000000000000002' }))).post('/settings/library/4/import');
    expect(other.status).toBe(302);
  });

  it('redirects to login without a session user', async () => {
    const res = await supertest(buildTestApp({ router, session: {}, mockRender: 'text' })).post('/settings/library/4/import');
    expect(res.headers.location).toBe('/auth/login');
    expect(importLibraryVideo).not.toHaveBeenCalled();
  });
});
