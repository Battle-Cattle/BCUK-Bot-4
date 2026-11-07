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
  findUser: vi.fn(),
  getGuildsForMember: vi.fn(),
  getAllGuilds: vi.fn(),
  getEffectiveAccessLevelForUser: vi.fn(),
  findKeyByHash: vi.fn(),
  findDiscordIdByTokenHash: vi.fn(),
}));

import supertest from 'supertest';
import { router } from './overlayAdminLibraryMutations';
import { removeLibraryVideo, deleteVideo, findUser, getGuildsForMember } from '../../db';
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
