import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

/** Hoisted so the `vi.mock` factories below can safely reference these — `vi.mock` factories are hoisted above imports, so plain imported bindings could throw `ReferenceError` depending on import order. */
const { mockLogger, ACCESS_LEVEL_MOCK, SFX_FOLDER_MOCK } = vi.hoisted(() => ({
  mockLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  ACCESS_LEVEL_MOCK: { USER: 0, MOD: 1, MANAGER: 2, ADMIN: 3 },
  SFX_FOLDER_MOCK: require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'sfx-test-')) as string,
}));

/** Mocks the `db` facade so `AccessLevel` resolves to the shared hoisted mock instead of hitting the real module. */
vi.mock('../../db', () => ({
  getAllSfxTriggers: vi.fn().mockResolvedValue([]),
  getAllCategories: vi.fn().mockResolvedValue([]),
  getSfxFileById: vi.fn().mockResolvedValue(null),
  AccessLevel: ACCESS_LEVEL_MOCK,
}));
/** Mocks the shared logger so route handlers don't write real log output during tests. */
vi.mock('../../shared/logger', () => ({ createLogger: mockLogger }));
vi.mock('../../shared/config', () => ({ SFX_MAX_FILE_MB: 10, OPENAI_API_KEY: 'test-openai-key', SFX_FOLDER: SFX_FOLDER_MOCK }));
vi.mock('../csrf', () => ({
  csrfProtection: (req: any, _res: any, next: any) => {
    req.csrfToken = () => 'test-csrf-token';
    next();
  },
}));

import supertest from 'supertest';
import router from './sfx';
import { getAllSfxTriggers, getAllCategories, getSfxFileById, AccessLevel } from '../../db';
import { buildTestApp } from '../../test-utils/expressTestApp';

/**
 * Build a supertest GET request against the SFX view router with a stubbed session
 * and a render mock that echoes the view name and locals as JSON.
 * @param sessionUser Session user to attach to the request (defaults to a level-0 user).
 * @param query Optional query string appended to `/sfx` (e.g. `?error=invalid_id`).
 * @returns A supertest request for `GET /sfx`.
 */
function buildApp(sessionUser: unknown = { discordId: '1', accessLevel: AccessLevel.USER }, query = '') {
  const app = buildTestApp({ router, sessionUser, mockRender: 'nested' });
  return supertest(app).get('/sfx' + query);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getAllSfxTriggers).mockResolvedValue([]);
  vi.mocked(getAllCategories).mockResolvedValue([]);
  vi.mocked(getSfxFileById).mockResolvedValue(null);
});

describe('GET /sfx', () => {
  it('renders the sfx view with triggers and categories', async () => {
    vi.mocked(getAllCategories).mockResolvedValue([{ id: 1, name: 'Reactions' }]);
    const res = await buildApp();
    expect(res.status).toBe(200);
    expect((res.body as any).view).toBe('sfx');
    expect((res.body as any).locals.categories).toEqual([{ id: 1, name: 'Reactions' }]);
    expect((res.body as any).locals.maxUploadMb).toBe(10);
  });

  it('sets canManage=false for a level-0 user', async () => {
    const res = await buildApp({ discordId: '1', accessLevel: AccessLevel.USER });
    expect((res.body as any).locals.canManage).toBe(false);
  });

  it('sets canManage=true for a Mod', async () => {
    const res = await buildApp({ discordId: '1', accessLevel: AccessLevel.MOD });
    expect((res.body as any).locals.canManage).toBe(true);
  });

  it('sets canSuggestDescriptions=true for the owner when OPENAI_API_KEY is set', async () => {
    const res = await buildApp({ discordId: '1', accessLevel: AccessLevel.USER, isOwner: true });
    expect((res.body as any).locals.canSuggestDescriptions).toBe(true);
  });

  it('sets canSuggestDescriptions=false for a non-owner Admin, even though canManage is true', async () => {
    const res = await buildApp({ discordId: '1', accessLevel: AccessLevel.ADMIN, isOwner: false });
    expect((res.body as any).locals.canManage).toBe(true);
    expect((res.body as any).locals.canSuggestDescriptions).toBe(false);
  });

  it('sets canSuggestDescriptions=false when isOwner is absent from the session', async () => {
    const res = await buildApp({ discordId: '1', accessLevel: AccessLevel.USER });
    expect((res.body as any).locals.canSuggestDescriptions).toBe(false);
  });

  it('passes through a known error query param and ignores unknown ones', async () => {
    const known = await buildApp({ discordId: '1', accessLevel: AccessLevel.MOD }, '?error=command_taken');
    expect((known.body as any).locals.error).toBe('command_taken');
    const unknown = await buildApp({ discordId: '1', accessLevel: AccessLevel.MOD }, '?error=nonsense');
    expect((unknown.body as any).locals.error).toBeNull();
  });

  it('passes through a known success query param', async () => {
    const res = await buildApp({ discordId: '1', accessLevel: AccessLevel.MOD }, '?success=trigger_added');
    expect((res.body as any).locals.success).toBe('trigger_added');
  });

  it('returns 500 and renders the error page when the DB query fails', async () => {
    vi.mocked(getAllSfxTriggers).mockRejectedValueOnce(new Error('DB down'));
    const res = await buildApp();
    expect(res.status).toBe(500);
    expect((res.body as any).view).toBe('error');
  });

  it('sets canSuggestDescriptions=false for the owner when OPENAI_API_KEY is unset', async () => {
    vi.resetModules();
    vi.doMock('../../db', () => ({
      getAllSfxTriggers: vi.fn().mockResolvedValue([]),
      getAllCategories: vi.fn().mockResolvedValue([]),
      AccessLevel: ACCESS_LEVEL_MOCK,
    }));
    vi.doMock('../../shared/logger', () => ({ createLogger: mockLogger }));
    vi.doMock('../../shared/config', () => ({ SFX_MAX_FILE_MB: 10, OPENAI_API_KEY: '' }));
    vi.doMock('../csrf', () => ({
      csrfProtection: (req: any, _res: any, next: any) => {
        req.csrfToken = () => 'test-csrf-token';
        next();
      },
    }));

    const freshRouter: any = (await import('./sfx.js')).default;
    const freshBuildTestApp = (await import('../../test-utils/expressTestApp.js')).buildTestApp;
    const app = freshBuildTestApp({
      router: freshRouter,
      sessionUser: { discordId: '1', accessLevel: AccessLevel.USER, isOwner: true },
      mockRender: 'nested',
    });

    const res = await supertest(app).get('/sfx');
    expect((res.body as any).locals.canSuggestDescriptions).toBe(false);
  });
});

describe('GET /sfx/file/:id/audio', () => {
  function buildAudioApp() {
    return buildTestApp({ router, sessionUser: { discordId: '1', accessLevel: AccessLevel.USER } });
  }

  it('streams the file when the id resolves to a real file under SFX_FOLDER', async () => {
    fs.writeFileSync(path.join(SFX_FOLDER_MOCK, 'clap.mp3'), 'fake-audio-bytes');
    vi.mocked(getSfxFileById).mockResolvedValue({ file: 'clap.mp3' });

    const res = await supertest(buildAudioApp()).get('/sfx/file/1/audio');
    expect(res.status).toBe(200);
    expect(Buffer.isBuffer(res.body) ? res.body.toString() : res.text).toBe('fake-audio-bytes');
  });

  it('returns 400 for a non-numeric id', async () => {
    const res = await supertest(buildAudioApp()).get('/sfx/file/not-a-number/audio');
    expect(res.status).toBe(400);
  });

  it('returns 404 when no sfx row matches the id', async () => {
    vi.mocked(getSfxFileById).mockResolvedValue(null);
    const res = await supertest(buildAudioApp()).get('/sfx/file/999/audio');
    expect(res.status).toBe(404);
  });

  it('returns 404 when the stored path escapes SFX_FOLDER', async () => {
    vi.mocked(getSfxFileById).mockResolvedValue({ file: '../../etc/passwd' });
    const res = await supertest(buildAudioApp()).get('/sfx/file/1/audio');
    expect(res.status).toBe(404);
  });

  it('returns 404 when the DB row points at a file that no longer exists on disk', async () => {
    vi.mocked(getSfxFileById).mockResolvedValue({ file: 'missing.mp3' });
    const res = await supertest(buildAudioApp()).get('/sfx/file/1/audio');
    expect(res.status).toBe(404);
  });

  it('returns 500 when the DB lookup throws', async () => {
    vi.mocked(getSfxFileById).mockRejectedValue(new Error('DB down'));
    const res = await supertest(buildAudioApp()).get('/sfx/file/1/audio');
    expect(res.status).toBe(500);
  });
});
